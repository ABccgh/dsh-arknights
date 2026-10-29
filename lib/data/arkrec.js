/**
 * ArkRec（明日方舟少人WIKI）数据客户端：关卡中文名 / 所属章节或活动 / 突袭条件 / 少人纪录。
 *
 * 与 `lib/arkrec.js`（P2 用的旧客户端）的区别：
 * - 这里只做**数据层**：结果给 `ark_data` / `GET /arknights/query` 用，不参与打关卡决策；
 * - 缓存走 `lib/data/cache.js` 的 TTL JSON 缓存（默认 168h，契约 §12「缓存 7 天」）；
 * - 任何失败都降级成 `null`（或旧缓存 + `stale`），**绝不抛裸异常**。
 *
 * 实测接口（2026-10-28）：
 *   GET {api}/api/menu              → 关卡树（主线/活动/危机合约/剿灭/物资/芯片/悖论…）
 *   GET {api}/api/hard-operations   → 各关少人纪录（最少人数）
 *
 * @module @local/arknights/data/arkrec
 */

import path from 'node:path';

import { createJsonCache, fetchJson, ttlMsFromHours } from './cache.js';

/** 默认 API 根。 */
export const DEFAULT_ARKREC_API = 'https://wiki.arkrec.com/v1';
/** 缓存 key：关卡树。 */
const MENU_KEY = 'arkrec-menu';
/** 缓存 key：少人纪录。 */
const HARD_KEY = 'arkrec-hard-operations';

/**
 * 把关卡树展平成 `code → { cn_name, en_name, challenge, story, group }`。
 *
 * 结构（实测）：根节点 `childNodes[]` 是一级分类（`story` 字段，如「主线关卡」「活动关卡」），
 * 分类下是分组节点（`episode`/`name`），再下面是叶子节点（`operation` + `cn_name`）。
 * 同一个 operation 可能出现多次（活动 + 主线），只保留第一次出现的（与旧客户端一致）。
 * @param {any} root - `/api/menu` 的返回值。
 * @returns {Record<string, { code: string, cn_name: string, en_name: string, challenge: string,
 *   story: string, group: string }>} 展平结果。
 */
export function flattenMenu(root) {
  /** @type {Record<string, any>} */
  const out = {};
  if (root === null || typeof root !== 'object') return out;

  /**
   * @param {any} node - 节点。
   * @param {string} story - 一级分类。
   * @param {string} group - 二级分组名。
   * @returns {void}
   */
  const walk = (node, story, group) => {
    if (node === null || typeof node !== 'object') return;
    const operation = typeof node.operation === 'string' ? node.operation.trim() : '';
    if (operation !== '') {
      if (out[operation] === undefined) {
        out[operation] = {
          code: operation,
          cn_name: typeof node.cn_name === 'string' ? node.cn_name.trim() : '',
          en_name: typeof node.en_name === 'string' ? node.en_name.trim() : '',
          challenge: typeof node.challenge === 'string' ? node.challenge.trim() : '',
          story,
          group,
        };
      }
      return;
    }
    const nextStory = typeof node.story === 'string' && node.story !== '' ? node.story : story;
    const nextGroup = typeof node.episode === 'string' && node.episode !== ''
      ? node.episode
      : (typeof node.name === 'string' && node.name !== '' && nextStory !== '' && story !== nextStory ? node.name : group);
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) walk(child, nextStory, nextGroup);
  };

  for (const top of Array.isArray(root.childNodes) ? root.childNodes : []) {
    const story = typeof top?.story === 'string' ? top.story : '';
    for (const child of Array.isArray(top?.childNodes) ? top.childNodes : []) walk(child, story, '');
  }
  return out;
}

/**
 * 把 `/api/hard-operations` 收成 `code → { minOperators, categories }`。
 * @param {any} raw - 返回值：`[{ name, value: [{ operation, num, ... }] }]`。
 * @returns {Record<string, { minOperators: number, categories: string[] }>} 聚合结果。
 */
export function flattenHardOperations(raw) {
  /** @type {Record<string, { minOperators: number, categories: string[] }>} */
  const out = {};
  if (!Array.isArray(raw)) return out;
  for (const group of raw) {
    const category = typeof group?.name === 'string' ? group.name.trim() : '';
    for (const item of Array.isArray(group?.value) ? group.value : []) {
      const code = typeof item?.operation === 'string' ? item.operation.trim() : '';
      const num = Number.parseInt(String(item?.num ?? ''), 10);
      if (code === '' || !Number.isFinite(num)) continue;
      const existing = out[code];
      if (existing === undefined) out[code] = { minOperators: num, categories: category === '' ? [] : [category] };
      else {
        existing.minOperators = Math.min(existing.minOperators, num);
        if (category !== '' && !existing.categories.includes(category)) existing.categories.push(category);
      }
    }
  }
  return out;
}

/**
 * 造 ArkRec 数据客户端。
 * @param {{ api?: string, timeoutMs?: number, cacheTtlHours?: number, cacheDir?: string,
 *   logger?: { warn?: Function, info?: Function }, fetchImpl?: Function, now?: () => number }} [options]
 *   选项。
 * @returns {object} 客户端：`{ load, loadMenu, loadHardOperations, get, status, api }`。
 */
export function createArkrecData(options = {}) {
  const api = String(options.api ?? DEFAULT_ARKREC_API).replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const ttlMs = ttlMsFromHours(options.cacheTtlHours, 168);
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = options.fetchImpl;
  const cacheDir = typeof options.cacheDir === 'string' ? path.resolve(options.cacheDir) : '';

  const menuCache = createJsonCache({ dir: cacheDir, ttlMs, now, logger, label: 'ArkRec 关卡表' });
  const hardCache = createJsonCache({ dir: cacheDir, ttlMs, now, logger, label: 'ArkRec 少人纪录' });

  /**
   * 拉取关卡树（缓存 → 网络 → 旧缓存）。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<{ data: Record<string, any> | null, fetchedAt: number | null, ageMs: number | null,
   *   stale: boolean, error: unknown }>} 结果；完全不可用 `data:null`。
   */
  const loadMenu = async (input = {}) => {
    const result = await menuCache.remember(MENU_KEY, async () => {
      const raw = await fetchJson(`${api}/api/menu`, { fetchImpl, timeoutMs });
      const stages = flattenMenu(raw);
      if (Object.keys(stages).length === 0) {
        throw new Error('ArkRec 关卡表为空（接口结构可能变了）。');
      }
      logger?.info?.(`[arknights] ArkRec 关卡表已更新：${Object.keys(stages).length} 关。`);
      return stages;
    }, { fresh: input.fresh === true, allowStale: true });
    return { data: result.data, fetchedAt: result.fetchedAt, ageMs: result.ageMs, stale: result.stale, error: result.error };
  };

  /**
   * 拉取少人纪录（缓存 → 网络 → 旧缓存）。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<{ data: Record<string, any> | null, fetchedAt: number | null, ageMs: number | null,
   *   stale: boolean, error: unknown }>} 结果。
   */
  const loadHardOperations = async (input = {}) => {
    const result = await hardCache.remember(HARD_KEY, async () => {
      const raw = await fetchJson(`${api}/api/hard-operations`, { fetchImpl, timeoutMs });
      const table = flattenHardOperations(raw);
      if (Object.keys(table).length === 0) throw new Error('ArkRec 少人纪录为空。');
      return table;
    }, { fresh: input.fresh === true, allowStale: true });
    return { data: result.data, fetchedAt: result.fetchedAt, ageMs: result.ageMs, stale: result.stale, error: result.error };
  };

  /**
   * 一次性取两份数据。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<{ ok: boolean, menu: Record<string, any> | null, hardOperations: Record<string, any> | null,
   *   fetchedAt: number | null, ageMs: number | null, stale: boolean, error: unknown, warnings: string[] }>} 结果。
   */
  const load = async (input = {}) => {
    const [menu, hard] = await Promise.all([loadMenu(input), loadHardOperations(input)]);
    const warnings = [];
    if (menu.data === null) warnings.push('ArkRec 关卡名不可用（网络失败且没有缓存）。');
    if (hard.data === null) warnings.push('ArkRec 少人纪录不可用。');
    return {
      ok: menu.data !== null,
      menu: menu.data,
      hardOperations: hard.data,
      fetchedAt: menu.fetchedAt,
      ageMs: menu.ageMs,
      stale: menu.stale === true || hard.stale === true,
      error: menu.error,
      warnings,
    };
  };

  /**
   * 取某关的 ArkRec 信息（失败返回 null）。
   * @param {string} code - 关卡代码，如 `5-10`、`CW-1`。
   * @returns {Promise<{ cn_name: string, en_name: string, challenge: string, story: string, group: string,
   *   minOperators: number | null, categories: string[], url: string, ageMs: number | null, stale: boolean } | null>} 信息。
   */
  const get = async (code) => {
    const key = String(code ?? '').trim();
    if (key === '') return null;
    const [menu, hard] = await Promise.all([loadMenu(), loadHardOperations()]);
    const base = menu.data?.[key] ?? null;
    const record = hard.data?.[key] ?? null;
    if (base === null && record === null) return null;
    return {
      cn_name: base?.cn_name ?? '',
      en_name: base?.en_name ?? '',
      challenge: base?.challenge ?? '',
      story: base?.story ?? '',
      group: base?.group ?? '',
      minOperators: Number.isFinite(record?.minOperators) ? record.minOperators : null,
      categories: Array.isArray(record?.categories) ? [...record.categories] : [],
      url: `https://wiki.arkrec.com/operation/${encodeURIComponent(key)}`,
      ageMs: menu.ageMs,
      stale: menu.stale === true || hard.stale === true,
    };
  };

  /**
   * 只读缓存元信息（不联网；给状态面板用）。
   * @returns {Promise<{ ok: boolean, ageMs: number | null, entries: number | null }>} 状态。
   */
  const status = async () => {
    const menu = await menuCache.peek(MENU_KEY);
    return {
      ok: menu !== null,
      ageMs: menu?.ageMs ?? null,
      entries: menu !== null && menu.data !== null && typeof menu.data === 'object' ? Object.keys(menu.data).length : null,
    };
  };

  return { load, loadMenu, loadHardOperations, get, status, api, ttlMs };
}

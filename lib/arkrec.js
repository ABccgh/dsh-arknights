/**
 * ArkRec（明日方舟少人WIKI）客户端：关卡中文名、所属章节/活动、突袭条件、少人纪录。
 *
 * 它只提供**可读性与人工参考**，不提供可执行作业；任何失败都必须降级成 `null`，
 * 绝不影响打关卡本身（契约见 docs/contracts.md）。
 *
 * 实测接口（2026-10-28）：
 *   GET {api}/api/menu              → 关卡树（活动/主线/危机合约/剿灭/物资/芯片/悖论…）
 *   GET {api}/api/hard-operations   → 各关少人纪录（最少人数）
 * 单关页面：https://wiki.arkrec.com/operation/<code>
 *
 * @module @local/arknights/arkrec
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** 请求最小间隔（礼貌限速）。 */
const MIN_INTERVAL_MS = 800;
/** 缓存文件名。 */
const CACHE_FILE = 'menu.json';

/**
 * 造一个 ArkRec 客户端。
 * @param {{ api: string, timeoutMs: number, cacheTtlHours: number, cacheDir: string,
 *   logger?: { warn?: Function, info?: Function }, fetchImpl?: Function }} options - 选项。
 * @returns {object} 客户端。
 */
export function createArkrec(options) {
  const api = String(options?.api ?? 'https://wiki.arkrec.com/v1').replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 15000;
  const ttlMs = (Number.isFinite(options?.cacheTtlHours) ? options.cacheTtlHours : 168) * 3600 * 1000;
  const cacheDir = typeof options?.cacheDir === 'string' ? options.cacheDir : '';
  const logger = options?.logger;
  const fetchImpl = typeof options?.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  /** @type {Record<string, any> | null} */
  let stages = null;
  /** @type {Record<string, any> | null} */
  let hardOperations = null;
  let lastRequestAt = 0;

  /**
   * 统一的 GET（带超时 + 限速 + 静默降级）。
   * @param {string} url - 完整 URL。
   * @returns {Promise<any | null>} 解析后的 JSON；失败为 null。
   */
  const getJson = async (url) => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response?.ok) return null;
      return await response.json();
    } catch (error) {
      logger?.warn?.(`[arknights] ArkRec 请求失败（${url}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 把关卡树展平成 `code → 信息`。
   * @param {any} root - `/api/menu` 的返回值。
   * @returns {Record<string, Record<string, any>>} 展平结果。
   */
  const flattenMenu = (root) => {
    /** @type {Record<string, Record<string, any>>} */
    const out = {};
    if (root === null || typeof root !== 'object') return out;

    /**
     * @param {any} node - 节点。
     * @param {string} story - 一级分类（活动关卡/主线关卡/…）。
     * @param {string} group - 二级分组名（章节/活动名）。
     * @returns {void}
     */
    const walk = (node, story, group) => {
      if (node === null || typeof node !== 'object') return;
      const operation = typeof node.operation === 'string' ? node.operation : '';
      if (operation !== '') {
        if (out[operation] === undefined) {
          out[operation] = {
            code: operation,
            cn_name: typeof node.cn_name === 'string' ? node.cn_name : '',
            en_name: typeof node.en_name === 'string' ? node.en_name : '',
            challenge: typeof node.challenge === 'string' ? node.challenge : '',
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
      const children = Array.isArray(node.childNodes) ? node.childNodes : [];
      for (const child of children) walk(child, nextStory, nextGroup);
    };

    for (const top of Array.isArray(root.childNodes) ? root.childNodes : []) {
      const story = typeof top?.story === 'string' ? top.story : '';
      for (const child of Array.isArray(top?.childNodes) ? top.childNodes : []) {
        walk(child, story, '');
      }
    }
    return out;
  };

  /**
   * 读关卡表（磁盘缓存 → 网络 → 旧缓存），结果缓存在内存。
   * @param {{ fresh?: boolean }} [input] - 强制刷新。
   * @returns {Promise<Record<string, Record<string, any>> | null>} 关卡表；完全没有时为 null。
   */
  const loadStages = async (input = {}) => {
    if (stages !== null && input.fresh !== true) return stages;
    if (stages !== null) return stages;

    const file = cacheDir !== '' ? path.join(cacheDir, CACHE_FILE) : '';
    /** @type {{ fetchedAt?: number, stages?: Record<string, any> } | null} */
    let cached = null;
    if (file !== '') {
      try {
        cached = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        cached = null;
      }
    }
    const fresh = input.fresh === true;
    const usable = cached !== null && typeof cached.stages === 'object' && cached.stages !== null
      && (fresh || (Number.isFinite(cached.fetchedAt) && Date.now() - Number(cached.fetchedAt) < ttlMs));
    if (usable) {
      stages = cached.stages;
      return stages;
    }

    const raw = await getJson(`${api}/api/menu`);
    if (raw === null) {
      if (cached !== null && typeof cached.stages === 'object' && cached.stages !== null) {
        stages = cached.stages;
        logger?.warn?.('[arknights] ArkRec 不可用，使用旧缓存。');
        return stages;
      }
      return null;
    }
    const flattened = flattenMenu(raw);
    stages = flattened;
    if (file !== '') {
      try {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(file, `${JSON.stringify({ fetchedAt: Date.now(), stages: flattened })}\n`, 'utf8');
      } catch (error) {
        logger?.warn?.(`[arknights] ArkRec 缓存写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    logger?.info?.(`[arknights] ArkRec 关卡表已更新：${Object.keys(flattened).length} 关`);
    return stages;
  };

  /**
   * 读少人纪录表（内存缓存）。
   * @returns {Promise<Record<string, { minOperators: number, categories: string[] }> | null>} 表。
   */
  const loadHardOperations = async () => {
    if (hardOperations !== null) return hardOperations;
    const raw = await getJson(`${api}/api/hard-operations`);
    if (!Array.isArray(raw)) return null;
    /** @type {Record<string, { minOperators: number, categories: string[] }>} */
    const out = {};
    for (const group of raw) {
      const category = typeof group?.name === 'string' ? group.name : '';
      const values = Array.isArray(group?.value) ? group.value : [];
      for (const item of values) {
        const code = typeof item?.operation === 'string' ? item.operation : '';
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
    hardOperations = out;
    return hardOperations;
  };

  /**
   * 取某关的展示信息（失败一律返回 null）。
   * @param {string} code - 关卡代码。
   * @returns {Promise<{ cn_name: string, en_name: string, challenge: string, story: string, group: string, minOperators: number | null, url: string } | null>} 信息。
   */
  const describe = async (code) => {
    const key = String(code ?? '').trim();
    if (key === '') return null;
    const [table, hard] = await Promise.all([loadStages(), loadHardOperations()]);
    const base = table?.[key] ?? null;
    const record = hard?.[key] ?? null;
    if (base === null && record === null) return null;
    return {
      cn_name: base?.cn_name ?? '',
      en_name: base?.en_name ?? '',
      challenge: base?.challenge ?? '',
      story: base?.story ?? '',
      group: base?.group ?? '',
      minOperators: record?.minOperators ?? null,
      url: `https://wiki.arkrec.com/operation/${encodeURIComponent(key)}`,
    };
  };

  return {
    loadStages,
    loadHardOperations,
    describe,
    flattenMenu,
    /** 预热（不阻塞调用方）：失败也无所谓。 */
    warmup: () => {
      void loadStages().catch(() => {});
      void loadHardOperations().catch(() => {});
    },
  };
}

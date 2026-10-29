/**
 * 企鹅物流（penguin-stats）掉率数据：把 result/matrix 换算成「每件材料的期望理智」。
 *
 * 契约（docs/contracts.md §12）：
 *   GET {api}/PenguinStats/api/v2/result/matrix?server=CN&itemFilter=<itemId>
 *   掉率 = quantity / times；期望理智 = apCost * times / quantity；
 *   只统计「end 为空或已开始（且未结束）」的关卡行。
 *
 * 数据只用于**规划参考**，失败必须降级（旧缓存 → 空结果 + 原因），绝不阻塞打关卡。
 * 本模块只读网络/缓存，不启动 sidecar/模拟器。
 *
 * @module @local/arknights/data/penguin
 */

import path from 'node:path';

import { createJsonCache, fetchJson, ttlMsFromHours } from './cache.js';

/** 默认 API 根。 */
export const DEFAULT_PENGUIN_API = 'https://penguin-stats.cn';
/** 默认服务器。 */
export const DEFAULT_SERVER = 'CN';
/** 「低样本」阈值：次数少于它时在输出里标注（默认 300 次）。 */
export const DEFAULT_LOW_SAMPLE_TIMES = 300;

/**
 * 掉率 = 掉落数量 / 作战次数（`times <= 0` 时返回 null，避免除零）。
 * @param {number} quantity - 掉落数量。
 * @param {number} times - 作战次数。
 * @returns {number | null} 掉率；无有效样本为 null。
 */
export function computeDropRate(quantity, times) {
  if (!Number.isFinite(quantity) || !Number.isFinite(times) || times <= 0 || quantity < 0) return null;
  return quantity / times;
}

/**
 * 期望理智 = 关卡理智 × 次数 / 掉落数量（拿 1 件材料平均要花多少理智）。
 * @param {number | null} apCost - 单次关卡理智。
 * @param {number} times - 作战次数。
 * @param {number} quantity - 掉落数量。
 * @returns {number | null} 期望理智；缺数据为 null。
 */
export function computeExpectedSanity(apCost, times, quantity) {
  if (!Number.isFinite(apCost) || !Number.isFinite(times) || !Number.isFinite(quantity)) return null;
  if (times <= 0 || quantity <= 0) return null;
  return (apCost * times) / quantity;
}

/**
 * 归一材料 id（数字或数字字符串）。
 * @param {unknown} value - 原始值。
 * @returns {string} 材料 id；非法为空串。
 */
export function normalizeItemId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

/**
 * 归一 matrix 的每一行（只保留可计算字段，时间戳保留原样）。
 * @param {any} matrix - 接口返回的 `matrix` 数组。
 * @returns {Array<Record<string, any>>} 归一后的行。
 */
export function normalizeMatrixRows(matrix) {
  const rows = [];
  if (!Array.isArray(matrix)) return rows;
  for (const raw of matrix) {
    if (raw === null || typeof raw !== 'object') continue;
    const stageId = typeof raw.stageId === 'string' ? raw.stageId.trim() : '';
    const itemId = normalizeItemId(raw.itemId);
    if (stageId === '' || itemId === '') continue;
    const times = Number.isFinite(raw.times) ? Number(raw.times) : 0;
    const quantity = Number.isFinite(raw.quantity) ? Number(raw.quantity) : 0;
    rows.push({
      stageId,
      itemId,
      times,
      quantity,
      stdDev: Number.isFinite(raw.stdDev) ? Number(raw.stdDev) : null,
      start: Number.isFinite(raw.start) ? Number(raw.start) : null,
      end: Number.isFinite(raw.end) ? Number(raw.end) : null,
      dropRate: computeDropRate(quantity, times),
    });
  }
  return rows;
}

/**
 * 造企鹅物流数据客户端。
 * @param {{ api?: string, server?: string, timeoutMs?: number, cacheTtlHours?: number,
 *   cacheDir?: string, lowSampleTimes?: number, now?: () => number,
 *   fetchImpl?: Function, logger?: { warn?: Function, info?: Function },
 *   getStage?: (stageId: string) => any | Promise<any> }} [options] - 选项。
 * @returns {object} 客户端：`{ matrix, peek, status, api, server, lowSampleTimes }`。
 */
export function createPenguinData(options = {}) {
  const api = String(options.api ?? DEFAULT_PENGUIN_API).replace(/\/+$/, '');
  const server = String(options.server ?? DEFAULT_SERVER).trim().toUpperCase() || DEFAULT_SERVER;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const ttlMs = ttlMsFromHours(options.cacheTtlHours, 168);
  const lowSampleTimes = Number.isFinite(options.lowSampleTimes) && options.lowSampleTimes >= 0
    ? Number(options.lowSampleTimes)
    : DEFAULT_LOW_SAMPLE_TIMES;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const cacheDir = typeof options.cacheDir === 'string' ? path.resolve(options.cacheDir) : '';
  const getStage = typeof options.getStage === 'function' ? options.getStage : () => null;
  const host = safeHost(api);
  /** 统一的来源标识（展示层会渲染成「企鹅物流」）。 */
  const SOURCE = 'penguin-stats';

  const cache = createJsonCache({ dir: cacheDir, ttlMs, now, logger, label: '企鹅物流掉率' });
  /** 最近一次真正取到数据的时间（状态面板用）。 @type {Map<string, number | null>} */
  const lastFetchedAt = new Map();

  /**
   * 把缓存里的原始行 + 关卡表算成候选关卡。
   * @param {{ server: string, itemId: string, rows: Array<Record<string, any>> } | null} payload - 缓存数据。
   * @param {{ fetchedAt: number | null, ageMs: number | null, stale: boolean }} meta - 缓存元信息。
   * @param {string} itemId - 材料 id。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const compute = async (payload, meta, itemId) => {
    if (payload === null || !Array.isArray(payload.rows)) {
      const failure = meta.error;
      return {
        ok: false,
        itemId,
        server,
        source: SOURCE,
        host,
        fetchedAt: meta.fetchedAt,
        ageMs: meta.ageMs,
        stale: meta.stale === true,
        lowSampleTimes,
        rows: [],
        candidates: [],
        excluded: { notStarted: 0, ended: 0, zeroSample: 0, unknownStage: 0 },
        error: failure ?? null,
        reason: failure !== null && failure !== undefined
          ? `掉率数据不可用：${failure instanceof Error ? failure.message : String(failure)}`
          : '没有可用的掉率缓存。',
      };
    }
    const nowMs = Number(now());
    const rows = [];
    /** @type {Map<string, Record<string, any>>} */
    const byCode = new Map();
    const excluded = { notStarted: 0, ended: 0, zeroSample: 0, unknownStage: 0 };
    for (const raw of payload.rows) {
      const started = raw.start === null || nowMs >= raw.start;
      const ended = raw.end !== null && nowMs > raw.end;
      // 请求时用一个 Stage 查询就够了：同一批行里 stageId 会重复，做一次小缓存。
      const stage = await lookupStage(raw.stageId);
      const row = {
        stageId: raw.stageId,
        itemId: raw.itemId,
        times: raw.times,
        quantity: raw.quantity,
        dropRate: raw.dropRate,
        stdDev: raw.stdDev,
        start: raw.start,
        end: raw.end,
        apCost: stage?.apCost ?? null,
        code: stage?.code ?? null,
        difficulty: stage?.prefix === 'tough_' ? 'tough' : 'easy',
        started,
        ended,
        active: started && !ended,
        lowSample: Number.isFinite(raw.times) && raw.times > 0 && raw.times < lowSampleTimes,
        expectedSanity: null,
      };
      rows.push(row);
      if (!row.active) {
        if (!started) excluded.notStarted += 1;
        else excluded.ended += 1;
        continue;
      }
      if (!(row.times > 0) || !(row.quantity > 0)) {
        excluded.zeroSample += 1;
        continue;
      }
      if (row.apCost === null) {
        excluded.unknownStage += 1;
        continue;
      }
      row.expectedSanity = computeExpectedSanity(row.apCost, row.times, row.quantity);
      const key = row.code ?? row.stageId;
      const existing = byCode.get(key);
      if (existing === undefined || (row.expectedSanity !== null
        && (existing.expectedSanity === null || row.expectedSanity < existing.expectedSanity))) {
        byCode.set(key, row);
      }
    }
    const candidates = [...byCode.values()]
      .filter((row) => row.expectedSanity !== null)
      .sort((a, b) => a.expectedSanity - b.expectedSanity);
    return {
      ok: true,
      itemId,
      server,
      source: SOURCE,
      host,
      fetchedAt: meta.fetchedAt,
      ageMs: meta.ageMs,
      stale: meta.stale === true,
      lowSampleTimes,
      rows,
      candidates,
      excluded,
      error: meta.error ?? null,
      reason: candidates.length === 0 ? '没有可用的掉率样本（样本为 0、关卡未知或已过期）。' : '',
    };
  };

  /** 同一批行里 stageId 会重复，按 stageId 缓存一次查询结果。 */
  let lookupCache = new Map();

  /**
   * 查关卡（带一批内缓存）。
   * @param {string} stageId - 内部关卡 id。
   * @returns {Promise<any | null>} 关卡条目。
   */
  const lookupStage = async (stageId) => {
    if (lookupCache.has(stageId)) return lookupCache.get(stageId);
    let stage = null;
    try {
      stage = await getStage(stageId);
    } catch (error) {
      logger?.warn?.(`[arknights] 企鹅物流行解析时查关卡 ${stageId} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const value = stage ?? null;
    lookupCache.set(stageId, value);
    return value;
  };

  /**
   * 取某材料的掉率矩阵（TTL 缓存 → 网络 → 旧缓存；失败降级成空结果）。
   * @param {string | number} itemInput - 材料 id。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<Record<string, any>>} 结构化结果（`ok:false` 表示数据不可用，不抛异常）。
   */
  const matrix = async (itemInput, input = {}) => {
    const itemId = normalizeItemId(itemInput);
    if (itemId === '') {
      return {
        ok: false,
        itemId: '',
        server,
        source: SOURCE,
        host,
        fetchedAt: null,
        ageMs: null,
        stale: false,
        lowSampleTimes,
        rows: [],
        candidates: [],
        excluded: { notStarted: 0, ended: 0, zeroSample: 0, unknownStage: 0 },
        error: null,
        reason: `材料 id 不合法：${String(itemInput ?? '')}`,
      };
    }
    lookupCache = new Map();
    const url = `${api}/PenguinStats/api/v2/result/matrix?server=${encodeURIComponent(server)}&itemFilter=${encodeURIComponent(itemId)}`;
    const result = await cache.remember(`matrix-${server}-${itemId}`, async () => {
      const body = await fetchJson(url, { fetchImpl, timeoutMs });
      if (body === null || typeof body !== 'object' || !Array.isArray(body.matrix)) {
        throw new Error('企鹅物流接口没有返回 matrix 数组。');
      }
      const rows = normalizeMatrixRows(body.matrix);
      logger?.info?.(`[arknights] 企鹅物流掉率已更新：材料 ${itemId}，${rows.length} 行。`);
      return { server, itemId, rows };
    }, { fresh: input.fresh === true, allowStale: true });
    if (result.data !== null) lastFetchedAt.set(itemId, result.fetchedAt);
    return compute(result.data, result, itemId);
  };

  /**
   * 只读缓存（不联网；给 `kind=item` 与状态面板用）。
   * @param {string | number} itemInput - 材料 id。
   * @returns {Promise<Record<string, any>>} 结构化结果；无缓存时 `ok:false, cached:false`。
   */
  const peek = async (itemInput, input = {}) => {
    const itemId = normalizeItemId(itemInput);
    if (itemId === '') return compute(null, { fetchedAt: null, ageMs: null, stale: false }, '');
    lookupCache = new Map();
    const entry = await cache.peek(`matrix-${server}-${itemId}`);
    if (entry === null) {
      return {
        ok: false,
        itemId,
        server,
        source: SOURCE,
        host,
        fetchedAt: null,
        ageMs: null,
        stale: false,
        lowSampleTimes,
        rows: [],
        candidates: [],
        excluded: { notStarted: 0, ended: 0, zeroSample: 0, unknownStage: 0 },
        error: null,
        reason: '掉率数据未缓存（用 refresh=true 才会联网拉取）。',
        cached: false,
      };
    }
    const result = await compute(entry.data, { fetchedAt: entry.fetchedAt, ageMs: entry.ageMs, stale: false }, itemId);
    return { ...result, cached: true };
  };

  /**
   * 只读状态（不联网）：最近一次拉取时间。
   * @returns {Promise<{ ok: boolean, ageMs: number | null, items: number }>} 状态。
   */
  const status = async () => {
    if (lastFetchedAt.size === 0) return { ok: false, ageMs: null, items: 0 };
    let newest = null;
    for (const value of lastFetchedAt.values()) {
      if (Number.isFinite(value) && (newest === null || value > newest)) newest = value;
    }
    return {
      ok: newest !== null,
      ageMs: newest === null ? null : Math.max(0, Number(now()) - newest),
      items: lastFetchedAt.size,
    };
  };

  return { matrix, peek, status, api, server, lowSampleTimes, ttlMs };
}

/**
 * 从 URL 里取 host（展示用；解析失败返回原串）。
 * @param {string} url - URL。
 * @returns {string} host 或原串。
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? '');
  }
}

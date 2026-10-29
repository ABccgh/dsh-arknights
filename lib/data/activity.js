/**
 * 活动日历：消费 MAA 的 `StageActivityV2.json`（`Official` 客户端）。
 *
 * 契约（docs/contracts.md §12）：StageActivityV2 提供活动/复刻关卡与时间窗；
 * 活动关卡允许不在 `stages.json` 里也能导航（MAA 直接认活动关代码，如 `YW-8`）。
 *
 * 时间字段的坑（MAA 源码注释确认）：`UtcStartTime` / `UtcExpireTime` **写作 UTC、
 * 实际是 `TimeZone` 时区的本地时间**，所以换算 epoch 时要减去 `TimeZone` 小时。
 *
 * 本模块只读网络/缓存（默认 6h TTL），失败降级成空结果 + 原因，不抛裸异常。
 *
 * @module @local/arknights/data/activity
 */

import path from 'node:path';

import { normalizeCode } from '../stages.js';
import { createJsonCache, fetchJson, ttlMsFromHours } from './cache.js';

/** 默认 API（MAA 官方 GUI 数据）。 */
export const DEFAULT_ACTIVITY_API = 'https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json';
/** 默认客户端。 */
export const DEFAULT_ACTIVITY_CLIENT = 'Official';
/** 缓存 key。 */
const CACHE_KEY = 'stage-activity-v2';

/**
 * 把 `YYYY/MM/DD HH:mm:ss` 这类「TimeZone 时区的本地时间」换算成 epoch 毫秒。
 * @param {unknown} text - 原始时间文本。
 * @param {unknown} timeZone - 时区偏移（小时，如 8、-7）。
 * @returns {number | null} epoch 毫秒；无法解析为 null。
 */
export function parseActivityTime(text, timeZone) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(text ?? '').trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const zone = Number.isFinite(timeZone) ? Number(timeZone) : 8;
  const wallClock = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (!Number.isFinite(wallClock)) return null;
  return wallClock - zone * 3600000;
}

/**
 * 归一单条「活动」（sideStory / resourceCollection / miniGame 通用）。
 * @param {{ key?: string, category: string, info: any, stages?: any[] }} input - 原始信息。
 * @param {number} nowMs - 当前时间。
 * @returns {Record<string, any>} 归一后的活动。
 */
export function normalizeActivity(input, nowMs) {
  const info = input.info !== null && typeof input.info === 'object' ? input.info : {};
  const start = parseActivityTime(info.UtcStartTime, info.TimeZone);
  const end = parseActivityTime(info.UtcExpireTime, info.TimeZone);
  const started = start === null || nowMs >= start;
  const expired = end !== null && nowMs > end;
  const active = started && !expired;
  const stages = (Array.isArray(input.stages) ? input.stages : []).map((raw) => {
    const value = typeof raw?.Value === 'string' ? raw.Value.trim() : '';
    const drop = typeof raw?.Drop === 'string' ? raw.Drop.trim() : '';
    return {
      display: typeof raw?.Display === 'string' ? raw.Display.trim() : value,
      value,
      drop,
      itemId: /^\d+$/.test(drop) ? drop : null,
      category: input.category,
      activityKey: typeof input.key === 'string' ? input.key : '',
      activityName: typeof info.StageName === 'string' && info.StageName !== ''
        ? info.StageName
        : (typeof info.Tip === 'string' ? info.Tip : (typeof info.Display === 'string' ? info.Display : '')),
      start,
      end,
      active,
      expired,
    };
  });
  return {
    key: typeof input.key === 'string' ? input.key : (typeof info.Value === 'string' ? info.Value : ''),
    category: input.category,
    name: typeof info.StageName === 'string' && info.StageName !== ''
      ? info.StageName
      : (typeof info.Display === 'string' && info.Display !== ''
        ? info.Display
        : (typeof info.Tip === 'string' ? info.Tip : '')),
    tip: typeof info.Tip === 'string' ? info.Tip : '',
    start,
    end,
    timeZone: Number.isFinite(info.TimeZone) ? Number(info.TimeZone) : null,
    minimumRequired: typeof info.MinimumRequired === 'string' ? info.MinimumRequired : '',
    isResourceCollection: info.IsResourceCollection === true,
    started,
    expired,
    active,
    stages,
  };
}

/**
 * 归一整份 StageActivityV2（取某个客户端）。
 *
 * 结构（实测 2026-10）：
 * ```
 * { Official: { sideStoryStage: { KEY: { Activity: {...}, Stages: [...] } },
 *               resourceCollection: { Tip, UtcStartTime, UtcExpireTime, TimeZone, IsResourceCollection },
 *               miniGame: [{ Display, Value, Tip, UtcStartTime, ... }] } }
 * ```
 * @param {any} root - 接口返回值。
 * @param {{ client?: string, now?: number }} [options] - 选项。
 * @returns {{ client: string, activities: Array<Record<string, any>>, stages: Array<Record<string, any>>,
 *   resourceCollection: Record<string, any> | null, miniGame: Array<Record<string, any>>,
 *   warnings: string[] }} 归一结果。
 */
export function normalizeStageActivity(root, options = {}) {
  const client = typeof options.client === 'string' && options.client !== '' ? options.client : DEFAULT_ACTIVITY_CLIENT;
  const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const warnings = [];
  /** @type {Array<Record<string, any>>} */
  const activities = [];
  /** @type {Array<Record<string, any>>} */
  const stages = [];
  let resourceCollection = null;
  /** @type {Array<Record<string, any>>} */
  const miniGame = [];

  const bucket = root !== null && typeof root === 'object' ? root[client] : null;
  if (bucket === null || typeof bucket !== 'object') {
    return { client, activities, stages, resourceCollection, miniGame, warnings: [`StageActivityV2 里没有 ${client} 客户端。`] };
  }

  // sideStoryStage（含复刻）：key → { Activity, Stages }
  const sideStory = bucket.sideStoryStage;
  if (sideStory !== null && typeof sideStory === 'object' && !Array.isArray(sideStory)) {
    for (const [key, value] of Object.entries(sideStory)) {
      const activity = normalizeActivity({
        key,
        category: 'sideStoryStage',
        info: value?.Activity ?? {},
        stages: value?.Stages ?? [],
      }, nowMs);
      activities.push(activity);
      for (const stage of activity.stages) stages.push(stage);
    }
  }

  // resourceCollection：单条「资源收集全天开放」信息
  if (bucket.resourceCollection !== null && typeof bucket.resourceCollection === 'object') {
    resourceCollection = normalizeActivity({
      key: 'resourceCollection',
      category: 'resourceCollection',
      info: bucket.resourceCollection,
      stages: [],
    }, nowMs);
    activities.push(resourceCollection);
  }

  // miniGame：只有时间窗/入口说明，没有可刷关卡
  if (Array.isArray(bucket.miniGame)) {
    for (const raw of bucket.miniGame) {
      const entry = normalizeActivity({ key: typeof raw?.Value === 'string' ? raw.Value : '', category: 'miniGame', info: raw, stages: [] }, nowMs);
      miniGame.push(entry);
      activities.push(entry);
    }
  }

  // 兜底：将来新增的分类（对象 map 且元素像活动）也尽量收进来
  for (const [key, value] of Object.entries(bucket)) {
    if (['sideStoryStage', 'resourceCollection', 'miniGame'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const raw of value) {
        if (raw === null || typeof raw !== 'object' || raw.UtcStartTime === undefined) continue;
        activities.push(normalizeActivity({ key: typeof raw.Value === 'string' ? raw.Value : key, category: key, info: raw, stages: Array.isArray(raw.Stages) ? raw.Stages : [] }, nowMs));
      }
    } else if (value !== null && typeof value === 'object' && value.UtcStartTime !== undefined) {
      activities.push(normalizeActivity({ key, category: key, info: value, stages: Array.isArray(value.Stages) ? value.Stages : [] }, nowMs));
    }
  }
  if (stages.length === 0 && activities.length === 0) warnings.push(`StageActivityV2 的 ${client} 里没有活动数据。`);
  return { client, activities, stages, resourceCollection, miniGame, warnings };
}

/**
 * 造活动日历客户端。
 * @param {{ api?: string, client?: string, timeoutMs?: number, cacheTtlHours?: number,
 *   cacheFile?: string, cacheDir?: string, now?: () => number, fetchImpl?: Function,
 *   logger?: { warn?: Function, info?: Function } }} [options] - 选项。
 * @returns {object} 客户端：`{ load, lookupStage, stagesForItem, status, api, client }`。
 */
export function createActivityData(options = {}) {
  const api = String(options.api ?? DEFAULT_ACTIVITY_API).trim();
  const client = typeof options.client === 'string' && options.client !== '' ? options.client : DEFAULT_ACTIVITY_CLIENT;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const ttlMs = ttlMsFromHours(options.cacheTtlHours, 6);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const cacheFile = typeof options.cacheFile === 'string' && options.cacheFile !== '' ? path.resolve(options.cacheFile) : '';
  const cacheDir = cacheFile === '' && typeof options.cacheDir === 'string' && options.cacheDir !== ''
    ? path.resolve(options.cacheDir)
    : '';
  const cache = createJsonCache({
    ...(cacheFile !== '' ? { file: cacheFile } : { dir: cacheDir }),
    ttlMs,
    now,
    logger,
    label: '活动日历',
  });

  /** @type {Record<string, any> | null} */
  let memory = null;

  /**
   * 取归一后的活动日历（缓存 → 网络 → 旧缓存）。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<{ ok: boolean, client: string, activities: Array<Record<string, any>>,
   *   stages: Array<Record<string, any>>, resourceCollection: Record<string, any> | null,
   *   miniGame: Array<Record<string, any>>, fetchedAt: number | null, ageMs: number | null,
   *   stale: boolean, source: string, error: unknown, warnings: string[] }>} 结果。
   */
  const load = async (input = {}) => {
    const result = await cache.remember(CACHE_KEY, async () => {
      const raw = await fetchJson(api, { fetchImpl, timeoutMs });
      const normalized = normalizeStageActivity(raw, { client, now: Number(now()) });
      if (normalized.activities.length === 0) throw new Error(`StageActivityV2 里没有 ${client} 的活动。`);
      logger?.info?.(`[arknights] 活动日历已更新：${normalized.activities.length} 条活动、${normalized.stages.length} 个活动关。`);
      return normalized;
    }, { fresh: input.fresh === true, allowStale: true });
    const data = result.data;
    // 过期/开放状态按「现在」重算，避免缓存里的布尔值随时间失真。
    const nowMs = Number(now());
    const activities = Array.isArray(data?.activities) ? data.activities.map((activity) => recomputeWindow(activity, nowMs)) : [];
    const stages = activities.flatMap((activity) => (Array.isArray(activity.stages) ? activity.stages : []));
    const resourceCollection = activities.find((activity) => activity.category === 'resourceCollection') ?? null;
    const miniGame = activities.filter((activity) => activity.category === 'miniGame');
    if (data !== null) memory = { activities, stages };
    return {
      ok: data !== null,
      client,
      activities,
      stages,
      resourceCollection,
      miniGame,
      fetchedAt: result.fetchedAt,
      ageMs: result.ageMs,
      stale: result.stale,
      source: 'MAA StageActivityV2',
      error: result.error,
      warnings: Array.isArray(data?.warnings) ? [...data.warnings] : (result.data === null ? ['活动日历不可用（网络失败且没有缓存）。'] : []),
    };
  };

  /**
   * 按活动关代码查时间窗（大小写/空白不敏感）。
   * @param {string} code - 活动关代码，如 `YW-8`。
   * @returns {Promise<Record<string, any> | null>} 活动关信息。
   */
  const lookupStage = async (code) => {
    const key = normalizeCode(code);
    if (key === '') return null;
    if (memory === null) await load();
    const table = memory?.stages ?? [];
    return table.find((stage) => normalizeCode(stage.value) === key) ?? null;
  };

  /**
   * 正在开放、且 `Drop` 字段是目标材料的活动关。
   * @param {string} itemId - 材料 id。
   * @returns {Promise<Array<Record<string, any>>>} 活动关列表。
   */
  const stagesForItem = async (itemId) => {
    const id = String(itemId ?? '').trim();
    if (id === '') return [];
    if (memory === null) await load();
    return (memory?.stages ?? []).filter((stage) => stage.itemId === id && stage.active === true);
  };

  /**
   * 只读状态（不联网）。
   * @returns {Promise<{ ok: boolean, ageMs: number | null, stages: number | null }>} 状态。
   */
  const status = async () => {
    const entry = await cache.peek(CACHE_KEY);
    return {
      ok: entry !== null,
      ageMs: entry?.ageMs ?? null,
      stages: entry !== null && Array.isArray(entry.data?.stages) ? entry.data.stages.length : null,
    };
  };

  return { load, lookupStage, stagesForItem, status, api, client, ttlMs };
}

/**
 * 按当前时间重算一条活动及其关卡的 open/expired 标记。
 * @param {Record<string, any>} activity - 活动。
 * @param {number} nowMs - 当前 epoch 毫秒。
 * @returns {Record<string, any>} 更新后的副本。
 */
export function recomputeWindow(activity, nowMs) {
  if (activity === null || typeof activity !== 'object') return activity;
  const start = Number.isFinite(activity.start) ? activity.start : null;
  const end = Number.isFinite(activity.end) ? activity.end : null;
  const started = start === null || nowMs >= start;
  const expired = end !== null && nowMs > end;
  const active = started && !expired;
  return {
    ...activity,
    started,
    expired,
    active,
    stages: Array.isArray(activity.stages)
      ? activity.stages.map((stage) => ({ ...stage, started, expired, active }))
      : activity.stages,
  };
}

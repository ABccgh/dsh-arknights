/**
 * 只读数据门面：`ark_data` / `ark_plan` 工具与 `GET /arknights/query` 路由共用。
 *
 * 职责：
 * - 组合 `lib/data/resources.js`（MAA 本地资源）、`arkrec.js`（关卡中文名）、
 *   `penguin.js`（掉率）、`activity.js`（活动日历）、`operators.js`（干员）、
 *   `planner.js`（材料规划）；
 * - 把失败收成结构化结果 + 警告（工具层再渲染成文本），**绝不启动 sidecar/模拟器**；
 * - 缓存目录/网络/时钟都可注入，测试完全离线。
 *
 * 常用装配（lib/index.js 里接线）：
 * ```js
 * const data = createData({
 *   config, paths, logger,
 *   maaPath: async () => (await env.get()).maaPath,
 * });
 * createToolDefinitions(deps).push(...createDataTools({ data }), ...createPlanTools({ data }));
 * ```
 *
 * @module @local/arknights/data/query
 */

import path from 'node:path';

import { arkError } from '../errors.js';
import { normalizeCode, pickDifficulty, resolveStage } from '../stages.js';
import { createActivityData } from './activity.js';
import { createArkrecData } from './arkrec.js';
import { formatAge } from './cache.js';
import { buildOperatorIndex, clampLimit, searchOperators } from './operators.js';
import { createPenguinData } from './penguin.js';
import { createPlanner } from './planner.js';
import { loadResourceBundle } from './resources.js';

/** 单次查询默认返回条数。 */
export const DEFAULT_DATA_LIMIT = 8;
/** 单次查询最大返回条数。 */
export const MAX_DATA_LIMIT = 20;
/** 资源 bundle 进程内复用的时间窗（毫秒）：避免一个规划请求里反复 stat 5 个文件。 */
const RESOURCE_MEMO_MS = 5000;

/**
 * 把 limit 收进 [1, MAX_DATA_LIMIT]。
 * @param {unknown} value - 原始值。
 * @param {number} [fallback] - 回退值。
 * @returns {number} 合法 limit。
 */
export function clampDataLimit(value, fallback = DEFAULT_DATA_LIMIT) {
  const parsed = Number.isFinite(value) ? Math.trunc(Number(value)) : fallback;
  return Math.min(Math.max(parsed, 1), MAX_DATA_LIMIT);
}

/**
 * 把缓存客户端的结果收成统一的来源元信息。
 * @param {{ ok?: boolean, ageMs?: number | null, stale?: boolean, source?: string } | null | undefined} result
 *   客户端结果。
 * @param {string} source - 默认来源名。
 * @returns {{ ok: boolean, ageMs: number | null, stale: boolean, source: string }} 元信息。
 */
export function sourceMeta(result, source) {
  return {
    ok: result?.ok === true,
    ageMs: Number.isFinite(result?.ageMs) ? Number(result?.ageMs) : null,
    stale: result?.stale === true,
    source: typeof result?.source === 'string' && result.source !== '' ? result.source : source,
  };
}

/**
 * 造只读数据门面。
 * @param {{ config?: Record<string, any>, paths?: Record<string, any>,
 *   logger?: { info?: Function, warn?: Function }, fetchImpl?: Function, now?: () => number,
 *   offline?: boolean, maaPath?: string | (() => string | Promise<string>),
 *   resourceBundle?: Record<string, any> | (() => Record<string, any> | Promise<Record<string, any>>),
 *   server?: string }} [options] - 选项。
 * @returns {object} 门面：`{ stage, item, operator, activity, search, drops, plan, status, ensureResources }`。
 */
export function createData(options = {}) {
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
  const paths = options.paths !== null && typeof options.paths === 'object' ? options.paths : {};
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const offline = options.offline === true;
  const server = typeof options.server === 'string' && options.server !== '' ? options.server : 'CN';
  const baseFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const networkFetch = offline
    ? async () => {
      throw arkError('E_DATA_UNAVAILABLE', '离线模式不联网（offline:true）。');
    }
    : baseFetch;

  const arkrecConfig = config.arkrec !== null && typeof config.arkrec === 'object' ? config.arkrec : {};
  const penguinConfig = config.penguin !== null && typeof config.penguin === 'object' ? config.penguin : {};
  const activityConfig = config.activity !== null && typeof config.activity === 'object' ? config.activity : {};
  const arkrecEnabled = arkrecConfig.enabled !== false;
  const penguinEnabled = penguinConfig.enabled !== false;
  const activityEnabled = activityConfig.enabled !== false;

  /**
   * 造路径缓存目录（空串 = 纯内存缓存）。
   * @param {string} key - `paths` 的键。
   * @param {string} fallback - dataCacheDir 下的子目录名。
   * @returns {string} 绝对路径或空串。
   */
  const pathOrEmpty = (key, fallback) => {
    const direct = paths[key];
    if (typeof direct === 'string' && direct.trim() !== '') return path.resolve(direct.trim());
    const base = paths.dataCacheDir;
    if (typeof base === 'string' && base.trim() !== '') return path.join(path.resolve(base.trim()), fallback);
    return '';
  };

  // —— MAA 资源：路径可注入，bundle 按 mtime 缓存，再加 5s 进程内复用 ——
  const injectedBundle = options.resourceBundle ?? null;
  const configuredMaaPath = typeof config.maaPath === 'string' ? config.maaPath.trim() : '';
  const maaPathProvider = (() => {
    if (typeof options.maaPath === 'function') return options.maaPath;
    if (typeof options.maaPath === 'string' && options.maaPath.trim() !== '') return () => options.maaPath;
    if (configuredMaaPath !== '') return () => configuredMaaPath;
    return () => '';
  })();
  let memo = { at: Number.NEGATIVE_INFINITY, bundle: null };
  /**
   * 进程内「最近一次看到的数据」快照，给状态面板的同步 `meta()` 用（不读盘不联网）。
   * @type {{ resources: { stages: number | null, items: number | null, operators: number | null, warnings: string[] },
   *   arkrec: { ok: boolean, fetchedAt: number | null }, activity: { ok: boolean, fetchedAt: number | null },
   *   penguin: { ok: boolean, fetchedAt: number | null } }}
   */
  const tracked = {
    resources: { stages: null, items: null, operators: null, warnings: [] },
    arkrec: { ok: false, fetchedAt: null },
    activity: { ok: false, fetchedAt: null },
    penguin: { ok: false, fetchedAt: null },
  };

  /**
   * 记一次数据源结果（fetchedAt 优先用结果里的，其次由 ageMs 反推）。
   * @param {'arkrec' | 'activity' | 'penguin'} key - 数据源。
   * @param {{ ok?: boolean, fetchedAt?: number | null, ageMs?: number | null } | null | undefined} result
   *   结果。
   * @returns {void}
   */
  const trackSource = (key, result) => {
    if (result === null || result === undefined) return;
    const fetchedAt = Number.isFinite(result.fetchedAt)
      ? Number(result.fetchedAt)
      : (Number.isFinite(result.ageMs) ? Number(now()) - Number(result.ageMs) : null);
    tracked[key] = { ok: result.ok === true, fetchedAt };
  };

  /**
   * 取 MAA 资源 bundle。
   * @param {{ fresh?: boolean }} [input] - 是否强制按 mtime 重读。
   * @returns {Promise<Record<string, any>>} bundle。
   * @throws {import('../errors.js').ArkError} 读不到关卡表时。
   */
  const ensureResources = async (input = {}) => {
    if (typeof injectedBundle === 'function') return await injectedBundle();
    if (injectedBundle !== null && typeof injectedBundle === 'object' && typeof injectedBundle.stageByCode === 'function') {
      return injectedBundle;
    }
    const fresh = input.fresh === true;
    const timestamp = Number(now());
    if (!fresh && memo.bundle !== null && timestamp - memo.at < RESOURCE_MEMO_MS) return memo.bundle;
    const maaPath = await maaPathProvider();
    const bundle = await loadResourceBundle(maaPath, { fresh, logger });
    memo = { at: Number(now()), bundle };
    tracked.resources = {
      stages: bundle.stages.length,
      items: bundle.items.length,
      operators: bundle.operators.length,
      warnings: [...(bundle.warnings ?? [])],
    };
    return bundle;
  };

  // —— 在线数据客户端（全部失败降级）——
  const arkrec = arkrecEnabled
    ? createArkrecData({
      api: arkrecConfig.api,
      timeoutMs: arkrecConfig.timeoutMs,
      cacheTtlHours: arkrecConfig.cacheTtlHours,
      cacheDir: pathOrEmpty('arkrecCacheDir', 'arkrec'),
      logger,
      fetchImpl: networkFetch,
      now,
    })
    : null;
  const penguin = penguinEnabled
    ? createPenguinData({
      api: penguinConfig.api,
      server,
      timeoutMs: penguinConfig.timeoutMs,
      cacheTtlHours: penguinConfig.cacheTtlHours,
      cacheDir: pathOrEmpty('penguinCacheDir', 'penguin'),
      lowSampleTimes: penguinConfig.lowSampleTimes,
      getStage: async (stageId) => (await ensureResources()).stageById(stageId),
      logger,
      fetchImpl: networkFetch,
      now,
    })
    : null;
  const activity = activityEnabled
    ? createActivityData({
      api: activityConfig.api,
      timeoutMs: activityConfig.timeoutMs,
      cacheTtlHours: activityConfig.cacheTtlHours,
      cacheFile: typeof paths.activityCacheFile === 'string' && paths.activityCacheFile !== '' ? paths.activityCacheFile : '',
      cacheDir: pathOrEmpty('dataCacheDir', ''),
      logger,
      fetchImpl: networkFetch,
      now,
    })
    : null;

  /**
   * 取活动日历（失败降级成空结果）。
   * @param {{ refresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<Record<string, any>>} 活动日历结果。
   */
  const loadActivity = async (input = {}) => {
    if (activity === null) {
      tracked.activity = { ok: false, fetchedAt: null };
      return {
        ok: false,
        client: 'Official',
        activities: [],
        stages: [],
        resourceCollection: null,
        miniGame: [],
        fetchedAt: null,
        ageMs: null,
        stale: false,
        source: 'MAA StageActivityV2',
        error: null,
        warnings: ['活动日历已在配置里关闭（activity.enabled=false）。'],
      };
    }
    const result = await activity.load({ fresh: input.refresh === true });
    trackSource('activity', result);
    return result;
  };

  /**
   * 取 ArkRec 信息（失败返回 null，不抛）。
   * @param {string} code - 关卡代码。
   * @returns {Promise<Record<string, any> | null>} 信息。
   */
  const arkrecInfo = async (code) => {
    if (arkrec === null) return null;
    try {
      const info = await arkrec.get(code);
      trackSource('arkrec', info === null ? { ok: false, fetchedAt: null } : {
        ok: true,
        ageMs: Number.isFinite(info.ageMs) ? info.ageMs : null,
      });
      return info;
    } catch {
      return null;
    }
  };

  /**
   * 取 ArkRec 关卡树（失败返回 null）。
   * @param {{ fresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<Record<string, any> | null>} `code → info`。
   */
  const arkrecMenu = async (input = {}) => {
    if (arkrec === null) return null;
    try {
      const result = await arkrec.loadMenu({ fresh: input.fresh === true });
      trackSource('arkrec', {
        ok: result.data !== null,
        fetchedAt: result.fetchedAt,
        ageMs: result.ageMs,
      });
      return result.data;
    } catch {
      return null;
    }
  };

  /**
   * 企鹅物流：取某材料掉率（失败降级成 `ok:false` 结果）。
   * @param {string} itemId - 材料 id。
   * @param {{ refresh?: boolean }} [input] - 是否强制刷新。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const loadDrops = async (itemId, input = {}) => {
    if (penguin === null) {
      tracked.penguin = { ok: false, fetchedAt: null };
      return {
        ok: false,
        itemId: String(itemId ?? ''),
        candidates: [],
        rows: [],
        source: 'penguin-stats',
        fetchedAt: null,
        ageMs: null,
        stale: false,
        reason: '企鹅物流已在配置里关闭（penguin.enabled=false）。',
        excluded: { notStarted: 0, ended: 0, zeroSample: 0, unknownStage: 0 },
      };
    }
    const result = await penguin.matrix(itemId, { fresh: input.refresh === true });
    trackSource('penguin', result);
    return result;
  };

  /**
   * 从材料表解析材料（id / 中文名 / 唯一包含）。
   * @param {Record<string, any>} bundle - 资源 bundle。
   * @param {unknown} input - 用户输入。
   * @returns {Record<string, any>} 材料。
   * @throws {import('../errors.js').ArkError} 找不到或歧义时。
   */
  const resolveItem = (bundle, input) => {
    const text = String(input ?? '').trim();
    if (text === '') throw arkError('E_BAD_ARGS', '没有给材料名或材料 id。', { hint: '示例：q=固源岩 或 q=30012。' });
    const item = bundle.itemById(text) ?? bundle.itemByName(text);
    if (item !== null) return item;
    const lower = text.toLowerCase();
    const matches = bundle.items.filter((entry) => entry.name.toLowerCase().includes(lower));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw arkError('E_BAD_ARGS', `材料「${text}」有多个匹配，请写完整名字或材料 id。`, {
        detail: matches.slice(0, 8).map((entry) => `${entry.name}(${entry.itemId})`).join('、'),
      });
    }
    throw arkError('E_BAD_ARGS', `材料表里没有「${text}」。`, {
      hint: '用 ark_data(kind=search, q=…) 查材料名，或直接传材料 id（如 30012）。',
    });
  };

  /**
   * 把一个关卡组收成对外结构。
   * @param {Record<string, any>} bundle - 资源 bundle。
   * @param {string} code - 关卡代码。
   * @param {Array<Record<string, any>>} entries - 同代码的难度条目。
   * @param {Record<string, any> | null} arkrecStage - ArkRec 信息。
   * @param {Record<string, any> | null} activityStage - 活动关信息。
   * @returns {Record<string, any>} 对外结构。
   */
  const makeStageView = (bundle, code, entries, arkrecStage, activityStage) => {
    const pick = entries.length > 0 ? pickDifficulty(entries, 'auto') : null;
    const itemIds = [];
    for (const entry of entries) {
      for (const itemId of entry.dropItems) {
        // 家具不是材料，不进掉落列表（与 lib/stages.js#describeDrops 语义一致）。
        if (itemId === 'furni') continue;
        if (!itemIds.includes(itemId)) itemIds.push(itemId);
      }
    }
    if (activityStage !== null && typeof activityStage.itemId === 'string' && activityStage.itemId !== ''
      && !itemIds.includes(activityStage.itemId)) {
      itemIds.push(activityStage.itemId);
    }
    return {
      code,
      displayName: arkrecStage !== null && typeof arkrecStage.cn_name === 'string' && arkrecStage.cn_name !== ''
        ? `${code} ${arkrecStage.cn_name}`
        : code,
      apCost: pick?.apCost ?? entries.find((entry) => Number.isFinite(entry.apCost))?.apCost ?? null,
      internalIds: entries.map((entry) => ({
        stageId: entry.stageId,
        difficulty: entry.prefix === 'tough_' ? 'tough' : 'easy',
        apCost: entry.apCost,
      })),
      drops: itemIds.slice(0, 12).map((itemId) => ({ itemId, name: bundle.itemNames[itemId] ?? '' })),
      arkrec: arkrecStage,
      activity: activityStage === null
        ? null
        : {
          name: activityStage.activityName ?? '',
          value: activityStage.value,
          start: activityStage.start,
          end: activityStage.end,
          active: activityStage.active === true,
          expired: activityStage.expired === true,
          itemId: activityStage.itemId ?? null,
        },
      source: 'MAA resource',
    };
  };

  /**
   * 取活动关里与代码匹配的一条。
   * @param {Record<string, any>} activityResult - 活动日历结果。
   * @param {string} code - 关卡代码。
   * @returns {Record<string, any> | null} 活动关。
   */
  const findActivityStage = (activityResult, code) => {
    const key = normalizeCode(code);
    if (key === '') return null;
    return (Array.isArray(activityResult?.stages) ? activityResult.stages : [])
      .find((stage) => normalizeCode(stage.value) === key) ?? null;
  };

  // —— 对外方法 ——

  /**
   * `kind=stage`：按代码/内部 id 查关卡，或列出正在开放的活动关。
   * @param {unknown} [input] - 关卡代码/内部 id；空串时列出活动关。
   * @param {{ limit?: number }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const stageQuery = async (input = '', opts = {}) => {
    const bundle = await ensureResources();
    const query = String(input ?? '').trim();
    const limit = clampDataLimit(opts.limit);
    const [activityResult, arkrecResult] = await Promise.all([loadActivity(), query === '' ? Promise.resolve(null) : arkrecMenu()]);
    const sources = {
      maa: { ok: true, ageMs: 0, stale: false, source: 'MAA resource' },
      arkrec: { ok: arkrecResult !== null, ageMs: null, stale: false, source: 'ArkRec' },
      activity: sourceMeta(activityResult, 'MAA StageActivityV2'),
    };

    if (query === '') {
      const activeStages = (Array.isArray(activityResult.stages) ? activityResult.stages : [])
        .filter((entry) => entry.active === true)
        .slice(0, limit);
      return {
        ok: true,
        kind: 'stage',
        query,
        matches: activeStages.map((stage) => ({
          code: stage.value,
          displayName: stage.activityName !== '' ? `${stage.value}（${stage.activityName}）` : stage.value,
          apCost: null,
          internalIds: [],
          drops: stage.itemId === null ? [] : [{ itemId: stage.itemId, name: bundle.itemNames[stage.itemId] ?? '' }],
          arkrec: null,
          activity: {
            name: stage.activityName ?? '',
            value: stage.value,
            start: stage.start,
            end: stage.end,
            active: stage.active === true,
            expired: stage.expired === true,
            itemId: stage.itemId ?? null,
          },
          source: 'MAA StageActivityV2',
        })),
        note: '没有给 q：上面是正在开放的活动关；用 q=关卡代码（如 5-10、CE-6、main_05-10）精确定位。',
        sources,
        cache: { activity: { ageMs: activityResult.ageMs, stale: activityResult.stale } },
      };
    }

    let resolveError = null;
    /** @type {{ code: string, entries: Array<Record<string, any>> } | null} */
    let resolved = null;
    try {
      const value = resolveStage(bundle.stages, query);
      resolved = { code: value.code, entries: value.entries };
    } catch (error) {
      resolveError = error;
    }

    const activityStage = findActivityStage(activityResult, resolved?.code ?? query);
    if (resolved === null && activityStage === null) {
      throw resolveError ?? arkError('E_STAGE_UNKNOWN', `关卡代码「${query}」不在 MAA 的关卡表里。`);
    }

    const code = resolved?.code ?? activityStage?.value ?? query;
    const entries = resolved?.entries ?? [];
    const arkrecStage = await arkrecInfo(code);
    const match = resolved !== null
      ? makeStageView(bundle, code, entries, arkrecStage, activityStage)
      : {
        ...makeStageView(bundle, code, [], arkrecStage, activityStage),
        displayName: activityStage?.activityName !== '' && activityStage !== null
          ? `${code}（${activityStage.activityName}）`
          : code,
      };
    if (arkrecStage !== null && match.arkrec === null) match.arkrec = arkrecStage;
    return {
      ok: true,
      kind: 'stage',
      query,
      code,
      matches: [match],
      note: '',
      sources: {
        ...sources,
        arkrec: {
          ok: arkrecStage !== null,
          ageMs: Number.isFinite(arkrecStage?.ageMs) ? arkrecStage.ageMs : null,
          stale: arkrecStage?.stale === true,
          source: 'ArkRec',
        },
      },
      cache: {
        arkrec: { ageMs: arkrecStage?.ageMs ?? null, stale: arkrecStage?.stale === true },
        activity: { ageMs: activityResult.ageMs, stale: activityResult.stale },
      },
    };
  };

  /**
   * `kind=item`：查材料（常驻掉落关、活动掉落、掉率/期望理智）。
   * @param {unknown} input - 材料名或 id。
   * @param {{ limit?: number, refresh?: boolean }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const itemQuery = async (input = '', opts = {}) => {
    const bundle = await ensureResources();
    const item = resolveItem(bundle, input);
    const limit = clampDataLimit(opts.limit);
    const [activityResult, drops] = await Promise.all([
      loadActivity(),
      loadDrops(item.itemId, { refresh: opts.refresh === true }),
    ]);
    /** @type {Array<Record<string, any>>} */
    const permanentStages = [];
    for (const entry of bundle.stages) {
      const drop = entry.dropInfos.find((value) => value.itemId === item.itemId);
      if (drop === undefined) continue;
      permanentStages.push({
        code: entry.code,
        stageId: entry.stageId,
        difficulty: entry.prefix === 'tough_' ? 'tough' : 'easy',
        apCost: entry.apCost,
        dropType: drop.dropType,
      });
    }
    permanentStages.sort((a, b) => {
      const left = Number.isFinite(a.apCost) ? a.apCost : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.apCost) ? b.apCost : Number.POSITIVE_INFINITY;
      return left - right;
    });
    const activityStages = (Array.isArray(activityResult.stages) ? activityResult.stages : [])
      .filter((entry) => entry.itemId === item.itemId)
      .map((entry) => ({
        code: entry.value,
        activityName: entry.activityName ?? '',
        start: entry.start,
        end: entry.end,
        active: entry.active === true,
        expired: entry.expired === true,
      }));
    return {
      ok: true,
      kind: 'item',
      query: String(input ?? ''),
      item: {
        itemId: item.itemId,
        name: item.name,
        classifyType: item.classifyType,
        usage: item.usage,
        description: item.description,
        icon: item.icon,
      },
      permanentStages: permanentStages.slice(0, limit),
      permanentStageCount: permanentStages.length,
      activityStages: activityStages.slice(0, limit),
      drops: {
        ok: drops.ok === true,
        source: drops.source ?? 'penguin-stats',
        fetchedAt: drops.fetchedAt ?? null,
        ageMs: drops.ageMs ?? null,
        stale: drops.stale === true,
        lowSampleTimes: drops.lowSampleTimes ?? null,
        candidates: (drops.candidates ?? []).slice(0, limit),
        reason: drops.reason ?? '',
        excluded: drops.excluded ?? {},
      },
      sources: {
        maa: { ok: true, ageMs: 0, stale: false, source: 'MAA resource' },
        penguin: sourceMeta(drops, 'penguin-stats'),
        activity: sourceMeta(activityResult, 'MAA StageActivityV2'),
      },
    };
  };

  /**
   * `kind=operator`：查公开招募干员（id/名字/标签/星级）。
   * @param {unknown} input - 查询词；空串按稀有度列出。
   * @param {{ limit?: number }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const operatorQuery = async (input = '', opts = {}) => {
    const bundle = await ensureResources();
    const index = bundle.operatorIndex ?? buildOperatorIndex({ operators: bundle.operators });
    const limit = clampDataLimit(opts.limit);
    const query = String(input ?? '').trim();
    const matches = searchOperators(index, query, { limit });
    return {
      ok: true,
      kind: 'operator',
      query,
      total: index.total ?? bundle.operators.length,
      matches: matches.map((operator) => ({
        id: operator.id,
        name: operator.name,
        rarity: operator.rarity,
        tags: operator.tags,
      })),
      note: query === '' ? '没有给 q：按稀有度从高到低列出干员；可用名字、ID、标签搜索。' : '',
      sources: { maa: { ok: true, ageMs: 0, stale: false, source: 'MAA recruitment.json' } },
    };
  };

  /**
   * `kind=activity`：活动/复刻关卡与时间窗。
   * @param {{ refresh?: boolean }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const activityQuery = async (opts = {}) => {
    const result = await loadActivity({ refresh: opts.refresh === true });
    return {
      ok: result.ok === true,
      kind: 'activity',
      client: result.client,
      activities: result.activities,
      resourceCollection: result.resourceCollection,
      miniGame: result.miniGame,
      stages: result.stages,
      fetchedAt: result.fetchedAt,
      ageMs: result.ageMs,
      stale: result.stale,
      error: result.error,
      warnings: result.warnings,
      sources: { activity: sourceMeta(result, 'MAA StageActivityV2') },
    };
  };

  /**
   * `kind=search`：跨关卡/材料/干员/活动搜索。
   * @param {unknown} input - 查询词。
   * @param {{ limit?: number, refresh?: boolean }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const searchQuery = async (input = '', opts = {}) => {
    const query = String(input ?? '').trim();
    if (query === '') throw arkError('E_BAD_ARGS', '搜索需要 q。', { hint: '示例：q=固源岩、q=CE、q=能天使、q=活动。' });
    const bundle = await ensureResources();
    const limit = clampDataLimit(opts.limit);
    const [menu, activityResult] = await Promise.all([arkrecMenu(), loadActivity()]);
    const lower = query.toLowerCase();
    const normalized = normalizeCode(query);

    /** @type {Array<Record<string, any>>} */
    const stages = [];
    const seenCodes = new Set();
    const addStage = (code, extra = {}) => {
      const key = normalizeCode(code);
      if (key === '' || seenCodes.has(key)) return;
      seenCodes.add(key);
      stages.push({
        code,
        displayName: typeof extra.cn_name === 'string' && extra.cn_name !== '' ? `${code} ${extra.cn_name}` : code,
        apCost: Number.isFinite(extra.apCost) ? extra.apCost : null,
        source: extra.source ?? 'MAA resource',
      });
    };
    // 1) ArkRec 中文名/代码优先（更好读）
    if (menu !== null && typeof menu === 'object') {
      for (const [code, info] of Object.entries(menu)) {
        if (stages.length >= limit * 2) break;
        const cnName = typeof info?.cn_name === 'string' ? info.cn_name : '';
        if (String(code).toLowerCase().includes(lower) || cnName.toLowerCase().includes(lower)) {
          const entries = bundle.stageByCode(code);
          addStage(code, { cn_name: cnName, apCost: entries.length > 0 ? pickDifficulty(entries, 'auto').apCost : null, source: 'ArkRec' });
        }
      }
    }
    // 2) MAA 关卡代码
    for (const entry of bundle.stages) {
      if (stages.length >= limit * 2) break;
      if (entry.code.toLowerCase().includes(lower) || (normalized !== '' && normalizeCode(entry.code).includes(normalized))) {
        addStage(entry.code, { apCost: entry.apCost });
      }
    }
    // 3) 活动关代码
    for (const entry of Array.isArray(activityResult.stages) ? activityResult.stages : []) {
      if (String(entry.value).toLowerCase().includes(lower)) {
        addStage(entry.value, { cn_name: entry.activityName ?? '', source: 'MAA StageActivityV2' });
      }
    }

    const items = bundle.items
      .filter((item) => item.name.toLowerCase().includes(lower) || item.itemId.includes(lower))
      .slice(0, limit)
      .map((item) => ({ itemId: item.itemId, name: item.name, classifyType: item.classifyType }));
    const operators = searchOperators(bundle.operatorIndex ?? buildOperatorIndex({ operators: bundle.operators }), query, { limit })
      .map((operator) => ({ id: operator.id, name: operator.name, rarity: operator.rarity, tags: operator.tags }));
    const activities = (Array.isArray(activityResult.activities) ? activityResult.activities : [])
      .filter((entry) => `${entry.name}${entry.tip}`.toLowerCase().includes(lower))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        category: entry.category,
        start: entry.start,
        end: entry.end,
        active: entry.active === true,
        expired: entry.expired === true,
        stages: (entry.stages ?? []).slice(0, limit).map((stage) => stage.value),
      }));

    return {
      ok: true,
      kind: 'search',
      query,
      stages: stages.slice(0, limit),
      items,
      operators,
      activities,
      sources: {
        maa: { ok: true, ageMs: 0, stale: false, source: 'MAA resource' },
        arkrec: { ok: menu !== null, ageMs: null, stale: false, source: 'ArkRec' },
        activity: sourceMeta(activityResult, 'MAA StageActivityV2'),
      },
    };
  };

  /**
   * `drops`：某材料的掉率候选（不要求材料在规划里用得上）。
   * @param {unknown} input - 材料名或 id。
   * @param {{ refresh?: boolean, limit?: number }} [opts] - 选项。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const dropsQuery = async (input = '', opts = {}) => {
    const bundle = await ensureResources();
    const item = resolveItem(bundle, input);
    const limit = clampDataLimit(opts.limit);
    const drops = await loadDrops(item.itemId, { refresh: opts.refresh === true });
    return {
      ok: drops.ok === true,
      kind: 'drops',
      item: { itemId: item.itemId, name: item.name },
      server: drops.server ?? server,
      source: drops.source ?? 'penguin-stats',
      fetchedAt: drops.fetchedAt ?? null,
      ageMs: drops.ageMs ?? null,
      stale: drops.stale === true,
      lowSampleTimes: drops.lowSampleTimes ?? null,
      candidates: (drops.candidates ?? []).slice(0, limit),
      reason: drops.reason ?? '',
      excluded: drops.excluded ?? {},
      sources: { penguin: sourceMeta(drops, 'penguin-stats') },
    };
  };

  /**
   * `plan`：材料规划（期望理智升序、最多 3 个候选、合并去重）。
   * @param {{ targets?: unknown, preferEvent?: boolean, exclude?: unknown, refresh?: boolean }} [input]
   *   输入。
   * @returns {Promise<Record<string, any>>} 结构化结果。
   */
  const planQuery = async (input = {}) => {
    const bundle = await ensureResources();
    const planner = createPlanner({
      resources: bundle,
      getDrops: (itemId) => loadDrops(itemId, { refresh: input.refresh === true }),
      getActivity: () => loadActivity({ refresh: input.refresh === true }),
      now,
      maxCandidates: 3,
      lowSampleTimes: penguin?.lowSampleTimes ?? null,
    });
    const result = await planner.plan({
      targets: input.targets,
      preferEvent: input.preferEvent === true,
      exclude: input.exclude,
    });
    return {
      ...result,
      kind: 'plan',
      lowSampleTimes: penguin?.lowSampleTimes ?? null,
      sources: {
        ...result.sources,
        penguin: {
          ...result.sources.penguin,
          source: 'penguin-stats',
        },
        activity: {
          ...result.sources.activity,
          source: 'MAA StageActivityV2',
        },
        maa: { ok: true, ageMs: 0, stale: false, source: 'MAA resource' },
      },
    };
  };

  /**
   * 只读状态（面板 `data` 字段用；绝不联网、绝不启动 sidecar/模拟器）。
   * @returns {Promise<Record<string, any>>} 状态。
   */
  const status = async () => {
    /** @type {Record<string, any>} */
    const out = { ok: true, stages: null, items: null, operators: null, version: null, warnings: [] };
    try {
      const bundle = await ensureResources();
      out.stages = bundle.stages.length;
      out.items = bundle.items.length;
      out.operators = bundle.operators.length;
      out.version = bundle.version;
      out.warnings = [...(bundle.warnings ?? [])];
    } catch (error) {
      out.ok = false;
      out.warnings.push(`MAA 资源不可用：${error instanceof Error ? error.message : String(error)}`);
    }
    const [arkrecStatus, activityStatus, penguinStatus] = await Promise.all([
      arkrec !== null ? arkrec.status() : Promise.resolve({ ok: false, ageMs: null }),
      activity !== null ? activity.status() : Promise.resolve({ ok: false, ageMs: null }),
      penguin !== null ? penguin.status() : Promise.resolve({ ok: false, ageMs: null }),
    ]);
    return {
      ...out,
      arkrec: { ok: arkrecStatus.ok, ageMs: arkrecStatus.ageMs, source: 'ArkRec' },
      activity: { ok: activityStatus.ok, ageMs: activityStatus.ageMs, source: 'MAA StageActivityV2' },
      penguin: { ok: penguinStatus.ok, ageMs: penguinStatus.ageMs, source: 'penguin-stats' },
    };
  };

  /**
   * 同步的只读数据快照（状态面板 `data` 字段用；不读盘、不联网、不启动 sidecar/模拟器）。
   * @returns {Record<string, any>} 快照：`{ok, stages, items, operators, arkrec, penguin, activity, warnings}`。
   */
  const meta = () => {
    const ageOf = (entry) => (Number.isFinite(entry?.fetchedAt)
      ? Math.max(0, Number(now()) - Number(entry.fetchedAt))
      : null);
    return {
      ok: tracked.resources.stages !== null,
      stages: tracked.resources.stages,
      items: tracked.resources.items,
      operators: tracked.resources.operators,
      arkrec: { ok: tracked.arkrec.ok, ageMs: ageOf(tracked.arkrec) },
      penguin: { ok: tracked.penguin.ok, ageMs: ageOf(tracked.penguin) },
      activity: { ok: tracked.activity.ok, ageMs: ageOf(tracked.activity) },
      warnings: [...tracked.resources.warnings],
    };
  };

  return {
    stage: stageQuery,
    item: itemQuery,
    operator: operatorQuery,
    activity: activityQuery,
    search: searchQuery,
    drops: dropsQuery,
    plan: planQuery,
    status,
    meta,
    ensureResources,
    /** 把 ageMs 渲染成中文（工具层共用）。 */
    formatAge,
  };
}

/**
 * `infrast` 动作：基建换班（MAA `Infrast` 任务链）。
 *
 * 契约要点（docs/contracts.md §9/§10）：
 * - **需要 confirm**；
 * - 不消耗理智/源石/招聘许可；无人机（`drones`）会把基建无人机库存用掉，属于
 *   游戏内资源但不是稀缺货币，所以不过资源安全闸（计划里写明）；
 * - 事件 `EnterFacility` / `ProductOfFacility` / `NotEnoughStaff` 用于汇总换班结果。
 *
 * @module @local/arknights/actions/infrast
 */

import { arkError } from '../errors.js';
import { planResult, runAction } from './shared.js';

/** 动作超时（30 分钟；工具层同值）。 */
export const INFRAST_TIMEOUT_MS = 30 * 60 * 1000;

/** MAA 允许的设施名（集成文档 `Infrast.facility`）。 */
export const INFRAST_FACILITIES = [
  'Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Recycle', 'Dorm', 'Processing', 'Training', 'AssistantChange',
];

/** 默认设施：契约 §10 与用户日常习惯一致的 7 个。 */
export const DEFAULT_FACILITIES = ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'];

/** 无人机用途（MAA `drones` 枚举）。 */
export const INFRAST_DRONES = ['_NotUse', 'Money', 'SyntheticJade', 'CombatRecord', 'PureGold', 'OriginStone', 'Chip'];

/** 换班模式。 */
export const INFRAST_MODES = [0, 10000, 20000];

/**
 * 取对象。
 * @param {unknown} value - 原始值。
 * @returns {Record<string, any>} 对象。
 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 取整数，非法回退。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 回退值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 取数字，非法回退。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 回退值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 数字。
 */
function numberIn(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * 取字符串，否则空串。
 * @param {unknown} value - 原始值。
 * @returns {string} 字符串。
 */
function textOr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 换班模式文案。
 * @param {number} mode - 模式。
 * @returns {string} 文案。
 */
export function infraModeLabel(mode) {
  if (mode === 10000) return '自定义换班（Custom）';
  if (mode === 20000) return '一键轮换（Rotation）';
  return '默认换班（Default）';
}

/**
 * 生效超时：`config.daily.infrast.timeoutMs` 可覆盖。
 * @param {Record<string, any>} config - 生效配置。
 * @returns {number} 毫秒。
 */
function infrastTimeout(config) {
  return intIn(asObject(config?.daily?.infrast).timeoutMs, INFRAST_TIMEOUT_MS, 10000, 4 * 60 * 60 * 1000);
}

/**
 * 把动作参数与 `config.daily.infrast` 合成 MAA 参数。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {{ mode: number, facility: string[], drones: string, threshold: number,
 *   filename: string|null, planIndex: number|null, maa: Record<string, any> }} 组装结果。
 * @throws {ArkError} 参数不合法时 `E_BAD_ARGS`。
 */
export function resolveInfrastParams(config, params = {}) {
  const configured = asObject(config?.daily?.infrast);
  const merged = { ...configured, ...params };
  const explicitMode = merged?.mode !== undefined && merged?.mode !== null && merged?.mode !== '';
  let mode = intIn(merged?.mode, 0, 0, 20000);
  if (!INFRAST_MODES.includes(mode)) {
    throw arkError('E_BAD_ARGS', `mode=${String(merged?.mode)} 不支持；只能是 0（默认）、10000（自定义）或 20000（一键轮换）。`, {
      hint: '用 mode=0 跑默认换班；自定义排班用 mode=10000 + customFile；一键轮换用 20000。',
    });
  }
  const filename = textOr(merged?.customFile);
  const planIndexRaw = merged?.planIndex;
  const planIndex = planIndexRaw === undefined || planIndexRaw === null || planIndexRaw === ''
    ? null
    : intIn(planIndexRaw, 0, 0, 1000);
  if (!explicitMode && (filename !== '' || planIndex !== null)) mode = 10000;
  if (explicitMode && mode !== 10000 && (filename !== '' || planIndex !== null)) {
    throw arkError('E_BAD_ARGS', 'customFile/planIndex 只在 mode=10000（自定义换班）时生效。', {
      hint: '要么去掉 customFile/planIndex，要么改 mode=10000。',
    });
  }
  if (mode === 10000 && filename === '') {
    throw arkError('E_BAD_ARGS', '自定义换班（mode=10000）需要 customFile 指定排班文件。', {
      hint: 'customFile 是 MAA 基建排班 JSON 的路径（相对 MAA userDir 或绝对路径）。',
    });
  }
  const facilityRaw = Array.isArray(merged?.facility) ? merged.facility : [];
  /** @type {string[]} */
  const facility = [];
  for (const item of facilityRaw) {
    const name = textOr(item);
    if (name === '') continue;
    if (!INFRAST_FACILITIES.includes(name)) {
      throw arkError('E_BAD_ARGS', `设施名「${name}」不认识。`, {
        hint: `可用设施：${INFRAST_FACILITIES.join(' / ')}。`,
      });
    }
    if (!facility.includes(name)) facility.push(name);
  }
  // 默认换班/一键轮换没给设施时用默认集合；自定义换班以排班文件为准。
  const effectiveFacility = facility.length > 0 ? facility : (mode === 10000 ? [] : [...DEFAULT_FACILITIES]);
  const dronesRaw = textOr(merged?.drones);
  const drones = dronesRaw === '' ? '_NotUse' : dronesRaw;
  if (!INFRAST_DRONES.includes(drones)) {
    throw arkError('E_BAD_ARGS', `drones=${drones} 不支持。`, { hint: `可用：${INFRAST_DRONES.join(' / ')}。` });
  }
  const threshold = numberIn(merged?.threshold, 0.3, 0, 1);

  /** @type {Record<string, any>} */
  const maa = { enable: true, mode, threshold };
  if (effectiveFacility.length > 0) maa.facility = effectiveFacility;
  if (mode !== 10000) maa.drones = drones;
  if (mode === 10000) {
    maa.filename = filename;
    if (planIndex !== null) maa.plan_index = planIndex;
  }
  return {
    mode,
    facility: effectiveFacility,
    drones,
    threshold,
    filename: filename === '' ? null : filename,
    planIndex,
    maa,
  };
}

/**
 * 取最近事件序号；状态对象缺失时返回 0。
 * @param {any} state - 状态容器。
 * @returns {number} 序号。
 */
function lastSeq(state) {
  return typeof state?.getLastSeq === 'function' ? state.getLastSeq() : 0;
}

/**
 * 取 `seq` 之后的事件（带 MAA `details`）。
 * @param {any} state - 状态容器。
 * @param {number} seq - 起点序号。
 * @returns {Array<Record<string, any>>} 事件。
 */
function eventsSince(state, seq) {
  const recent = typeof state?.recentEvents === 'function' ? state.recentEvents(500, { withDetails: true }) : [];
  return recent.filter((event) => (Number.isFinite(event?.seq) ? event.seq > seq : true));
}

/**
 * 取事件里的整数。
 * @param {unknown} value - 原始值。
 * @returns {number|null} 整数或 null。
 */
function intOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 解析基建事件（`EnterFacility` / `ProductOfFacility` / `NotEnoughStaff` 及自定义排班提示）。
 * @param {Array<Record<string, any>>} events - 本次任务链之后的事件。
 * @returns {{ entered: Array<Record<string, any>>, products: Array<Record<string, any>>,
 *   productSummary: Record<string, number>, notEnoughStaff: Array<Record<string, any>>,
 *   keptUnchanged: Array<Record<string, any>>, notes: string[] }} 解析结果。
 */
export function parseInfrastEvents(events = []) {
  const entered = [];
  const products = [];
  const productSummary = {};
  const notEnoughStaff = [];
  const keptUnchanged = [];
  const notes = [];
  for (const event of events) {
    const what = typeof event?.what === 'string' ? event.what : '';
    const details = asObject(event?.details);
    if (what === 'EnterFacility') {
      entered.push({ facility: textOr(details.facility), index: intOrNull(details.index) });
      continue;
    }
    if (what === 'ProductOfFacility') {
      const product = textOr(details.product);
      products.push({ facility: textOr(details.facility), index: intOrNull(details.index), product });
      if (product !== '') productSummary[product] = (productSummary[product] ?? 0) + 1;
      continue;
    }
    if (what === 'NotEnoughStaff') {
      notEnoughStaff.push({ facility: textOr(details.facility), index: intOrNull(details.index) });
      continue;
    }
    if (what === 'CustomInfrastRoomKeptUnchanged' || what === 'CustomInfrastRoomsNotConfigured') {
      keptUnchanged.push({
        facility: textOr(details.facility),
        index: intOrNull(details.index),
        ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
      });
      continue;
    }
    if (what === 'CustomInfrastTraineeNotFound' || what === 'CustomInfrastAssistantNotFound'
      || what === 'CustomInfrastRoomGroupsMatchFailed') {
      notes.push(`${what}${typeof details.facility === 'string' ? `@${details.facility}` : ''}`);
    }
  }
  return { entered, products, productSummary, notEnoughStaff, keptUnchanged, notes };
}

/**
 * 收成便于排障的事件摘要。
 * @param {Array<Record<string, any>>} events - 事件。
 * @param {number} [limit] - 最多几条。
 * @returns {Array<Record<string, any>>} 摘要。
 */
function summarizeEvents(events, limit = 10) {
  return events.slice(-limit).map((event) => ({
    seq: event?.seq ?? null,
    name: typeof event?.name === 'string' ? event.name : '',
    ...(typeof event?.what === 'string' ? { what: event.what } : {}),
  }));
}

/**
 * 跑一条 MAA 任务链并把「超时/被停」翻译成动作错误。
 * @param {Record<string, any>} deps - 依赖。
 * @param {string} type - MAA 任务类型。
 * @param {Record<string, any>} params - MAA 参数。
 * @param {number} timeoutMs - 超时毫秒。
 * @returns {Promise<Record<string, any>>} 结果。
 */
async function runChain(deps, type, params, timeoutMs) {
  const outcome = await deps.runtime.runTaskChain({ type, params, timeoutMs });
  const waited = outcome?.waited ?? {};
  if (waited.aborted !== null && waited.aborted !== undefined) {
    throw arkError('E_ABORTED', `MAA ${type} 任务被停止。`, { hint: '停止是用户动作；需要时重新发起。' });
  }
  if (waited.timedOut === true) {
    throw arkError('E_TIMEOUT', `MAA ${type} 任务超过 ${Math.round(timeoutMs / 1000)}s 没有结束。`, {
      hint: '确认游戏画面没有卡在弹窗/公告上；必要时先 ark_stop 再重试。',
    });
  }
  return outcome;
}

/**
 * 把设施列表渲染成一行。
 * @param {Array<Record<string, any>>} list - 设施列表。
 * @returns {string} 文本。
 */
function formatFacilities(list) {
  return list
    .map((item) => `${item.facility === '' ? '?' : item.facility}${item.index === null ? '' : `#${item.index}`}`)
    .join('、');
}

/**
 * 执行 `infrast`（不经过 runAction；daily 直接复用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {Promise<{ text: string, result: Record<string, any>, status?: 'completed'|'partial' }>} 结果。
 */
export async function runInfrast(deps, params = {}) {
  const { config, state } = deps;
  const resolved = resolveInfrastParams(config, params);
  const startSeq = lastSeq(state);
  const outcome = await runChain(deps, 'Infrast', resolved.maa, infrastTimeout(config));
  const events = eventsSince(state, startSeq);
  const parsed = parseInfrastEvents(events);
  const chainError = events.some((event) => event?.name === 'TaskChainError' || event?.code === 10000);
  const failed = chainError || (Array.isArray(outcome?.chains) && outcome.chains.some((chain) => chain?.status === 'error'));
  const partial = failed || parsed.notEnoughStaff.length > 0;
  const detail = {
    mode: resolved.mode,
    modeLabel: infraModeLabel(resolved.mode),
    facility: resolved.facility,
    drones: resolved.mode === 10000 ? null : resolved.drones,
    threshold: resolved.threshold,
    ...(resolved.filename === null ? {} : { filename: resolved.filename, planIndex: resolved.planIndex }),
    entered: parsed.entered,
    products: parsed.products,
    productSummary: parsed.productSummary,
    notEnoughStaff: parsed.notEnoughStaff,
    keptUnchanged: parsed.keptUnchanged,
    ...(parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
    events: summarizeEvents(events),
  };
  const lines = [`基建换班完成（${infraModeLabel(resolved.mode)}）。`];
  lines.push(`设施：${resolved.facility.join('/')}。`);
  if (parsed.entered.length > 0) lines.push(`进入设施：${parsed.entered.length} 个（${formatFacilities(parsed.entered)}）。`);
  if (parsed.products.length > 0) {
    const summary = Object.entries(parsed.productSummary).map(([name, count]) => `${name}×${count}`).join('、');
    lines.push(`产物：${parsed.products.length} 条（${summary}）。`);
  }
  if (parsed.notEnoughStaff.length > 0) {
    lines.push(`干员不足：${parsed.notEnoughStaff.length} 处（${formatFacilities(parsed.notEnoughStaff)}）；这些设施的换班没有完成。`);
  }
  if (parsed.keptUnchanged.length > 0) lines.push(`按自定义排班保持原样：${parsed.keptUnchanged.length} 个房间。`);
  if (resolved.mode !== 10000 && resolved.drones !== '_NotUse') lines.push(`无人机用途：${resolved.drones}。`);
  if (failed) lines.push('任务链报错（可能停在某个弹窗），以上是已回传的部分结果。');
  if (parsed.entered.length === 0 && parsed.products.length === 0 && !failed) {
    lines.push('没有回传设施/产物事件：可能队列里没有需要换班的设施，或 MAA 提前结束。');
  }
  return {
    text: lines.join('\n'),
    result: { infrast: detail },
    ...(partial ? { status: 'partial' } : {}),
  };
}

/**
 * 造 `infrast` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createInfrastAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function infrast(params = {}) {
    return runAction({
      config,
      store,
      kind: 'infrast',
      params,
      plan: () => {
        const resolved = resolveInfrastParams(config, params);
        const plannedItems = [{
          task: 'infrast',
          mode: resolved.mode,
          facility: resolved.facility,
          note: infraModeLabel(resolved.mode),
          consumes: resolved.drones === '_NotUse' ? 'none' : 'drone',
        }];
        const lines = [
          `基建换班计划（${infraModeLabel(resolved.mode)}，需要 confirm=true）：`,
          `- 设施：${resolved.facility.length > 0 ? resolved.facility.join(' / ') : '（按排班文件）'}`,
          `- 心情阈值：${resolved.threshold}`,
        ];
        if (resolved.mode === 10000) {
          lines.push(`- 排班文件：${resolved.filename}${resolved.planIndex === null ? '' : `（方案 ${resolved.planIndex}）`}`);
        } else {
          lines.push(`- 无人机：${resolved.drones === '_NotUse' ? '不使用' : resolved.drones}`);
        }
        lines.push('消耗：不消耗理智/源石/招聘许可；指定无人机时会用掉基建无人机库存。');
        return {
          ...planResult({ kind: 'infrast', text: lines.join('\n'), planned: plannedItems }),
          plannedItems,
        };
      },
      execute: async (run) => {
        await deps.runtime.ensureReady({
          startup: true,
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        return runInfrast(deps, params);
      },
    });
  };
}

/**
 * `box` 动作：识别仓库与干员 box 并写入本地快照（MAA `Depot` / `OperBox` 任务链）。
 *
 * 契约要点（docs/contracts.md §7.2/§9/§10）：
 * - **不需要 confirm**：只读游戏界面，不消耗任何资源；
 * - target=`both|operbox|depot`；每个目标独立跑一条 MAA 任务链；
 * - 必须等到 `OperBoxInfo` / `DepotInfo` 的 `done=true` 才算完整识别，否则
 *   `E_BOX_TIMEOUT`（不拿半成品覆盖完整快照，契约 §7.2）；
 * - 识别结果交给 `deps.box.saveOperBox/saveDepot` 落盘（接口由 kernel 的 lib/box.js 提供）。
 *
 * @module @local/arknights/actions/box
 */

import { arkError, normalizeError } from '../errors.js';
import { planResult, runAction } from './shared.js';

/** 动作超时（40 分钟；工具层同值）。 */
export const BOX_TIMEOUT_MS = 40 * 60 * 1000;
/** 单条任务链的默认超时（20 分钟）。 */
const TARGET_TIMEOUT_MS = 20 * 60 * 1000;

/** 允许的 target。 */
export const BOX_TARGETS = ['both', 'operbox', 'depot'];

/**
 * 取对象。
 * @param {unknown} value - 原始值。
 * @returns {Record<string, any>} 对象。
 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 取整数或 null。
 * @param {unknown} value - 原始值。
 * @returns {number|null} 整数或 null。
 */
function intOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
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
 * 取目标超时：`config.box.<operboxTimeoutMs|depotTimeoutMs>`。
 * @param {Record<string, any>} config - 生效配置。
 * @param {'operbox'|'depot'} target - 目标。
 * @returns {number} 毫秒。
 */
function targetTimeout(config, target) {
  const fallback = TARGET_TIMEOUT_MS;
  const raw = target === 'operbox' ? config?.box?.operboxTimeoutMs : config?.box?.depotTimeoutMs;
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/**
 * 找最后一条 `done=true` 的目标事件。
 * @param {Array<Record<string, any>>} events - 事件。
 * @param {string} what - `OperBoxInfo` / `DepotInfo`。
 * @returns {Record<string, any>|null} `details`；没有完整结果时为 null。
 */
function finalDoneDetails(events, what) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.what !== what) continue;
    const details = asObject(event?.details);
    if (details.done === true) return details;
  }
  return null;
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
 * 把 `OperBoxInfo` 的 details 归一成契约 §7.2 的 operators 形状。
 * @param {Record<string, any>} details - `done=true` 的 details。
 * @returns {{ all: Array<Record<string, any>>, own: Array<Record<string, any>> }} 干员快照。
 */
export function normalizeOperBox(details) {
  const all = [];
  for (const raw of Array.isArray(details?.all_opers) ? details.all_opers : []) {
    const oper = asObject(raw);
    const id = textOr(oper.id);
    if (id === '') continue;
    all.push({
      id,
      name: textOr(oper.name),
      rarity: intOrNull(oper.rarity),
      own: oper.own === true,
    });
  }
  const own = [];
  for (const raw of Array.isArray(details?.own_opers) ? details.own_opers : []) {
    const oper = asObject(raw);
    const id = textOr(oper.id);
    if (id === '') continue;
    own.push({
      id,
      name: textOr(oper.name),
      elite: intOrNull(oper.elite),
      level: intOrNull(oper.level),
      potential: intOrNull(oper.potential),
      rarity: intOrNull(oper.rarity),
    });
  }
  return { all, own };
}

/**
 * 解析 `DepotInfo.data`（JSON 字符串 `{"itemId":count,...}` 或已是对象）。
 * @param {unknown} raw - `details.data`。
 * @returns {{ items: Record<string, number>, corrupted: boolean }} 解析结果。
 */
export function parseDepotData(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { items: {}, corrupted: true };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { items: {}, corrupted: false };
  /** @type {Record<string, number>} */
  const items = {};
  for (const [key, countRaw] of Object.entries(value)) {
    const count = intOrNull(countRaw);
    if (count === null) continue;
    items[String(key)] = count;
  }
  return { items, corrupted: false };
}

/**
 * 尽力解析物品名（data 层没交付时返回空串；box.js 收到 itemNames 会自行补名）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {string} id - 物品 id。
 * @returns {string} 名称；解析不到为空串。
 */
function resolveItemName(deps, id) {
  const direct = deps?.itemNames;
  if (direct !== null && typeof direct === 'object') {
    const value = direct[id];
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object' && typeof value.name === 'string') return value.name;
  }
  const data = deps?.data;
  if (data !== null && typeof data === 'object') {
    try {
      if (typeof data.item === 'function') {
        const value = data.item(id);
        if (typeof value === 'string') return value;
        if (value !== null && typeof value === 'object' && typeof value.name === 'string') return value.name;
      }
      if (typeof data.itemName === 'function') {
        const value = data.itemName(id);
        if (typeof value === 'string') return value;
      }
    } catch {
      // 数据层不可用就留空名，不影响识别结果落盘。
    }
  }
  return '';
}

/**
 * 异步解析物品名：兼容 data.item(id) 返回 Promise/`{item:{name}}`/`{name}` 的几种形状。
 * @param {Record<string, any>} deps - 依赖。
 * @param {string} id - 物品 id。
 * @returns {Promise<string>} 名称；解析不到为空串。
 */
async function resolveItemNameAsync(deps, id) {
  const sync = resolveItemName(deps, id);
  if (sync !== '') return sync;
  const data = deps?.data;
  if (data === null || typeof data !== 'object') return '';
  // 优先用 MAA 资源 bundle 的 itemNames（一次读取、无网络），避免对 81 个物品逐个查 data.item。
  if (typeof data.ensureResources === 'function') {
    try {
      const bundle = await data.ensureResources();
      const name = bundle?.itemNames?.[id];
      if (typeof name === 'string' && name !== '') return name;
    } catch {
      // 资源不可用再退回 data.item。
    }
  }
  if (typeof data.item !== 'function') return '';
  try {
    const value = await data.item(id);
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      if (value.item !== null && typeof value.item === 'object' && typeof value.item.name === 'string') return value.item.name;
      if (typeof value.name === 'string') return value.name;
    }
  } catch {
    // 数据层不可用就留空名。
  }
  return '';
}

/**
 * 异步版：把 `DepotInfo.data` 归一成契约 §7.2 的 depot 形状（含异步补的物品名）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} details - `done=true` 的 details。
 * @returns {Promise<{ depot: { items: Record<string, { name: string, count: number }> }, corrupted: boolean }>} 快照。
 */
export async function normalizeDepotAsync(deps, details) {
  const parsed = parseDepotData(details?.data);
  /** @type {Record<string, { name: string, count: number }>} */
  const items = {};
  for (const [id, count] of Object.entries(parsed.items)) {
    items[id] = { name: await resolveItemNameAsync(deps, id), count };
  }
  return { depot: { items }, corrupted: parsed.corrupted };
}

/**
 * 把 `DepotInfo.data` 归一成契约 §7.2 的 depot 形状（同步版，测试用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} details - `done=true` 的 details。
 * @returns {{ depot: { items: Record<string, { name: string, count: number }> }, corrupted: boolean }} 快照。
 */
export function normalizeDepot(deps, details) {
  const parsed = parseDepotData(details?.data);
  /** @type {Record<string, { name: string, count: number }>} */
  const items = {};
  for (const [id, count] of Object.entries(parsed.items)) {
    items[id] = { name: resolveItemName(deps, id), count };
  }
  return { depot: { items }, corrupted: parsed.corrupted };
}

/**
 * 跑一次 OperBox 识别并落盘。
 * @param {Record<string, any>} deps - 依赖。
 * @returns {Promise<{ operators: { total: number, own: number }, events: Array<Record<string, any>> }>} 结果。
 */
async function recognizeOperBox(deps) {
  const { config, state } = deps;
  const startSeq = lastSeq(state);
  const timeoutMs = targetTimeout(config, 'operbox');
  await runChain(deps, 'OperBox', { enable: true }, timeoutMs);
  const events = eventsSince(state, startSeq);
  const details = finalDoneDetails(events, 'OperBoxInfo');
  if (details === null) {
    throw arkError('E_BOX_TIMEOUT', `干员识别在 ${Math.round(timeoutMs / 1000)}s 内没有回传完整结果（OperBoxInfo done=true）。`, {
      hint: '确认游戏在前台、没有停在公告/弹窗上；重试 target=operbox，或先手动打开一次干员列表。',
      data: { target: 'operbox', events: summarizeEvents(events) },
    });
  }
  if (typeof deps.box?.saveOperBox !== 'function') {
    throw arkError('E_UNDEFINED', '干员识别完成，但 box 存储不可用（没有 saveOperBox）。', {
      hint: '这是插件装配问题：确认 lib/box.js 已交付并在 deps 里注入。',
    });
  }
  const operators = normalizeOperBox(details);
  await deps.box.saveOperBox(operators, { partial: false });
  return {
    operators: { total: operators.all.length, own: operators.own.length },
    events,
  };
}

/**
 * 跑一次 Depot 识别并落盘。
 * @param {Record<string, any>} deps - 依赖。
 * @returns {Promise<{ depot: { types: number, total: number }, events: Array<Record<string, any>> }>} 结果。
 */
async function recognizeDepot(deps) {
  const { config, state } = deps;
  const startSeq = lastSeq(state);
  const timeoutMs = targetTimeout(config, 'depot');
  await runChain(deps, 'Depot', { enable: true }, timeoutMs);
  const events = eventsSince(state, startSeq);
  const details = finalDoneDetails(events, 'DepotInfo');
  if (details === null) {
    throw arkError('E_BOX_TIMEOUT', `仓库识别在 ${Math.round(timeoutMs / 1000)}s 内没有回传完整结果（DepotInfo done=true）。`, {
      hint: '确认游戏在前台、没有停在公告/弹窗上；重试 target=depot，或先手动打开一次仓库。',
      data: { target: 'depot', events: summarizeEvents(events) },
    });
  }
  if (typeof deps.box?.saveDepot !== 'function') {
    throw arkError('E_UNDEFINED', '仓库识别完成，但 box 存储不可用（没有 saveDepot）。', {
      hint: '这是插件装配问题：确认 lib/box.js 已交付并在 deps 里注入。',
    });
  }
  const normalized = await normalizeDepotAsync(deps, details);
  const items = normalized.depot.items;
  const itemNames = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.name !== '') itemNames[id] = item.name;
  }
  await deps.box.saveDepot(normalized.depot, {
    partial: false,
    ...(Object.keys(itemNames).length === 0 ? {} : { itemNames }),
  });
  let total = 0;
  for (const item of Object.values(items)) total += item.count;
  return {
    depot: { types: Object.keys(items).length, total, corrupted: normalized.corrupted },
    events,
  };
}

/**
 * 读 box 快照摘要（拿 updatedAt/partial）。
 * @param {Record<string, any>} deps - 依赖。
 * @returns {{ operators: number, depotItems: number, updatedAt: string|null, partial: boolean }} 摘要。
 */
function readSummary(deps) {
  try {
    if (typeof deps.box?.summary === 'function') {
      const summary = asObject(deps.box.summary());
      return {
        operators: Number.isFinite(summary.operators) ? summary.operators : 0,
        depotItems: Number.isFinite(summary.depotItems) ? summary.depotItems : 0,
        updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : null,
        partial: summary.partial === true,
      };
    }
  } catch {
    // 摘要读不到不影响识别结果本身。
  }
  return { operators: 0, depotItems: 0, updatedAt: null, partial: false };
}

/**
 * 把 target 归一。
 * @param {unknown} target - 原始值。
 * @returns {'both'|'operbox'|'depot'} 目标。
 * @throws {ArkError} 非法 target `E_BAD_ARGS`。
 */
export function resolveBoxTarget(target) {
  const text = textOr(target);
  if (text === '') return 'both';
  if (!BOX_TARGETS.includes(text)) {
    throw arkError('E_BAD_ARGS', `target=${text} 不支持；只能是 both / operbox / depot。`);
  }
  return /** @type {'both'|'operbox'|'depot'} */ (text);
}

/**
 * 执行 `box`（不经过 runAction；daily 直接复用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {Promise<{ text: string, result: Record<string, any>, status?: 'completed'|'partial' }>} 结果。
 */
export async function runBox(deps, params = {}) {
  const target = resolveBoxTarget(params?.target);
  const requested = target === 'both' ? ['operbox', 'depot'] : [target];
  /** @type {Record<string, any>|null} */
  let operators = null;
  /** @type {Record<string, any>|null} */
  let depot = null;
  /** @type {Record<string, { code: string, message: string, hint?: string }>} */
  const errors = {};

  for (const one of requested) {
    try {
      if (one === 'operbox') {
        const recognized = await recognizeOperBox(deps);
        operators = recognized.operators;
      } else {
        const recognized = await recognizeDepot(deps);
        depot = recognized.depot;
      }
    } catch (error) {
      const normalized = normalizeError(error);
      errors[one] = {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.hint ? { hint: normalized.hint } : {}),
      };
    }
  }

  if (Object.keys(errors).length === requested.length) {
    const first = errors[requested[0]];
    throw arkError(first.code, first.message, { ...(first.hint ? { hint: first.hint } : {}), data: { target, errors } });
  }

  const summary = readSummary(deps);
  const partial = Object.keys(errors).length > 0;
  const detail = {
    target,
    operators,
    depot,
    updatedAt: summary.updatedAt ?? new Date().toISOString(),
    partial,
    ...(partial ? { errors } : {}),
  };
  const lines = [];
  if (operators !== null) lines.push(`干员识别完成：共 ${operators.total} 名，拥有 ${operators.own} 名。`);
  if (depot !== null) {
    lines.push(`仓库识别完成：${depot.types} 种物品，合计 ${depot.total} 个${depot.corrupted ? '（仓库数据解析失败，按空处理）' : ''}。`);
  }
  if (partial) {
    for (const [name, error] of Object.entries(errors)) lines.push(`${name === 'operbox' ? '干员' : '仓库'}识别失败：${error.code} ${error.message}`);
    lines.push('部分识别结果已保存；失败的项没有覆盖已有完整快照。');
  } else {
    lines.push('已写入本地快照。');
  }
  return {
    text: lines.join('\n'),
    result: { box: detail },
    ...(partial ? { status: 'partial' } : {}),
  };
}

/**
 * 造 `box` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/session/state/runtime/box/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createBoxAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function box(params = {}) {
    return runAction({
      config,
      store,
      kind: 'box',
      params,
      plan: () => {
        const target = resolveBoxTarget(params?.target);
        const labels = target === 'both' ? ['干员 box', '仓库'] : [target === 'operbox' ? '干员 box' : '仓库'];
        const plannedItems = labels.map((label) => ({ task: 'box', note: label, consumes: 'none' }));
        return {
          ...planResult({
            kind: 'box',
            text: [
              `识别计划（不需要 confirm，不消耗资源）：${labels.join(' + ')}`,
              '每个目标跑一条 MAA 任务链，等 done=true 的完整结果后写入本地快照；超时不会拿半成品覆盖已有快照。',
              `超时：干员 ${Math.round((config?.box?.operboxTimeoutMs ?? TARGET_TIMEOUT_MS) / 60000)} 分钟，仓库 ${Math.round((config?.box?.depotTimeoutMs ?? TARGET_TIMEOUT_MS) / 60000)} 分钟。`,
            ].join('\n'),
            planned: plannedItems,
          }),
          plannedItems,
        };
      },
      execute: async (run) => {
        await deps.runtime.ensureReady({
          startup: true,
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        return runBox(deps, params);
      },
    });
  };
}

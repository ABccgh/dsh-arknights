/**
 * `mall` 动作：领取信用点并逛信用商店（MAA `Mall` 任务链）。
 *
 * 契约要点（docs/contracts.md §9/§10）：
 * - **需要 confirm**（mall 属于需要确认的动作）；
 * - 消耗的是游戏内信用点，不是理智/源石/招聘许可，所以不过资源安全闸；
 * - MAA 不回传「买了什么、信用怎么变」的明细，`result.mall` 只给开关快照，
 *   文案里如实写「识别不到明细」。
 *
 * @module @local/arknights/actions/mall
 */

import { planResult, runAction } from './shared.js';

/** 动作超时（30 分钟；工具层同值）。 */
export const MALL_TIMEOUT_MS = 30 * 60 * 1000;

/** 开关键 → MAA 字段 → 默认值。 */
const SWITCH_SPECS = [
  { key: 'visitFriends', maa: 'visit_friends', fallback: true, label: '访问好友基建' },
  { key: 'shopping', maa: 'shopping', fallback: true, label: '信用商店购物' },
  { key: 'onlyDiscount', maa: 'only_buy_discount', fallback: false, label: '只买折扣商品' },
  { key: 'forceWhenFull', maa: 'force_shopping_if_credit_full', fallback: false, label: '信用溢出时无视黑名单' },
  { key: 'reserveMaxCredit', maa: 'reserve_max_credit', fallback: false, label: '信用低于 300 时停止购买' },
];

/**
 * 取对象。
 * @param {unknown} value - 原始值。
 * @returns {Record<string, any>} 对象。
 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 取布尔值，否则回退。
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 回退值。
 * @returns {boolean} 布尔值。
 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
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
 * 取去重后的字符串数组（每项非空，带长度上限）。
 * @param {unknown} value - 原始值。
 * @param {number} [limit] - 最多几项。
 * @returns {string[]} 字符串数组。
 */
function stringList(value, limit = 30) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text === '' || out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 生效超时：`config.daily.mall.timeoutMs` 可覆盖。
 * @param {Record<string, any>} config - 生效配置。
 * @returns {number} 毫秒。
 */
function mallTimeout(config) {
  return intIn(asObject(config?.daily?.mall).timeoutMs, MALL_TIMEOUT_MS, 10000, 4 * 60 * 60 * 1000);
}

/**
 * 把动作参数与 `config.daily.mall` 合成 MAA 参数。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {{ flags: Record<string, boolean>, buyFirst: string[], blacklist: string[], maa: Record<string, any> }} 组装结果。
 */
export function resolveMallParams(config, params = {}) {
  const configured = asObject(config?.daily?.mall);
  const merged = { ...configured, ...params };
  /** @type {Record<string, boolean>} */
  const flags = {};
  /** @type {Record<string, any>} */
  const maa = { enable: true };
  for (const spec of SWITCH_SPECS) {
    const value = boolOr(merged?.[spec.key], spec.fallback);
    flags[spec.key] = value;
    maa[spec.maa] = value;
  }
  const buyFirst = stringList(merged?.buyFirst);
  const blacklist = stringList(merged?.blacklist);
  maa.buy_first = buyFirst;
  maa.blacklist = blacklist;
  return { flags, buyFirst, blacklist, maa };
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
 * 执行 `mall`（不经过 runAction；daily 直接复用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {Promise<{ text: string, result: Record<string, any>, status?: 'completed'|'partial' }>} 结果。
 */
export async function runMall(deps, params = {}) {
  const { config, state } = deps;
  const resolved = resolveMallParams(config, params);
  const startSeq = lastSeq(state);
  const outcome = await runChain(deps, 'Mall', resolved.maa, mallTimeout(config));
  const events = eventsSince(state, startSeq);
  const chainError = events.some((event) => event?.name === 'TaskChainError' || event?.code === 10000);
  const failed = chainError || (Array.isArray(outcome?.chains) && outcome.chains.some((chain) => chain?.status === 'error'));
  const labels = SWITCH_SPECS.filter((spec) => resolved.flags[spec.key]).map((spec) => spec.label);
  const detail = {
    flags: resolved.flags,
    buyFirst: resolved.buyFirst,
    blacklist: resolved.blacklist,
    labels,
    detailsAvailable: false,
    note: '识别不到明细：MAA 不回传购买清单与信用变化（没有对应事件），只能确认任务链是否跑完。',
    events: summarizeEvents(events),
  };
  const lines = [
    failed
      ? '信用领取/购物任务链报错（可能停在某个弹窗），识别不到明细。'
      : '信用领取与购物任务链已完成。',
    `开关：${labels.join('、')}。`,
  ];
  if (resolved.buyFirst.length > 0) lines.push(`优先购买：${resolved.buyFirst.join('、')}。`);
  if (resolved.blacklist.length > 0) lines.push(`黑名单：${resolved.blacklist.join('、')}。`);
  lines.push('识别不到明细：MAA 不回传具体购买清单与信用变化。');
  return {
    text: lines.join('\n'),
    result: { mall: detail },
    ...(failed ? { status: 'partial' } : {}),
  };
}

/**
 * 造 `mall` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createMallAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function mall(params = {}) {
    return runAction({
      config,
      store,
      kind: 'mall',
      params,
      plan: () => {
        const resolved = resolveMallParams(config, params);
        const lines = [
          '信用商店计划（需要 confirm=true）：',
          `- 访问好友基建：${resolved.flags.visitFriends ? '是' : '否'}`,
          `- 购物：${resolved.flags.shopping ? '是' : '否'}`,
          `- 只买折扣：${resolved.flags.onlyDiscount ? '是' : '否'}`,
          `- 信用溢出无视黑名单：${resolved.flags.forceWhenFull ? '是' : '否'}`,
          `- 信用低于 300 停买：${resolved.flags.reserveMaxCredit ? '是' : '否'}`,
          `- 优先购买：${resolved.buyFirst.length > 0 ? resolved.buyFirst.join('、') : '（无）'}`,
          `- 黑名单：${resolved.blacklist.length > 0 ? resolved.blacklist.join('、') : '（无）'}`,
          '消耗：信用点（游戏内货币）；不消耗理智/源石/招聘许可。',
        ];
        const plannedItems = [{ task: 'mall', note: 'MAA Mall 任务链', consumes: 'credit' }];
        return {
          ...planResult({ kind: 'mall', text: lines.join('\n'), planned: plannedItems }),
          plannedItems,
        };
      },
      execute: async (run) => {
        await deps.runtime.ensureReady({
          startup: true,
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        return runMall(deps, params);
      },
    });
  };
}

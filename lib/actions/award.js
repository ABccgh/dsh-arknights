/**
 * `award` 动作：领取各类日常奖励（每日/每周、邮件、每日免费单抽、幸运墙…）。
 *
 * 这是 MAA `Award` 任务链的薄封装：
 * - **不需要 confirm**（契约 §9：award 属于无需确认的动作）；
 * - 只动游戏内「领取」按钮，不消耗理智/源石/招聘许可，因此不过资源安全闸；
 * - MAA 不回传领取明细（没有 `Award` 相关事件），所以 `result.award` 只给开关快照与
 *   任务链结果，并如实说明「识别不到明细」。
 *
 * @module @local/arknights/actions/award
 */

import { arkError } from '../errors.js';
import { planResult, runAction } from './shared.js';

/** 动作超时（30 分钟；工具层同值）。 */
export const AWARD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 参数名 → MAA `Award` 任务字段 → 默认值。
 * 契约 §10 的 `award{award,mail,dailyPull,orundum,mining,specialAccess,signInEvent}`。
 */
const FLAG_SPECS = [
  { key: 'award', maa: 'award', fallback: true, label: '每日/每周任务奖励' },
  { key: 'mail', maa: 'mail', fallback: false, label: '邮件奖励' },
  { key: 'dailyPull', maa: 'recruit', fallback: false, label: '限定池每日免费单抽' },
  { key: 'orundum', maa: 'orundum', fallback: false, label: '幸运墙合成玉' },
  { key: 'mining', maa: 'mining', fallback: false, label: '限时开采许可合成玉' },
  { key: 'specialAccess', maa: 'specialaccess', fallback: false, label: '赠送月卡奖励' },
  { key: 'signInEvent', maa: 'signinevent', fallback: false, label: '限时签到活动奖励' },
];

/**
 * 取对象（数组与 null 视为空对象）。
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
 * 取出整数，非法回退。
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
 * 生效超时：`config.daily.award.timeoutMs` 可覆盖。
 * @param {Record<string, any>} config - 生效配置。
 * @returns {number} 毫秒。
 */
function awardTimeout(config) {
  return intIn(asObject(config?.daily?.award).timeoutMs, AWARD_TIMEOUT_MS, 10000, 4 * 60 * 60 * 1000);
}

/**
 * 把动作参数与 `config.daily.award` 合成 MAA 参数。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {{ flags: Record<string, boolean>, maa: Record<string, any>, labels: string[] }} 组装结果。
 * @throws {ArkError} 所有开关都为 false 时 `E_BAD_ARGS`。
 */
export function resolveAwardParams(config, params = {}) {
  const configured = asObject(config?.daily?.award);
  /** @type {Record<string, boolean>} */
  const flags = {};
  /** @type {Record<string, any>} */
  const maa = { enable: true };
  for (const spec of FLAG_SPECS) {
    const fromParams = typeof params?.[spec.key] === 'boolean' ? params[spec.key] : undefined;
    const fromConfig = typeof configured[spec.key] === 'boolean' ? configured[spec.key] : undefined;
    const value = boolOr(fromParams, boolOr(fromConfig, spec.fallback));
    flags[spec.key] = value;
    maa[spec.maa] = value;
  }
  if (!Object.values(flags).some(Boolean)) {
    throw arkError('E_BAD_ARGS', '没有一个奖励开关是开着的（award 默认开，其余默认关）。', {
      hint: '至少保留 award=true，或显式打开 mail / dailyPull / orundum / mining / specialAccess / signInEvent 中的一项。',
    });
  }
  const labels = FLAG_SPECS.filter((spec) => flags[spec.key]).map((spec) => spec.label);
  return { flags, maa, labels };
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
 * @returns {Promise<Record<string, any>>} runtime.runTaskChain 的结果。
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
 * 执行 `award`（不经过 runAction；daily 直接复用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {Promise<{ text: string, result: Record<string, any>, status?: 'completed'|'partial' }>} 结果。
 */
export async function runAward(deps, params = {}) {
  const { config, state } = deps;
  const resolved = resolveAwardParams(config, params);
  const startSeq = lastSeq(state);
  const outcome = await runChain(deps, 'Award', resolved.maa, awardTimeout(config));
  const events = eventsSince(state, startSeq);
  const chainError = events.some((event) => event?.name === 'TaskChainError' || event?.code === 10000);
  const failed = chainError || (Array.isArray(outcome?.chains) && outcome.chains.some((chain) => chain?.status === 'error'));
  const detail = {
    flags: resolved.flags,
    labels: resolved.labels,
    detailsAvailable: false,
    note: 'MAA 不回传奖励领取明细（没有对应事件），只能确认任务链是否跑完。',
    events: summarizeEvents(events),
  };
  const text = failed
    ? `奖励领取任务链报错（可能停在某个弹窗或奖励已领完），识别不到明细。\n开关：${resolved.labels.join('、')}`
    : `奖励领取完成：${resolved.labels.join('、')}。MAA 不回传具体领取明细，识别不到明细。`;
  return {
    text,
    result: { award: detail },
    ...(failed ? { status: 'partial' } : {}),
  };
}

/**
 * 造 `award` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createAwardAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function award(params = {}) {
    return runAction({
      config,
      store,
      kind: 'award',
      params,
      plan: () => {
        const resolved = resolveAwardParams(config, params);
        const plannedItems = resolved.labels.map((label) => ({ task: 'award', note: label, consumes: 'none' }));
        return {
          ...planResult({
            kind: 'award',
            text: `奖励领取（不需要确认，不消耗理智/源石/招聘许可）：${resolved.labels.join('、')}。\n确认后跑一次 MAA Award 任务链；没有领取明细事件，完成后只能确认任务链跑完。`,
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
        return runAward(deps, params);
      },
    });
  };
}

/**
 * 兜底把奖励参数归一（给工具/HTTP 层复用）。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 参数。
 * @returns {Record<string, any>} 归一后的参数。
 * @throws {ArkError} 参数不合法时。
 */
export function normalizeAwardParams(config, params = {}) {
  const resolved = resolveAwardParams(config, params);
  return { ...resolved.flags };
}

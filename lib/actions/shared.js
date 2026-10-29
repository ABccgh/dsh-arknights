/**
 * 动作层共享原语：单飞 run 记录、确认/安全闸、超时与计划信封。
 *
 * 设计目标（见 docs/contracts.md）：
 * - 同一时间只有一个会动 MAA 的动作；第二个动作直接 `E_BUSY`；
 * - 每次动作产出一个 run（工具等待它结束，面板只拿 runId 轮询）；
 * - 所有资源消耗必须先过 `assertResourcesAllowed`，且默认配置一律拒绝；
 * - 计划（confirm=false）只读、零副作用。
 *
 * @module @local/arknights/actions/shared
 */

import { randomUUID } from 'node:crypto';

import { actionRequiresConfirm, RESOURCE_PARAM_KEYS } from '../contracts.js';
import { arkError, normalizeError } from '../errors.js';

/**
 * 当前时间 ISO 串。
 * @param {() => Date} [clock] - 可注入时钟。
 * @returns {string} ISO 时间。
 */
export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

/**
 * 睡一会儿。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 无。
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 造 run id。
 * @returns {string} `run-<base36>-<8hex>`。
 */
export function makeRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * 人类可读时长。
 * @param {number} ms - 毫秒。
 * @returns {string} 如 `1m 20s`。
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * 只留可序列化的参数摘要（去掉 confirm 与空值；路径保留，便于排障）。
 * @param {string} kind - 动作。
 * @param {Record<string, any>} params - 参数。
 * @returns {Record<string, any>} 摘要。
 */
export function summarizeParams(kind, params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'confirm' || value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    if (typeof value === 'string' && value.length > 300) {
      out[key] = `${value.slice(0, 300)}…`;
      continue;
    }
    out[key] = value;
  }
  out.kind = kind;
  return out;
}

/**
 * 单飞 run 记录器。
 *
 * @param {{
 *   history?: { append?: (entry: Record<string, any>) => Promise<void> | void },
 *   logger?: { info?: Function, warn?: Function },
 *   now?: () => string,
 *   onChange?: (snapshot: { run: Record<string, any> | null, lastRun: Record<string, any> | null }) => void,
 * }} [options] - 选项。
 * @returns {object} run store。
 */
export function createRunStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const history = options.history;
  const logger = options.logger;
  /** @type {Record<string, any> | null} */
  let current = null;
  /** @type {Record<string, any> | null} */
  let last = null;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Array<(snapshot: Record<string, any>) => void>} */
  const listeners = [];

  const snapshot = () => ({
    run: current === null ? null : serializeRun(current),
    lastRun: last === null ? null : serializeRun(last),
  });

  const notify = () => {
    const value = snapshot();
    if (typeof options.onChange === 'function') {
      try {
        options.onChange(value);
      } catch (error) {
        logger?.warn?.(`[arknights] run 状态回调失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // 订阅者失败不影响动作。
      }
    }
  };

  /**
   * 开始一个 run。
   * @param {{ kind: string, params?: Record<string, any>, meta?: Record<string, any> }} input - 输入。
   * @returns {Record<string, any>} run（带 signal/update）。
   */
  const begin = (input) => {
    if (current !== null) {
      throw arkError('E_BUSY', `上一个动作还没结束（${current.kind}，${current.status}）。`, {
        hint: '等它结束（ark_status 看进度），或先 ark_stop。',
        data: { runId: current.id, kind: current.kind },
      });
    }
    controller = new AbortController();
    const run = {
      id: makeRunId(),
      kind: input.kind,
      status: 'running',
      startedAt: now(),
      updatedAt: now(),
      params: summarizeParams(input.kind, input.params ?? {}),
      ...input.meta,
      signal: controller.signal,
      update(patch) {
        Object.assign(run, patch ?? {});
        run.updatedAt = now();
        notify();
        return run;
      },
    };
    current = run;
    notify();
    logger?.info?.(`[arknights] run ${run.id} 开始：${input.kind}`);
    return run;
  };

  /**
   * 结束当前 run。
   * @param {string} status - completed/partial/failed/stopped/planned。
   * @param {Record<string, any>} [patch] - 附加字段（summary、diagnosis…）。
   * @returns {Promise<Record<string, any> | null>} 结束后的 lastRun。
   */
  const finish = async (status, patch = {}) => {
    if (current === null) return last;
    const ended = {
      ...serializeRun(current),
      ...patch,
      status,
      endedAt: now(),
      updatedAt: now(),
    };
    delete ended.signal;
    delete ended.update;
    current = null;
    controller = null;
    last = ended;
    notify();
    try {
      await history?.append?.(ended);
    } catch (error) {
      logger?.warn?.(`[arknights] 运行历史写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    logger?.info?.(`[arknights] run ${ended.id} 结束：${status}`);
    return last;
  };

  /**
   * 以错误结束当前 run。
   * @param {unknown} error - 原始错误。
   * @param {Record<string, any>} [patch] - 附加字段。
   * @returns {Promise<Record<string, any> | null>} 结束后的 lastRun。
   */
  const fail = async (error, patch = {}) => {
    const normalized = normalizeError(error);
    return finish('failed', {
      ...patch,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.hint ? { hint: normalized.hint } : {}),
        ...(normalized.detail ? { detail: normalized.detail } : {}),
      },
    });
  };

  /** 请求停止当前 run。 */
  const stop = () => {
    if (current === null) return false;
    controller?.abort();
    logger?.info?.(`[arknights] run ${current.id} 收到停止请求。`);
    return true;
  };

  return {
    begin,
    finish,
    fail,
    stop,
    snapshot,
    isRunning: () => current !== null,
    current: () => (current === null ? null : serializeRun(current)),
    last: () => (last === null ? null : serializeRun(last)),
    signal: () => (current === null ? null : current.signal),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
}

/**
 * 去掉不可序列化字段。
 * @param {Record<string, any>} run - run。
 * @returns {Record<string, any>} 副本。
 */
function serializeRun(run) {
  const { signal: _signal, update: _update, ...rest } = run;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * 是否已确认（`confirmRequired=false` 时永远视为已确认）。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ confirm?: boolean }} params - 参数。
 * @returns {boolean} 已确认为 true。
 */
export function isConfirmed(config, params = {}) {
  if (params.confirm === true) return true;
  return config?.confirmRequired === false;
}

/**
 * 该动作是否需要确认。
 * @param {string} kind - 动作。
 * @param {Record<string, any>} params - 参数。
 * @returns {boolean} 需要为 true。
 */
export function needsConfirm(kind, params = {}) {
  return actionRequiresConfirm(kind, params);
}

/**
 * 计划结果信封（零副作用）。
 * @param {{ kind: string, text: string, planned?: Array<Record<string, any>>, totals?: Record<string, any>, diagnosis?: Record<string, any> }} input - 输入。
 * @returns {Record<string, any>} 结果。
 */
export function planResult(input) {
  return {
    status: 'planned',
    kind: input.kind,
    planned: Array.isArray(input.planned) ? input.planned : [],
    executed: [],
    totals: input.totals ?? {},
    events: [],
    ...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
    text: input.text,
  };
}

/**
 * 检查资源安全闸；配置为 false 时拒绝任何消耗。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} params - 参数。
 * @returns {void}
 * @throws {ArkError} `E_UNSAFE_RESOURCE`。
 */
export function assertResourcesAllowed(config, params = {}) {
  const safety = config?.safety ?? {};
  const violations = [];
  if (Number(params.medicine) > 0 && safety.allowSanityPotion !== true) violations.push('理智药 medicine');
  if (params.useSanityPotion === true && safety.allowSanityPotion !== true) violations.push('抄作业用理智药 useSanityPotion');
  if (Number(params.stone) > 0 && safety.allowOriginitePrime !== true) violations.push('至纯源石 stone');
  if (params.expedite === true && safety.allowExpedite !== true) violations.push('加急许可 expedite');
  if (params.mode === 'execute' && safety.allowRecruitPermits !== true) violations.push('招聘许可（公招执行）');
  if (violations.length === 0) return;
  throw arkError('E_UNSAFE_RESOURCE', `安全闸拒绝了这次资源消耗：${violations.join('、')}。`, {
    hint: '这是默认行为。用户明确同意后，在 cordis.patch.yml 的 safety 段打开对应开关，并显式传参。',
    data: { violations, resourceKeys: RESOURCE_PARAM_KEYS },
  });
}

/**
 * dryRun 时拒绝真正执行。
 * @param {Record<string, any>} config - 生效配置。
 * @returns {void}
 * @throws {ArkError} `E_DRY_RUN`。
 */
export function assertNotDryRun(config) {
  if (config?.dryRun === true) {
    throw arkError('E_DRY_RUN', 'dryRun=true：只回报计划，不会执行。', {
      hint: '在 cordis.patch.yml 里把 dryRun 改成 false 才会真正执行。',
    });
  }
}

/**
 * 统一动作外壳：计划 → 确认 → 安全闸 → begin run → execute → finish。
 *
 * @param {{
 *   config: Record<string, any>,
 *   store: ReturnType<typeof createRunStore>,
 *   kind: string,
 *   params: Record<string, any>,
 *   plan: () => Promise<{ text: string, plannedItems?: Array<Record<string, any>>, plannedTotalSanity?: number|null, result?: Record<string, any> }> | { text: string, plannedItems?: Array<Record<string, any>>, plannedTotalSanity?: number|null, result?: Record<string, any> },
 *   execute: (run: Record<string, any>) => Promise<{ text: string, result?: Record<string, any>, status?: 'completed'|'partial' }>,
 * }} input - 输入。
 * @returns {Promise<Record<string, any>>} 响应信封。
 */
export async function runAction(input) {
  const { config, store, kind, params } = input;
  const planned = await input.plan();
  const plannedResponse = {
    ok: true,
    planned: true,
    plannedItems: planned.plannedItems ?? [],
    plannedTotalSanity: planned.plannedTotalSanity ?? null,
    text: planned.text,
    ...(planned.result ? { result: planned.result } : {}),
  };
  if (needsConfirm(kind, params) && !isConfirmed(config, params)) return plannedResponse;
  if (config?.dryRun === true) {
    return { ...plannedResponse, text: `[dry-run] 只出计划，不会执行。\n${planned.text}` };
  }
  assertResourcesAllowed(config, params);
  const run = store.begin({ kind, params });
  const task = (async () => {
    try {
      const outcome = await input.execute(run);
      await store.finish(outcome.status ?? 'completed', { result: outcome.result ?? {} });
      return outcome;
    } catch (error) {
      await store.fail(error);
      throw error;
    }
  })();
  if (params.wait === false) {
    task.catch(() => {});
    return {
      ok: true,
      runId: run.id,
      started: true,
      done: false,
      text: planned.text,
    };
  }
  const outcome = await task;
  return {
    ok: true,
    runId: run.id,
    started: true,
    done: true,
    status: outcome.status ?? 'completed',
    text: outcome.text,
    ...(outcome.result ? { result: outcome.result } : {}),
  };
}

/**
 * 给 promise 加超时。
 * @template T
 * @param {Promise<T>} promise - 原 promise。
 * @param {number} ms - 超时毫秒。
 * @param {{ code?: string, message?: string, hint?: string }} [options] - 超时错误。
 * @returns {Promise<T>} 结果。
 */
export function withTimeout(promise, ms, options = {}) {
  const timeoutMs = Math.max(1, Number(ms) || 1);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(arkError(options.code ?? 'E_TIMEOUT', options.message ?? `操作超过 ${formatDuration(timeoutMs)} 未完成。`, {
        hint: options.hint ?? '用 ark_status / ark_diag 看当前画面与任务链。',
      }));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 轮询等待条件成立。
 * @template T
 * @param {() => Promise<T> | T} probe - 探测函数；返回真值即结束。
 * @param {{ timeoutMs: number, intervalMs?: number, signal?: AbortSignal, onTick?: () => void,
 *   code?: string, message?: string }} options - 选项。
 * @returns {Promise<T>} 最后一次探测的真值。
 */
export async function waitFor(probe, options) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 1);
  const intervalMs = Math.max(50, Number(options.intervalMs) || 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw arkError('E_ABORTED', '操作被中止。');
    const value = await probe();
    if (value) return value;
    options.onTick?.();
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw arkError(options.code ?? 'E_TIMEOUT', options.message ?? `等待超过 ${formatDuration(timeoutMs)}。`);
}

/**
 * 判断错误是否来自中止。
 * @param {unknown} error - 错误。
 * @returns {boolean} 是中止为 true。
 */
export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.code === 'E_ABORTED' || error.code === 'ABORT_ERR');
}

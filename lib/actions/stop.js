/**
 * `stop` 动作：立即中止当前动作（打关卡/推关/肉鸽/日常都适用）。
 *
 * 契约要点（docs/contracts.md §4/§9/§10）：
 * - **不需要 confirm**；不是 run（不占单飞锁、不产生 run 记录）；
 * - 先让 run store 中止当前 run（`store.stop()`），再让侧车清空任务链；
 * - 侧车没在跑、还没 init、或进程已退出时**不报错**，只如实说明「本来就没在跑」。
 *
 * 侧车停法优先用 kernel 的 `session.stop()`（优先通道，未启动时直接 no-op），
 * 退化顺序：`session.stop()` → `session.requestPriority('stop')` → `session.request('stop')`。
 *
 * @module @local/arknights/actions/stop
 */

import { normalizeError } from '../errors.js';

/**
 * 侧车本来就没跑时常见的错误码（这些不该让 stop 失败）。
 */
const BENIGN_CODES = new Set(['E_SIDECAR_EXIT', 'E_NOT_INIT', 'E_NOT_READY', 'E_TIMEOUT', 'E_PROTOCOL']);

/**
 * 向侧车发 stop（兼容三种会话门面）。
 * @param {Record<string, any>} session - 侧车会话门面。
 * @returns {Promise<{ requested: boolean, note: string }>} `requested=false` 表示侧车本来就没跑。
 */
async function requestSidecarStop(session) {
  if (typeof session?.stop === 'function') {
    const result = await session.stop({ timeoutMs: 15000 });
    if (result !== null && typeof result === 'object' && result.inited === false) {
      return { requested: false, note: '侧车本来就没在跑，无需停止。' };
    }
    return { requested: true, note: '' };
  }
  const sidecarAlive = typeof session?.isRunning === 'function' ? session.isRunning() === true : true;
  if (!sidecarAlive) return { requested: false, note: '侧车本来就没在跑，无需停止。' };
  if (typeof session?.requestPriority === 'function') {
    await session.requestPriority('stop', {}, { timeoutMs: 15000 });
    return { requested: true, note: '' };
  }
  if (typeof session?.request === 'function') {
    await session.request('stop', {}, { timeoutMs: 15000 });
    return { requested: true, note: '' };
  }
  return { requested: false, note: '侧车会话不可用（没有 session）；只中止了本地 run。' };
}

/**
 * 造 `stop` 动作。
 *
 * 这是唯一不走 runAction 的动作：它本身就是「打断 run」，返回
 * `{ ok, text, stopped, status }`（契约 §10）。
 * @param {Record<string, any>} deps - 依赖（session/store/runtime/logger）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createStopAction(deps) {
  const { session, store, runtime, logger } = deps;
  /**
   * 执行停止。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function stop() {
    const storeStopped = typeof store?.stop === 'function' ? store.stop() === true : false;
    let sidecarStopped = false;
    /** @type {string} */
    let note = '';
    try {
      const result = await requestSidecarStop(session);
      sidecarStopped = result.requested;
      note = result.note;
    } catch (error) {
      const normalized = normalizeError(error);
      if (BENIGN_CODES.has(normalized.code)) {
        note = `侧车本来就没在跑（${normalized.code}），无需停止。`;
      } else {
        note = `向侧车发 stop 失败（${normalized.code}: ${normalized.message}），但本地 run 已中止。`;
        logger?.warn?.(`[arknights] stop 请求失败：${normalized.code} ${normalized.message}`);
        // 侧车半死状态下尽力再敲一次 stop（runtime.stopQuietly 内部已吞错）。
        if (typeof runtime?.stopQuietly === 'function') await runtime.stopQuietly();
      }
    }

    const stopped = storeStopped || sidecarStopped;
    const lines = [];
    if (stopped) lines.push('已停止当前动作。');
    else lines.push('没有正在运行的动作，无需停止。');
    if (note !== '') lines.push(note);
    lines.push('停止后不会自动继续，需要重新发起动作。');
    return {
      ok: true,
      text: lines.join('\n'),
      stopped,
      status: stopped ? 'stopped' : 'idle',
    };
  };
}

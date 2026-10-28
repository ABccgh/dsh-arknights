/**
 * Python 侧车会话：启动、串行队列、超时杀进程、崩溃后透明重启、空闲回收、事件转发。
 *
 * 与 dsh-input 的 helper 会话同源（同一套生命周期取舍）：
 * - 常驻一个 `python -u maa_sidecar.py`，冷启动 + 资源加载实测约 5s，不能每次调用都起进程；
 * - **单请求在途**（MaaCore 单例，并发调用没有意义），队列上限 8；
 * - 协议错误 / 超时一律**杀进程**，下次调用透明重启，避免半死状态；
 * - 空闲 `idleTimeoutMs` 后 `stdin.end()`（EOF），侧车自己 `AsstDestroy` 再退出；
 * - 任务执行期间不回收（`hold()` / `release()`）。
 *
 * `spawn` 可注入，测试用假子进程覆盖全部生命周期分支，不产生真实 MAA 调用。
 *
 * @module @local/arknights/maa-session
 */

import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';

import { arkError, fromSidecarError, hintForCode, normalizeError } from './errors.js';
import { decodeLine, encodeLine, makeRequest, readResult, validateInitResult, validateReady } from './protocol.js';

const MAX_QUEUE = 8;
const QUIT_GRACE_MS = 1500;
const STDERR_TAIL_CHARS = 4096;

/**
 * 造一个侧车会话。
 * @param {{
 *   pythonPath: string, sidecarPath: string,
 *   startupTimeoutMs?: number, requestTimeoutMs?: number, idleTimeoutMs?: number,
 *   resolveInit: () => Promise<Record<string, unknown>>,
 *   onEvent?: (event: { name: string, payload: Record<string, unknown> }) => void,
 *   spawn?: Function, logger?: { info?: Function, warn?: Function }, platform?: string,
 * }} options - 选项。
 * @returns {object} 会话。
 */
export function createMaaSession(options) {
  const pythonPath = options?.pythonPath;
  const sidecarPath = options?.sidecarPath;
  if (typeof pythonPath !== 'string' || pythonPath === '') throw new TypeError('createMaaSession 需要 pythonPath');
  if (typeof sidecarPath !== 'string' || sidecarPath === '') throw new TypeError('createMaaSession 需要 sidecarPath');

  const startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) ? options.startupTimeoutMs : 120000;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 20000;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 600000;
  const resolveInit = typeof options.resolveInit === 'function' ? options.resolveInit : async () => ({});
  const spawn = typeof options.spawn === 'function' ? options.spawn : defaultSpawn;
  const logger = options.logger;
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {Promise<Record<string, any>> | null} */
  let startPromise = null;
  /** @type {Record<string, any> | null} */
  let info = null;
  let nextId = 1;
  const queue = [];
  /** @type {null | { id: number, op: string, args: object, timeoutMs: number, resolve: Function, reject: Function, timer: any }} */
  let inflight = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  /** @type {any} */
  let idleTimer = null;
  let disposed = false;
  let holdCount = 0;
  /** @type {Set<Function>} */
  const listeners = new Set();
  if (typeof options.onEvent === 'function') listeners.add(options.onEvent);

  const log = (level, message) => {
    try {
      logger?.[level]?.(`[arknights] ${message}`);
    } catch {
      // 日志不可用不影响会话。
    }
  };

  const stderrDetail = () => {
    const text = stderrTail.trim();
    return text === '' ? undefined : text.slice(-1200);
  };

  const failure = (code, message, cause) => {
    const causeText = cause instanceof Error
      ? cause.message
      : typeof cause === 'string' && cause !== ''
        ? cause
        : undefined;
    const detail = [stderrDetail(), causeText].filter((part) => typeof part === 'string' && part !== '').join(' | ');
    return arkError(code, message, {
      detail: detail === '' ? undefined : detail,
      hint: hintForCode(code),
      cause,
    });
  };

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const resetIdle = () => {
    clearIdle();
    if (disposed || holdCount > 0 || child === null || inflight !== null || queue.length > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      log('info', '侧车空闲回收。');
      stopChild({ graceful: true, reason: '侧车空闲退出。' });
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  const rejectPending = (error) => {
    if (inflight !== null) {
      clearTimeout(inflight.timer);
      inflight.reject(error);
      inflight = null;
    }
    while (queue.length > 0) {
      const job = queue.shift();
      clearTimeout(job.timer);
      job.reject(error);
    }
  };

  /**
   * 停掉当前子进程并拒绝所有排队工作。
   * @param {{ graceful?: boolean, reason?: string }} [stopOptions] - 停法。
   * @returns {void}
   */
  function stopChild(stopOptions = {}) {
    const graceful = stopOptions.graceful !== false;
    const reason = typeof stopOptions.reason === 'string' ? stopOptions.reason : '侧车已停止。';
    clearIdle();
    const proc = child;
    child = null;
    info = null;
    startPromise = null;
    rejectPending(arkError('E_SIDECAR_EXIT', reason, { hint: hintForCode('E_SIDECAR_EXIT') }));
    if (proc === null) return;
    try {
      proc.stdin?.end?.();
    } catch {
      // 管道可能已经坏了。
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill?.();
      } catch {
        // 已经退出。
      }
    }, graceful ? QUIT_GRACE_MS : 0);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    if (typeof proc.once === 'function') proc.once('exit', () => clearTimeout(killTimer));
    if (!graceful) {
      try {
        proc.kill?.();
      } catch {
        // 已经退出。
      }
    }
  }

  const failJob = (job, error) => {
    if (inflight === job) {
      clearTimeout(job.timer);
      inflight = null;
    }
    job.reject(error);
    resetIdle();
    pump();
  };

  const breakProtocol = (detail) => {
    log('warn', `协议错误：${detail}`);
    rejectPending(arkError('E_PROTOCOL', '侧车线路协议错误，进程已终止。', {
      detail,
      hint: hintForCode('E_PROTOCOL'),
    }));
    stopChild({ graceful: false, reason: '侧车协议错误，进程已终止。' });
  };

  const emitEvent = (name, payload) => {
    for (const listener of listeners) {
      try {
        listener({ name, payload });
      } catch (error) {
        log('warn', `事件处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const handleLine = (proc, line) => {
    if (child !== proc) return;
    let message;
    try {
      message = decodeLine(line);
    } catch (error) {
      breakProtocol(`无法解析侧车输出：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (message.kind === 'event') {
      if (message.event === 'ready') {
        try {
          const ready = validateReady(message.payload);
          log('info', `侧车就绪：sidecar ${ready.sidecarVersion}，python ${ready.python}`);
        } catch (error) {
          breakProtocol(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (message.event === 'maa') emitEvent('maa', message.payload);
      return;
    }

    const job = inflight;
    if (job === null || job.id !== message.id) {
      log('warn', `忽略无法匹配的响应 id=${message.id}`);
      return;
    }
    if (message.ok !== true) {
      failJob(job, fromSidecarError(message.error));
      return;
    }
    let result;
    try {
      result = readResult(message, job.op);
    } catch (error) {
      failJob(job, normalizeError(error, 'E_PROTOCOL'));
      breakProtocol('响应结构不合法');
      return;
    }
    clearTimeout(job.timer);
    inflight = null;
    job.resolve(result);
    resetIdle();
    pump();
  };

  const onStdout = (proc, chunk) => {
    if (child !== proc) return;
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim() !== '') handleLine(proc, line);
      if (child !== proc) return;
      index = stdoutBuffer.indexOf('\n');
    }
    if (stdoutBuffer.length > 16 * 1024 * 1024) breakProtocol('侧车单行输出异常过长');
  };

  const onExit = (proc, code, signal) => {
    if (child !== proc) return;
    const error = failure(
      'E_SIDECAR_EXIT',
      `侧车意外退出（code=${code === null || code === undefined ? 'null' : code}${signal ? `, signal=${signal}` : ''}）。`,
    );
    child = null;
    info = null;
    startPromise = null;
    rejectPending(error);
  };

  const onError = (proc, error) => {
    if (child !== proc) return;
    const wrapped = failure('E_SIDECAR_EXIT', `侧车进程无法启动：${error instanceof Error ? error.message : String(error)}`, error);
    child = null;
    info = null;
    startPromise = null;
    rejectPending(wrapped);
    try {
      proc.kill?.();
    } catch {
      // 已经退出。
    }
  };

  function pump() {
    if (inflight !== null || queue.length === 0) return;
    if (child === null) {
      rejectPending(arkError('E_SIDECAR_EXIT', '侧车未运行。', { hint: hintForCode('E_SIDECAR_EXIT') }));
      return;
    }
    const job = queue.shift();
    inflight = job;
    job.timer = setTimeout(() => {
      if (inflight !== job) return;
      inflight = null;
      job.reject(arkError('E_TIMEOUT', `侧车在 ${job.timeoutMs}ms 内没有响应（op=${job.op}）；已终止进程。`, {
        detail: stderrDetail(),
        hint: hintForCode('E_TIMEOUT'),
      }));
      stopChild({ graceful: false, reason: '侧车响应超时，进程已终止。' });
    }, job.timeoutMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    let line;
    try {
      line = encodeLine(makeRequest(job.id, job.op, job.args));
    } catch (error) {
      failJob(job, normalizeError(error, 'E_PROTOCOL'));
      return;
    }
    try {
      child.stdin.write(`${line}\n`, (error) => {
        if (error && inflight === job) {
          failJob(job, failure('E_SIDECAR_EXIT', '写入侧车失败。', error));
        }
      });
    } catch (error) {
      failJob(job, failure('E_SIDECAR_EXIT', '写入侧车失败。', error));
    }
  }

  const enqueue = (op, args, timeoutMs) => new Promise((resolve, reject) => {
    if (disposed) {
      reject(arkError('E_SIDECAR_EXIT', '插件已卸载，侧车已停止。'));
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      reject(arkError('E_BUSY', `侧车队列已满（上限 ${MAX_QUEUE} 条），等当前操作结束再试。`, {
        hint: hintForCode('E_BUSY'),
      }));
      return;
    }
    queue.push({
      id: nextId,
      op,
      args: args !== null && typeof args === 'object' ? args : {},
      timeoutMs,
      resolve,
      reject,
      timer: null,
    });
    nextId += 1;
    pump();
  });

  const spawnChild = () => {
    const args = ['-u', sidecarPath];
    log('info', `启动侧车：${path.basename(pythonPath)} -u <包内 maa_sidecar.py>`);
    let proc;
    try {
      proc = spawn(pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(sidecarPath),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
        },
      });
    } catch (cause) {
      throw failure('E_SIDECAR_EXIT', '侧车进程无法启动。', cause);
    }
    if (proc === null || typeof proc !== 'object') throw failure('E_SIDECAR_EXIT', '侧车进程无法启动。');
    child = proc;
    stdoutBuffer = '';
    stderrTail = '';
    proc.stdout?.setEncoding?.('utf8');
    proc.stderr?.setEncoding?.('utf8');
    proc.stdout?.on?.('data', (chunk) => onStdout(proc, String(chunk)));
    proc.stderr?.on?.('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
    });
    proc.stdin?.on?.('error', () => {
      // 进程已经退出时写管道会报错；真正的失败由 exit 分支处理。
    });
    proc.on?.('error', (error) => onError(proc, error));
    proc.on?.('exit', (code, signal) => onExit(proc, code, signal));
    return proc;
  };

  /**
   * 确保侧车已启动并完成 init 握手。
   * @returns {Promise<Record<string, any>>} init 结果（含 coreVersion）。
   */
  const ensureStarted = () => {
    if (disposed) return Promise.reject(arkError('E_SIDECAR_EXIT', '插件已卸载，侧车已停止。'));
    if (info !== null && child !== null) return Promise.resolve(info);
    if (startPromise !== null) return startPromise;
    const attempt = (async () => {
      if (platform !== 'win32') {
        throw arkError('E_SIDECAR_EXIT', '本插件只支持 Windows（MaaCore 为 Windows 版）。');
      }
      const initArgs = await resolveInit();
      spawnChild();
      const result = await enqueue('init', initArgs, startupTimeoutMs);
      let validated;
      try {
        validated = validateInitResult(result);
      } catch (error) {
        throw normalizeError(error, 'E_MAA_LOAD');
      }
      if (disposed) throw arkError('E_SIDECAR_EXIT', '插件已卸载，侧车已停止。');
      info = { ...validated, initArgs };
      log('info', `MaaCore 就绪：${validated.coreVersion}`);
      resetIdle();
      return info;
    })();
    startPromise = attempt;
    attempt.catch((error) => {
      if (startPromise === attempt) startPromise = null;
      stopChild({ graceful: false, reason: '侧车启动失败。' });
      log('warn', `侧车启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return attempt;
  };

  /**
   * 发一条命令（自动确保侧车已启动）。
   * @param {string} op - 操作名。
   * @param {Record<string, unknown>} [args] - 参数。
   * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
   * @returns {Promise<Record<string, any>>} result。
   */
  const request = async (op, args = {}, requestOptions = {}) => {
    await ensureStarted();
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
      ? Math.max(1000, Math.trunc(requestOptions.timeoutMs))
      : requestTimeoutMs;
    return enqueue(op, args, timeoutMs);
  };

  return {
    ensureStarted,
    request,
    getInfo: () => info,
    isRunning: () => child !== null,
    isHeld: () => holdCount > 0,
    /** 任务执行期间阻止空闲回收。 */
    hold: () => {
      holdCount += 1;
      clearIdle();
    },
    /** 任务结束，恢复空闲计时。 */
    release: () => {
      holdCount = Math.max(0, holdCount - 1);
      resetIdle();
    },
    /**
     * 订阅事件（maa）。
     * @param {(event: { name: string, payload: Record<string, unknown> }) => void} listener - 监听器。
     * @returns {() => void} 取消订阅。
     */
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopChild({ graceful: true, reason: '插件已卸载，侧车已停止。' });
    },
  };
}

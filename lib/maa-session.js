/**
 * Python 侧车会话：启动、串行队列、超时杀进程、崩溃后透明重启、空闲回收、事件转发。
 *
 * 与 dsh-input 的 helper 会话同源（同一套生命周期取舍）：
 * - 常驻一个 `python -u maa_sidecar.py`，冷启动 + 资源加载实测约 5s，不能每次调用都起进程；
 * - **普通请求单请求在途**（MaaCore 单例，并发调用没有意义），队列上限 8；
 * - **`stop` 走优先通道**：不排在普通队列后面，直接写给侧车（契约 §1 / §2.4）；
 * - 协议错误 / 超时一律**杀进程**，下次调用透明重启，避免半死状态；
 * - `ready` 事件必须带 `protocolVersion`，主版本不一致报 `E_PROTOCOL_VERSION`；
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
import {
  MAX_LINE_BYTES,
  decodeLine,
  encodeLine,
  makeRequest,
  readResult,
  validateInitResult,
  validateReady,
} from './protocol.js';

const MAX_QUEUE = 8;
const QUIT_GRACE_MS = 1500;
const STDERR_TAIL_CHARS = 4096;
/** `stop` 优先通道的默认超时（比普通请求短，避免卡住面板的停止按钮）。 */
const STOP_TIMEOUT_MS = 15000;

/**
 * 造一个侧车会话。
 * @param {{
 *   pythonPath: string, sidecarPath: string, sidecarArgs?: string[],
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
  // 测试接缝：真实侧车用 `python -u <script>`；假侧车用 `node <script>` 时删掉 -u。
  const sidecarArgs = Array.isArray(options.sidecarArgs) && options.sidecarArgs.length > 0
    ? options.sidecarArgs.map((value) => String(value))
    : ['-u', sidecarPath];

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {Promise<Record<string, any>> | null} */
  let startPromise = null;
  /** @type {Record<string, any> | null} */
  let info = null;
  /** `ready` 事件带来的进程信息（init 之前就有）。 */
  /** @type {{ sidecarVersion: string, protocolVersion: string, python: string } | null} */
  let readyInfo = null;
  let nextId = 1;
  /** 普通请求队列（串行，一次一个在途）。 */
  const queue = [];
  /** 所有在途请求（普通 1 个 + 优先通道若干）。 @type {Map<number, Record<string, any>>} */
  const pending = new Map();
  /** 当前在途的普通请求 id；优先请求不占这个位置。 */
  let inflightId = null;
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
    if (disposed || holdCount > 0 || child === null || pending.size > 0 || queue.length > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      log('info', '侧车空闲回收。');
      stopChild({ graceful: true, reason: '侧车空闲退出。' });
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  /**
   * 停掉当前子进程并拒绝所有排队/在途请求。
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
    readyInfo = null;
    startPromise = null;
    inflightId = null;
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

  /**
   * 拒绝所有排队与在途请求（保留对象本身，供 breakProtocol 里先拒绝再杀进程）。
   * @param {import('./errors.js').ArkError} error - 统一错误。
   * @returns {void}
   */
  function rejectPending(error) {
    for (const job of pending.values()) {
      if (job.timer !== null) clearTimeout(job.timer);
      job.reject(error);
    }
    pending.clear();
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.timer !== null) clearTimeout(job.timer);
      job.reject(error);
    }
  }

  const failJob = (job, error) => {
    if (pending.get(job.id) === job) pending.delete(job.id);
    if (job.timer !== null) clearTimeout(job.timer);
    if (inflightId === job.id) inflightId = null;
    job.reject(error);
    resetIdle();
    if (job.priority !== true) pump();
  };

  const breakProtocol = (detail, code = 'E_PROTOCOL') => {
    log('warn', `协议错误：${detail}`);
    const error = arkError(code, '侧车线路协议错误，进程已终止。', {
      detail,
      hint: hintForCode(code),
    });
    rejectPending(error);
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
          readyInfo = ready;
          log('info', `侧车就绪：sidecar ${ready.sidecarVersion}，protocol ${ready.protocolVersion}，python ${ready.python}`);
        } catch (error) {
          // 版本不匹配是契约层错误：带 E_PROTOCOL_VERSION，杀掉进程等下次重装/重启。
          const code = error instanceof Error && typeof error.code === 'string' ? error.code : 'E_PROTOCOL';
          breakProtocol(error instanceof Error ? error.message : String(error), code);
        }
        return;
      }
      if (message.event === 'maa') emitEvent('maa', message.payload);
      return;
    }

    const job = pending.get(message.id);
    if (job === undefined) {
      log('warn', `忽略无法匹配的响应 id=${message.id}`);
      return;
    }
    pending.delete(message.id);
    if (job.timer !== null) clearTimeout(job.timer);
    if (job.priority !== true) {
      if (inflightId !== job.id) {
        log('warn', `忽略不匹配的普通响应 id=${message.id}`);
        return;
      }
      inflightId = null;
    }
    if (message.ok !== true) {
      job.reject(fromSidecarError(message.error));
      resetIdle();
      if (job.priority !== true) pump();
      return;
    }
    let result;
    try {
      result = readResult(message, job.op);
    } catch (error) {
      job.reject(normalizeError(error, 'E_PROTOCOL'));
      breakProtocol('响应结构不合法');
      return;
    }
    job.resolve(result);
    resetIdle();
    if (job.priority !== true) pump();
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
    if (stdoutBuffer.length > MAX_LINE_BYTES) breakProtocol('侧车单行输出异常过长');
  };

  const onExit = (proc, code, signal) => {
    if (child !== proc) return;
    const error = failure(
      'E_SIDECAR_EXIT',
      `侧车意外退出（code=${code === null || code === undefined ? 'null' : code}${signal ? `, signal=${signal}` : ''}）。`,
    );
    child = null;
    info = null;
    readyInfo = null;
    startPromise = null;
    inflightId = null;
    rejectPending(error);
  };

  const onError = (proc, error) => {
    if (child !== proc) return;
    const wrapped = failure('E_SIDECAR_EXIT', `侧车进程无法启动：${error instanceof Error ? error.message : String(error)}`, error);
    child = null;
    info = null;
    readyInfo = null;
    startPromise = null;
    inflightId = null;
    rejectPending(wrapped);
    try {
      proc.kill?.();
    } catch {
      // 已经退出。
    }
  };

  /**
   * 把一条请求写进侧车并挂超时。
   * @param {Record<string, any>} job - 请求。
   * @returns {void}
   */
  const sendJob = (job) => {
    if (child === null) {
      job.reject(arkError('E_SIDECAR_EXIT', '侧车未运行。', { hint: hintForCode('E_SIDECAR_EXIT') }));
      return;
    }
    job.timer = setTimeout(() => {
      if (pending.get(job.id) !== job) return;
      pending.delete(job.id);
      if (inflightId === job.id) inflightId = null;
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
        if (error && pending.get(job.id) === job) {
          failJob(job, failure('E_SIDECAR_EXIT', '写入侧车失败。', error));
        }
      });
    } catch (error) {
      failJob(job, failure('E_SIDECAR_EXIT', '写入侧车失败。', error));
    }
  };

  function pump() {
    if (inflightId !== null || queue.length === 0) return;
    if (child === null) {
      rejectPending(arkError('E_SIDECAR_EXIT', '侧车未运行。', { hint: hintForCode('E_SIDECAR_EXIT') }));
      return;
    }
    const job = queue.shift();
    inflightId = job.id;
    pending.set(job.id, job);
    sendJob(job);
  }

  /**
   * 普通请求入队（串行）。
   * @param {string} op - 操作名。
   * @param {Record<string, unknown>} args - 参数。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<Record<string, any>>} result。
   */
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
      priority: false,
    });
    nextId += 1;
    pump();
  });

  /**
   * 优先请求：不排普通队列，即使有普通请求在途也立刻写出（`stop` 用）。
   * @param {string} op - 操作名。
   * @param {Record<string, unknown>} args - 参数。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<Record<string, any>>} result。
   */
  const enqueuePriority = (op, args, timeoutMs) => new Promise((resolve, reject) => {
    if (disposed) {
      reject(arkError('E_SIDECAR_EXIT', '插件已卸载，侧车已停止。'));
      return;
    }
    const job = {
      id: nextId,
      op,
      args: args !== null && typeof args === 'object' ? args : {},
      timeoutMs,
      resolve,
      reject,
      timer: null,
      priority: true,
    };
    nextId += 1;
    if (child === null) {
      reject(arkError('E_SIDECAR_EXIT', '侧车未运行。', { hint: hintForCode('E_SIDECAR_EXIT') }));
      return;
    }
    pending.set(job.id, job);
    sendJob(job);
  });

  const spawnChild = () => {
    log('info', `启动侧车：${path.basename(pythonPath)} ${sidecarArgs.map((value) => (value === sidecarPath ? '<包内侧车脚本>' : value)).join(' ')}`);
    let proc;
    try {
      proc = spawn(pythonPath, sidecarArgs, {
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
   * @returns {Promise<Record<string, any>>} init 结果（含 coreVersion / protocolVersion）。
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
      info = {
        ...validated,
        protocolVersion: validated.protocolVersion || readyInfo?.protocolVersion || '',
        sidecarVersion: readyInfo?.sidecarVersion ?? '',
        python: readyInfo?.python ?? '',
        initArgs,
      };
      log('info', `MaaCore 就绪：${validated.coreVersion}（protocol ${info.protocolVersion || '?'}）`);
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

  /**
   * 发一条优先命令（不排队；需要侧车已存在或在启动中）。
   * @param {string} op - 操作名。
   * @param {Record<string, unknown>} [args] - 参数。
   * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
   * @returns {Promise<Record<string, any>>} result。
   */
  const requestPriority = async (op, args = {}, requestOptions = {}) => {
    await ensureStarted();
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
      ? Math.max(1000, Math.trunc(requestOptions.timeoutMs))
      : requestTimeoutMs;
    return enqueuePriority(op, args, timeoutMs);
  };

  return {
    ensureStarted,
    request,
    requestPriority,
    /**
     * 停止当前任务链：优先通道发送，绝不排在普通请求队列后面。
     *
     * 侧车根本没起来时直接回 `{running:false}`：没有任务可停，也不值得为
     * 了一个 stop 去冷启动 MaaCore。
     * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
     * @returns {Promise<{ running: boolean }>} 结果。
     */
    stop: async (requestOptions = {}) => {
      if (disposed) return { running: false };
      if (child === null && startPromise === null) return { running: false, inited: false };
      const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
        ? Math.max(1000, Math.trunc(requestOptions.timeoutMs))
        : Math.min(requestTimeoutMs, STOP_TIMEOUT_MS);
      const result = await requestPriority('stop', {}, { timeoutMs });
      return { running: result.running === true, ...(result.inited === false ? { inited: false } : {}) };
    },
    /**
     * 更新已追加任务的参数（`AsstSetTaskParams`）。
     * @param {number} taskId - 任务 id。
     * @param {Record<string, unknown>} params - 新参数。
     * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
     * @returns {Promise<Record<string, any>>} result。
     */
    setParams: (taskId, params = {}, requestOptions = {}) => request('setParams', { taskId, params }, requestOptions),
    /**
     * 截图（`AsstGetImage`，侧车写盘后返回路径）。
     * @param {{ dir?: string, prefix?: string, format?: string, timeoutMs?: number }} [shotOptions] - 落盘位置。
     * @returns {Promise<{ path: string, width: number, height: number, bytes: number }>} 截图信息。
     */
    screenshot: (shotOptions = {}) => {
      const dir = typeof shotOptions.dir === 'string' && shotOptions.dir !== '' ? shotOptions.dir : undefined;
      const prefix = typeof shotOptions.prefix === 'string' && shotOptions.prefix !== '' ? shotOptions.prefix : undefined;
      const format = typeof shotOptions.format === 'string' && shotOptions.format !== '' ? shotOptions.format : 'png';
      return request(
        'screenshot',
        {
          format,
          ...(dir === undefined ? {} : { dir }),
          ...(prefix === undefined ? {} : { prefix }),
        },
        { timeoutMs: Number.isFinite(shotOptions.timeoutMs) ? shotOptions.timeoutMs : 30000 },
      );
    },
    /**
     * 回主界面（`AsstBackToHome`）。
     * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
     * @returns {Promise<Record<string, any>>} result。
     */
    backHome: (requestOptions = {}) => request('backHome', {}, {
      timeoutMs: Number.isFinite(requestOptions.timeoutMs) ? requestOptions.timeoutMs : 15000,
    }),
    /**
     * 当前任务链 id 列表（`AsstGetTasksList`，可选；失败降级为空数组）。
     * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
     * @returns {Promise<Record<string, any>>} result。
     */
    tasks: (requestOptions = {}) => request('tasks', {}, requestOptions),
    getInfo: () => info,
    getReadyInfo: () => readyInfo,
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

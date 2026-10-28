/**
 * 测试用的「假侧车」：用纯 Node 模拟 `lib/sidecar/maa_sidecar.py` 的 NDJSON 协议
 * （docs/contracts.md §2），不依赖 Python / MaaCore / 模拟器。
 *
 * 两种用法：
 * 1. 直接被 spawn：`node test/fake-sidecar.mjs`，从 stdin 读请求、往 stdout 写协议行；
 * 2. 测试里用 `spawnFakeSidecar(options)` 起一个进程并拿到驱动句柄：
 *
 *    const sidecar = spawnFakeSidecar({ events: [{ code: 10001, details: { taskchain: 'Fight' } }] });
 *    const ready = await sidecar.nextEvent('ready');
 *    const id = sidecar.send('ping');
 *    const response = await sidecar.nextResponse(id);
 *    sidecar.kill();
 *
 * 可配置项（都通过环境变量传给子进程，避免命令行转义问题）：
 * - `failInit`         init 返回 `E_MAA_LOAD`
 * - `resourceLoaded`   init 结果的 resourceLoaded（默认 true）
 * - `failAppend`       append 一律返回 `E_TASK_TYPE`
 * - `events`           一组 `{ code, name?, details? }`，按 `eventsOn` 的时机推送
 * - `eventsOn`         `'start'`（默认）/`'append'`/`'init'`/`'never'`
 * - `running`          `running` op 的返回值（默认 false）
 * - `connected`        `connected` op 的返回值（默认 true；`null` 表示 MAA 没有该符号）
 * - `coreVersion`      版本号
 *
 * 该文件不是产品代码，只服务于 `test/protocol.unit.test.js` 的自检。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 与 lib/config.js 的 PROTOCOL_VERSION 一致。 */
export const PROTOCOL_VERSION = '1.0.0';
/** 假 MaaCore 版本。 */
export const CORE_VERSION = 'v6.21.0-beta.2';

/** 与 docs/contracts.md §6 一致的码表（子集，够测试用）。 */
const MESSAGE_NAMES = {
  0: 'InternalError',
  1: 'InitFailed',
  2: 'ConnectionInfo',
  3: 'AllTasksCompleted',
  4: 'AsyncCallInfo',
  5: 'Destroyed',
  10000: 'TaskChainError',
  10001: 'TaskChainStart',
  10002: 'TaskChainCompleted',
  10004: 'TaskChainStopped',
  20000: 'SubTaskError',
  20001: 'SubTaskStart',
  20002: 'SubTaskCompleted',
  20003: 'SubTaskExtraInfo',
  20004: 'SubTaskStopped',
  30000: 'ReportRequest',
};

/**
 * 写一行协议 JSON（stdout 只走协议）。
 * @param {import('node:stream').Writable} stream - 目标流。
 * @param {Record<string, unknown>} value - 消息。
 * @returns {void}
 */
function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * 从环境变量取配置。
 * @returns {Record<string, any>} 配置。
 */
function readOptions() {
  const raw = process.env.FAKE_SIDECAR_OPTIONS;
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 假侧车主循环。
 * @returns {void}
 */
async function main() {
  const options = readOptions();
  const coreVersion = typeof options.coreVersion === 'string' ? options.coreVersion : CORE_VERSION;
  const scriptedEvents = Array.isArray(options.events) ? options.events : [];
  const eventsOn = typeof options.eventsOn === 'string' ? options.eventsOn : 'start';

  let inited = false;
  let nextTaskId = 1;
  let seq = 0;

  writeLine(process.stdout, {
    event: 'ready',
    sidecarVersion: typeof options.sidecarVersion === 'string' ? options.sidecarVersion : PROTOCOL_VERSION,
    python: typeof options.python === 'string' ? options.python : '3.12.14',
    platform: 'win32',
  });

  /**
   * 推送一条 maa 事件（seq 单调递增）。
   * @param {{ code?: number, name?: string, details?: Record<string, unknown> }} input - 事件。
   * @returns {void}
   */
  const emitMaa = (input = {}) => {
    const code = Number.isInteger(input.code) ? input.code : 20003;
    seq += 1;
    writeLine(process.stdout, {
      event: 'maa',
      seq,
      code,
      name: typeof input.name === 'string' && input.name !== '' ? input.name : (MESSAGE_NAMES[code] ?? `Code${code}`),
      details: input.details !== null && typeof input.details === 'object' ? input.details : {},
      ts: new Date().toISOString(),
    });
  };

  /**
   * 按配置的时机推送脚本事件。
   * @param {string} phase - init / append / start。
   * @returns {void}
   */
  const emitScripted = (phase) => {
    if (eventsOn !== phase) return;
    for (const event of scriptedEvents) emitMaa(event);
  };

  /**
   * 回一条响应。
   * @param {number} id - 请求 id（原样回传）。
   * @param {boolean} ok - 是否成功。
   * @param {Record<string, unknown>} [body] - `result` 或 `error` 的内容。
   * @returns {void}
   */
  const reply = (id, ok, body = {}) => {
    writeLine(process.stdout, ok ? { id, ok: true, result: body } : { id, ok: false, error: body });
  };

  /**
   * 处理一条请求。
   * @param {Record<string, any>} request - 请求。
   * @returns {void}
   */
  const handle = (request) => {
    const id = Number.isInteger(request?.id) ? request.id : 0;
    const op = typeof request?.op === 'string' ? request.op : '';
    const args = request?.args !== null && typeof request?.args === 'object' ? request.args : {};

    // init 之前的约束（docs/contracts.md §2.5）；ping/version 不碰 MAA，允许。
    if (!inited && op !== 'init' && op !== 'ping' && op !== 'version') {
      reply(id, false, { code: 'E_NOT_INIT', message: 'MaaCore 尚未初始化。', detail: `op=${op}` });
      return;
    }

    switch (op) {
      case 'ping':
        reply(id, true, { pong: true, inited });
        return;
      case 'init': {
        if (options.failInit === true) {
          reply(id, false, { code: 'E_MAA_LOAD', message: 'MaaCore.dll 加载失败', detail: 'fake failInit' });
          return;
        }
        inited = true;
        reply(id, true, {
          coreVersion,
          resourceLoaded: options.resourceLoaded !== false,
          maaPath: typeof args.maaPath === 'string' ? args.maaPath : '',
          userDir: typeof args.userDir === 'string' ? args.userDir : '',
        });
        emitScripted('init');
        return;
      }
      case 'version':
        reply(id, true, { coreVersion });
        return;
      case 'append': {
        if (options.failAppend === true) {
          reply(id, false, { code: 'E_TASK_TYPE', message: 'MAA 不接受该任务类型。', detail: 'fake failAppend' });
          return;
        }
        const type = typeof args.type === 'string' ? args.type : '';
        if (type === '' || type === 'Bogus') {
          reply(id, false, { code: 'E_TASK_TYPE', message: 'MAA 不接受该任务类型。', detail: `type=${type}` });
          return;
        }
        const taskId = nextTaskId;
        nextTaskId += 1;
        reply(id, true, { taskId });
        emitScripted('append');
        return;
      }
      case 'start':
        reply(id, true, { running: true });
        emitScripted('start');
        return;
      case 'stop':
        reply(id, true, { running: false });
        return;
      case 'running':
        reply(id, true, { running: options.running === true });
        return;
      case 'connected':
        reply(id, true, { connected: options.connected === null ? null : options.connected !== false });
        return;
      case 'destroy':
        inited = false;
        reply(id, true, { destroyed: true });
        return;
      case 'emit': {
        // 测试专用：随时插一条事件。
        emitMaa(args);
        reply(id, true, { emitted: true });
        return;
      }
      default:
        reply(id, false, { code: 'E_BAD_OP', message: '侧车收到未知操作。', detail: `op=${op}` });
    }
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        try {
          handle(JSON.parse(line));
        } catch {
          // 坏请求不能让侧车崩；回一条协议错误（拿不到 id 时用 0）。
          writeLine(process.stdout, { id: 0, ok: false, error: { code: 'E_PROTOCOL', message: '请求不是合法 JSON。' } });
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  // stdin EOF → AsstDestroy → 退出码 0（契约 §2.5）。
  process.stdin.on('end', () => {
    inited = false;
    process.exit(0);
  });
  process.stdin.on('close', () => {
    inited = false;
    process.exit(0);
  });
}

/**
 * 起一个假侧车并返回驱动句柄。
 * @param {Record<string, any>} [options] - 见文件头注释。
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   send: (op: string, args?: Record<string, unknown>) => number,
 *   request: (op: string, args?: Record<string, unknown>) => Promise<Record<string, any>>,
 *   nextResponse: (id?: number) => Promise<Record<string, any>>,
 *   nextEvent: (name?: string) => Promise<Record<string, any>>,
 *   events: Array<Record<string, any>>,
 *   responses: Array<Record<string, any>>,
 *   kill: () => void,
 *   closeStdin: () => void,
 *   waitExit: (timeoutMs?: number) => Promise<{ code: number | null, signal: string | null }>,
 * }} 句柄。
 */
export function spawnFakeSidecar(options = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      FAKE_SIDECAR_OPTIONS: JSON.stringify(options),
      PYTHONIOENCODING: 'utf-8',
    },
  });

  /** @type {Array<Record<string, any>>} */
  const responses = [];
  /** @type {Array<Record<string, any>>} */
  const events = [];
  /** @type {Array<{ match: (value: any) => boolean, resolve: (value: any) => void }>} */
  const responseWaiters = [];
  /** @type {Array<{ match: (value: any) => boolean, resolve: (value: any) => void }>} */
  const eventWaiters = [];
  let buffer = '';
  let nextId = 1;
  /** @type {Promise<{ code: number | null, signal: string | null }> | null} */
  let exitPromise = null;

  /**
   * 从一个队列里取第一个匹配项；没有就排队等。
   * @param {Array<Record<string, any>>} items - 已收到的消息。
   * @param {Array<{ match: Function, resolve: Function }>} waiters - 等待者。
   * @param {(value: any) => boolean} match - 匹配函数。
   * @returns {Promise<Record<string, any>>} 消息。
   */
  const take = (items, waiters, match) => {
    const index = items.findIndex(match);
    if (index >= 0) return Promise.resolve(items.splice(index, 1)[0]);
    return new Promise((resolve) => {
      waiters.push({ match, resolve });
    });
  };

  /** 把排队的等待者和新到的消息配对。 */
  const flush = () => {
    for (const list of [responseWaiters, eventWaiters]) {
      for (let i = 0; i < list.length; i += 1) {
        const pool = list === responseWaiters ? responses : events;
        const index = pool.findIndex(list[i].match);
        if (index < 0) continue;
        const waiter = list.splice(i, 1)[0];
        waiter.resolve(pool.splice(index, 1)[0]);
        i -= 1;
      }
    }
  };

  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on?.('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        if (message !== null && typeof message === 'object') {
          if (typeof message.event === 'string') events.push(message);
          else responses.push(message);
        }
      }
      index = buffer.indexOf('\n');
    }
    flush();
  });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', () => {
    // 假侧车的 stderr 不参与协议，丢弃。
  });

  /**
   * 等进程退出。
   * @param {number} [timeoutMs] - 超时。
   * @returns {Promise<{ code: number | null, signal: string | null }>} 退出结果。
   */
  const waitExit = (timeoutMs = 5000) => {
    if (exitPromise !== null) return exitPromise;
    exitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('假侧车没有在预期时间内退出。')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    return exitPromise;
  };

  return {
    child,
    events,
    responses,
    /**
     * 写一条请求，返回请求 id。
     * @param {string} op - 操作名。
     * @param {Record<string, unknown>} [args] - 参数。
     * @returns {number} 请求 id。
     */
    send(op, args = {}) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      return id;
    },
    /**
     * 写一条请求并等它的响应。
     * @param {string} op - 操作名。
     * @param {Record<string, unknown>} [args] - 参数。
     * @returns {Promise<Record<string, any>>} 响应。
     */
    request(op, args = {}) {
      const id = this.send(op, args);
      return take(responses, responseWaiters, (value) => value.id === id);
    },
    /**
     * 等下一条响应（可按 id 过滤）。
     * @param {number} [id] - 请求 id。
     * @returns {Promise<Record<string, any>>} 响应。
     */
    nextResponse(id) {
      return take(responses, responseWaiters, typeof id === 'number' ? (value) => value.id === id : () => true);
    },
    /**
     * 等下一条事件（可按事件名过滤，如 `'ready'` / `'maa'`）。
     * @param {string} [name] - 事件名。
     * @returns {Promise<Record<string, any>>} 事件。
     */
    nextEvent(name) {
      return take(events, eventWaiters, typeof name === 'string' ? (value) => value.event === name : () => true);
    },
    /** 杀掉进程。 */
    kill() {
      try {
        child.stdin.end();
      } catch {
        // 管道可能已经关了。
      }
      try {
        child.kill();
      } catch {
        // 已经退出。
      }
    },
    /** 关 stdin（模拟 EOF，让侧车自己退出）。 */
    closeStdin() {
      child.stdin.end();
    },
    waitExit,
  };
}

// 只有在被 `node test/fake-sidecar.mjs` 直接运行时才进入协议循环。
const entry = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entry !== null && entry.toLowerCase() === import.meta.url.toLowerCase()) {
  await main();
}

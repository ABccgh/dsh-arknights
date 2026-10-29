/**
 * 测试用的「假侧车」：用纯 Node 模拟 `lib/sidecar/maa_sidecar.py` 的 NDJSON 协议 2.0
 * （docs/contracts.md §2），不依赖 Python / MaaCore / 模拟器。
 *
 * 三种用法：
 *
 * 1. 直接被 spawn：`node test/fake-sidecar.mjs`，从 stdin 读请求、往 stdout 写协议行；
 *
 * 2. 测试里起一个进程并拿到驱动句柄（适合 session / runtime 测试）：
 *
 *    ```js
 *    import { fileURLToPath } from 'node:url';
 *    import { createMaaSession } from '../lib/maa-session.js';
 *    const fake = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));
 *    const session = createMaaSession({
 *      pythonPath: process.execPath,            // 用 node 当解释器
 *      sidecarPath: fake,
 *      sidecarArgs: [fake, JSON.stringify({ tasks: { Recruit: { events: [...] } } })],
 *      resolveInit: async () => ({ maaPath: 'D:\\MAA', userDir: 'C:\\tmp' }),
 *      platform: 'win32',
 *      requestTimeoutMs: 10000,
 *    });
 *    ```
 *
 * 3. 直接 `spawnFakeSidecar(options)` 拿驱动句柄（本文件的旧用法，测试协议细节用）：
 *
 *    ```js
 *    const sidecar = spawnFakeSidecar({ tasks: { Fight: [{ what: 'StageDrops', details: { stars: 3 } }] } });
 *    const ready = await sidecar.nextEvent('ready');
 *    const id = sidecar.send('init', { maaPath: 'D:\\MAA' });
 *    await sidecar.nextResponse(id);
 *    ```
 *
 * 可配置项（也可以把同样对象 JSON 化后放在 argv[2] 或环境变量 FAKE_SIDECAR_OPTIONS）：
 *
 * 基础：
 * - `protocolVersion` / `sidecarVersion`  ready 事件里的版本（默认 2.0.0）；换掉可测 E_PROTOCOL_VERSION
 * - `coreVersion`       init/version 返回的 MaaCore 版本（默认 v6.21.0-beta.2）
 * - `failInit`          init 返回 E_MAA_LOAD
 * - `resourceLoaded`    init 的 resourceLoaded（默认 true）
 * - `failAppend`        append 一律 E_TASK_TYPE；`rejectTypes:[...]` 只拒绝这些类型
 * - `running`           `running` op 的初始值（默认 false）
 * - `connected`         `connected` op 结果（默认 true；`null` 表示 MAA 没有该符号）
 * - `taskIds`           `tasks` op 的固定结果；不传则返回已 append 未结束的 taskId
 * - `delays.ops`        按 op 延迟处理（如 `{ connect: 800 }`，用来测 stop 优先通道）
 *
 * 任务链脚本（start 时回放）：
 * - `tasks`             `{ Recruit: { events: [...] }, Infrast: [...] }`，key 是 append 的 type；
 *                       事件项写法：`{what:'RecruitResult',details:{…}}`（自动 code=20003）/
 *                       `{code:10001,details:{…}}` / `{event:'maa',code,name,details}`；
 *                       每项可带 `delayMs`；条目可配 `autoChain:false`（不自动发 TaskChainStart/Completed）
 * - `replay`            **按任务类型 + 第几次 start 回放**：
 *                       `{ Fight: [[{what:'StageDrops',details:{stars:3}}], [{what:'StageDrops',details:{stars:2}}]] }`
 *                       第 N 次 start 取第 N 组（超出取最后一组）；优先于 `tasks`
 * - `onStart`           `'auto'`（默认：回放脚本，running 自动回 false）/ `'manual'`（只置 running=true，
 *                       用控制 op `finish`/`emit` 手动推进）
 * - `events` + `eventsOn`  旧接口：`eventsOn:'init'|'append'|'start'|'never'` 时回放 `events`
 * - `stopEvents`        stop 时额外回放的事件
 * - `initEvents`        init 成功后回放的事件
 *
 * 其它 op：
 * - `screenshot`        `{ok:false, code?, message?}` 测降级；或 `{width,height}` 改返回尺寸（默认 1280x720）
 * - `failBackHome`      backHome 返回 E_TASK_REJECTED
 * - `failSetParams`     setParams 返回 E_TASK_REJECTED
 *
 * 假侧车专属控制 op（不碰 MaaCore，测试用）：
 * - `emit`      `{what,details}` / `{code,name,details}` / `{events:[…]}`，立刻插一条事件
 * - `finish`    把 running 置 false 并清空任务链（配合 onStart:'manual'）
 * - `setRunning` `{running:bool}`
 * - `captured`  返回 `{appends:[{type,params,taskId}], setParams:[…], starts, stops}` 供断言
 *
 * 该文件不是产品代码，只服务于测试；全部离线，不产生任何真实 MAA 调用。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 与 lib/contracts.js 的 PROTOCOL_VERSION 一致。 */
export const PROTOCOL_VERSION = '2.0.0';
/** 假 MaaCore 版本。 */
export const CORE_VERSION = 'v6.21.0-beta.2';

/** 1x1 透明 PNG（截图 op 落盘用；尺寸由 options 决定，内容只要求能写盘）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 与 docs/contracts.md §6 一致的码表。 */
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
  10003: 'TaskChainExtraInfo',
  10004: 'TaskChainStopped',
  20000: 'SubTaskError',
  20001: 'SubTaskStart',
  20002: 'SubTaskCompleted',
  20003: 'SubTaskExtraInfo',
  20004: 'SubTaskStopped',
  30000: 'ReportRequest',
};

/** 不需要 init 就能处理的 op（契约 §2.4 生命周期 + 假侧车控制 op）。 */
const PRE_INIT_OPS = new Set(['init', 'ping', 'emit', 'finish', 'setRunning', 'captured', 'destroy']);

/** 写一行协议 JSON（stdout 只走协议）。 */
function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

/** 从 argv[2] / 环境变量取配置。 */
function readOptions() {
  const fromArgv = process.argv[2];
  if (typeof fromArgv === 'string' && fromArgv.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(fromArgv);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 落到环境变量。
    }
  }
  const raw = process.env.FAKE_SIDECAR_OPTIONS;
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 归一化一条事件项。 */
function normalizeEventItem(item) {
  if (item === null || typeof item !== 'object') return null;
  if (typeof item.event === 'string') {
    const code = Number.isInteger(item.code) ? item.code : 20003;
    return {
      event: item.event,
      code,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : (MESSAGE_NAMES[code] ?? `Code${code}`),
      details: item.details !== null && typeof item.details === 'object' ? item.details : {},
      delayMs: Number.isFinite(item.delayMs) ? Math.max(0, item.delayMs) : 0,
    };
  }
  if (typeof item.what === 'string' && item.what !== '') {
    return {
      event: 'maa',
      code: 20003,
      name: 'SubTaskExtraInfo',
      details: { ...(item.details !== null && typeof item.details === 'object' ? item.details : {}), what: item.what },
      delayMs: Number.isFinite(item.delayMs) ? Math.max(0, item.delayMs) : 0,
    };
  }
  if (Number.isInteger(item.code)) {
    return {
      event: 'maa',
      code: item.code,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : (MESSAGE_NAMES[item.code] ?? `Code${item.code}`),
      details: item.details !== null && typeof item.details === 'object' ? item.details : {},
      delayMs: Number.isFinite(item.delayMs) ? Math.max(0, item.delayMs) : 0,
    };
  }
  return null;
}

/**
 * 假侧车主循环。
 * @returns {Promise<void>} 无。
 */
async function main() {
  const options = readOptions();
  const coreVersion = typeof options.coreVersion === 'string' ? options.coreVersion : CORE_VERSION;
  const scriptedEvents = Array.isArray(options.events) ? options.events : [];
  const eventsOn = typeof options.eventsOn === 'string' ? options.eventsOn : 'start';
  const taskScripts = options.tasks !== null && typeof options.tasks === 'object' ? options.tasks : {};
  const replayScripts = options.replay !== null && typeof options.replay === 'object' ? options.replay : {};
  /** 每个任务类型被 start 过几次（replay 用）。 @type {Record<string, number>} */
  const startCounts = {};
  const onStart = typeof options.onStart === 'string' ? options.onStart : 'auto';
  const delays = options.delays !== null && typeof options.delays === 'object' ? options.delays : {};
  const opDelays = delays.ops !== null && typeof delays.ops === 'object' ? delays.ops : {};

  let inited = false;
  let running = options.running === true;
  let nextTaskId = 1;
  let seq = 0;
  /** @type {Array<{type:string,params:Record<string,any>,taskId:number}>} */
  const appends = [];
  /** @type {Array<{taskId:number,params:Record<string,any>}>} */
  const setParamsRecords = [];
  let starts = 0;
  let stops = 0;
  /** @type {number[]} */
  let taskChain = [];
  /** 处理过的 op 顺序（captured 返回，测优先通道用）。 @type {string[]} */
  const requestLog = [];
  /** @type {Record<string, any> | null} */
  let lastAppend = null;

  writeLine(process.stdout, {
    event: 'ready',
    sidecarVersion: typeof options.sidecarVersion === 'string' ? options.sidecarVersion : PROTOCOL_VERSION,
    protocolVersion: typeof options.protocolVersion === 'string' ? options.protocolVersion : PROTOCOL_VERSION,
    python: typeof options.python === 'string' ? options.python : '3.12.14',
    platform: 'win32',
  });

  /** 推送一条 maa 事件（seq 单调递增）。 */
  const emitMaa = (input = {}) => {
    const normalized = normalizeEventItem(input) ?? normalizeEventItem({ what: 'Unknown' });
    seq += 1;
    writeLine(process.stdout, {
      event: 'maa',
      seq,
      code: normalized.code,
      name: normalized.name,
      details: normalized.details,
      ts: new Date().toISOString(),
    });
  };

  /**
   * 回放一组事件脚本。
   * @param {Array<any>} items - 事件项。
   * @param {{ autoChain?: boolean, taskchain?: string|null, onDone?: () => void }} [opts] - 选项。
   * @returns {void}
   */
  const playEvents = (items, opts = {}) => {
    const chain = typeof opts.taskchain === 'string' ? opts.taskchain : null;
    const autoChain = opts.autoChain !== false;
    const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
    const list = (Array.isArray(items) ? items : []).map(normalizeEventItem).filter(Boolean);
    if (autoChain && chain !== null) emitMaa({ code: 10001, details: { taskchain: chain } });
    if (list.length === 0) {
      if (autoChain && chain !== null) emitMaa({ code: 10002, details: { taskchain: chain } });
      onDone?.();
      return;
    }
    let index = 0;
    const step = () => {
      if (index >= list.length) {
        if (autoChain && chain !== null) emitMaa({ code: 10002, details: { taskchain: chain } });
        onDone?.();
        return;
      }
      const item = list[index];
      index += 1;
      emitMaa(item);
      const delay = item.delayMs > 0 ? item.delayMs : (Number.isFinite(opts.gapMs) ? opts.gapMs : 0);
      if (delay > 0) setTimeout(step, delay);
      else setImmediate(step);
    };
    step();
  };

  /** 取某个任务的脚本配置。 */
  const taskScriptOf = (type) => {
    if (typeof type !== 'string' || !(type in taskScripts)) return null;
    const value = taskScripts[type];
    if (Array.isArray(value)) return { events: value, autoChain: true };
    if (value !== null && typeof value === 'object') {
      return {
        events: Array.isArray(value.events) ? value.events : [],
        autoChain: value.autoChain !== false,
        gapMs: Number.isFinite(value.gapMs) ? value.gapMs : 0,
      };
    }
    return null;
  };

  /** 回一条响应。 */
  const reply = (id, ok, body = {}) => {
    writeLine(process.stdout, ok ? { id, ok: true, result: body } : { id, ok: false, error: body });
  };

  /** 处理一条请求。 */
  const handle = (request) => {
    const id = Number.isInteger(request?.id) ? request.id : 0;
    const op = typeof request?.op === 'string' ? request.op : '';
    const args = request?.args !== null && typeof request.args === 'object' ? request.args : {};
    requestLog.push(op);

    if (!inited && !PRE_INIT_OPS.has(op)) {
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
          protocolVersion: typeof options.protocolVersion === 'string' ? options.protocolVersion : PROTOCOL_VERSION,
          maaPath: typeof args.maaPath === 'string' ? args.maaPath : '',
          userDir: typeof args.userDir === 'string' ? args.userDir : '',
        });
        if (Array.isArray(options.initEvents)) setTimeout(() => playEvents(options.initEvents, { autoChain: false }), 0);
        if (eventsOn === 'init') setTimeout(() => playEvents(scriptedEvents, { autoChain: false }), 0);
        return;
      }
      case 'version':
        reply(id, true, {
          coreVersion,
          protocolVersion: typeof options.protocolVersion === 'string' ? options.protocolVersion : PROTOCOL_VERSION,
        });
        return;
      case 'append': {
        if (options.failAppend === true) {
          reply(id, false, { code: 'E_TASK_TYPE', message: 'MAA 不接受该任务类型。', detail: 'fake failAppend' });
          return;
        }
        const type = typeof args.type === 'string' ? args.type : '';
        const rejectTypes = Array.isArray(options.rejectTypes) ? options.rejectTypes : [];
        if (type === '' || type === 'Bogus' || rejectTypes.includes(type)) {
          reply(id, false, { code: 'E_TASK_TYPE', message: 'MAA 不接受该任务类型。', detail: `type=${type}` });
          return;
        }
        const params = args.params !== null && typeof args.params === 'object' ? args.params : {};
        const taskId = nextTaskId;
        nextTaskId += 1;
        appends.push({ type, params, taskId });
        lastAppend = { type, params, taskId };
        taskChain.push(taskId);
        reply(id, true, { taskId });
        if (eventsOn === 'append') {
          const script = taskScriptOf(type);
          setTimeout(() => playEvents(script === null ? scriptedEvents : script.events, {
            autoChain: script === null ? false : script.autoChain,
            taskchain: script === null ? null : type,
          }), 0);
        }
        return;
      }
      case 'setParams': {
        if (options.failSetParams === true) {
          reply(id, false, { code: 'E_TASK_REJECTED', message: 'MAA 拒绝了任务参数更新', detail: 'fake failSetParams' });
          return;
        }
        const taskId = Number.isInteger(args.taskId) ? args.taskId : -1;
        const known = appends.some((item) => item.taskId === taskId);
        if (!known) {
          reply(id, false, { code: 'E_TASK_REJECTED', message: 'MAA 拒绝了任务参数更新', detail: `taskId=${taskId}` });
          return;
        }
        setParamsRecords.push({ taskId, params: args.params !== null && typeof args.params === 'object' ? args.params : {} });
        reply(id, true, { ok: true, taskId });
        return;
      }
      case 'start': {
        starts += 1;
        running = true;
        reply(id, true, { running: true });
        if (onStart === 'manual') return;
        const type = lastAppend === null ? null : lastAppend.type;
        let count = 1;
        if (typeof type === 'string') {
          count = (startCounts[type] ?? 0) + 1;
          startCounts[type] = count;
        }
        /** @type {{ events: Array<any>, autoChain: boolean, gapMs?: number } | null} */
        let replayScript = null;
        if (typeof type === 'string' && Array.isArray(replayScripts[type]) && replayScripts[type].length > 0) {
          const group = replayScripts[type][Math.min(count - 1, replayScripts[type].length - 1)];
          if (Array.isArray(group)) replayScript = { events: group, autoChain: true };
          else if (group !== null && typeof group === 'object') {
            replayScript = {
              events: Array.isArray(group.events) ? group.events : [],
              autoChain: group.autoChain !== false,
              gapMs: Number.isFinite(group.gapMs) ? group.gapMs : 0,
            };
          }
        }
        const script = replayScript ?? taskScriptOf(type ?? '');
        const legacyItems = script === null && scriptedEvents.length > 0 && eventsOn === 'start' ? scriptedEvents : null;
        if (script === null && legacyItems === null) {
          // 没有脚本：延迟一点把 running 置回 false，保证 waitForIdle 能结束。
          setTimeout(() => {
            running = false;
            taskChain = [];
            seq += 1;
            writeLine(process.stdout, {
              event: 'maa',
              seq,
              code: 10002,
              name: 'TaskChainCompleted',
              details: { taskchain: type ?? 'Unknown' },
              ts: new Date().toISOString(),
            });
          }, 5);
          return;
        }
        setTimeout(() => {
          playEvents(script === null ? legacyItems : script.events, {
            autoChain: script === null ? false : script.autoChain,
            taskchain: type,
            gapMs: script === null ? 0 : script.gapMs,
            onDone: () => {
              running = false;
              taskChain = [];
            },
          });
        }, 0);
        return;
      }
      case 'stop': {
        stops += 1;
        running = false;
        taskChain = [];
        reply(id, true, { running: false });
        if (Array.isArray(options.stopEvents) && options.stopEvents.length > 0) {
          setTimeout(() => playEvents(options.stopEvents, { autoChain: false }), 0);
        }
        return;
      }
      case 'running':
        reply(id, true, { running });
        return;
      case 'connected':
        reply(id, true, { connected: options.connected === null ? null : options.connected !== false });
        return;
      case 'connect': {
        if (options.failConnect === true) {
          reply(id, false, { code: 'E_CONNECT', message: '连接模拟器失败（fake）', detail: 'fake failConnect' });
          return;
        }
        reply(id, true, { connected: true });
        return;
      }
      case 'screenshot': {
        const shot = options.screenshot !== null && typeof options.screenshot === 'object' ? options.screenshot : {};
        if (shot.ok === false) {
          reply(id, false, {
            code: typeof shot.code === 'string' ? shot.code : 'E_NOT_SUPPORTED',
            message: typeof shot.message === 'string' ? shot.message : '截图不可用（fake）',
          });
          return;
        }
        const directory = typeof args.dir === 'string' && args.dir !== ''
          ? path.resolve(args.dir)
          : path.join(os.tmpdir(), 'dsh-arknights-fake-shots');
        try {
          fs.mkdirSync(directory, { recursive: true });
          const target = path.join(directory, `fake-shot-${Date.now()}-${process.pid}.png`);
          fs.writeFileSync(target, TINY_PNG);
          reply(id, true, {
            path: target,
            width: Number.isFinite(shot.width) ? shot.width : 1280,
            height: Number.isFinite(shot.height) ? shot.height : 720,
            bytes: TINY_PNG.length,
          });
        } catch (error) {
          reply(id, false, { code: 'E_NOT_SUPPORTED', message: '截图写入失败', detail: String(error) });
        }
        return;
      }
      case 'backHome':
        if (options.failBackHome === true) {
          reply(id, false, { code: 'E_TASK_REJECTED', message: 'AsstBackToHome 返回 false（fake）' });
          return;
        }
        reply(id, true, { ok: true });
        return;
      case 'tasks': {
        const ids = Array.isArray(options.taskIds)
          ? options.taskIds.filter((value) => Number.isInteger(value))
          : [...taskChain];
        reply(id, true, { taskIds: ids });
        return;
      }
      case 'destroy':
        inited = false;
        running = false;
        taskChain = [];
        reply(id, true, { destroyed: true });
        return;
      case 'emit': {
        const list = Array.isArray(args.events) ? args.events : [args];
        for (const item of list) emitMaa(item);
        reply(id, true, { emitted: list.length });
        return;
      }
      case 'finish': {
        const chain = lastAppend === null ? null : lastAppend.type;
        running = false;
        taskChain = [];
        if (chain !== null) emitMaa({ code: 10002, details: { taskchain: chain } });
        reply(id, true, { running: false });
        return;
      }
      case 'setRunning':
        running = args.running === true;
        reply(id, true, { running });
        return;
      case 'captured':
        reply(id, true, {
          appends: appends.map((item) => ({ type: item.type, params: item.params, taskId: item.taskId })),
          setParams: setParamsRecords.map((item) => ({ taskId: item.taskId, params: item.params })),
          starts,
          stops,
          startCounts: { ...startCounts },
          ops: [...requestLog],
        });
        return;
      default:
        reply(id, false, { code: 'E_BAD_OP', message: '侧车收到未知操作。', detail: `op=${op}` });
    }
  };

  /** 按 op 延迟表的调度处理。 */
  const handleMaybeDelayed = (request) => {
    const op = typeof request?.op === 'string' ? request.op : '';
    const delayMs = Number.isFinite(opDelays[op]) ? Math.max(0, opDelays[op]) : 0;
    // stop 永不走延迟队列：Node 侧 stop 优先通道要求它立刻被处理。
    if (op === 'stop' || delayMs <= 0) {
      handle(request);
      return;
    }
    setTimeout(() => handle(request), delayMs);
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
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          writeLine(process.stdout, { id: 0, ok: false, error: { code: 'E_PROTOCOL', message: '请求不是合法 JSON。' } });
          index = buffer.indexOf('\n');
          continue;
        }
        handleMaybeDelayed(request);
      }
      index = buffer.indexOf('\n');
    }
  });
  // stdin EOF → AsstDestroy → 退出码 0（契约 §2.4）。
  const shutdown = () => {
    inited = false;
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

/**
 * 起一个假侧车并返回驱动句柄。
 * @param {Record<string, any>} [options] - 见文件头注释。
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   send: (op: string, args?: Record<string, unknown>) => number,
 *   sendRaw: (line: string) => void,
 *   request: (op: string, args?: Record<string, unknown>) => Promise<Record<string, any>>,
 *   nextResponse: (id?: number) => Promise<Record<string, any>>,
 *   nextEvent: (name?: string) => Promise<Record<string, any>>,
 *   waitForEvent: (name: string, timeoutMs?: number) => Promise<Record<string, any>>,
 *   events: Array<Record<string, any>>,
 *   responses: Array<Record<string, any>>,
 *   captured: { appends: Array<Record<string, any>> },
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
  /** 本地记录通过驱动发出的 append 请求（断言参数用）。 */
  const captured = { appends: [] };
  let buffer = '';
  let nextId = 1;
  /** @type {Promise<{ code: number | null, signal: string | null }> | null} */
  let exitPromise = null;

  /** 从队列里取第一个匹配项；没有就排队等。 */
  const take = (items, waiters, match) => {
    const index = items.findIndex(match);
    if (index >= 0) return Promise.resolve(items.splice(index, 1)[0]);
    return new Promise((resolve) => {
      waiters.push({ match, resolve });
    });
  };

  /** 把排队的等待者和新到的消息配对。 */
  const flushWaiters = () => {
    for (const [waiters, pool] of [[responseWaiters, responses], [eventWaiters, events]]) {
      for (let index = 0; index < waiters.length; index += 1) {
        const found = pool.findIndex(waiters[index].match);
        if (found < 0) continue;
        const waiter = waiters.splice(index, 1)[0];
        waiter.resolve(pool.splice(found, 1)[0]);
        index -= 1;
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
    flushWaiters();
  });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', () => {
    // 假侧车的 stderr 不参与协议，丢弃。
  });

  /** 写一条请求，返回请求 id。 */
  const send = (op, args = {}) => {
    const id = nextId;
    nextId += 1;
    if (op === 'append' && args !== null && typeof args === 'object') {
      captured.appends.push({ type: args.type, params: args.params ?? {}, taskId: null });
    }
    child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    return id;
  };

  /** 等进程退出。 */
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
    captured,
    send,
    /** 写一行原始文本（测「非法 JSON 行」之类的协议错误）。 */
    sendRaw(line) {
      child.stdin.write(`${line}\n`);
    },
    /** 写一条请求并等它的响应。 */
    request(op, args = {}) {
      const id = send(op, args);
      return take(responses, responseWaiters, (value) => value.id === id);
    },
    /** 等下一条响应（可按 id 过滤）。 */
    nextResponse(id) {
      return take(responses, responseWaiters, typeof id === 'number' ? (value) => value.id === id : () => true);
    },
    /** 等下一条事件（可按事件名过滤，如 `'ready'` / `'maa'`）。 */
    nextEvent(name) {
      return take(events, eventWaiters, typeof name === 'string' ? (value) => value.event === name : () => true);
    },
    /**
     * 等一条满足条件的事件（超时会 reject）。
     * @param {string} name - 事件名（`ready`/`maa`）。
     * @param {number} [timeoutMs] - 超时。
     * @returns {Promise<Record<string, any>>} 事件。
     */
    waitForEvent(name, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`假侧车没有在 ${timeoutMs}ms 内发出 ${name} 事件。`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        take(events, eventWaiters, (value) => value.event === name).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
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

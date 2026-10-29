/**
 * lib/protocol.js + lib/maa-session.js 单元测试，以及假侧车（test/fake-sidecar.mjs）自检。
 * 契约：docs/contracts.md §2（NDJSON 线路协议 2.0）、§2.4（生命周期）。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MAX_LINE_BYTES,
  assertProtocolVersion,
  decodeLine,
  encodeLine,
  makeRequest,
  protocolMajor,
  readResult,
  validateInitResult,
  validateReady,
} from '../lib/protocol.js';
import { ArkError } from '../lib/errors.js';
import { createMaaSession } from '../lib/maa-session.js';
import { spawnFakeSidecar } from './fake-sidecar.mjs';

const FAKE_PATH = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

/** 断言抛出的是带指定 code 的 ArkError。 */
function assertArkCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArkError, `${label} 应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

/** 异步断言 reject 的 code。 */
async function assertRejectsCode(promise, code, label = '') {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `${label} 应 reject ArkError，实际：${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

/** 睡一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等到条件成立。 */
async function waitUntil(probe, timeoutMs = 3000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(10);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

/**
 * 起一个「真 session + 假侧车」的会话。
 * @param {Record<string, any>} [fakeOptions] - 假侧车选项。
 * @param {Record<string, any>} [sessionOptions] - 覆盖会话选项。
 * @returns {{ session: ReturnType<typeof createMaaSession>, created: Array<any> }} 会话与 spawn 记录。
 */
function makeFakeSession(fakeOptions = {}, sessionOptions = {}) {
  /** @type {Array<any>} */
  const created = [];
  const session = createMaaSession({
    pythonPath: process.execPath,
    sidecarPath: FAKE_PATH,
    sidecarArgs: [FAKE_PATH, JSON.stringify(fakeOptions)],
    resolveInit: async () => ({ maaPath: 'D:\\MAA', userDir: 'C:\\tmp', touchMode: 'minitouch', deploymentWithPause: false }),
    platform: 'win32',
    requestTimeoutMs: 10000,
    idleTimeoutMs: 120000,
    spawn: (command, args, options) => {
      const proc = spawn(command, args, options);
      created.push(proc);
      return proc;
    },
    ...sessionOptions,
  });
  return { session, created };
}

// ---------------------------------------------------------------------------
// protocol.js
// ---------------------------------------------------------------------------

test('protocol: makeRequest 补齐默认 args', () => {
  assert.deepEqual(makeRequest(1, 'ping'), { id: 1, op: 'ping', args: {} });
  assert.deepEqual(makeRequest(2, 'init', { maaPath: 'D:\\MAA' }), { id: 2, op: 'init', args: { maaPath: 'D:\\MAA' } });
});

test('protocol: makeRequest 把非对象 args 归一成 {}', () => {
  assert.deepEqual(makeRequest(1, 'ping', null).args, {});
  assert.deepEqual(makeRequest(1, 'ping', 'x').args, {});
  assert.deepEqual(makeRequest(1, 'ping', [1, 2]).args, {});
});

test('protocol: makeRequest 拒绝非法 id（必须是正整数）', () => {
  for (const id of [0, -1, 1.5, '1', null, undefined, NaN, Infinity]) {
    assertArkCode(() => makeRequest(id, 'ping'), 'E_BAD_OP', `id=${String(id)}`);
  }
});

test('protocol: makeRequest 拒绝缺失/非法 op', () => {
  for (const op of ['', null, undefined, 42, {}]) {
    assertArkCode(() => makeRequest(1, op), 'E_BAD_OP', `op=${String(op)}`);
  }
});

test('protocol: encodeLine → decodeLine 请求往返', () => {
  const line = encodeLine(makeRequest(7, 'init', { maaPath: 'D:\\MAA' }));
  assert.equal(typeof line, 'string');
  assert.equal(line.includes('\n'), false);
  const decoded = decodeLine(line);
  assert.equal(decoded.kind, 'response');
  assert.equal(decoded.id, 7);
  assert.equal(decoded.ok, false);
});

test('protocol: encodeLine 编码事件行', () => {
  const decoded = decodeLine(encodeLine({ event: 'maa', seq: 3, code: 10001, details: { taskchain: 'Fight' } }));
  assert.equal(decoded.kind, 'event');
  assert.equal(decoded.event, 'maa');
  assert.equal(decoded.payload.seq, 3);
  assert.equal(decoded.payload.details.taskchain, 'Fight');
});

test('protocol: encodeLine 对不可 JSON 化的对象抛 E_PROTOCOL', () => {
  const circular = {};
  circular.self = circular;
  assertArkCode(() => encodeLine(circular), 'E_PROTOCOL');
  assertArkCode(() => encodeLine({ big: 1n }), 'E_PROTOCOL');
});

test('protocol: decodeLine 拒绝空行/纯空白', () => {
  for (const line of ['', '   ', '\t', null, undefined]) {
    assertArkCode(() => decodeLine(line), 'E_PROTOCOL');
  }
});

test('protocol: decodeLine 拒绝非 JSON 文本', () => {
  assertArkCode(() => decodeLine('not-json'), 'E_PROTOCOL');
  assertArkCode(() => decodeLine('{"id":1'), 'E_PROTOCOL');
});

test('protocol: decodeLine 拒绝非对象 JSON（数组/标量/null）', () => {
  for (const line of ['[]', '[1,2]', 'null', '42', '"text"', 'true']) {
    assertArkCode(() => decodeLine(line), 'E_PROTOCOL', line);
  }
});

test('protocol: decodeLine 拒绝既无 id 也无 event 的对象', () => {
  assertArkCode(() => decodeLine('{}'), 'E_PROTOCOL');
  assertArkCode(() => decodeLine('{"ok":true}'), 'E_PROTOCOL');
  assertArkCode(() => decodeLine('{"event":""}'), 'E_PROTOCOL');
});

test('protocol: decodeLine 拒绝超长行（8 MiB 上限）', () => {
  assert.equal(MAX_LINE_BYTES, 8 * 1024 * 1024);
  const huge = 'x'.repeat(MAX_LINE_BYTES + 1);
  assertArkCode(() => decodeLine(huge), 'E_PROTOCOL');
});

test('protocol: decodeLine 解析成功/失败响应（error 原样保留）', () => {
  const ok = decodeLine('{"id":1,"ok":true,"result":{"coreVersion":"v6"}}');
  assert.deepEqual(ok, { kind: 'response', id: 1, ok: true, result: { coreVersion: 'v6' }, error: undefined });
  const bad = decodeLine('{"id":2,"ok":false,"error":{"code":"E_NOT_INIT","message":"no"}}');
  assert.equal(bad.kind, 'response');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.error, { code: 'E_NOT_INIT', message: 'no' });
  assert.equal(decodeLine('{"id":3}').ok, false);
});

test('protocol: readResult 只接受对象 result', () => {
  assert.deepEqual(readResult({ ok: true, result: { a: 1 } }, 'ping'), { a: 1 });
  assert.deepEqual(readResult({ ok: false, error: {} }, 'ping'), {});
  assert.deepEqual(readResult({ ok: true }, 'ping'), {});
  assert.deepEqual(readResult({ ok: true, result: null }, 'ping'), {});
  assertArkCode(() => readResult({ ok: true, result: [1] }, 'ping'), 'E_PROTOCOL');
  assertArkCode(() => readResult({ ok: true, result: 'x' }, 'ping'), 'E_PROTOCOL');
});

test('protocol: protocolMajor / assertProtocolVersion 校验主版本', () => {
  assert.equal(protocolMajor('2.0.0'), 2);
  assert.equal(protocolMajor('2.7.3-beta.1'), 2);
  assert.equal(protocolMajor('3.0.0'), 3);
  assert.equal(protocolMajor(''), null);
  assert.equal(protocolMajor(null), null);
  assert.equal(assertProtocolVersion('2.0.0'), '2.0.0');
  assert.equal(assertProtocolVersion('2.9.1'), '2.9.1');
  assertArkCode(() => assertProtocolVersion('1.0.0'), 'E_PROTOCOL_VERSION');
  assertArkCode(() => assertProtocolVersion('3.0.0'), 'E_PROTOCOL_VERSION');
  assertArkCode(() => assertProtocolVersion(''), 'E_PROTOCOL_VERSION');
  assertArkCode(() => assertProtocolVersion(undefined), 'E_PROTOCOL_VERSION');
});

test('protocol: validateReady 要求 sidecarVersion + 合法 protocolVersion', () => {
  assert.deepEqual(
    validateReady({ sidecarVersion: '2.0.0', protocolVersion: '2.0.0', python: '3.12.14', platform: 'win32' }),
    { sidecarVersion: '2.0.0', protocolVersion: '2.0.0', python: '3.12.14', platform: 'win32' },
  );
  assert.deepEqual(
    validateReady({ sidecarVersion: '2.0.0', protocolVersion: '2.1.0' }),
    { sidecarVersion: '2.0.0', protocolVersion: '2.1.0', python: '', platform: '' },
  );
  assertArkCode(() => validateReady({}), 'E_PROTOCOL');
  assertArkCode(() => validateReady({ sidecarVersion: '' }), 'E_PROTOCOL');
  // 缺 protocolVersion / 主版本不一致 → E_PROTOCOL_VERSION
  assertArkCode(() => validateReady({ sidecarVersion: '2.0.0' }), 'E_PROTOCOL_VERSION');
  assertArkCode(() => validateReady({ sidecarVersion: '2.0.0', protocolVersion: '1.0.0' }), 'E_PROTOCOL_VERSION');
});

test('protocol: validateInitResult 校验版本/资源加载/协议版本', () => {
  assert.deepEqual(
    validateInitResult({ coreVersion: 'v6.21.0-beta.2', resourceLoaded: true, protocolVersion: '2.0.0' }),
    { coreVersion: 'v6.21.0-beta.2', resourceLoaded: true, protocolVersion: '2.0.0' },
  );
  // 不传 protocolVersion 时容忍（以 ready 校验为准），返回空串
  assert.deepEqual(validateInitResult({ coreVersion: 'v6', resourceLoaded: true }), {
    coreVersion: 'v6',
    resourceLoaded: true,
    protocolVersion: '',
  });
  assertArkCode(() => validateInitResult({ resourceLoaded: true }), 'E_MAA_LOAD');
  assertArkCode(() => validateInitResult({ coreVersion: 'v6', resourceLoaded: false }), 'E_MAA_LOAD');
  assertArkCode(() => validateInitResult({ coreVersion: 'v6', resourceLoaded: 'true' }), 'E_MAA_LOAD');
  assertArkCode(
    () => validateInitResult({ coreVersion: 'v6', resourceLoaded: true, protocolVersion: '1.9.0' }),
    'E_PROTOCOL_VERSION',
  );
});

// ---------------------------------------------------------------------------
// fake sidecar：协议 2.0 自检
// ---------------------------------------------------------------------------

test('protocol: 假侧车 ready 带 protocolVersion=2.0.0', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    const ready = await sidecar.nextEvent('ready');
    assert.equal(ready.event, 'ready');
    assert.equal(ready.sidecarVersion, '2.0.0');
    assert.equal(ready.protocolVersion, '2.0.0');
    assert.equal(ready.platform, 'win32');
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 init 前只允许 ping/控制 op，其它 E_NOT_INIT', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    await sidecar.nextEvent('ready');
    assert.deepEqual((await sidecar.request('ping')).result, { pong: true, inited: false });
    assert.equal((await sidecar.request('append', { type: 'Fight' })).error.code, 'E_NOT_INIT');
    assert.equal((await sidecar.request('version')).error.code, 'E_NOT_INIT');
    assert.equal((await sidecar.request('screenshot')).error.code, 'E_NOT_INIT');

    const init = await sidecar.request('init', {
      maaPath: 'D:\\MAA',
      userDir: 'C:\\u',
      touchMode: 'minitouch',
      deploymentWithPause: false,
    });
    assert.equal(init.ok, true);
    assert.equal(init.result.protocolVersion, '2.0.0');
    assert.equal(init.result.resourceLoaded, true);
    assert.equal(typeof init.result.coreVersion, 'string');
    assert.deepEqual((await sidecar.request('ping')).result, { pong: true, inited: true });
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 init 失败返回 E_MAA_LOAD', async () => {
  const sidecar = spawnFakeSidecar({ failInit: true });
  try {
    await sidecar.nextEvent('ready');
    const response = await sidecar.request('init', { maaPath: 'D:\\MAA' });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'E_MAA_LOAD');
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 append 捕获 / taskId / tasks / setParams', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    const append = await sidecar.request('append', { type: 'Fight', params: { stage: '5-10', times: 2 } });
    assert.equal(append.ok, true);
    assert.equal(append.result.taskId, 1);
    const second = await sidecar.request('append', { type: 'Recruit', params: {} });
    assert.equal(second.result.taskId, 2);
    assert.deepEqual(sidecar.captured.appends[0], { type: 'Fight', params: { stage: '5-10', times: 2 }, taskId: null });

    assert.deepEqual((await sidecar.request('tasks')).result.taskIds, [1, 2]);
    assert.deepEqual((await sidecar.request('setParams', { taskId: 1, params: { times: 3 } })).result, { ok: true, taskId: 1 });
    assert.equal((await sidecar.request('setParams', { taskId: 999, params: {} })).error.code, 'E_TASK_REJECTED');
    assert.equal((await sidecar.request('append', { type: 'Bogus', params: {} })).error.code, 'E_TASK_TYPE');

    const captured = await sidecar.request('captured');
    assert.equal(captured.result.appends.length, 2);
    assert.deepEqual(captured.result.setParams, [{ taskId: 1, params: { times: 3 } }]);
    assert.equal(captured.result.starts, 0);
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 replay 按任务类型 + 第几次 start 回放', async () => {
  const sidecar = spawnFakeSidecar({
    replay: {
      Fight: [
        [
          { what: 'StageDrops', details: { stars: 3, stats: [{ itemName: '源岩', quantity: 1 }] } },
          { what: 'StageDrops', details: { stars: 3, stats: [{ itemName: '源岩', quantity: 2 }] } },
        ],
        [{ what: 'StageDrops', details: { stars: 2 } }],
      ],
    },
  });
  /** 从假侧车连续收集 n 条 maa 事件。 */
  const collect = async (count) => {
    const out = [];
    while (out.length < count) out.push(await sidecar.nextEvent('maa'));
    return out;
  };
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    await sidecar.request('append', { type: 'Fight', params: { stage: '5-10' } });

    // 第 1 次 start：两条三星 StageDrops
    await sidecar.request('start');
    const first = await collect(4);
    assert.deepEqual(first.map((event) => event.code), [10001, 20003, 20003, 10002]);
    assert.deepEqual(first.slice(1, 3).map((event) => event.details.stars), [3, 3]);
    await waitUntil(async () => (await sidecar.request('running')).result.running === false, 3000, '第一次 running=false');

    // 第 2 次 start：一局二星（按次数切脚本）
    await sidecar.request('start');
    const second = await collect(3);
    assert.deepEqual(second.map((event) => event.code), [10001, 20003, 10002]);
    assert.equal(second[1].details.stars, 2);

    const captured = await sidecar.request('captured');
    assert.deepEqual(captured.result.startCounts, { Fight: 2 });
  } finally {
    sidecar.kill();
  }
});
test('protocol: 假侧车 start 回放任务链事件并让 running 自动变回 false', async () => {
  const sidecar = spawnFakeSidecar({
    tasks: {
      Recruit: {
        events: [
          { what: 'RecruitResult', details: { level: 5 } },
          { what: 'RecruitTagsDetected', details: { tags: ['近战位'] } },
        ],
      },
    },
  });
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    const appended = await sidecar.request('append', { type: 'Recruit', params: {} });
    assert.equal(appended.result.taskId, 1);
    await sidecar.request('start');

    /** @type {Array<Record<string, any>>} */
    const events = [];
    const collected = (async () => {
      while (events.length < 4) {
        events.push(await sidecar.nextEvent('maa'));
      }
    })();
    await collected;
    assert.deepEqual(events.map((event) => event.code), [10001, 20003, 20003, 10002]);
    assert.equal(events[0].details.taskchain, 'Recruit');
    assert.equal(events[1].details.what, 'RecruitResult');
    assert.equal(events[3].name, 'TaskChainCompleted');
    await waitUntil(async () => (await sidecar.request('running')).result.running === false, 3000, 'running=false');
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 screenshot / backHome / connected / stop / destroy', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    assert.deepEqual((await sidecar.request('connected')).result, { connected: true });
    const shot = await sidecar.request('screenshot', { dir: 'C:\\tmp\\shots' });
    assert.equal(shot.ok, true);
    assert.equal(typeof shot.result.path, 'string');
    assert.equal(shot.result.width, 1280);
    assert.equal(shot.result.height, 720);
    assert.ok(shot.result.bytes > 0);
    assert.deepEqual((await sidecar.request('backHome')).result, { ok: true });
    assert.deepEqual((await sidecar.request('stop')).result, { running: false });
    await sidecar.request('start');
    await sidecar.request('stop');
    assert.equal((await sidecar.request('running')).result.running, false);
    assert.deepEqual((await sidecar.request('destroy')).result, { destroyed: true });
    assert.equal((await sidecar.request('ping')).result.inited, false);
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 screenshot 可配置降级为 E_NOT_SUPPORTED', async () => {
  const sidecar = spawnFakeSidecar({ screenshot: { ok: false, code: 'E_NOT_SUPPORTED' } });
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    const shot = await sidecar.request('screenshot');
    assert.equal(shot.ok, false);
    assert.equal(shot.error.code, 'E_NOT_SUPPORTED');
    assert.match(shot.error.message, /截图不可用/);
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 emit 控制 op 随时插事件', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    await sidecar.request('emit', { what: 'ConnectionInfo', details: { what: 'ConnectSuccess' } });
    const event = await sidecar.nextEvent('maa');
    assert.equal(event.code, 20003);
    assert.equal(event.details.what, 'ConnectionInfo');
  } finally {
    sidecar.kill();
  }
});

test('protocol: 假侧车 stdin EOF 后退出码 0', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    await sidecar.nextEvent('ready');
    await sidecar.request('init', { maaPath: 'D:\\MAA' });
    sidecar.closeStdin();
    const exit = await sidecar.waitExit(5000);
    assert.equal(exit.code, 0);
  } finally {
    sidecar.kill();
  }
});

// ---------------------------------------------------------------------------
// maa-session：真会话 + 假侧车
// ---------------------------------------------------------------------------

test('session: ensureStarted/request/subscribe/stop 全链路（假侧车）', async () => {
  const { session } = makeFakeSession({
    tasks: { Recruit: { events: [{ what: 'RecruitResult', details: { level: 5 } }] } },
  });
  /** @type {Array<Record<string, any>>} */
  const events = [];
  try {
    const unsubscribe = session.subscribe((event) => events.push(event));
    const info = await session.ensureStarted();
    assert.equal(info.coreVersion, 'v6.21.0-beta.2');
    assert.equal(info.protocolVersion, '2.0.0');
    assert.equal(info.resourceLoaded, true);

    const appended = await session.request('append', { type: 'Recruit', params: { times: 1 } });
    assert.equal(appended.taskId, 1);
    await session.request('start');
    await waitUntil(() => events.some((event) => event.name === 'maa' && event.payload.code === 10002), 3000, '链结束事件');
    assert.ok(events.some((event) => event.payload.details?.what === 'RecruitResult'));

    const captured = await session.request('captured');
    assert.deepEqual(captured.appends, [{ type: 'Recruit', params: { times: 1 }, taskId: 1 }]);
    assert.equal(captured.starts, 1);

    const tasks = await session.tasks();
    assert.deepEqual(tasks.taskIds, []);
    assert.deepEqual(await session.backHome(), { ok: true });
    const shot = await session.screenshot({ dir: undefined });
    assert.equal(typeof shot.width, 'number');
    assert.equal(typeof shot.height, 'number');
    assert.equal(typeof shot.path, 'string');
    unsubscribe();
  } finally {
    session.dispose();
  }
});

test('session: setParams / 便捷方法', async () => {
  const { session } = makeFakeSession();
  try {
    await session.ensureStarted();
    const appended = await session.request('append', { type: 'Fight', params: { stage: '5-10' } });
    const updated = await session.setParams(appended.taskId, { stage: '5-10', times: 2 });
    assert.equal(updated.ok, true);
    await assertRejectsCode(session.setParams(999, {}), 'E_TASK_REJECTED');
  } finally {
    session.dispose();
  }
});

test('session: ready 协议主版本不一致 → E_PROTOCOL_VERSION 并杀进程', async () => {
  const { session, created } = makeFakeSession({ protocolVersion: '1.0.0' });
  try {
    await assertRejectsCode(session.ensureStarted(), 'E_PROTOCOL_VERSION');
    await waitUntil(() => session.isRunning() === false, 3000, '侧车被终止');
    assert.equal(created.length, 1);
  } finally {
    session.dispose();
  }
});

test('session: stop 走优先通道，不排在普通请求队列后面', async () => {
  // connect 在假侧车里被延迟 600ms；stop 必须立刻发出并立刻返回。
  const { session } = makeFakeSession({ delays: { ops: { connect: 600 } } });
  try {
    await session.ensureStarted();
    const slow = session.request('connect', { adbPath: 'C:\\adb.exe', address: '127.0.0.1:16384' });
    await sleep(80);
    // 普通队列里的下一条：只有 connect 完成后才会被发送。
    const queued = session.request('version');
    await sleep(30);
    const startedAt = Date.now();
    const stopped = await session.stop();
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(stopped, { running: false });
    assert.ok(elapsed < 500, `stop 应优先返回，实际 ${elapsed}ms`);

    await slow;
    await queued;
    const captured = await session.request('captured');
    const ops = captured.ops;
    assert.ok(ops.indexOf('stop') >= 0, `captured ops 里应有 stop：${JSON.stringify(ops)}`);
    assert.ok(ops.indexOf('stop') < ops.indexOf('version'), `stop 应先于排队的 version：${JSON.stringify(ops)}`);
    assert.equal(captured.stops, 1);
  } finally {
    session.dispose();
  }
});

test('session: 侧车崩溃后下次请求透明重启', async () => {
  const { session, created } = makeFakeSession();
  try {
    await session.ensureStarted();
    assert.equal(created.length, 1);
    created[0].kill();
    await waitUntil(() => session.isRunning() === false, 3000, '旧进程退出');
    const ping = await session.request('ping');
    assert.equal(ping.pong, true);
    assert.ok(created.length >= 2, '应重新 spawn 侧车');
    const info = session.getInfo();
    assert.equal(info.protocolVersion, '2.0.0');
  } finally {
    session.dispose();
  }
});

test('session: 单请求超时 → E_TIMEOUT 并杀进程', async () => {
  const { session } = makeFakeSession({ delays: { ops: { ping: 5000 } } });
  try {
    await session.ensureStarted();
    const startedAt = Date.now();
    await assertRejectsCode(session.request('ping', {}, { timeoutMs: 1000 }), 'E_TIMEOUT');
    assert.ok(Date.now() - startedAt < 3000, '超时不应拖太久');
    await waitUntil(() => session.isRunning() === false, 3000, '侧车被终止');
  } finally {
    session.dispose();
  }
});

test('session: 未启动时 stop 直接返回（不冷启动 MaaCore）', async () => {
  const { session, created } = makeFakeSession();
  try {
    assert.deepEqual(await session.stop(), { running: false, inited: false });
    assert.equal(created.length, 0);
  } finally {
    session.dispose();
  }
});

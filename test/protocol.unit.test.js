/**
 * lib/protocol.js 单元测试 + 假侧车（test/fake-sidecar.mjs）自检。
 * 契约：docs/contracts.md §2（NDJSON 线路协议）、§2.5（生命周期约束）。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LINE_BYTES,
  decodeLine,
  encodeLine,
  makeRequest,
  readResult,
  validateInitResult,
  validateReady,
} from '../lib/protocol.js';
import { ArkError } from '../lib/errors.js';
import { spawnFakeSidecar } from './fake-sidecar.mjs';

/** 断言抛出的是带指定 code 的 ArkError。 */
function assertArkCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArkError, `${label} 应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

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

test('protocol: decodeLine 拒绝超长行', () => {
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

test('protocol: validateReady 要求 sidecarVersion', () => {
  assert.deepEqual(validateReady({ sidecarVersion: '1.0.0', python: '3.12.14' }), { sidecarVersion: '1.0.0', python: '3.12.14' });
  assert.deepEqual(validateReady({ sidecarVersion: '1.0.0' }), { sidecarVersion: '1.0.0', python: '' });
  assertArkCode(() => validateReady({}), 'E_PROTOCOL');
  assertArkCode(() => validateReady({ sidecarVersion: '' }), 'E_PROTOCOL');
});

test('protocol: validateInitResult 校验版本与资源加载', () => {
  assert.deepEqual(validateInitResult({ coreVersion: 'v6.21.0-beta.2', resourceLoaded: true }), {
    coreVersion: 'v6.21.0-beta.2',
    resourceLoaded: true,
  });
  assertArkCode(() => validateInitResult({ resourceLoaded: true }), 'E_MAA_LOAD');
  assertArkCode(() => validateInitResult({ coreVersion: 'v6', resourceLoaded: false }), 'E_MAA_LOAD');
  assertArkCode(() => validateInitResult({ coreVersion: 'v6', resourceLoaded: 'true' }), 'E_MAA_LOAD');
});

test('protocol: 假侧车 ready + ping 往返（init 前后的 inited）', async () => {
  const sidecar = spawnFakeSidecar();
  try {
    const ready = await sidecar.nextEvent('ready');
    assert.equal(ready.event, 'ready');
    assert.equal(ready.sidecarVersion, '1.0.0');
    assert.equal(ready.platform, 'win32');

    // init 之前：ping 可用，其它 op 拒绝。
    const pingId = sidecar.send('ping');
    const ping = await sidecar.nextResponse(pingId);
    assert.deepEqual(ping.result, { pong: true, inited: false });

    const appendId = sidecar.send('append', { type: 'Fight' });
    const append = await sidecar.nextResponse(appendId);
    assert.equal(append.ok, false);
    assert.equal(append.error.code, 'E_NOT_INIT');

    // init 之后：inited=true，append 返回 taskId。
    const initId = sidecar.send('init', { maaPath: 'D:\\MAA', userDir: 'C:\\u', touchMode: 'minitouch', deploymentWithPause: false });
    const init = await sidecar.nextResponse(initId);
    assert.equal(init.ok, true);
    assert.equal(init.result.resourceLoaded, true);
    assert.equal(typeof init.result.coreVersion, 'string');

    const pingId2 = sidecar.send('ping');
    assert.deepEqual((await sidecar.nextResponse(pingId2)).result, { pong: true, inited: true });

    const bogus = await sidecar.request('append', { type: 'Bogus' });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.error.code, 'E_TASK_TYPE');

    const okAppend = await sidecar.request('append', { type: 'Fight', params: { stage: '5-10' } });
    assert.equal(okAppend.ok, true);
    assert.ok(okAppend.result.taskId > 0);
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

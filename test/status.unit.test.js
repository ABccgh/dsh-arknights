/**
 * lib/status.js 单元测试：状态 JSON 形状、只读、可选依赖缺失时的降级。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStatus } from '../lib/status.js';
import { normalizeConfig, resolvePaths } from '../lib/config.js';

/**
 * 造一份完整依赖。
 * @param {Record<string, any>} [overrides] - 覆盖。
 * @returns {Record<string, any>} 依赖。
 */
function makeDeps(overrides = {}) {
  const config = normalizeConfig();
  return {
    config,
    paths: resolvePaths(config),
    env: {
      peek: () => ({
        maaPath: 'D:\\MAA',
        pythonPath: 'C:\\py\\python.exe',
        adbPath: 'C:\\adb.exe',
        address: '127.0.0.1:16384',
        emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, vmIndex: 0, name: 'MuMu' },
      }),
      get: async () => { throw new Error('状态路由不应触发探测'); },
    },
    session: {
      getInfo: () => ({ coreVersion: 'v6.21.0', resourceLoaded: true, protocolVersion: '2.0.0' }),
      isRunning: () => true,
    },
    state: {
      snapshot: () => ({
        tasks: { running: false, current: null, chains: [] },
        sanity: { current: 100, max: 135 },
        drops: { 固源岩: 2 },
        events: [{ seq: 1, name: 'TaskChainCompleted', task: 'Fight' }],
      }),
    },
    ledger: {
      view: () => ({ fullStar: 2, missing: 1, primeClaimed: 2, entries: [] }),
      pushView: () => ({ nextStage: '5-11', lastStopped: '5-11', lastReason: 'not-three-stars' }),
      dailyView: () => ({ date: '2026-10-29', tasks: { award: { ok: true, at: 'x' }, mall: {} } }),
    },
    box: { summary: () => ({ operators: 10, depotItems: 20, updatedAt: '2026-10-29T00:00:00.000Z', partial: false }) },
    data: { meta: () => ({ stages: 608, items: 482, arkrec: { ok: true, ageMs: 1000 }, penguin: { ageMs: 2000 }, activity: { ageMs: 3000 }, warnings: [] }) },
    runStore: { snapshot: () => ({ run: null, lastRun: { id: 'run-1', kind: 'daily', status: 'completed', endedAt: '2026-10-29T00:00:00.000Z', result: { daily: { tasks: { award: { ok: true } } } } } }) },
    connection: () => ({ connected: true, address: '127.0.0.1:16384', at: '2026-10-29T00:00:00.000Z' }),
    lastError: () => ({ lastCode: 'E_NO_SOLUTION', lastMessage: '没有作业', at: '2026-10-29T00:00:00.000Z' }),
    now: () => '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

test('status: 形状与契约 §5 一致', async () => {
  const status = createStatus(makeDeps());
  const object = await status.build();
  assert.equal(object.ok, true);
  assert.equal(object.schema, 2);
  assert.equal(object.ts, '2026-10-29T00:00:00.000Z');
  assert.equal(object.sidecar.coreVersion, 'v6.21.0');
  assert.equal(object.sidecar.protocolVersion, '2.0.0');
  assert.equal(object.paths.maaPath, 'D:\\MAA');
  assert.equal(object.emulator.androidStarted, true);
  assert.equal(object.connection.connected, true);
  assert.equal(object.sanity.current, 100);
  assert.equal(object.ledger.fullStar, 2);
  assert.equal(object.push.nextStage, '5-11');
  assert.equal(object.daily.tasks.award.ok, true);
  assert.equal(object.box.operators, 10);
  assert.equal(object.data.stages, 608);
  assert.equal(object.run, null);
  assert.equal(object.lastRun.kind, 'daily');
  assert.equal(object.lastRun.result.daily.tasks.award.ok, true);
  assert.equal(object.errors.lastCode, 'E_NO_SOLUTION');
  assert.equal(object.safety.allowSanityPotion, false);
  assert.equal(object.config.confirmRequired, true);
  assert.equal(object.events.length, 1);
});

test('status: 不触发探测（refreshEmulator=false）', async () => {
  let getCalls = 0;
  const deps = makeDeps({
    env: {
      peek: () => null,
      get: async () => { getCalls += 1; return {}; },
    },
    v: undefined,
  });
  const object = await createStatus(deps).build();
  assert.equal(getCalls, 0);
  assert.equal(object.paths.maaPath, '');
  assert.equal(object.sidecar.alive, true);
});

test('status: refreshEmulator=true 只后台刷新，不 await', async () => {
  let getCalls = 0;
  const deps = makeDeps({
    env: {
      peek: () => null,
      get: async () => { getCalls += 1; await new Promise((r) => setTimeout(r, 20)); return {}; },
    },
  });
  const status = createStatus(deps);
  await status.build({ refreshEmulator: true });
  assert.equal(getCalls, 1);
  await new Promise((r) => setTimeout(r, 30));
});

test('status: 依赖缺失时降级不抛错', async () => {
  const config = normalizeConfig();
  const status = createStatus({ config, paths: resolvePaths(config) });
  const object = await status.build();
  assert.equal(object.ok, true);
  assert.equal(object.sidecar.alive, false);
  assert.equal(object.ledger.fullStar, 0);
  assert.equal(object.box.operators, 0);
  assert.deepEqual(object.events, []);
  assert.equal(object.daily.tasks?.award, undefined);
});

test('status: run result 被裁剪（大数组/长字符串）', async () => {
  const deps = makeDeps({
    runStore: {
      snapshot: () => ({
        run: {
          id: 'run-2',
          kind: 'box',
          status: 'running',
          startedAt: 'x',
          updatedAt: 'y',
          phase: 'scan',
          result: { big: Array.from({ length: 100 }, (_, index) => ({ index, text: 'x'.repeat(900) })) },
        },
        lastRun: null,
      }),
    },
  });
  const object = await createStatus(deps).build();
  assert.equal(object.run.phase, 'scan');
  assert.equal(object.run.result.big.length, 20);
  assert.ok(object.run.result.big[0].text.length <= 501);
});

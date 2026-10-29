/**
 * fight 端到端集成：**真** `lib/maa-session.js` + `test/fake-sidecar.mjs` 子进程 +
 * `lib/actions/runtime.js` 的 runTaskChain/waitForIdle + `lib/state.js` 事件归一化 +
 * v2 账本，只把 `ensureReady`/`dismissOverlays`（会碰模拟器/adb）替换成空实现。
 *
 * 覆盖：Fight 事件 `StageQueueUnableToAgent` → 停止原链 → 自动改写 Copilot →
 * 三星入账；并检查侧车实际收到的 append 参数（Fight stage / Copilot loop_times 等）。
 * 全程离线，不消耗理智。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { createLedger } from '../lib/ledger.js';
import { createMaaSession } from '../lib/maa-session.js';
import { createState } from '../lib/state.js';
import { createRuntime } from '../lib/actions/runtime.js';
import { createFightAction } from '../lib/actions/fight.js';
import { createRunStore } from '../lib/actions/shared.js';
import { makeTempDir, removeDir } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeSidecarPath = path.join(here, 'fake-sidecar.mjs');

/** 打关卡用的最小资源表（不读真实 MAA resource）。 */
const STAGES = [
  { stageId: 'main_05-10', code: '5-10', prefix: 'main_', suffix: '05-10', apCost: 18, dropItems: [] },
  { stageId: 'tough_05-10', code: '5-10', prefix: 'tough_', suffix: '05-10', apCost: 21, dropItems: [] },
];

/** 假作业：Fight 无法代理时会被使用。 */
function makeCopilot() {
  const state = { queries: [], materialized: [] };
  return {
    state,
    async query(code) {
      state.queries.push(code);
      return {
        solutions: [{
          id: 104178,
          stageName: 'main_05-10',
          title: '作业A',
          uploader: '博士',
          opers: ['德克萨斯'],
          available: true,
          contentRaw: '{"actions":[{}]}',
          ratingLevel: 3,
        }],
        reason: '',
        total: 1,
      };
    },
    pick: (solutions) => solutions,
    async detail(id) {
      return { id, contentRaw: '{"actions":[{}]}', stageName: 'main_05-10' };
    },
    async materialize(solution, code) {
      state.materialized.push({ solution, code });
      return `C:\\tmp\\${code}-${solution.id}.json`;
    },
    hasExecutableActions: () => true,
  };
}

test('fight 集成：fake-sidecar 事件 UnableToAgent → 自动抄作业三星，参数正确', { timeout: 60000 }, async () => {
  const tempDir = makeTempDir('dsh-ark-fight-sidecar-');
  /** @type {ReturnType<typeof createMaaSession> | null} */
  let session = null;
  try {
    const state = createState();
    session = createMaaSession({
      pythonPath: process.execPath,
      sidecarPath: fakeSidecarPath,
      sidecarArgs: [fakeSidecarPath, JSON.stringify({
        protocolVersion: '2.0.0',
        tasks: {
          Fight: {
            gapMs: 0,
            // 300ms：给 waitForIdle 至少一轮轮询看到「无法代理」，又不至于拖慢测试。
            events: [{ what: 'StageQueueUnableToAgent', delayMs: 300 }],
          },
          Copilot: {
            gapMs: 0,
            events: [{ what: 'StageDrops', details: { stars: 3, stats: [{ itemName: '固源岩', quantity: 2 }] }, delayMs: 300 }],
          },
        },
      })],
      resolveInit: async () => ({ maaPath: path.join(tempDir, 'maa'), userDir: path.join(tempDir, 'maa-user') }),
      platform: 'win32',
      requestTimeoutMs: 10000,
      startupTimeoutMs: 20000,
      idleTimeoutMs: 60000,
      logger: { info() {}, warn() {} },
    });
    session.subscribe((event) => state.pushEvent(event.payload));

    const config = normalizeConfig();
    const realRuntime = createRuntime({
      config,
      paths: { userDir: path.join(tempDir, 'maa-user') },
      env: {
        get: async () => ({
          maaPath: path.join(tempDir, 'maa'),
          pythonPath: process.execPath,
          adbPath: '',
          address: '',
          emulator: {},
        }),
        clear: () => {},
        peek: () => null,
      },
      session,
      state,
      logger: { info() {}, warn() {} },
    });
    // 只替换会碰模拟器/adb 的两步；runTaskChain/waitForIdle/stopQuietly 用真实实现。
    const runtime = {
      ...realRuntime,
      ensureReady: async () => ({ address: '127.0.0.1:16384' }),
      dismissOverlays: async () => {},
      screenshot: async () => ({ path: 'shot.png', method: 'maa' }),
    };

    const ledger = createLedger({ file: path.join(tempDir, 'progress.json'), logger: { warn() {} } });
    const copilot = makeCopilot();
    const store = createRunStore({ logger: { info() {}, warn() {} } });
    const action = createFightAction({
      config,
      paths: { userDir: path.join(tempDir, 'maa-user') },
      env: {},
      session,
      state,
      ledger,
      copilot,
      arkrec: { describe: async () => null },
      resources: async () => ({ stages: STAGES, itemNames: { 30011: '固源岩' } }),
      runtime,
      store,
      logger: { info() {}, warn() {} },
    });

    const response = await action({ stages: '5-10', times: 2, confirm: true });
    assert.equal(response.ok, true);
    assert.equal(response.done, true);
    assert.equal(response.status, 'completed');
    const record = response.result.executed[0];
    assert.equal(record.ok, true);
    assert.equal(record.method, 'copilot');
    assert.equal(record.solutionId, 104178);
    assert.deepEqual(record.drops, [{ itemId: '30011', itemName: '固源岩', quantity: 2 }]);
    assert.deepEqual(response.result.totals, { sanity: 18, stages: 1 });
    assert.match(response.text, /满星/);
    assert.match(response.text, /抄作业/);
    assert.equal(copilot.state.queries.length, 1);

    // 侧车实际收到的 append 参数
    const captured = await session.request('captured');
    assert.deepEqual(captured.appends.map((item) => item.type), ['Fight', 'Copilot']);
    assert.equal(captured.appends[0].params.stage, '5-10');
    assert.equal(captured.appends[0].params.times, 2);
    assert.equal(captured.appends[1].params.loop_times, 1);
    assert.equal(captured.appends[1].params.filename, 'C:\\tmp\\5-10-104178.json');
    assert.equal(ledger.get('5-10').stars, 3);
    assert.equal(ledger.get('5-10').method, 'copilot');
  } finally {
    try {
      session?.dispose();
    } catch {
      // 已经退出。
    }
    removeDir(tempDir);
  }
});

test('fight 集成：fake-sidecar 正常 Fight 三星（事件归一化到 state）', { timeout: 60000 }, async () => {
  const tempDir = makeTempDir('dsh-ark-fight-sidecar-');
  /** @type {ReturnType<typeof createMaaSession> | null} */
  let session = null;
  try {
    const state = createState();
    session = createMaaSession({
      pythonPath: process.execPath,
      sidecarPath: fakeSidecarPath,
      sidecarArgs: [fakeSidecarPath, JSON.stringify({
        protocolVersion: '2.0.0',
        tasks: {
          Fight: {
            events: [{
              what: 'StageDrops',
              details: { stars: 3, stats: [{ itemName: '源岩', quantity: 1 }] },
              delayMs: 200,
            }],
          },
        },
      })],
      resolveInit: async () => ({ maaPath: path.join(tempDir, 'maa'), userDir: path.join(tempDir, 'maa-user') }),
      platform: 'win32',
      requestTimeoutMs: 10000,
      startupTimeoutMs: 20000,
      idleTimeoutMs: 60000,
      logger: { info() {}, warn() {} },
    });
    session.subscribe((event) => state.pushEvent(event.payload));

    const config = normalizeConfig();
    const realRuntime = createRuntime({
      config,
      paths: { userDir: path.join(tempDir, 'maa-user') },
      env: {
        get: async () => ({ maaPath: '', pythonPath: process.execPath, adbPath: '', address: '', emulator: {} }),
        clear: () => {},
        peek: () => null,
      },
      session,
      state,
      logger: { info() {}, warn() {} },
    });
    const runtime = {
      ...realRuntime,
      ensureReady: async () => ({ address: '127.0.0.1:16384' }),
      dismissOverlays: async () => {},
      screenshot: async () => ({ path: 'shot.png', method: 'maa' }),
    };

    const ledger = createLedger({ file: path.join(tempDir, 'progress.json'), logger: { warn() {} } });
    const action = createFightAction({
      config,
      paths: { userDir: path.join(tempDir, 'maa-user') },
      env: {},
      session,
      state,
      ledger,
      copilot: makeCopilot(),
      arkrec: { describe: async () => null },
      resources: async () => ({ stages: STAGES, itemNames: { 30012: '源岩' } }),
      runtime,
      store: createRunStore({ logger: { info() {}, warn() {} } }),
      logger: { info() {}, warn() {} },
    });

    const response = await action({ stages: '5-10', confirm: true });
    assert.equal(response.status, 'completed');
    assert.equal(response.result.executed[0].method, 'fight');
    assert.equal(response.result.executed[0].stars, 3);
    assert.deepEqual(response.result.executed[0].drops, [{ itemId: '30012', itemName: '源岩', quantity: 1 }]);
    assert.equal(ledger.get('5-10').fullStar, true);

    const captured = await session.request('captured');
    assert.deepEqual(captured.appends.map((item) => item.type), ['Fight']);
    assert.equal(captured.appends[0].params.stage, '5-10');
    assert.equal(captured.starts, 1);
  } finally {
    try {
      session?.dispose();
    } catch {
      // 已经退出。
    }
    removeDir(tempDir);
  }
});

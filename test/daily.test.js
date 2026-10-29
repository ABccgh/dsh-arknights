/**
 * 日常编排测试：真 session/state/runtime/ledger/box + 假侧车脚本化
 * StartUp/Award/Mall/Infrast/Recruit/OperBox/Depot 事件，全部离线。
 *
 * 覆盖：计划（逐项说明消耗、零副作用）、固定执行顺序、每项独立 MAA 链、
 * 逐项结果、失败不中断、skipDone、全部跳过不启动 MAA、ledger.markDaily、工具输出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBox } from '../lib/box.js';
import { normalizeConfig, resolvePaths } from '../lib/config.js';
import { arkError } from '../lib/errors.js';
import { createLedger } from '../lib/ledger.js';
import { createMaaSession } from '../lib/maa-session.js';
import { createState } from '../lib/state.js';
import { createRuntime } from '../lib/actions/runtime.js';
import { createRunStore } from '../lib/actions/shared.js';
import {
  createDailyAction,
  planDaily,
  readDailyView,
  resolveDailyTasks,
  todayLocal,
} from '../lib/actions/daily.js';
import { createStopAction } from '../lib/actions/stop.js';
import { createDailyTools } from '../lib/tools/daily.js';
import { createStopTools } from '../lib/tools/stop.js';
import { makeLogger, makeTempDir, removeDir, callTool } from './helpers.mjs';

/** 假侧车脚本。 */
const FAKE_SIDECAR = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

/** 各类任务链的脚本事件。 */
const TASK_SCRIPTS = {
  StartUp: [],
  Award: [],
  Mall: [],
  Infrast: [
    { what: 'EnterFacility', details: { facility: 'Mfg', index: 0 } },
    { what: 'ProductOfFacility', details: { product: '赤金', facility: 'Mfg', index: 0 } },
  ],
  Recruit: [
    {
      what: 'RecruitResult',
      details: {
        tags: ['输出', '防护', '生存', '治疗', '近战位'],
        level: 4,
        result: [{ tags: ['输出'], level: 4, opers: [{ id: 'char_1', name: '甲', level: 4 }] }],
      },
    },
  ],
  OperBox: [
    {
      what: 'OperBoxInfo',
      details: {
        done: true,
        all_opers: [{ id: 'char_1', name: '甲', rarity: 4, own: true }],
        own_opers: [{ id: 'char_1', name: '甲', own: true, elite: 1, level: 55, potential: 1, rarity: 4 }],
      },
    },
  ],
  Depot: [{ what: 'DepotInfo', details: { done: true, data: JSON.stringify({ 30061: 12 }) } }],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假环境探测（动作测试不经过 ensureReady，只用它占位）。
 * @returns {Record<string, any>} env 门面。
 */
function fakeEnv() {
  return {
    get: async () => ({}),
    clear: () => {},
    peek: () => null,
    initArgs: {},
  };
}

/**
 * 起测试脚手架：真 session/state/runtime/ledger/box + 假侧车。
 * @param {{ tasks?: Record<string, any>, sidecar?: Record<string, any>, config?: Record<string, any> }} [options] - 选项。
 * @returns {Promise<Record<string, any>>} 脚手架。
 */
async function startHarness(options = {}) {
  const logger = makeLogger();
  const dir = makeTempDir('ark-daily-');
  const config = normalizeConfig({
    userDir: dir,
    ledgerFile: path.join(dir, 'progress.json'),
    box: { file: path.join(dir, 'box.json') },
    history: { file: path.join(dir, 'history.jsonl') },
    requestTimeoutMs: 10000,
    connectTimeoutMs: 5000,
    startupTimeoutMs: 10000,
    idleTimeoutMs: 60000,
    ...(options.config ?? {}),
  });
  const paths = resolvePaths(config);
  const state = createState();
  const session = createMaaSession({
    pythonPath: process.execPath,
    sidecarPath: FAKE_SIDECAR,
    sidecarArgs: [FAKE_SIDECAR, JSON.stringify({ tasks: options.tasks ?? {}, ...(options.sidecar ?? {}) })],
    resolveInit: async () => ({ maaPath: 'D:\\MAA', userDir: dir, touchMode: 'minitouch', deploymentWithPause: false }),
    platform: 'win32',
    requestTimeoutMs: 10000,
    logger,
  });
  session.subscribe((event) => {
    if (event.name === 'maa') state.pushEvent(event.payload);
  });
  const ledger = createLedger({ file: paths.ledgerFile, logger });
  const box = createBox({ file: paths.boxFile, logger });
  const runtime = createRuntime({ config, paths, env: fakeEnv(), session, state, logger });
  const ensureCalls = [];
  runtime.ensureReady = async (readyOptions = {}) => {
    ensureCalls.push(readyOptions);
    if (readyOptions.startup === true) {
      await runtime.runTaskChain({
        type: 'StartUp',
        params: { client_type: config.clientType, start_game_enabled: false },
        timeoutMs: 10000,
      });
    }
    return { address: '127.0.0.1:16384' };
  };
  const store = createRunStore({ logger });
  const deps = {
    config,
    paths,
    env: fakeEnv(),
    session,
    state,
    ledger,
    box,
    history: { append: async () => {} },
    data: null,
    runtime,
    store,
    logger,
  };
  return {
    dir,
    config,
    paths,
    state,
    session,
    runtime,
    ledger,
    box,
    store,
    deps,
    action: createDailyAction(deps),
    logger,
    ensureCalls,
  };
}

/**
 * 取假侧车记录的 append 列表。
 * @param {Record<string, any>} harness - 脚手架。
 * @returns {Promise<Array<Record<string, any>>>} append 记录。
 */
async function appendsOf(harness) {
  const captured = await harness.session.request('captured');
  return captured.appends ?? [];
}

/**
 * 收尾：停会话、落盘、删临时目录。
 * @param {Record<string, any>} harness - 脚手架。
 * @returns {Promise<void>} 无。
 */
async function stopHarness(harness) {
  try {
    harness.session.dispose();
  } catch {
    // 已经退出。
  }
  try {
    await harness.ledger.flush?.();
  } catch {
    // 清理尽力而为。
  }
  try {
    await harness.box.flush?.();
  } catch {
    // 清理尽力而为。
  }
  await sleep(30);
  removeDir(harness.dir);
}

test('计划：confirm=false 只回计划（逐项说明消耗），不启动 MAA、不写账本', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const response = await harness.action({});
    assert.equal(response.planned, true);
    assert.equal(response.runId, undefined);
    assert.equal(response.plannedTotalSanity, 0);
    assert.equal(response.plannedItems.length, 3);
    assert.deepEqual(response.plannedItems.map((item) => item.task), ['award', 'mall', 'infrast']);
    assert.match(response.text, /日常计划/);
    assert.match(response.text, /不消耗/);
    assert.match(response.text, /需要 confirm=true/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
    assert.deepEqual(harness.ledger.viewDaily().tasks, {});
  } finally {
    await stopHarness(harness);
  }
});

test('计划：dryRun 时即使 confirm=true 也只回计划', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS, config: { dryRun: true } });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.planned, true);
    assert.match(response.text, /\[dry-run\]/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：StartUp → award → mall → infrast 顺序，逐项结果 ok，账本记三项', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.ok, true);
    assert.equal(response.status, 'completed');
    assert.equal(harness.ensureCalls.length, 1);
    assert.equal(harness.ensureCalls[0].startup, true);
    assert.equal(response.result.daily.tasks.award.ok, true);
    assert.equal(response.result.daily.tasks.mall.ok, true);
    assert.equal(response.result.daily.tasks.infrast.ok, true);
    assert.match(response.text, /日常结束/);

    const appends = await appendsOf(harness);
    assert.deepEqual(appends.map((item) => item.type), ['StartUp', 'Award', 'Mall', 'Infrast']);
    assert.equal(response.result.daily.ledgerMarked, true);
    const daily = harness.ledger.viewDaily();
    assert.equal(daily.date, todayLocal());
    assert.equal(daily.tasks.award.ok, true);
    assert.equal(daily.tasks.mall.ok, true);
    assert.equal(daily.tasks.infrast.ok, true);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：包含 recruit(analyze) 与 box 时顺序固定，recruit 只识别，账本不记 recruit/box', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const response = await harness.action({ confirm: true, tasks: 'award,mall,infrast,recruit,box' });
    assert.equal(response.status, 'completed');
    const appends = await appendsOf(harness);
    assert.deepEqual(appends.map((item) => item.type), ['StartUp', 'Award', 'Mall', 'Infrast', 'Recruit', 'OperBox', 'Depot']);
    const recruitAppend = appends.find((item) => item.type === 'Recruit');
    assert.equal(recruitAppend.params.times, 0);
    assert.deepEqual(recruitAppend.params.select, []);
    assert.deepEqual(recruitAppend.params.confirm, []);
    assert.equal(recruitAppend.params.refresh, false);
    assert.equal(response.result.daily.tasks.recruit.ok, true);
    assert.equal(response.result.daily.tasks.box.ok, true);
    const daily = harness.ledger.viewDaily();
    assert.equal(daily.tasks.award.ok, true);
    assert.equal(daily.tasks.recruit, undefined);
    assert.equal(daily.tasks.box, undefined);
  } finally {
    await stopHarness(harness);
  }
});

test('skipDone：按账本跳过当天已完成的 award，其余照跑', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    harness.ledger.markDaily({ date: todayLocal(), tasks: { award: { ok: true } } });
    const response = await harness.action({ confirm: true });
    assert.equal(response.status, 'completed');
    assert.equal(response.result.daily.tasks.award.skipped, true);
    assert.equal(response.result.daily.tasks.award.ok, true);
    assert.equal(response.result.daily.tasks.mall.ok, true);
    assert.match(response.text, /跳过/);
    const appends = await appendsOf(harness);
    assert.deepEqual(appends.map((item) => item.type), ['StartUp', 'Mall', 'Infrast']);
  } finally {
    await stopHarness(harness);
  }
});

test('skipDone=false：即使账本标记已完成也照跑', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    harness.ledger.markDaily({ date: todayLocal(), tasks: { award: { ok: true } } });
    const response = await harness.action({ confirm: true, skipDone: false });
    assert.equal(response.status, 'completed');
    const appends = await appendsOf(harness);
    assert.deepEqual(appends.map((item) => item.type), ['StartUp', 'Award', 'Mall', 'Infrast']);
    assert.equal(response.result.daily.tasks.award.skipped, undefined);
  } finally {
    await stopHarness(harness);
  }
});

test('全部跳过：不启动 MAA（不 ensureReady、不 append）', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    harness.ledger.markDaily({
      date: todayLocal(),
      tasks: { award: { ok: true }, mall: { ok: true }, infrast: { ok: true } },
    });
    const response = await harness.action({ confirm: true });
    assert.equal(response.status, 'completed');
    assert.match(response.text, /没有启动 MAA/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
    assert.equal(response.result.daily.ledgerMarked, false);
    assert.equal(response.result.daily.tasks.award.skipped, true);
  } finally {
    await stopHarness(harness);
  }
});

test('失败不中断：mall 任务链被 MAA 拒绝，award/infrast 仍执行，账本只记成功的', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS, sidecar: { rejectTypes: ['Mall'] } });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.status, 'failed');
    assert.equal(response.result.daily.tasks.award.ok, true);
    assert.equal(response.result.daily.tasks.mall.ok, false);
    assert.equal(response.result.daily.tasks.mall.code, 'E_TASK_TYPE');
    assert.equal(response.result.daily.tasks.infrast.ok, true);
    assert.match(response.text, /失败/);
    assert.equal(response.result.daily.ledgerMarked, true);
    const daily = harness.ledger.viewDaily();
    assert.equal(daily.tasks.award.ok, true);
    assert.equal(daily.tasks.mall, undefined);
    assert.equal(daily.tasks.infrast.ok, true);
  } finally {
    await stopHarness(harness);
  }
});

test('环境未就绪：所有待执行项记为失败，不跑 MAA 任务链', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    harness.runtime.ensureReady = async () => {
      throw arkError('E_NOT_READY', '模拟器没有开机（测试）');
    };
    const response = await harness.action({ confirm: true });
    assert.equal(response.status, 'failed');
    assert.match(response.text, /环境未就绪/);
    assert.equal(response.result.daily.tasks.award.ok, false);
    assert.equal(response.result.daily.tasks.award.code, 'E_NOT_READY');
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('子任务参数：params.mall / params.infrast 覆盖默认值并透传到 MAA', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const response = await harness.action({
      confirm: true,
      tasks: 'mall,infrast',
      mall: { buyFirst: ['招聘许可'], onlyDiscount: true },
      infrast: { drones: 'Money', threshold: 0.5 },
    });
    assert.equal(response.status, 'completed');
    const appends = await appendsOf(harness);
    const mall = appends.find((item) => item.type === 'Mall');
    assert.deepEqual(mall.params.buy_first, ['招聘许可']);
    assert.equal(mall.params.only_buy_discount, true);
    const infrast = appends.find((item) => item.type === 'Infrast');
    assert.equal(infrast.params.drones, 'Money');
    assert.equal(infrast.params.threshold, 0.5);
  } finally {
    await stopHarness(harness);
  }
});

test('resolveDailyTasks：非法项报 E_BAD_ARGS，字符串/数组都收，顺序固定', () => {
  assert.throws(() => resolveDailyTasks({ daily: { tasks: ['award', 'nope'] } }, {}), (error) => error.code === 'E_BAD_ARGS');
  assert.deepEqual(resolveDailyTasks({ daily: { tasks: ['award'] } }, {}), ['award']);
  assert.deepEqual(resolveDailyTasks({ daily: { tasks: ['award'] } }, { tasks: 'box, recruit award' }), ['award', 'recruit', 'box']);
  assert.throws(() => resolveDailyTasks({ daily: { tasks: [] } }, {}), (error) => error.code === 'E_BAD_ARGS');
});

test('readDailyView：兼容 viewDaily()/dailyView()，读不到时返回空任务', () => {
  assert.deepEqual(readDailyView(null), { date: '', tasks: {} });
  assert.deepEqual(
    readDailyView({ viewDaily: () => ({ date: '2026-10-29', tasks: { award: { ok: true } } }) }),
    { date: '2026-10-29', tasks: { award: { ok: true } } },
  );
  assert.deepEqual(
    readDailyView({ dailyView: () => ({ date: '2026-10-28', tasks: { award: { ok: true } } }) }),
    { date: '2026-10-28', tasks: { award: { ok: true } } },
  );
});

test('planDaily：零副作用（只读配置与账本）', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const planned = planDaily(harness.deps, {});
    assert.equal(planned.plannedTotalSanity, 0);
    assert.match(planned.text, /日常计划/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('ark_daily 工具：返回 response.text、超时 2 小时、非并发安全', async () => {
  const tools = createDailyTools({
    actions: {
      daily: async (args) => ({ text: `daily:${args.tasks}:${args.skipDone}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_daily');
  assert.equal(tools[0].timeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_daily', { tasks: 'award,mall', skipDone: true });
  assert.equal(result.text, 'daily:award,mall:true');
});

test('stop：没有正在运行的动作时返回 stopped=false 且不报错', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    const stop = createStopAction(harness.deps);
    const response = await stop();
    assert.equal(response.ok, true);
    assert.equal(response.stopped, false);
    assert.equal(response.status, 'idle');
    assert.match(response.text, /没有正在运行的动作/);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('stop：有 run 且侧车在跑时同时中止 run 与任务链', async () => {
  const harness = await startHarness({ tasks: TASK_SCRIPTS });
  try {
    // 先真的起一次动作，让侧车进程活着。
    await harness.action({ confirm: true, tasks: 'award' });
    assert.equal(harness.session.isRunning(), true);
    harness.store.begin({ kind: 'test' });
    const stop = createStopAction(harness.deps);
    const response = await stop();
    assert.equal(response.ok, true);
    assert.equal(response.stopped, true);
    assert.equal(response.status, 'stopped');
    assert.match(response.text, /已停止当前动作/);
    assert.equal(harness.store.signal()?.aborted, true);
  } finally {
    await stopHarness(harness);
  }
});

test('stop：侧车 stop 请求失败也只告警，不抛错', async () => {
  const failing = {
    isRunning: () => true,
    request: async () => {
      throw arkError('E_MAA_LOAD', '侧车异常（测试）');
    },
  };
  const store = createRunStore({ logger: makeLogger() });
  const stop = createStopAction({ session: failing, store, runtime: null, logger: makeLogger() });
  const response = await stop();
  assert.equal(response.ok, true);
  assert.equal(response.stopped, false);
  assert.match(response.text, /失败/);
  assert.match(response.text, /无需停止|已中止/);
});

test('ark_stop 工具：返回 response.text、超时 30 分钟、非并发安全', async () => {
  const tools = createStopTools({
    actions: {
      stop: async () => ({ text: 'stopped:false', ok: true, stopped: false }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_stop');
  assert.equal(tools[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_stop', {});
  assert.equal(result.text, 'stopped:false');
});

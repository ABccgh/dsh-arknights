/**
 * 基建换班动作测试：真 session/state/runtime + 假侧车脚本化基建事件，全部离线。
 *
 * 覆盖：计划零副作用、confirm 矩阵、MAA 参数组装（mode/facility/drones/threshold/
 * customFile/planIndex）、EnterFacility/ProductOfFacility/NotEnoughStaff 汇总、工具输出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBox } from '../lib/box.js';
import { normalizeConfig, resolvePaths } from '../lib/config.js';
import { createLedger } from '../lib/ledger.js';
import { createMaaSession } from '../lib/maa-session.js';
import { createState } from '../lib/state.js';
import { createRuntime } from '../lib/actions/runtime.js';
import { createRunStore } from '../lib/actions/shared.js';
import {
  DEFAULT_FACILITIES,
  createInfrastAction,
  parseInfrastEvents,
  resolveInfrastParams,
} from '../lib/actions/infrast.js';
import { createInfrastTools } from '../lib/tools/infrast.js';
import { makeLogger, makeTempDir, removeDir, callTool } from './helpers.mjs';

/** 假侧车脚本。 */
const FAKE_SIDECAR = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

/** 基建事件脚本。 */
const INFRAST_SCRIPT = {
  Infrast: {
    events: [
      { what: 'EnterFacility', details: { facility: 'Mfg', index: 0 } },
      { what: 'EnterFacility', details: { facility: 'Trade', index: 1 } },
      { what: 'ProductOfFacility', details: { product: '赤金', facility: 'Mfg', index: 0 } },
      { what: 'ProductOfFacility', details: { product: '龙门币', facility: 'Trade', index: 1 } },
      { what: 'NotEnoughStaff', details: { facility: 'Trade', index: 2 } },
      { what: 'CustomInfrastRoomKeptUnchanged', details: { facility: 'Power', index: 0, reason: 'facility_empty' } },
    ],
  },
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
  const dir = makeTempDir('ark-infrast-');
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
    action: createInfrastAction(deps),
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

test('计划：confirm=false 只回计划，不启动 MAA、不 append', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT });
  try {
    const response = await harness.action({});
    assert.equal(response.planned, true);
    assert.match(response.text, /基建换班计划/);
    assert.match(response.text, /需要 confirm=true/);
    assert.match(response.text, /无人机/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：默认 mode=0、默认设施、threshold=0.3、无人机 _NotUse', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.ok, true);
    assert.equal(response.status, 'partial'); // 脚本里有 NotEnoughStaff
    assert.equal(harness.ensureCalls.length, 1);
    assert.equal(response.result.infrast.mode, 0);
    assert.deepEqual(response.result.infrast.facility, DEFAULT_FACILITIES);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    assert.equal(appends[0].type, 'Infrast');
    const params = appends[0].params;
    assert.equal(params.mode, 0);
    assert.deepEqual(params.facility, DEFAULT_FACILITIES);
    assert.equal(params.drones, '_NotUse');
    assert.equal(params.threshold, 0.3);
    assert.equal(params.enable, true);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：解析 EnterFacility/ProductOfFacility/NotEnoughStaff，干员不足会标 partial', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT });
  try {
    const response = await harness.action({ confirm: true });
    const detail = response.result.infrast;
    assert.equal(detail.entered.length, 2);
    assert.deepEqual(detail.entered[0], { facility: 'Mfg', index: 0 });
    assert.equal(detail.products.length, 2);
    assert.deepEqual(detail.productSummary, { 赤金: 1, 龙门币: 1 });
    assert.deepEqual(detail.notEnoughStaff, [{ facility: 'Trade', index: 2 }]);
    assert.equal(detail.keptUnchanged.length, 1);
    assert.equal(detail.keptUnchanged[0].reason, 'facility_empty');
    assert.equal(response.status, 'partial');
    assert.match(response.text, /干员不足/);
    assert.match(response.text, /赤金×1/);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：自定义排班 mode=10000 传 filename/plan_index，且不传 drones', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT });
  try {
    const response = await harness.action({
      confirm: true,
      mode: 10000,
      customFile: 'schedules/base.json',
      planIndex: 2,
      facility: ['Mfg', 'Trade'],
    });
    assert.equal(response.result.infrast.mode, 10000);
    const appends = await appendsOf(harness);
    const params = appends[0].params;
    assert.equal(params.mode, 10000);
    assert.equal(params.filename, 'schedules/base.json');
    assert.equal(params.plan_index, 2);
    assert.equal(params.drones, undefined);
    assert.deepEqual(params.facility, ['Mfg', 'Trade']);
  } finally {
    await stopHarness(harness);
  }
});

test('参数：只给 customFile 时自动切 mode=10000；mode=10000 无 customFile 报 E_BAD_ARGS', async () => {
  const auto = resolveInfrastParams({}, { customFile: 'schedules/a.json' });
  assert.equal(auto.mode, 10000);
  assert.equal(auto.filename, 'schedules/a.json');
  assert.throws(
    () => resolveInfrastParams({}, { mode: 10000 }),
    (error) => {
      assert.equal(error.code, 'E_BAD_ARGS');
      assert.match(error.message, /customFile/);
      return true;
    },
  );
});

test('参数：非法设施/无人机/模式都报 E_BAD_ARGS', () => {
  assert.throws(() => resolveInfrastParams({}, { facility: ['Unknown'] }), (error) => error.code === 'E_BAD_ARGS');
  assert.throws(() => resolveInfrastParams({}, { drones: 'All' }), (error) => error.code === 'E_BAD_ARGS');
  assert.throws(() => resolveInfrastParams({}, { mode: 5 }), (error) => error.code === 'E_BAD_ARGS');
});

test('执行：无人机与心情阈值透传', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT });
  try {
    await harness.action({ confirm: true, drones: 'Money', threshold: 0.5, facility: ['Mfg', 'Trade', 'Dorm'] });
    const appends = await appendsOf(harness);
    assert.equal(appends[0].params.drones, 'Money');
    assert.equal(appends[0].params.threshold, 0.5);
    assert.deepEqual(appends[0].params.facility, ['Mfg', 'Trade', 'Dorm']);
  } finally {
    await stopHarness(harness);
  }
});

test('dryRun：只出计划，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: INFRAST_SCRIPT, config: { dryRun: true } });
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

test('parseInfrastEvents：空事件返回空汇总', () => {
  const parsed = parseInfrastEvents([]);
  assert.deepEqual(parsed.entered, []);
  assert.deepEqual(parsed.products, []);
  assert.deepEqual(parsed.productSummary, {});
  assert.deepEqual(parsed.notEnoughStaff, []);
});

test('ark_infrast 工具：返回 response.text、超时 30 分钟、非并发安全', async () => {
  const tools = createInfrastTools({
    actions: {
      infrast: async (args) => ({ text: `infrast:${args.mode}:${args.drones}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_infrast');
  assert.equal(tools[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_infrast', { mode: 0, drones: 'Money' });
  assert.equal(result.text, 'infrast:0:Money');
});

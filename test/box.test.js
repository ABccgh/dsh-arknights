/**
 * 仓库/干员识别动作测试：真 session/state/runtime/box + 假侧车脚本化
 * OperBoxInfo / DepotInfo 事件，全部离线。
 *
 * 覆盖：done=false→true 的完整识别、仓库 data JSON 解析、target 选择、
 * 超时（E_BOX_TIMEOUT）不覆盖已有完整快照、部分识别、工具输出。
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
  createBoxAction,
  normalizeOperBox,
  parseDepotData,
  resolveBoxTarget,
} from '../lib/actions/box.js';
import { createBoxTools } from '../lib/tools/box.js';
import { makeLogger, makeTempDir, removeDir, callTool } from './helpers.mjs';

/** 假侧车脚本。 */
const FAKE_SIDECAR = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

/** 干员 box 脚本：先 done=false 中间态，再 done=true 完整结果。 */
const OPER_BOX_SCRIPT = {
  OperBox: {
    events: [
      {
        what: 'OperBoxInfo',
        details: {
          done: false,
          all_opers: [{ id: 'char_1', name: '部分', rarity: 4, own: true }],
          own_opers: [],
        },
      },
      {
        what: 'OperBoxInfo',
        details: {
          done: true,
          all_opers: [
            { id: 'char_1', name: '甲', rarity: 4, own: true },
            { id: 'char_2', name: '乙', rarity: 6, own: true },
            { id: 'char_3', name: '丙', rarity: 5, own: false },
          ],
          own_opers: [
            { id: 'char_1', name: '甲', own: true, elite: 1, level: 55, potential: 2, rarity: 4 },
            { id: 'char_2', name: '乙', own: true, elite: 2, level: 90, potential: 1, rarity: 6 },
          ],
        },
      },
    ],
  },
};

/** 仓库脚本：data 是 JSON 字符串（与 MAA 回调一致）。 */
const DEPOT_SCRIPT = {
  Depot: {
    events: [
      { what: 'DepotInfo', details: { done: false, data: '{"30061":1}' } },
      { what: 'DepotInfo', details: { done: true, data: JSON.stringify({ 30061: 12, 30062: 3 }) } },
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
  const dir = makeTempDir('ark-box-');
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
    action: createBoxAction(deps),
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

test('target=operbox：等 done=true 后写入干员快照，中间态不覆盖', async () => {
  const harness = await startHarness({ tasks: OPER_BOX_SCRIPT });
  try {
    const response = await harness.action({ target: 'operbox' });
    assert.equal(response.ok, true);
    assert.equal(response.status, 'completed');
    assert.equal(harness.ensureCalls.length, 1);
    assert.deepEqual(response.result.box.operators, { total: 3, own: 2 });
    assert.equal(response.result.box.depot, null);
    assert.equal(response.result.box.partial, false);
    assert.equal(typeof response.result.box.updatedAt, 'string');
    assert.match(response.text, /干员识别完成/);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    assert.equal(appends[0].type, 'OperBox');

    const snapshot = harness.box.read();
    assert.equal(snapshot.partial, false);
    assert.equal(snapshot.operators.all.length, 3);
    assert.equal(snapshot.operators.own.length, 2);
    assert.equal(snapshot.operators.own[1].elite, 2);
    assert.equal(snapshot.operators.own[1].level, 90);
  } finally {
    await stopHarness(harness);
  }
});

test('target=depot：解析 DepotInfo.data JSON，写入仓库快照', async () => {
  const harness = await startHarness({ tasks: DEPOT_SCRIPT });
  try {
    const response = await harness.action({ target: 'depot' });
    assert.equal(response.status, 'completed');
    assert.deepEqual(response.result.box.depot, { types: 2, total: 15, corrupted: false });
    assert.equal(response.result.box.operators, null);
    assert.match(response.text, /仓库识别完成/);

    const appends = await appendsOf(harness);
    assert.equal(appends[0].type, 'Depot');
    const snapshot = harness.box.read();
    assert.equal(snapshot.depot.items['30061'].count, 12);
    assert.equal(snapshot.depot.items['30062'].count, 3);
  } finally {
    await stopHarness(harness);
  }
});

test('target=both：先 OperBox 再 Depot，两份快照都写入', async () => {
  const harness = await startHarness({ tasks: { ...OPER_BOX_SCRIPT, ...DEPOT_SCRIPT } });
  try {
    const response = await harness.action({});
    assert.equal(response.status, 'completed');
    assert.deepEqual(response.result.box.operators, { total: 3, own: 2 });
    assert.equal(response.result.box.depot.types, 2);
    assert.equal(response.result.box.partial, false);
    const appends = await appendsOf(harness);
    assert.deepEqual(appends.map((item) => item.type), ['OperBox', 'Depot']);
    const snapshot = harness.box.read();
    assert.equal(snapshot.operators.own.length, 2);
    assert.equal(snapshot.depot.items['30061'].count, 12);
  } finally {
    await stopHarness(harness);
  }
});

test('target=operbox 没有 done=true：E_BOX_TIMEOUT，不写快照', async () => {
  const harness = await startHarness({
    tasks: { OperBox: [{ what: 'OperBoxInfo', details: { done: false, all_opers: [], own_opers: [] } }] },
  });
  try {
    await assert.rejects(
      () => harness.action({ target: 'operbox' }),
      (error) => {
        assert.equal(error.code, 'E_BOX_TIMEOUT');
        return true;
      },
    );
    const snapshot = harness.box.read();
    assert.equal(snapshot.operators.all.length, 0);
    assert.equal(snapshot.operators.own.length, 0);
  } finally {
    await stopHarness(harness);
  }
});

test('target=both 部分识别：干员成功、仓库超时 → status=partial，不覆盖已有仓库快照', async () => {
  const harness = await startHarness({
    tasks: {
      OperBox: OPER_BOX_SCRIPT.OperBox,
      Depot: [{ what: 'DepotInfo', details: { done: false, data: '{"99999":1}' } }],
    },
  });
  try {
    // 先写入一份完整的仓库快照（模拟上一次成功识别）。
    harness.box.saveDepot({ items: { 30061: { name: '固源岩', count: 5 } } }, { partial: false });
    const response = await harness.action({});
    assert.equal(response.status, 'partial');
    assert.equal(response.result.box.partial, true);
    assert.equal(response.result.box.errors.depot.code, 'E_BOX_TIMEOUT');
    assert.deepEqual(response.result.box.operators, { total: 3, own: 2 });
    assert.match(response.text, /仓库识别失败/);
    // 仓库快照保持上一次的完整数据，没有被 done=false 的半成品覆盖。
    const snapshot = harness.box.read();
    assert.equal(snapshot.depot.items['30061'].count, 5);
    assert.equal(snapshot.depot.items['99999'], undefined);
  } finally {
    await stopHarness(harness);
  }
});

test('单 target 超时不覆盖已有完整快照', async () => {
  const harness = await startHarness({ tasks: { Depot: [] } });
  try {
    harness.box.saveDepot({ items: { 30061: { name: '固源岩', count: 5 } } }, { partial: false });
    await assert.rejects(() => harness.action({ target: 'depot' }), (error) => error.code === 'E_BOX_TIMEOUT');
    assert.equal(harness.box.read().depot.items['30061'].count, 5);
  } finally {
    await stopHarness(harness);
  }
});

test('参数：非法 target 报 E_BAD_ARGS', () => {
  assert.equal(resolveBoxTarget(''), 'both');
  assert.equal(resolveBoxTarget('operbox'), 'operbox');
  assert.throws(() => resolveBoxTarget('all'), (error) => error.code === 'E_BAD_ARGS');
});

test('normalizeOperBox / parseDepotData：契约形状与坏 JSON 容错', () => {
  const operators = normalizeOperBox({
    all_opers: [{ id: 'char_1', name: '甲', rarity: 4, own: true }, { name: '无名' }],
    own_opers: [{ id: 'char_2', name: '乙', elite: 2, level: 90, potential: 1, rarity: 6 }],
  });
  assert.equal(operators.all.length, 1);
  assert.deepEqual(operators.own[0], { id: 'char_2', name: '乙', elite: 2, level: 90, potential: 1, rarity: 6 });
  assert.deepEqual(parseDepotData('{"30061":12}'), { items: { 30061: 12 }, corrupted: false });
  assert.deepEqual(parseDepotData('not-json'), { items: {}, corrupted: true });
  assert.deepEqual(parseDepotData({ 30061: 12 }), { items: { 30061: 12 }, corrupted: false });
});

test('dryRun：只出计划，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: { ...OPER_BOX_SCRIPT, ...DEPOT_SCRIPT }, config: { dryRun: true } });
  try {
    const response = await harness.action({});
    assert.equal(response.planned, true);
    assert.match(response.text, /\[dry-run\]/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('ark_box 工具：返回 response.text、超时 40 分钟、非并发安全', async () => {
  const tools = createBoxTools({
    actions: {
      box: async (args) => ({ text: `box:${args.target}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_box');
  assert.equal(tools[0].timeoutMs, 40 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_box', { target: 'depot' });
  assert.equal(result.text, 'box:depot');
});

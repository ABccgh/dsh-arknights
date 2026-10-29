/**
 * 信用商店动作测试：真 session/state/runtime + 假侧车，全部离线。
 *
 * 覆盖：confirm 矩阵、MAA 参数映射（visit_friends/shopping/buy_first/blacklist/
 * force_shopping_if_credit_full/only_buy_discount/reserve_max_credit）、
 * 「识别不到明细」的如实回报、工具输出。
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
import { createMallAction, resolveMallParams } from '../lib/actions/mall.js';
import { createMallTools } from '../lib/tools/mall.js';
import { makeLogger, makeTempDir, removeDir, callTool } from './helpers.mjs';

/** 假侧车脚本。 */
const FAKE_SIDECAR = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

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
  const dir = makeTempDir('ark-mall-');
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
    action: createMallAction(deps),
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

test('计划：confirm=false 只回计划，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: { Mall: [] } });
  try {
    const response = await harness.action({});
    assert.equal(response.planned, true);
    assert.match(response.text, /信用商店计划/);
    assert.match(response.text, /需要 confirm=true/);
    assert.match(response.text, /信用点/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：默认开关映射到 MAA Mall 参数，如实说明识别不到明细', async () => {
  const harness = await startHarness({ tasks: { Mall: [] } });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.ok, true);
    assert.equal(response.status, 'completed');
    assert.equal(harness.ensureCalls.length, 1);
    assert.match(response.text, /识别不到明细/);
    assert.equal(response.result.mall.detailsAvailable, false);
    assert.match(response.result.mall.note, /识别不到明细/);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    assert.equal(appends[0].type, 'Mall');
    const params = appends[0].params;
    assert.equal(params.visit_friends, true);
    assert.equal(params.shopping, true);
    assert.deepEqual(params.buy_first, []);
    assert.deepEqual(params.blacklist, []);
    assert.equal(params.force_shopping_if_credit_full, false);
    assert.equal(params.only_buy_discount, false);
    assert.equal(params.reserve_max_credit, false);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：buyFirst/blacklist/onlyDiscount/forceWhenFull/reserveMaxCredit 全量映射', async () => {
  const harness = await startHarness({ tasks: { Mall: [] } });
  try {
    const response = await harness.action({
      confirm: true,
      visitFriends: false,
      shopping: false,
      buyFirst: ['招聘许可', '龙门币'],
      blacklist: ['家具零件'],
      onlyDiscount: true,
      forceWhenFull: true,
      reserveMaxCredit: true,
    });
    assert.deepEqual(response.result.mall.buyFirst, ['招聘许可', '龙门币']);
    assert.deepEqual(response.result.mall.blacklist, ['家具零件']);
    assert.equal(response.result.mall.flags.onlyDiscount, true);
    const appends = await appendsOf(harness);
    const params = appends[0].params;
    assert.equal(params.visit_friends, false);
    assert.equal(params.shopping, false);
    assert.deepEqual(params.buy_first, ['招聘许可', '龙门币']);
    assert.deepEqual(params.blacklist, ['家具零件']);
    assert.equal(params.only_buy_discount, true);
    assert.equal(params.force_shopping_if_credit_full, true);
    assert.equal(params.reserve_max_credit, true);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：confirmRequired=false 时不需要 confirm 也会执行', async () => {
  const harness = await startHarness({ tasks: { Mall: [] }, config: { confirmRequired: false } });
  try {
    const response = await harness.action({});
    assert.equal(response.ok, true);
    assert.equal(response.done, true);
    assert.equal((await appendsOf(harness)).length, 1);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：任务链报错时 status=partial 并说明', async () => {
  const harness = await startHarness({
    tasks: { Mall: [{ code: 10000, details: { taskchain: 'Mall' } }] },
  });
  try {
    const response = await harness.action({ confirm: true });
    assert.equal(response.status, 'partial');
    assert.match(response.text, /报错/);
  } finally {
    await stopHarness(harness);
  }
});

test('resolveMallParams：config.daily.mall 作为默认值，动作参数覆盖', () => {
  const resolved = resolveMallParams(
    { daily: { mall: { visitFriends: false, buyFirst: ['龙门币'] } } },
    { onlyDiscount: true, buyFirst: ['招聘许可'] },
  );
  assert.equal(resolved.flags.visitFriends, false);
  assert.equal(resolved.flags.onlyDiscount, true);
  assert.deepEqual(resolved.buyFirst, ['招聘许可']);
  assert.equal(resolved.maa.visit_friends, false);
  assert.deepEqual(resolved.maa.buy_first, ['招聘许可']);
});

test('ark_mall 工具：返回 response.text、超时 30 分钟、非并发安全', async () => {
  const tools = createMallTools({
    actions: {
      mall: async (args) => ({ text: `mall:${args.visitFriends}:${args.shopping}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_mall');
  assert.equal(tools[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_mall', { visitFriends: false, shopping: true });
  assert.equal(result.text, 'mall:false:true');
});

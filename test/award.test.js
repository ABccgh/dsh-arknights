/**
 * 领奖动作测试：真 session/state/runtime + 假侧车，全部离线。
 *
 * 覆盖：不需要 confirm、开关映射（award/mail/dailyPull→recruit/orundum/mining/
 * specialAccess→specialaccess/signInEvent→signinevent）、全关拒绝、失败态、工具输出。
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
import { createAwardAction, resolveAwardParams } from '../lib/actions/award.js';
import { createAwardTools } from '../lib/tools/award.js';
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
  const dir = makeTempDir('ark-award-');
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
    action: createAwardAction(deps),
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

test('不需要 confirm：直接跑 MAA Award，默认只开 award，报告识别不到明细', async () => {
  const harness = await startHarness({ tasks: { Award: [] } });
  try {
    const response = await harness.action({});
    assert.equal(response.ok, true);
    assert.equal(response.done, true);
    assert.equal(response.status, 'completed');
    assert.equal(harness.ensureCalls.length, 1);
    assert.match(response.text, /奖励领取完成/);
    assert.match(response.text, /识别不到明细/);
    assert.equal(response.result.award.detailsAvailable, false);
    assert.equal(response.result.award.flags.award, true);
    assert.equal(response.result.award.flags.mail, false);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    assert.equal(appends[0].type, 'Award');
    const params = appends[0].params;
    assert.equal(params.award, true);
    assert.equal(params.mail, false);
    assert.equal(params.recruit, false);
    assert.equal(params.orundum, false);
    assert.equal(params.mining, false);
    assert.equal(params.specialaccess, false);
    assert.equal(params.signinevent, false);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：所有开关按契约映射到 MAA Award 字段', async () => {
  const harness = await startHarness({ tasks: { Award: [] } });
  try {
    const response = await harness.action({
      award: false,
      mail: true,
      dailyPull: true,
      orundum: true,
      mining: true,
      specialAccess: true,
      signInEvent: true,
    });
    assert.equal(response.status, 'completed');
    const appends = await appendsOf(harness);
    const params = appends[0].params;
    assert.equal(params.award, false);
    assert.equal(params.mail, true);
    assert.equal(params.recruit, true);
    assert.equal(params.orundum, true);
    assert.equal(params.mining, true);
    assert.equal(params.specialaccess, true);
    assert.equal(params.signinevent, true);
    assert.deepEqual(response.result.award.flags, {
      award: false,
      mail: true,
      dailyPull: true,
      orundum: true,
      mining: true,
      specialAccess: true,
      signInEvent: true,
    });
  } finally {
    await stopHarness(harness);
  }
});

test('config.daily.award 作为默认值，动作参数可覆盖', async () => {
  const resolved = resolveAwardParams({ daily: { award: { mail: true, mining: true } } }, { mining: false });
  assert.equal(resolved.flags.mail, true);
  assert.equal(resolved.flags.mining, false);
  assert.equal(resolved.maa.mail, true);
  assert.equal(resolved.maa.mining, false);
});

test('全部开关关闭时报 E_BAD_ARGS，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: { Award: [] } });
  try {
    await assert.rejects(
      () => harness.action({
        award: false,
        mail: false,
        dailyPull: false,
        orundum: false,
        mining: false,
        specialAccess: false,
        signInEvent: false,
      }),
      (error) => {
        assert.equal(error.code, 'E_BAD_ARGS');
        return true;
      },
    );
    assert.equal(harness.ensureCalls.length, 0);
  } finally {
    await stopHarness(harness);
  }
});

test('执行：任务链报错时 status=partial 并说明', async () => {
  const harness = await startHarness({
    tasks: { Award: [{ code: 10000, details: { taskchain: 'Award' } }] },
  });
  try {
    const response = await harness.action({});
    assert.equal(response.status, 'partial');
    assert.match(response.text, /报错/);
  } finally {
    await stopHarness(harness);
  }
});

test('dryRun：只出计划，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: { Award: [] }, config: { dryRun: true } });
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

test('ark_award 工具：返回 response.text、超时 30 分钟、非并发安全', async () => {
  const tools = createAwardTools({
    actions: {
      award: async (args) => ({ text: `award:${args.award}:${args.mail}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_award');
  assert.equal(tools[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_award', { award: true, mail: false });
  assert.equal(result.text, 'award:true:false');
});

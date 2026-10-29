/**
 * 公招动作测试：真 session/state/runtime + 假侧车脚本化公招事件，全部离线。
 *
 * 覆盖：analyze 不消耗（times=0/select=[]/confirm=[]/refresh=false）、execute 确认矩阵、
 * 资源安全闸、tags/level/combos 解析、状态隔离（不拿上一次任务链的旧事件）、工具输出。
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
import { createRecruitAction, parseRecruitEvents, resolveRecruitParams } from '../lib/actions/recruit.js';
import { createRecruitTools } from '../lib/tools/recruit.js';
import { makeLogger, makeTempDir, removeDir, callTool } from './helpers.mjs';

/** 假侧车脚本。 */
const FAKE_SIDECAR = fileURLToPath(new URL('./fake-sidecar.mjs', import.meta.url));

/** 测试用 Tags。 */
const TAGS = ['高级资深干员', '输出', '防护', '生存', '治疗'];

/** 6 星组合脚本。 */
const SIX_STAR_SCRIPT = {
  Recruit: {
    events: [
      { what: 'RecruitTagsDetected', details: { tags: TAGS } },
      {
        what: 'RecruitResult',
        details: {
          tags: TAGS,
          level: 6,
          result: [
            {
              tags: ['高级资深干员', '输出'],
              level: 6,
              opers: [
                { id: 'char_103_angel', name: '能天使', level: 6 },
                { id: 'char_264_f12', name: '银灰', level: 6 },
              ],
            },
            { tags: ['高级资深干员', '防护'], level: 6, opers: [{ id: 'char_254_vodfox', name: '塞雷娅', level: 6 }] },
          ],
        },
      },
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
  const dir = makeTempDir('ark-recruit-');
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
  const action = createRecruitAction(deps);
  return { dir, config, paths, state, session, runtime, ledger, box, store, deps, action, logger, ensureCalls };
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

test('analyze：不需要 confirm，按只识别参数跑 MAA Recruit，并解析 tags/level/combos', async () => {
  const harness = await startHarness({ tasks: SIX_STAR_SCRIPT });
  try {
    const response = await harness.action({});
    assert.equal(response.ok, true);
    assert.equal(response.done, true);
    assert.equal(response.status, 'completed');
    assert.equal(harness.ensureCalls.length, 1);
    assert.equal(response.result.recruit.mode, 'analyze');
    assert.deepEqual(response.result.recruit.tags, TAGS);
    assert.equal(response.result.recruit.level, 6);
    assert.equal(response.result.recruit.combos.length, 2);
    assert.deepEqual(response.result.recruit.combos[0].operators[0], { id: 'char_103_angel', name: '能天使', rarity: 6 });
    assert.match(response.text, /公招识别完成/);
    assert.match(response.text, /能天使/);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    assert.equal(appends[0].type, 'Recruit');
    const params = appends[0].params;
    assert.equal(params.times, 0);
    assert.deepEqual(params.select, []);
    assert.deepEqual(params.confirm, []);
    assert.equal(params.refresh, false);
    assert.equal(params.set_time, false);
    assert.equal(params.expedite, false);
  } finally {
    await stopHarness(harness);
  }
});

test('analyze：参数解析固定为只识别（times=0、空 select/confirm、不刷新）', () => {
  const resolved = resolveRecruitParams({}, { mode: 'analyze', times: 9, refresh: true, expedite: true });
  assert.equal(resolved.mode, 'analyze');
  assert.equal(resolved.maa.times, 0);
  assert.deepEqual(resolved.maa.select, []);
  assert.deepEqual(resolved.maa.confirm, []);
  assert.equal(resolved.maa.refresh, false);
  assert.equal(resolved.maa.set_time, false);
  assert.equal(resolved.maa.expedite, false);
});

test('execute：没 confirm 只回计划，不启动 MAA、不 append', async () => {
  const harness = await startHarness({ tasks: SIX_STAR_SCRIPT, config: { safety: { allowRecruitPermits: true } } });
  try {
    const response = await harness.action({ mode: 'execute', times: 2 });
    assert.equal(response.planned, true);
    assert.equal(response.runId, undefined);
    assert.match(response.text, /需要 confirm=true/);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.session.isRunning(), false);
  } finally {
    await stopHarness(harness);
  }
});

test('execute：默认 safety.allowRecruitPermits=false 时被资源安全闸拒绝', async () => {
  const harness = await startHarness({ tasks: SIX_STAR_SCRIPT });
  try {
    await assert.rejects(
      () => harness.action({ mode: 'execute', confirm: true, times: 1 }),
      (error) => {
        assert.equal(error.code, 'E_UNSAFE_RESOURCE');
        assert.match(error.message, /招聘许可/);
        return true;
      },
    );
    assert.equal(harness.ensureCalls.length, 0);
  } finally {
    await stopHarness(harness);
  }
});

test('execute：安全闸打开后按 times/confirmLevels/selectLevels/refresh/permitReserve/firstTags/preserveTags 组装 MAA 参数', async () => {
  const harness = await startHarness({
    tasks: SIX_STAR_SCRIPT,
    config: { safety: { allowRecruitPermits: true } },
  });
  try {
    const response = await harness.action({
      mode: 'execute',
      confirm: true,
      times: 2,
      confirmLevels: [3, 4],
      selectLevels: [5, 4],
      refresh: true,
      permitReserve: 8,
      firstTags: ['支援机械'],
      preserveTags: ['元素'],
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 'completed');
    assert.equal(response.result.recruit.mode, 'execute');
    assert.equal(response.result.recruit.times, 2);
    assert.deepEqual(response.result.recruit.confirmLevels, [3, 4]);
    assert.deepEqual(response.result.recruit.selectLevels, [4, 5]);
    assert.match(response.text, /公招执行完成/);

    const appends = await appendsOf(harness);
    assert.equal(appends.length, 1);
    const params = appends[0].params;
    assert.equal(params.times, 2);
    assert.deepEqual(params.select, [4, 5]);
    assert.deepEqual(params.confirm, [3, 4]);
    assert.equal(params.refresh, true);
    assert.equal(params.set_time, true);
    assert.equal(params.level3_recruitment_permit_reserve, 8);
    assert.deepEqual(params.first_tags, ['支援机械']);
    assert.deepEqual(params.preserve_tags, ['元素']);
  } finally {
    await stopHarness(harness);
  }
});

test('execute：expedite=true 但没开 safety.allowExpedite 时被拒', async () => {
  const harness = await startHarness({
    tasks: SIX_STAR_SCRIPT,
    config: { safety: { allowRecruitPermits: true } },
  });
  try {
    await assert.rejects(
      () => harness.action({ mode: 'execute', confirm: true, times: 1, expedite: true }),
      (error) => {
        assert.equal(error.code, 'E_UNSAFE_RESOURCE');
        assert.match(error.message, /加急许可/);
        return true;
      },
    );
  } finally {
    await stopHarness(harness);
  }
});

test('execute：times=0 直接拒绝并提示改用 analyze', async () => {
  const harness = await startHarness({ tasks: SIX_STAR_SCRIPT });
  try {
    await assert.rejects(
      () => harness.action({ mode: 'execute', confirm: true, times: 0 }),
      (error) => {
        assert.equal(error.code, 'E_BAD_ARGS');
        assert.match(error.message, /times/);
        return true;
      },
    );
  } finally {
    await stopHarness(harness);
  }
});

test('参数校验：未知 mode / 非法星级 / 非法 target 都报 E_BAD_ARGS', async () => {
  assert.throws(() => resolveRecruitParams({}, { mode: 'auto' }), (error) => error.code === 'E_BAD_ARGS');
  assert.throws(() => resolveRecruitParams({}, { mode: 'execute', confirmLevels: [2] }), (error) => error.code === 'E_BAD_ARGS');
  assert.throws(() => resolveRecruitParams({}, { mode: 'execute', selectLevels: '4,5' }), (error) => error.code === 'E_BAD_ARGS');
});

test('analyze：只解析本次任务链之后的事件（不拿上一次的旧 RecruitResult）', async () => {
  const harness = await startHarness({ tasks: { Recruit: [] } });
  try {
    // 先塞一条「上一次识别」的旧结果；本次任务链没有回传任何公招结果。
    harness.state.pushEvent({
      seq: 100,
      code: 20003,
      name: 'SubTaskExtraInfo',
      details: { what: 'RecruitResult', tags: ['陈旧标签'], level: 6, result: [] },
    });
    const response = await harness.action({});
    assert.equal(response.status, 'partial');
    assert.deepEqual(response.result.recruit.tags, []);
    assert.equal(response.result.recruit.level, null);
    assert.match(response.text, /没有回传结果/);
  } finally {
    await stopHarness(harness);
  }
});

test('dryRun：只出计划，不启动 MAA', async () => {
  const harness = await startHarness({ tasks: SIX_STAR_SCRIPT, config: { dryRun: true } });
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

test('parseRecruitEvents：兼容 MAA 回调细节（opers.level → rarity、刷新/无许可/保留许可）', () => {
  const parsed = parseRecruitEvents([
    {
      what: 'RecruitTagsDetected',
      details: { tags: TAGS },
    },
    {
      what: 'RecruitTagsRefreshed',
      details: { count: 2, refresh_limit: 3 },
    },
    {
      what: 'RecruitResult',
      details: {
        tags: TAGS,
        level: 5,
        result: [{ tags: ['输出'], level: 5, opers: [{ id: 'char_1', name: '甲', level: 5 }] }],
      },
    },
    { what: 'RecruitNoPermit', details: { continue: false } },
    { what: 'RecruitPermitReserved', details: { current: 3 } },
    { what: 'RecruitTagsSelected', details: { tags: ['输出'] } },
  ]);
  assert.equal(parsed.level, 5);
  assert.equal(parsed.combos[0].operators[0].rarity, 5);
  assert.deepEqual(parsed.refreshed, { count: 2, limit: 3 });
  assert.deepEqual(parsed.noPermit, { continue: false });
  assert.deepEqual(parsed.permitReserved, { current: 3 });
  assert.deepEqual(parsed.selected, [['输出']]);
});

test('ark_recruit 工具：返回 response.text、超时 10 分钟、非并发安全', async () => {
  const tools = createRecruitTools({
    actions: {
      recruit: async (args) => ({ text: `recruit:${args.mode}:${args.times}` }),
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_recruit');
  assert.equal(tools[0].timeoutMs, 10 * 60 * 1000);
  assert.equal(tools[0].isConcurrencySafe(), false);
  const result = await callTool(tools, 'ark_recruit', { mode: 'analyze' });
  assert.equal(result.text, 'recruit:analyze:undefined');
  const failure = createRecruitTools({
    actions: {
      recruit: async () => {
        throw arkError('E_NOT_READY', '侧车没跑');
      },
    },
  });
  const failed = await callTool(failure, 'ark_recruit', {});
  assert.match(failed.text, /E_NOT_READY/);
});

/**
 * `lib/actions/rogue.js` + `lib/tools/rogue.js` 单元测试。
 *
 * 覆盖：计划零副作用、MAA 6.21 数字 mode 映射、分队/职业组/核心干员/难度参数、
 * 默认后台（appendAndStart 立即返回）、wait=true 等链结束（6h）、参数校验、
 * 配置回落与工具文本。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createState } from '../lib/state.js';
import { createRunStore } from '../lib/actions/shared.js';
import {
  createRogueAction,
  describeRoguePlan,
  normalizeRogueParams,
  ROGUE_WAIT_TIMEOUT_MS,
} from '../lib/actions/rogue.js';
import { createRogueTool, createRogueTools } from '../lib/tools/rogue.js';
import { callTool } from './helpers.mjs';

/** 断言 rejects 的 code。 */
async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 假运行时：记录 appendAndStart / waitForIdle。 */
function makeRuntime({ state, events = null, waited = null, ensureReadyError = null } = {}) {
  const calls = [];
  return {
    calls,
    async ensureReady(options = {}) {
      calls.push({ op: 'ensureReady', options });
      if (ensureReadyError !== null) throw ensureReadyError;
    },
    async appendAndStart(type, params) {
      calls.push({ op: 'appendAndStart', type, params });
      if (typeof events === 'function') events({ state, params });
      return { taskId: 5 };
    },
    async waitForIdle(options) {
      calls.push({ op: 'waitForIdle', options });
      return waited ?? { timedOut: false, aborted: null };
    },
  };
}

/**
 * 造 rogue 依赖。
 * @param {Record<string, any>} [options] - 覆盖项。
 * @returns {Record<string, any>} harness。
 */
function makeHarness(options = {}) {
  const state = options.state ?? createState();
  const runtime = options.runtime ?? makeRuntime({
    state,
    events: options.events ?? null,
    waited: options.waited ?? null,
  });
  const config = options.config ?? normalizeConfig();
  const logger = { info() {}, warn() {}, error() {} };
  const store = createRunStore({ logger });
  const action = createRogueAction({
    config,
    runtime,
    state,
    store,
    logger,
  });
  return { action, runtime, state, config, store };
}

// —————————————————————————— 计划 ——————————————————————————

test('rogue plan: confirm=false 零副作用，文本含主题/数字 mode', async () => {
  const harness = makeHarness();
  const response = await harness.action({ confirm: false });
  assert.equal(response.ok, true);
  assert.equal(response.planned, true);
  assert.match(response.text, /主题 Sarkaz/);
  assert.match(response.text, /模式 Exp（MAA mode 0）/);
  assert.match(response.text, /9999/);
  assert.match(response.text, /confirm=true/);
  assert.equal(harness.runtime.calls.length, 0);
  assert.equal(harness.store.isRunning(), false);
});

test('rogue plan: 计划阶段回显分队/职业组/核心干员/难度', async () => {
  const harness = makeHarness();
  const response = await harness.action({
    theme: 'Sami',
    mode: 'Invest',
    startsCount: 3,
    squad: '近锋',
    roles: '近卫重装',
    coreChars: '银灰,史尔特尔',
    difficulty: 3,
    confirm: false,
  });
  assert.match(response.text, /主题 Sami/);
  assert.match(response.text, /模式 Invest（MAA mode 1）/);
  assert.match(response.text, /分队：近锋/);
  assert.match(response.text, /职业组：近卫重装/);
  assert.match(response.text, /核心干员：银灰,史尔特尔/);
  assert.match(response.text, /难度：3/);
  assert.equal(harness.runtime.calls.length, 0);
});

// —————————————————————————— 参数（数字 mode） ——————————————————————————

test('rogue params: 友好模式名按 MAA 6.21 映射成数字', () => {
  const config = normalizeConfig();
  assert.equal(normalizeRogueParams({ mode: 'Exp' }, config).maaMode, 0);
  assert.equal(normalizeRogueParams({ mode: 'Invest' }, config).maaMode, 1);
  assert.equal(normalizeRogueParams({ mode: 'Start' }, config).maaMode, 4);
  assert.equal(normalizeRogueParams({ mode: 'Collapse' }, config).maaMode, 5);
  assert.equal(normalizeRogueParams({ mode: 'Monthly' }, config).maaMode, 6);
  assert.equal(normalizeRogueParams({ mode: 'DeepExploration' }, config).maaMode, 7);
  assert.equal(normalizeRogueParams({ mode: 'QuickFirstLayer' }, config).maaMode, 10001);
  assert.equal(normalizeRogueParams({ mode: 'JieGardenNode' }, config).maaMode, 20001);
  assert.equal(normalizeRogueParams({ mode: 'BlackFlowStart' }, config).maaMode, 30003);
  assert.equal(normalizeRogueParams({ mode: 4 }, config).modeName, 'Start');
  assert.equal(normalizeRogueParams({ mode: '4' }, config).maaMode, 4);
});

test('rogue params: squad/roles/coreChars/difficulty 收进 MAA 参数', () => {
  const config = normalizeConfig();
  const normalized = normalizeRogueParams({
    theme: 'Sarkaz',
    mode: 'DeepExploration',
    startsCount: 12,
    squad: '近锋',
    roles: '近卫重装',
    coreChars: ['银灰', '史尔特尔'],
    difficulty: 7,
  }, config);
  assert.deepEqual(normalized.maaParams, {
    theme: 'Sarkaz',
    mode: 7,
    starts_count: 12,
    squad: '近锋',
    roles: '近卫重装',
    core_char: '银灰,史尔特尔',
    difficulty: 7,
  });
});

test('rogue params: 非法主题/模式/次数直接 E_BAD_ARGS，不丢给 MAA', async () => {
  const harness = makeHarness();
  await assertRejectsCode(harness.action({ theme: 'Bogus', confirm: true }), 'E_BAD_ARGS');
  await assertRejectsCode(harness.action({ mode: 'Bogus', confirm: true }), 'E_BAD_ARGS');
  await assertRejectsCode(harness.action({ startsCount: 0, confirm: true }), 'E_BAD_ARGS');
  await assertRejectsCode(harness.action({ difficulty: 99, confirm: true }), 'E_BAD_ARGS');
  assert.equal(harness.runtime.calls.length, 0);
});

test('rogue params: 配置回落（主题/模式/次数/分队/核心干员）', () => {
  const config = normalizeConfig({
    rogue: {
      theme: 'Sami',
      mode: 'Invest',
      startsCount: 5,
      squad: '特训分队',
      coreChars: ['凯尔希'],
    },
  });
  const normalized = normalizeRogueParams({}, config);
  assert.equal(normalized.theme, 'Sami');
  assert.equal(normalized.maaMode, 1);
  assert.equal(normalized.maaParams.starts_count, 5);
  assert.equal(normalized.maaParams.squad, '特训分队');
  assert.equal(normalized.maaParams.core_char, '凯尔希');
  assert.equal(normalized.maaParams.difficulty, undefined);
});

test('describeRoguePlan: 一行摘要', () => {
  assert.equal(describeRoguePlan({ mode: 'Invest' }, normalizeConfig()), '主题 Sarkaz · 模式 Invest（MAA mode 1） · 开始次数 9999');
});

// —————————————————————————— 执行 ——————————————————————————

test('rogue: 默认后台运行 → appendAndStart 后立即返回 started', async () => {
  const harness = makeHarness();
  const response = await harness.action({ confirm: true });
  assert.equal(response.done, true);
  assert.equal(response.status, 'completed');
  assert.equal(response.result.started, true);
  assert.equal(response.result.finished, false);
  assert.equal(response.result.background, true);
  assert.equal(response.result.taskId, 5);
  assert.equal(response.result.theme, 'Sarkaz');
  assert.equal(response.result.mode, 'Exp');
  assert.equal(response.result.maaMode, 0);
  assert.match(response.text, /肉鸽已启动/);
  assert.match(response.text, /不会阻塞等待/);
  const appendCall = harness.runtime.calls.find((call) => call.op === 'appendAndStart');
  assert.equal(appendCall.type, 'Roguelike');
  assert.deepEqual(appendCall.params, { theme: 'Sarkaz', mode: 0, starts_count: 9999 });
  assert.equal(harness.runtime.calls.some((call) => call.op === 'waitForIdle'), false);
});

test('rogue: 指定参数 → appendAndStart 带完整 MAA 参数', async () => {
  const harness = makeHarness();
  await harness.action({
    theme: 'Sami',
    mode: 'Invest',
    startsCount: 2,
    squad: '近锋',
    roles: '近卫重装',
    coreChars: '银灰,史尔特尔',
    difficulty: 3,
    confirm: true,
  });
  const appendCall = harness.runtime.calls.find((call) => call.op === 'appendAndStart');
  assert.deepEqual(appendCall.params, {
    theme: 'Sami',
    mode: 1,
    starts_count: 2,
    squad: '近锋',
    roles: '近卫重装',
    core_char: '银灰,史尔特尔',
    difficulty: 3,
  });
});

test('rogue: params 高级项原样并入并覆盖同名字段', async () => {
  const harness = makeHarness();
  await harness.action({ mode: 'Exp', params: { use_support: true, starts_count: 7 }, confirm: true });
  const appendCall = harness.runtime.calls.find((call) => call.op === 'appendAndStart');
  assert.equal(appendCall.params.use_support, true);
  assert.equal(appendCall.params.starts_count, 7);
});

test('rogue: wait=true 等任务链结束（6h 超时），返回 chains', async () => {
  const state = createState();
  const harness = makeHarness({
    state,
    events: ({ state: target }) => {
      target.pushEvent({ code: 10001, details: { taskchain: 'Roguelike' } });
      target.pushEvent({ code: 10002, details: { taskchain: 'Roguelike' } });
    },
  });
  const response = await harness.action({ wait: true, confirm: true });
  assert.equal(response.status, 'completed');
  assert.equal(response.result.finished, true);
  assert.equal(response.result.timedOut, false);
  assert.deepEqual(response.result.chains.map((chain) => chain.name), ['Roguelike']);
  assert.equal(response.result.chains[0].status, 'completed');
  const waited = harness.runtime.calls.find((call) => call.op === 'waitForIdle');
  assert.equal(waited.options.timeoutMs, ROGUE_WAIT_TIMEOUT_MS);
  assert.equal(ROGUE_WAIT_TIMEOUT_MS, 6 * 60 * 60 * 1000);
  assert.match(response.text, /肉鸽任务结束/);
});

test('rogue: wait=true 超时 → partial，提示任务可能仍在跑', async () => {
  const harness = makeHarness({
    runtime: makeRuntime({ state: createState(), waited: { timedOut: true, aborted: null } }),
  });
  const response = await harness.action({ wait: true, confirm: true });
  assert.equal(response.status, 'partial');
  assert.equal(response.result.finished, false);
  assert.equal(response.result.timedOut, true);
  assert.match(response.text, /等待超时/);
});

test('rogue: ensureReady 失败 → run failed', async () => {
  const harness = makeHarness({
    runtime: makeRuntime({ state: createState(), ensureReadyError: new ArkError('E_EMULATOR_START') }),
  });
  await assertRejectsCode(harness.action({ confirm: true }), 'E_EMULATOR_START');
  assert.equal(harness.store.last()?.status, 'failed');
  assert.equal(harness.runtime.calls.some((call) => call.op === 'appendAndStart'), false);
});

// —————————————————————————— 工具 ——————————————————————————

test('tools/rogue: 文本输出、24h 超时、非并发安全、参数含主题/模式/分队', async () => {
  const tools = createRogueTools({
    actions: { rogue: async (args) => ({ text: `肉鸽计划：${args.theme ?? '默认'}` }) },
  });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'ark_rogue');
  assert.equal(tool.timeoutMs, 24 * 60 * 60 * 1000);
  assert.equal(tool.isConcurrencySafe(), false);
  for (const key of ['theme', 'mode', 'startsCount', 'squad', 'roles', 'coreChars', 'difficulty', 'confirm', 'wait']) {
    assert.ok(tool.parameters.properties[key], `参数应有 ${key}`);
  }
  const result = await callTool(tools, 'ark_rogue', { theme: 'Sami' });
  assert.equal(result.text, '肉鸽计划：Sami');
});

test('tools/rogue: action 抛错时返回带 code 的文本', async () => {
  const tools = [createRogueTool({
    actions: {
      rogue: async () => {
        throw new ArkError('E_TASK_TYPE', 'MAA 不接受 Roguelike 任务参数');
      },
    },
  })];
  const result = await callTool(tools, 'ark_rogue', {});
  assert.match(result.text, /启动肉鸽失败/);
  assert.match(result.text, /E_TASK_TYPE/);
});

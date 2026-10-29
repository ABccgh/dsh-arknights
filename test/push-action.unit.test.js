/**
 * `lib/actions/push.js` + `lib/tools/push.js` 单元测试。
 *
 * 离线：假 runtime 按脚本推 MAA 事件；覆盖计划零副作用、跳过账本满星、
 * 关卡未解锁/无作业/连续失败的停止语义、账本推关进度与下一次起点、工具文本。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createState } from '../lib/state.js';
import { createRunStore } from '../lib/actions/shared.js';
import { createPushAction } from '../lib/actions/push.js';
import { createPushTool, createPushTools } from '../lib/tools/push.js';
import { callTool } from './helpers.mjs';

/** 事件构造器。 */
const ev = {
  chainStart: (taskchain = 'Fight') => ({ code: 10001, details: { taskchain } }),
  chainDone: (taskchain = 'Fight') => ({ code: 10002, details: { taskchain } }),
  chainError: (taskchain = 'Fight') => ({ code: 10000, details: { taskchain } }),
  drops: (stars) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars } }),
  what: (what, details = {}) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what, ...details } }),
};

/** 造主线关卡条目。 */
function makeStages(codes, { apCost = 18, prefix = 'main_' } = {}) {
  return codes.map((code) => ({
    stageId: `${prefix}${code}`,
    code,
    prefix,
    suffix: code,
    apCost,
    dropItems: [],
  }));
}

/** 断言 rejects 的 code。 */
async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 内存账本。 */
function makeLedger({ records = {}, nextPush = '' } = {}) {
  const calls = { recordRun: [], recordFailure: [], setPush: [] };
  return {
    calls,
    get: (code) => records[code],
    nextPushStage: () => nextPush,
    pushView: () => ({ nextStage: nextPush, lastStopped: '', lastReason: '' }),
    recordRun: (...args) => { calls.recordRun.push(args); },
    recordFailure: (...args) => { calls.recordFailure.push(args); },
    setPush: (input) => { calls.setPush.push(input); },
  };
}

/** 假作业站客户端。 */
function makeCopilot({ query } = {}) {
  const state = { queries: [], picks: [], materialized: [] };
  return {
    state,
    query: query ?? (async (code) => {
      state.queries.push(code);
      return { solutions: [], reason: '', total: 0 };
    }),
    pick: (solutions) => {
      state.picks.push(solutions);
      return solutions.slice(0, 3);
    },
    detail: async (id) => ({ id, contentRaw: '{"actions":[{}]}' }),
    materialize: async (solution, code) => {
      state.materialized.push({ solution, code });
      return `C:\\tmp\\${code}-${solution.id ?? 'local'}.json`;
    },
    hasExecutableActions: () => true,
  };
}

/** 假 ArkRec。 */
function makeArkrec() {
  return { describe: async () => null };
}

/** 假 env。 */
function makeEnv() {
  return {
    get: async () => ({ maaPath: '', adbPath: '', address: '', emulator: {} }),
    clear: () => {},
    peek: () => null,
  };
}

/** 假运行时（与 fight 测试同形，按任务类型脚本推事件）。 */
function makeRuntime({ state, scripts = {}, ensureReadyError = null } = {}) {
  const calls = [];
  const countOf = (type) => calls.filter((call) => call.op === 'runTaskChain' && call.type === type).length;
  return {
    calls,
    async ensureReady(options = {}) {
      calls.push({ op: 'ensureReady', options });
      if (ensureReadyError !== null) throw ensureReadyError;
    },
    async dismissOverlays(times = 1) {
      calls.push({ op: 'dismissOverlays', times });
    },
    async stopQuietly() {
      calls.push({ op: 'stopQuietly' });
    },
    async appendAndStart(type, params) {
      calls.push({ op: 'appendAndStart', type, params });
      return { taskId: 1 };
    },
    async waitForIdle() {
      calls.push({ op: 'waitForIdle' });
      return { timedOut: false, aborted: null };
    },
    async runTaskChain(input) {
      calls.push({ op: 'runTaskChain', type: input.type, params: input.params });
      state.resetChain();
      const attempt = countOf(input.type);
      const script = scripts[input.type] ?? scripts.default;
      if (typeof script === 'function') await script({ attempt, type: input.type, params: input.params, state });
      const aborted = typeof input.shouldAbort === 'function' ? input.shouldAbort() : null;
      return {
        taskId: attempt,
        waited: { timedOut: false, aborted },
        stars: state.getStars(),
        drops: state.getDrops(),
        chains: state.getChains(),
        branch: state.getBranch(),
      };
    },
  };
}

/**
 * 造 push 依赖。
 * @param {Record<string, any>} [options] - 覆盖项。
 * @returns {Record<string, any>} harness。
 */
function makeHarness(options = {}) {
  const stages = options.stages ?? makeStages(['5-9', '5-10', '5-11', '5-12', '5-13', '5-14']);
  const state = createState();
  const runtime = options.runtime ?? makeRuntime({
    state,
    scripts: options.scripts ?? {},
    ensureReadyError: options.ensureReadyError ?? null,
  });
  const ledger = options.ledger ?? makeLedger(options.ledgerOptions);
  const copilot = options.copilot ?? makeCopilot(options.copilotOptions);
  const config = options.config ?? normalizeConfig({ push: { maxStages: 10 } });
  const logger = { info() {}, warn() {}, error() {} };
  const store = createRunStore({ logger });
  const resources = async () => ({ stages, itemNames: {} });
  const action = createPushAction({
    config,
    paths: { userDir: '' },
    env: makeEnv(),
    session: { calls: [], request: async () => ({}) },
    state,
    ledger,
    copilot,
    arkrec: makeArkrec(),
    resources,
    runtime,
    store,
    logger,
  });
  return { action, state, runtime, ledger, copilot, config, store, stages };
}

// —————————————————————————— 计划 ——————————————————————————

test('push plan: 起点来自账本 nextPushStage，零副作用', async () => {
  const harness = makeHarness({ ledgerOptions: { nextPush: '5-11' } });
  const response = await harness.action({ confirm: false });
  assert.equal(response.ok, true);
  assert.equal(response.planned, true);
  assert.deepEqual(response.plannedItems.map((item) => item.code), ['5-11', '5-12', '5-13', '5-14']);
  assert.equal(response.plannedItems[0].sanity, 18);
  assert.equal(response.plannedTotalSanity, 4 * 18);
  assert.match(response.text, /推关计划/);
  assert.match(response.text, /没有消耗任何理智/);
  assert.equal(harness.runtime.calls.length, 0);
});

test('push plan: chapter 只推该章；from 与 chapter 同给时从 from 起', async () => {
  const harness = makeHarness({
    stages: [...makeStages(['4-4']), ...makeStages(['5-1', '5-2', '5-3'])],
  });
  const onlyChapter = await harness.action({ chapter: 5, confirm: false });
  assert.deepEqual(onlyChapter.plannedItems.map((item) => item.code), ['5-1', '5-2', '5-3']);

  const fromInChapter = await harness.action({ chapter: 5, from: '5-2', confirm: false });
  assert.deepEqual(fromInChapter.plannedItems.map((item) => item.code), ['5-2', '5-3']);
  assert.equal(harness.runtime.calls.length, 0);
});

test('push plan: 跳过账本已满星的关，并统计 skipped', async () => {
  const harness = makeHarness({
    ledgerOptions: { records: { '5-12': { fullStar: true }, '5-13': { fullStar: true } }, nextPush: '5-11' },
  });
  const response = await harness.action({ confirm: false });
  assert.deepEqual(response.plannedItems.map((item) => item.code), ['5-11', '5-14']);
  assert.match(response.text, /跳过账本已满星 2 关/);
});

test('push plan: 全部满星 → 空队列计划（仍零副作用）', async () => {
  const harness = makeHarness({
    stages: makeStages(['5-11', '5-12']),
    ledgerOptions: {
      records: { '5-11': { fullStar: true }, '5-12': { fullStar: true } },
      nextPush: '5-11',
    },
  });
  const response = await harness.action({ confirm: false });
  assert.deepEqual(response.plannedItems, []);
  assert.match(response.text, /没有需要推的关/);
  assert.equal(harness.runtime.calls.length, 0);
});

// —————————————————————————— 执行 ——————————————————————————

test('push: 全部满星 → completed，跳过满星并写账本进度', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    config: normalizeConfig({ push: { maxStages: 2, from: '', skipLedgerFullStar: true } }),
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart());
        state.pushEvent(ev.drops(3));
        state.pushEvent(ev.chainDone());
      },
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.result.executed.map((item) => item.code), ['5-11', '5-12']);
  assert.equal(response.result.nextStage, '5-13');
  assert.deepEqual(harness.ledger.calls.setPush, [{
    nextStage: '5-13',
    lastStopped: '5-13',
    lastReason: 'queue-exhausted',
  }]);
  assert.equal(harness.ledger.calls.recordRun.length, 2);
  assert.match(response.text, /停在：.*原因：本次队列打完/);
  assert.match(response.text, /下次继续：ark_push from=5-13/);
});

test('push: 遇到 StageQueueStageNotFound → 停在进度边界并记录 nextStage', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    config: normalizeConfig({ push: { maxStages: 3 } }),
    scripts: {
      Fight: ({ attempt, state }) => {
        state.pushEvent(ev.chainStart());
        if (attempt === 1) {
          state.pushEvent(ev.drops(3));
          state.pushEvent(ev.chainDone());
          return;
        }
        state.pushEvent(ev.what('StageQueueStageNotFound'));
      },
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'partial');
  assert.deepEqual(response.result.executed.map((item) => item.code), ['5-11', '5-12']);
  assert.deepEqual(response.result.stopped, { code: '5-12', reason: 'stage-not-found' });
  assert.equal(response.result.nextStage, '5-12');
  assert.match(response.text, /停在：5-12，原因：关卡未解锁（到达进度边界）/);
  assert.match(response.text, /下次继续：ark_push from=5-12/);
  assert.equal(harness.ledger.calls.setPush[0].lastReason, 'stage-not-found');
  assert.equal(harness.ledger.calls.setPush[0].lastStopped, '5-12');
});

test('push: 无作业且 stopOnNoSolution=true → 停在 no-solution', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart());
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'partial');
  assert.equal(response.result.executed.length, 1);
  assert.equal(response.result.executed[0].error.code, 'E_NO_SOLUTION');
  assert.equal(response.result.executed[0].diagnosis.code, 'no-agent');
  assert.deepEqual(response.result.stopped, { code: '5-11', reason: 'no-solution' });
  assert.equal(response.result.nextStage, '5-11');
  assert.match(response.text, /原因：该关没有可用作业/);
  assert.match(response.text, /诊断：no-agent/);
});

test('push: stopOnNoSolution=false → 无作业的关跳过，继续下一关', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    config: normalizeConfig({ push: { maxStages: 2, stopOnNoSolution: false } }),
    scripts: {
      Fight: ({ attempt, state }) => {
        state.pushEvent(ev.chainStart());
        if (attempt === 1) {
          state.pushEvent(ev.what('StageQueueUnableToAgent'));
          return;
        }
        state.pushEvent(ev.drops(3));
        state.pushEvent(ev.chainDone());
      },
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'partial');
  assert.deepEqual(response.result.executed.map((item) => item.ok), [false, true]);
  assert.equal(response.result.stopped.reason, 'queue-exhausted');
  assert.equal(response.result.nextStage, '5-13');
  assert.match(response.text, /下次继续：ark_push from=5-13/);
});

test('push: 连续未满星达到 maxConsecutiveFailures → 停下', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    config: normalizeConfig({ push: { maxStages: 10, maxConsecutiveFailures: 2 } }),
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart());
        state.pushEvent(ev.drops(2));
        state.pushEvent(ev.chainDone());
      },
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'partial');
  assert.equal(response.result.executed.length, 2, '连续两关未满星后应停');
  assert.deepEqual(response.result.stopped, { code: '5-12', reason: 'not-three-stars' });
  const attempts = harness.runtime.calls.filter((call) => call.op === 'runTaskChain');
  assert.equal(attempts.length, 2);
  assert.equal(harness.ledger.calls.recordRun.length, 2);
  assert.deepEqual(harness.ledger.calls.recordRun[0][1], { stars: 2, method: 'fight', difficulty: 'easy' });
});

test('push: 执行前 ensureReady 失败 → run failed，不 append/start', async () => {
  const harness = makeHarness({
    ledgerOptions: { nextPush: '5-11' },
    ensureReadyError: new ArkError('E_EMULATOR_START'),
  });
  await assertRejectsCode(harness.action({ confirm: true }), 'E_EMULATOR_START');
  assert.equal(harness.store.last()?.status, 'failed');
  assert.equal(harness.runtime.calls.some((call) => call.op === 'runTaskChain'), false);
});

test('push: 空队列执行时不 ensureReady（真正零消耗）', async () => {
  const harness = makeHarness({
    stages: makeStages(['5-11', '5-12']),
    ledgerOptions: {
      records: { '5-11': { fullStar: true }, '5-12': { fullStar: true } },
      nextPush: '5-11',
    },
  });
  const response = await harness.action({ confirm: true });
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.result.executed, []);
  assert.match(response.text, /没有启动任何 MAA 任务/);
  assert.equal(harness.runtime.calls.length, 0);
  assert.equal(harness.ledger.calls.setPush.length, 0, '空队列不覆盖账本推关进度');
});

// —————————————————————————— 工具 ——————————————————————————

test('tools/push: 文本输出、4h 超时、非并发安全', async () => {
  const tools = createPushTools({
    actions: { push: async (args) => ({ text: `推关计划：${args.from ?? '自动'}` }) },
  });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'ark_push');
  assert.equal(tool.timeoutMs, 4 * 60 * 60 * 1000);
  assert.equal(tool.isConcurrencySafe(), false);
  for (const key of ['from', 'chapter', 'maxStages', 'confirm']) {
    assert.ok(tool.parameters.properties[key], `参数应有 ${key}`);
  }
  const result = await callTool(tools, 'ark_push', { from: '5-11' });
  assert.equal(result.text, '推关计划：5-11');
});

test('tools/push: action 抛错时返回带 code 的文本', async () => {
  const tools = [createPushTool({
    actions: {
      push: async () => {
        throw new ArkError('E_STAGE_UNKNOWN', '关卡不存在', { hint: '用 ark_status 查进度' });
      },
    },
  })];
  const result = await callTool(tools, 'ark_push', {});
  assert.match(result.text, /推关失败/);
  assert.match(result.text, /E_STAGE_UNKNOWN/);
  assert.match(result.text, /用 ark_status 查进度/);
});

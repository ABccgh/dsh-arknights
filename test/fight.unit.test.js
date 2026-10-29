/**
 * `lib/actions/fight.js` + `lib/tools/fight.js` 单元测试。
 *
 * 全部离线：假 runtime 按「MAA 事件脚本」推事件（形状同 test/fake-sidecar.mjs 的 maa 事件，
 * 见 docs/contracts.md §2.3/§6），不启动 sidecar、不碰模拟器、不消耗理智。
 *
 * 覆盖：计划零副作用、Fight→Copilot 回退、无法代理、关卡不存在、BattleStartAll 分类、
 * tough 参数、drops/series/medicine、超时、多关部分成功、视频/本地作业兜底、工具文本。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createState } from '../lib/state.js';
import { createFightTool, createFightTools } from '../lib/tools/fight.js';
import { createFightAction } from '../lib/actions/fight.js';
import { createRunStore } from '../lib/actions/shared.js';
import { callTool } from './helpers.mjs';

/** 事件构造器（code/name 见 docs/contracts.md §6）。 */
const ev = {
  chainStart: (taskchain = 'Fight') => ({ code: 10001, details: { taskchain } }),
  chainDone: (taskchain = 'Fight') => ({ code: 10002, details: { taskchain } }),
  chainError: (taskchain = 'Fight') => ({ code: 10000, details: { taskchain } }),
  drops: (stars, stats = []) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars, stats } }),
  what: (what, details = {}) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what, ...details } }),
  task: (code, taskchain) => ({ code, details: { taskchain } }),
};

/** 关卡条目（含磨难档，apCost 故意不同以便断言选了哪一档）。 */
const S510_MAIN = { stageId: 'main_05-10', code: '5-10', prefix: 'main_', suffix: '05-10', apCost: 18, dropItems: [] };
const S510_TOUGH = { stageId: 'tough_05-10', code: '5-10', prefix: 'tough_', suffix: '05-10', apCost: 21, dropItems: [] };
const S511 = { stageId: 'main_05-11', code: '5-11', prefix: 'main_', suffix: '05-11', apCost: 18, dropItems: [] };
const S1616_MAIN = { stageId: 'main_16-16', code: '16-16', prefix: 'main_', suffix: '16-16', apCost: 21, dropItems: [] };
const S1616_TOUGH = { stageId: 'tough_16-16', code: '16-16', prefix: 'tough_', suffix: '16-16', apCost: 21, dropItems: [] };
const S17 = { stageId: 'main_01-07', code: '1-7', prefix: 'main_', suffix: '01-07', apCost: 6, dropItems: [] };

/** 默认资源表。 */
const DEFAULT_STAGES = [S510_MAIN, S510_TOUGH, S511, S1616_MAIN, S1616_TOUGH, S17];
/** 默认材料名表。 */
const DEFAULT_ITEM_NAMES = { 30011: '固源岩', 30012: '源岩' };

/** 断言 rejects 的 code。 */
async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 内存账本（v1/v2 字段都收）。 */
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
function makeCopilot(options = {}) {
  const state = { queries: [], picks: [], materialized: [], details: [] };
  const client = {
    state,
    query: options.query ?? (async (code) => {
      state.queries.push(code);
      return { solutions: [], reason: '', total: 0 };
    }),
    pick: options.pick ?? ((solutions) => {
      state.picks.push(solutions);
      return solutions.slice(0, 3);
    }),
    detail: options.detail ?? (async (id) => {
      state.details.push(id);
      return { id, contentRaw: '{"actions":[{},{}]}', stageName: 'main_05-10' };
    }),
    materialize: options.materialize ?? (async (solution, code) => {
      state.materialized.push({ solution, code });
      return `C:\\tmp\\${code}-${solution.id ?? 'local'}.json`;
    }),
    hasExecutableActions: options.hasExecutableActions ?? ((raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        return Array.isArray(parsed?.actions) && parsed.actions.length > 0;
      } catch {
        return false;
      }
    }),
  };
  if (options.queryRecord) {
    client.query = async (code) => {
      state.queries.push(code);
      return options.queryRecord(code);
    };
  }
  return client;
}

/** 假 ArkRec。 */
function makeArkrec(options = {}) {
  return {
    describe: options.describe ?? (async () => null),
  };
}

/** 假 env（fight 不用它，只是 deps 形状完整）。 */
function makeEnv() {
  return {
    get: async () => ({ maaPath: '', adbPath: '', address: '', emulator: {} }),
    clear: () => {},
    peek: () => null,
    initArgs: async () => ({}),
  };
}

/**
 * 假运行时：按脚本推 MAA 事件，然后像 `waitForIdle` 一样调一次 `shouldAbort`。
 *
 * 脚本键是任务类型（`Fight` / `Copilot`），值是 `({attempt,type,params,state}) => void`；
 * 返回 `{timedOut:true}` 可模拟超时。这样 action 的 shouldAbort 判据会被真正执行。
 */
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
      return { taskId: countOf(type) + 1 };
    },
    async waitForIdle(options) {
      calls.push({ op: 'waitForIdle', options });
      return { timedOut: options.runningForever === true, aborted: null };
    },
    async runTaskChain(input) {
      calls.push({ op: 'runTaskChain', type: input.type, params: input.params });
      if (typeof state?.resetChain === 'function') state.resetChain();
      const attempt = countOf(input.type);
      const script = scripts[input.type] ?? scripts.default;
      let scripted = {};
      if (typeof script === 'function') {
        scripted = (await script({ attempt, type: input.type, params: input.params, state, runtime: this })) ?? {};
      }
      if (input.signal?.aborted === true) {
        return {
          taskId: attempt,
          waited: { timedOut: false, aborted: 'stopped' },
          stars: state.getStars(),
          drops: state.getDrops(),
          chains: state.getChains(),
          branch: state.getBranch(),
        };
      }
      const aborted = scripted.aborted ?? (typeof input.shouldAbort === 'function' ? input.shouldAbort() : null);
      return {
        taskId: attempt,
        waited: { timedOut: scripted.timedOut === true, aborted },
        stars: state.getStars(),
        drops: state.getDrops(),
        chains: state.getChains(),
        branch: state.getBranch(),
      };
    },
    async screenshot() {
      return { path: 'shot.png', method: 'maa' };
    },
  };
}

/** 假 session：正常路径不应被调用（video 用 fake recognizeVideo 覆盖）。 */
function makeSession() {
  const session = {
    calls: [],
    holds: { hold: 0, release: 0 },
    async ensureStarted() {
      session.calls.push({ op: 'ensureStarted' });
      return { coreVersion: 'fake', resourceLoaded: true };
    },
    hold() {
      session.holds.hold += 1;
    },
    release() {
      session.holds.release += 1;
    },
    async request(op, args = {}) {
      session.calls.push({ op, args });
      return {};
    },
  };
  return session;
}

/**
 * 造一整套 fight 依赖。
 * @param {Record<string, any>} [options] - 覆盖项。
 * @returns {Record<string, any>} harness。
 */
function makeHarness(options = {}) {
  const state = options.state ?? createState();
  const runtime = options.runtime ?? makeRuntime({
    state,
    scripts: options.scripts ?? {},
    ensureReadyError: options.ensureReadyError ?? null,
  });
  const ledger = options.ledger ?? makeLedger(options.ledgerOptions);
  const copilot = options.copilot ?? makeCopilot();
  const arkrec = options.arkrec ?? makeArkrec();
  const session = options.session ?? makeSession();
  const config = options.config ?? normalizeConfig();
  const logger = {
    entries: [],
    info(message) { logger.entries.push({ level: 'info', message: String(message) }); },
    warn(message) { logger.entries.push({ level: 'warn', message: String(message) }); },
    error(message) { logger.entries.push({ level: 'error', message: String(message) }); },
  };
  const store = options.store ?? createRunStore({ logger });
  const resources = typeof options.resources === 'function'
    ? options.resources
    : async () => options.resources ?? { stages: DEFAULT_STAGES, itemNames: DEFAULT_ITEM_NAMES };
  const deps = {
    config,
    paths: { userDir: '' },
    env: makeEnv(),
    session,
    state,
    ledger,
    copilot,
    arkrec,
    resources,
    runtime,
    store,
    logger,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.deps ?? {}),
  };
  const action = createFightAction(deps);
  return { action, deps, state, runtime, ledger, copilot, arkrec, session, config, store, logger };
}

/** 造一份作业。 */
function solution(id, overrides = {}) {
  return {
    id,
    stageName: 'main_05-10',
    title: `作业${id}`,
    uploader: '博士',
    opers: ['德克萨斯'],
    available: true,
    contentRaw: '{"actions":[{},{}]}',
    ...overrides,
  };
}

// —————————————————————————— 计划（零副作用） ——————————————————————————

test('fight plan: confirm=false 零副作用，只出计划（不 ensureReady / 不 append / 不占 run）', async () => {
  const harness = makeHarness();
  const response = await harness.action({ stages: '5-10', confirm: false });
  assert.equal(response.ok, true);
  assert.equal(response.planned, true);
  assert.equal(response.runId, undefined);
  assert.equal(response.plannedTotalSanity, 18);
  assert.deepEqual(response.plannedItems.map((item) => item.code), ['5-10']);
  assert.match(response.text, /预计理智合计：18/);
  assert.match(response.text, /没有消耗任何理智/);
  assert.equal(harness.runtime.calls.length, 0, '计划阶段绝不能动 runtime');
  assert.equal(harness.session.calls.length, 0, '计划阶段绝不能发 session 请求');
  assert.equal(harness.store.isRunning(), false);
});

test('fight plan: ArkRec 中文名/突袭条件 + tough 选磨难档', async () => {
  const harness = makeHarness({
    arkrec: makeArkrec({
      describe: async (code) => ({
        cn_name: `中文名-${code}`,
        challenge: '禁止使用医疗干员',
        minOperators: 4,
        url: `https://wiki.arkrec.com/operation/${code}`,
      }),
    }),
  });
  const response = await harness.action({ stages: '5-10', difficulty: 'tough', confirm: false });
  assert.equal(response.plannedItems[0].code, '5-10');
  assert.equal(response.plannedItems[0].difficulty, 'tough');
  assert.equal(response.plannedItems[0].cnName, '中文名-5-10');
  assert.equal(response.plannedTotalSanity, 21, '应选 tough_05-10（apCost 21）');
  assert.match(response.text, /中文名-5-10/);
  assert.match(response.text, /突袭条件：禁止使用医疗干员/);
  assert.match(response.text, /磨难\/险地/);
  assert.equal(harness.runtime.calls.length, 0);
});

test('fight plan: drops 必须显式 times；材料名反查成 itemId', async () => {
  const harness = makeHarness();
  await assertRejectsCode(
    harness.action({ stages: '1-7', drops: { 固源岩: 10 }, confirm: false }),
    'E_BAD_ARGS',
  );
  const ok = await harness.action({
    stages: '1-7',
    times: 20,
    drops: { 固源岩: 10, 30012: 5 },
    confirm: false,
  });
  assert.equal(ok.planned, true);
  assert.equal(ok.plannedTotalSanity, 120);
  assert.match(ok.text, /固源岩×10/);
  assert.match(ok.text, /源岩×5/);
  assert.equal(harness.runtime.calls.length, 0);

  await assertRejectsCode(
    harness.action({ stages: '1-7', times: 10, drops: { 不存在的材料: 1 }, confirm: false }),
    'E_BAD_ARGS',
  );
});

test('fight plan: 计划里回显账本与上次失败诊断建议（16-16 场景）', async () => {
  const harness = makeHarness({
    ledger: makeLedger({
      records: {
        '16-16': {
          code: '16-16',
          stars: null,
          fullStar: false,
          failures: [{ at: '2026-10-29T00:00:00.000Z', reason: 'battle-start-timeout', detail: '没进关卡详情' }],
        },
      },
    }),
  });
  const response = await harness.action({ stages: '16-16', difficulty: 'tough', confirm: false });
  assert.equal(response.planned, true);
  assert.match(response.text, /上次失败：battle-start-timeout/);
  assert.match(response.text, /没进关卡详情/);
  assert.match(response.text, /建议：没进关卡详情/);
  assert.equal(harness.runtime.calls.length, 0);
});

test('fight plan: 计划阶段连续两次调用都不产生副作用', async () => {
  const harness = makeHarness();
  await harness.action({ stages: '5-10,5-11', confirm: false });
  await harness.action({ stages: '5-11', confirm: false });
  assert.equal(harness.runtime.calls.length, 0);
  assert.equal(harness.session.calls.length, 0);
});

// —————————————————————————— 执行：正常 / 回退 ——————————————————————————

test('fight: 代理指挥三星 → completed，记账本，Fight 参数正确', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart());
        state.pushEvent(ev.drops(3, [{ itemName: '固源岩', quantity: 2 }]));
        state.pushEvent(ev.chainDone());
      },
    },
  });
  const response = await harness.action({ stages: '5-10', times: 2, confirm: true });
  assert.equal(response.done, true);
  assert.equal(response.status, 'completed');
  const result = response.result;
  assert.deepEqual(result.totals, { sanity: 36, stages: 1 });
  assert.equal(result.executed.length, 1);
  const record = result.executed[0];
  assert.equal(record.ok, true);
  assert.equal(record.method, 'fight');
  assert.equal(record.stars, 3);
  assert.equal(record.sanity, 36);
  assert.deepEqual(record.drops, [{ itemId: '30011', itemName: '固源岩', quantity: 2 }]);
  assert.deepEqual(harness.ledger.calls.recordRun, [['5-10', {
    stars: 3,
    method: 'fight',
    difficulty: 'easy',
  }]]);
  const fightCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Fight');
  assert.deepEqual(fightCall.params, { stage: '5-10', times: 2 });
  assert.equal(harness.session.calls.length, 0);
});

test('fight: UnableToAgent → 自动改抄作业并返回 method=copilot', async () => {
  const solutionOne = solution(104178);
  const copilot = makeCopilot({
    query: async (code) => {
      copilot.state.queries.push(code);
      return { solutions: [solutionOne], reason: '', total: 1 };
    },
    pick: (solutions) => {
      copilot.state.picks.push(solutions);
      return solutions;
    },
  });
  const harness = makeHarness({
    copilot,
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
      Copilot: ({ state }) => {
        state.pushEvent(ev.chainStart('Copilot'));
        state.pushEvent(ev.drops(3));
        state.pushEvent(ev.chainDone('Copilot'));
      },
    },
  });
  const response = await harness.action({ stages: '5-10', times: 2, confirm: true });
  assert.equal(response.status, 'completed');
  const record = response.result.executed[0];
  assert.equal(record.ok, true);
  assert.equal(record.method, 'copilot');
  assert.equal(record.solutionId, 104178);
  assert.equal(record.sanity, 18, '抄作业只打 1 次');
  assert.deepEqual(copilot.state.queries, ['5-10']);
  assert.equal(copilot.state.picks.length, 1);
  assert.equal(copilot.state.materialized.length, 1);

  const types = harness.runtime.calls.filter((call) => call.op === 'runTaskChain').map((call) => call.type);
  assert.deepEqual(types, ['Fight', 'Copilot']);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'stopQuietly'), true, '改抄作业前应先停掉 Fight 链');
  assert.equal(harness.runtime.calls.some((call) => call.op === 'dismissOverlays'), true);
  const copilotCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Copilot');
  assert.equal(copilotCall.params.filename, 'C:\\tmp\\5-10-104178.json');
  assert.equal(copilotCall.params.loop_times, 1);
  assert.equal(copilotCall.params.use_sanity_potion, false);
  assert.equal(copilotCall.params.ignore_requirements, true);
  assert.equal(copilotCall.params.formation, false);
  assert.deepEqual(harness.ledger.calls.recordRun, [['5-10', {
    stars: 3,
    method: 'copilot',
    solutionId: 104178,
    difficulty: 'easy',
  }]]);
});

test('fight: 没有代理指挥且没有作业 → partial + no-agent 诊断 + 三条出路', async () => {
  const harness = makeHarness({
    copilot: makeCopilot({
      query: async (code) => {
        harness.copilot.state.queries.push(code);
        return { solutions: [], reason: `作业站上没有 ${code} 的作业。`, total: 0 };
      },
    }),
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
    },
  });
  const response = await harness.action({ stages: '5-10', confirm: true });
  assert.equal(response.status, 'partial');
  assert.equal(response.result.executed[0].ok, false);
  assert.equal(response.result.executed[0].error.code, 'E_NO_SOLUTION');
  assert.equal(response.result.executed[0].diagnosis.code, 'no-agent');
  assert.match(response.text, /诊断：no-agent/);
  assert.match(response.text, /copilotId/);
  assert.match(response.text, /file=/);
  assert.match(response.text, /手动打一局/);
  assert.equal(harness.ledger.calls.recordFailure.length, 1);
  const [code, failure] = harness.ledger.calls.recordFailure[0];
  assert.equal(code, '5-10');
  assert.equal(failure.reason, 'no-agent');
  assert.equal(failure.code, 'no-agent');
  assert.ok(String(failure.message).includes('没有代理指挥'));
});

test('fight: StageQueueStageNotFound → E_STAGE_UNKNOWN + stage-not-found，不换关不抄作业', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueStageNotFound'));
      },
    },
  });
  const response = await harness.action({ stages: '5-10', confirm: true });
  assert.equal(response.status, 'partial');
  const record = response.result.executed[0];
  assert.equal(record.ok, false);
  assert.equal(record.error.code, 'E_STAGE_UNKNOWN');
  assert.equal(record.diagnosis.code, 'stage-not-found');
  assert.match(response.text, /诊断：stage-not-found/);
  assert.match(response.text, /没解锁|进度边界/);
  assert.equal(harness.runtime.calls.some((call) => call.type === 'Copilot'), false);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'stopQuietly'), true);
  assert.equal(harness.ledger.calls.recordFailure[0][1].reason, 'stage-not-found');
});

test('fight: BattleStartAll 失败输出 battle-start-timeout 诊断，而不是「作业执行失败」', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('BattleStartAll', { taskchain: 'Fight' }));
        state.pushEvent(ev.what('BattleStartAll', { task: 'BattleStartAll' }));
        state.pushEvent(ev.chainError('Fight'));
      },
    },
  });
  const response = await harness.action({ stages: '16-16', difficulty: 'tough', confirm: true });
  assert.equal(response.status, 'partial');
  const record = response.result.executed[0];
  assert.equal(record.diagnosis.code, 'battle-start-timeout');
  assert.match(response.text, /诊断：battle-start-timeout/);
  assert.match(response.text, /没有进入关卡详情/);
  assert.match(response.text, /建议：/);
  assert.equal(response.text.includes('作业执行失败'), false);
});

test('fight: tough 难度 Fight 用 -HARD，抄作业带 is_raid + nav_name_override', async () => {
  const copilot = makeCopilot({
    query: async (code) => {
      copilot.state.queries.push(code);
      return { solutions: [solution(99, { stageName: 'tough_16-16' })], reason: '', total: 1 };
    },
    pick: (solutions) => solutions,
  });
  const harness = makeHarness({
    copilot,
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
      Copilot: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness.action({ stages: '16-16', difficulty: 'tough', confirm: true });
  assert.equal(response.status, 'completed');
  const fightCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Fight');
  assert.equal(fightCall.params.stage, '16-16-HARD');
  const copilotCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Copilot');
  assert.equal(copilotCall.params.is_raid, true);
  assert.equal(copilotCall.params.nav_name_override, '16-16-HARD');
  assert.equal(response.result.planned[0].difficulty, 'tough');
});

test('fight: 超时 → E_TIMEOUT + timeout 诊断并写账本', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: () => ({ timedOut: true }),
    },
  });
  const response = await harness.action({ stages: '5-10', confirm: true });
  assert.equal(response.status, 'partial');
  const record = response.result.executed[0];
  assert.equal(record.error.code, 'E_TIMEOUT');
  assert.equal(record.diagnosis.code, 'timeout');
  assert.match(response.text, /诊断：timeout/);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'stopQuietly'), true);
  assert.equal(harness.ledger.calls.recordFailure.length, 1);
});

test('fight: 多关时一关成功一关失败 → partial，继续打后面的关', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: ({ attempt, state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        if (attempt === 1) {
          state.pushEvent(ev.drops(3));
          state.pushEvent(ev.chainDone());
          return;
        }
        state.pushEvent(ev.what('StageQueueStageNotFound'));
      },
    },
  });
  const response = await harness.action({ stages: '5-10,5-11', confirm: true });
  assert.equal(response.status, 'partial');
  assert.equal(response.result.executed.length, 2);
  assert.equal(response.result.executed[0].ok, true);
  assert.equal(response.result.executed[1].ok, false);
  assert.equal(response.result.totals.stages, 2);
  assert.match(response.text, /完成：1\/2 关满星/);
});

test('fight: ensureReady 失败时整个动作失败（run 记 failed），不 append/start', async () => {
  const harness = makeHarness({ ensureReadyError: new ArkError('E_EMULATOR_START') });
  await assertRejectsCode(harness.action({ stages: '5-10', confirm: true }), 'E_EMULATOR_START');
  assert.equal(harness.store.isRunning(), false);
  assert.equal(harness.store.last()?.status, 'failed');
  assert.equal(harness.runtime.calls.some((call) => call.op === 'runTaskChain'), false);
});

// —————————————————————————— 参数：medicine / stone / series / drops ——————————————————————————

test('fight: medicine 默认被安全闸拒绝（零副作用）', async () => {
  const harness = makeHarness();
  await assertRejectsCode(
    harness.action({ stages: '5-10', medicine: 1, confirm: true }),
    'E_UNSAFE_RESOURCE',
  );
  assert.equal(harness.runtime.calls.length, 0);
  assert.equal(harness.store.isRunning(), false);

  const harness2 = makeHarness({
    config: normalizeConfig({ safety: { allowSanityPotion: true } }),
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness2.action({ stages: '5-10', medicine: 1, confirm: true });
  assert.equal(response.status, 'completed');
  const fightCall = harness2.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Fight');
  assert.equal(fightCall.params.medicine, 1);
});

test('fight: series/drops 传给 Fight；stone 安全闸', async () => {
  const harness = makeHarness({
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness.action({
    stages: '1-7',
    times: 10,
    series: 0,
    drops: { 固源岩: 10 },
    confirm: true,
  });
  assert.equal(response.status, 'completed');
  const fightCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Fight');
  assert.deepEqual(fightCall.params, { stage: '1-7', times: 10, series: 0, drops: { 30011: 10 } });

  await assertRejectsCode(
    makeHarness().action({ stages: '5-10', stone: 1, confirm: true }),
    'E_UNSAFE_RESOURCE',
  );
});

// —————————————————————————— 作业来源：file / video ——————————————————————————

test('fight: file= 本地作业在 Fight 失败后直接使用（不查作业站）', async () => {
  const local = solution(null, { file: 'C:\\tmp\\local-5-10.json', contentRaw: '{"actions":[{}]}' });
  const harness = makeHarness({
    deps: {
      loadLocalSolution: async (file) => ({ ...local, file }),
    },
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
      Copilot: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness.action({
    stages: '5-10',
    file: 'C:\\tmp\\local-5-10.json',
    confirm: true,
  });
  assert.equal(response.status, 'completed');
  assert.equal(harness.copilot.state.queries.length, 0);
  assert.equal(harness.copilot.state.materialized.length, 0);
  const copilotCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Copilot');
  assert.equal(copilotCall.params.filename, 'C:\\tmp\\local-5-10.json');
});

test('fight: video= best-effort 成功时走视频识别出的作业', async () => {
  const recognized = {
    stageName: 'main_05-10',
    contentRaw: '{"actions":[{}]}',
    file: 'C:\\tmp\\video-1.json',
    opers: [],
    title: '视频识别结果',
    source: '事件',
  };
  const harness = makeHarness({
    deps: {
      recognizeVideo: async () => recognized,
    },
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
      Copilot: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness.action({ stages: '5-10', video: 'C:\\tmp\\fight.mp4', confirm: true });
  assert.equal(response.status, 'completed');
  assert.equal(harness.copilot.state.queries.length, 1, '视频成功前会先查一次作业站（空）');
  const copilotCall = harness.runtime.calls.find((call) => call.op === 'runTaskChain' && call.type === 'Copilot');
  assert.equal(copilotCall.params.filename, 'C:\\tmp\\video-1.json');
});

test('fight: video 失败不阻塞 file= 与 copilotId', async () => {
  let recognizeCalls = 0;
  const harness = makeHarness({
    deps: {
      recognizeVideo: async () => {
        recognizeCalls += 1;
        throw new ArkError('E_NO_SOLUTION', '视频识别没有交付作业');
      },
      loadLocalSolution: async (file) => solution(null, { file }),
    },
    scripts: {
      Fight: ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueUnableToAgent'));
      },
      Copilot: ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const response = await harness.action({
    stages: '5-10',
    video: 'C:\\tmp\\fight.mp4',
    file: 'C:\\tmp\\local.json',
    confirm: true,
  });
  assert.equal(response.status, 'completed');
  assert.equal(recognizeCalls, 0, '有 file= 时不应跑视频识别');
});

// —————————————————————————— 工具 ——————————————————————————

test('tools/fight: 文本输出、2h 超时、非并发安全、参数含 series/drops/stone', async () => {
  const calls = [];
  const tools = createFightTools({
    actions: {
      fight: async (args) => {
        calls.push(args);
        return { text: `打关卡计划：${args.stages}` };
      },
    },
  });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'ark_fight');
  assert.equal(tool.timeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(tool.isConcurrencySafe(), false);
  for (const key of ['stages', 'times', 'difficulty', 'medicine', 'stone', 'series', 'drops', 'copilotId', 'file', 'video', 'confirm', 'wait']) {
    assert.ok(tool.parameters.properties[key], `参数应有 ${key}`);
  }
  const result = await callTool(tools, 'ark_fight', { stages: '5-10', difficulty: 'tough' });
  assert.equal(result.text, '打关卡计划：5-10');
  assert.equal(calls.length, 1);
});

test('tools/fight: action 抛 ArkError 时返回 code+message+hint 文本', async () => {
  const tools = [createFightTool({
    actions: {
      fight: async () => {
        throw new ArkError('E_NO_SOLUTION', '没有可用作业', { hint: '用 copilotId= 指定作业' });
      },
    },
  })];
  const result = await callTool(tools, 'ark_fight', { stages: '5-10' });
  assert.match(result.text, /打关卡失败/);
  assert.match(result.text, /E_NO_SOLUTION/);
  assert.match(result.text, /用 copilotId= 指定作业/);
});

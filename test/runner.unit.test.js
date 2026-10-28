/**
 * lib/runner.js 单元测试：单关判定表（三星/未满星/无代理指挥→抄作业/关卡未解锁/无作业/超时）
 * 与肉鸽启动。全部用假 session/env/ledger/copilot/arkrec，不碰 MAA、模拟器、网络。
 * 契约：docs/contracts.md §6（消息码）、§7（错误码）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createRunner } from '../lib/runner.js';
import { createState } from '../lib/state.js';

/** 目标关卡条目（main_05-10）。 */
const ENTRY = { stageId: 'main_05-10', code: '5-10', prefix: 'main_', suffix: '05-10', apCost: 18, dropInfos: [] };
/** 同一关的磨难条目（tough_05-10）。 */
const TOUGH = { ...ENTRY, stageId: 'tough_05-10', prefix: 'tough_' };

/** 事件构造器（code/name 见 docs/contracts.md §6）。 */
const ev = {
  chainStart: (taskchain = 'Fight') => ({ code: 10001, details: { taskchain } }),
  chainDone: (taskchain = 'Fight') => ({ code: 10002, details: { taskchain } }),
  chainError: (taskchain = 'Fight') => ({ code: 10000, details: { taskchain } }),
  drops: (stars, stats = []) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars, stats } }),
  what: (what, details = {}) => ({ code: 20003, name: 'SubTaskExtraInfo', details: { what, ...details } }),
};

/** 一个内存账本（只实现 runner 用到的接口）。 */
function makeLedger() {
  const calls = { recordRun: [], recordFailure: [] };
  return {
    calls,
    get: () => undefined,
    nextPushStage: () => '',
    pushView: () => ({ nextStage: '', lastStopped: '', lastReason: '' }),
    recordRun: (...args) => { calls.recordRun.push(args); },
    recordFailure: (...args) => { calls.recordFailure.push(args); },
    setPush: () => {},
  };
}

/** 假作业站客户端。 */
function makeCopilot(overrides = {}) {
  const state = { queries: [], picks: [], materialized: [] };
  return {
    state,
    query: async (code) => {
      state.queries.push(code);
      return { solutions: [], reason: '', total: 0 };
    },
    pick: (solutions) => {
      state.picks.push(solutions);
      return solutions.slice(0, 3);
    },
    materialize: async (solution, code) => {
      state.materialized.push({ solution, code });
      return `C:\\tmp\\${code}-${solution.id ?? 'local'}.json`;
    },
    ...overrides,
  };
}

/** 假 ArkRec 客户端。 */
function makeArkrec(overrides = {}) {
  return {
    describe: async () => ({
      cn_name: '',
      challenge: '',
      story: '',
      group: '',
      minOperators: 4,
      url: 'https://wiki.arkrec.com/operation/5-10',
    }),
    ...overrides,
  };
}

/** 假 env（runner.fightStage 不用它，只是 deps 需要）。 */
function makeEnv() {
  return { get: async () => ({ maaPath: 'C:\\MAA', pythonPath: 'python.exe' }), clear: () => {}, peek: () => null, initArgs: async () => ({}) };
}

/** 假 session：`script[op]` 可以拦截某个 op（state 可用来推事件）。 */
function makeSession(script, state) {
  const calls = [];
  const holds = { hold: 0, release: 0 };
  /** 各 op 的默认返回。 */
  const defaults = (op) => {
    switch (op) {
      case 'append': return { taskId: 1 };
      case 'start': return { running: true };
      case 'running': return { running: false };
      case 'stop': return { running: false };
      case 'connected': return { connected: true };
      default: return {};
    }
  };
  return {
    calls,
    holds,
    async ensureStarted() { return { coreVersion: 'v6.21.0-beta.2', resourceLoaded: true }; },
    hold() { holds.hold += 1; },
    release() { holds.release += 1; },
    async request(op, args = {}, options = {}) {
      calls.push({ op, args, options });
      const handler = script[op];
      if (typeof handler === 'function') {
        const result = await handler({ args, options, state, calls, op });
        if (result !== undefined) return result;
      }
      return defaults(op);
    },
  };
}

/** 造一整套 runner 依赖。 */
function makeHarness(options = {}) {
  const state = createState();
  const session = makeSession(options.script ?? {}, state);
  const ledger = options.ledger ?? makeLedger();
  const copilot = options.copilot ?? makeCopilot();
  const arkrec = options.arkrec ?? makeArkrec();
  const config = options.config ?? normalizeConfig();
  const runner = createRunner({
    config,
    paths: {},
    env: makeEnv(),
    session,
    state,
    ledger,
    copilot,
    arkrec,
    resources: options.resources ?? (async () => ({ stages: [ENTRY, TOUGH], itemNames: {} })),
    logger: { info: () => {}, warn: () => {} },
  });
  return { runner, state, session, ledger, copilot, arkrec, config };
}

/** 断言 rejects 的 ArkError code。 */
async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('runner: 三星 → ok/full-star，记入账本，hold/release 平衡', async () => {
  const harness = makeHarness({
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.chainStart());
        state.pushEvent(ev.drops(3, [{ itemName: '固源岩', quantity: 2 }]));
        state.pushEvent(ev.chainDone());
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY, TOUGH], code: '5-10', times: 2, difficulty: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'fight');
  assert.equal(result.stars, 3);
  assert.equal(result.reason, 'full-star');
  assert.equal(result.sanity, 36);
  assert.deepEqual(result.drops, { 固源岩: 2 });
  assert.equal(result.solutionId, null);
  assert.deepEqual(harness.ledger.calls.recordRun, [['5-10', { stars: 3, method: 'fight', solutionId: null }]]);
  assert.equal(harness.session.holds.hold, 1);
  assert.equal(harness.session.holds.release, 1);

  const append = harness.session.calls.find((call) => call.op === 'append');
  assert.deepEqual(append.args, { type: 'Fight', params: { stage: '5-10', times: 2 } });
});

test('runner: 二星 → not-three-stars（仍记星级到账本）', async () => {
  const harness = makeHarness({
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.drops(2, [{ itemName: '源岩', quantity: 1 }]));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.stars, 2);
  assert.equal(result.reason, 'not-three-stars');
  assert.deepEqual(result.drops, { 源岩: 1 });
  assert.deepEqual(harness.ledger.calls.recordRun, [['5-10', { stars: 2, method: 'fight', solutionId: null }]]);
});

test('runner: 没有星级事件 → unknown-stars 并记失败', async () => {
  const harness = makeHarness();
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.stars, null);
  assert.equal(result.reason, 'unknown-stars');
  assert.deepEqual(harness.ledger.calls.recordFailure, [['5-10', { reason: 'unknown-stars' }]]);
});

test('runner: UnableToAgent → 自动改抄作业并返回 method=copilot', async () => {
  const solution = { id: 104178, stageName: 'main_05-10', title: '作业', uploader: '博士', opers: [], available: true, contentRaw: '{}' };
  let startCount = 0;
  const copilot = makeCopilot();
  copilot.query = async (code) => {
    copilot.state.queries.push(code);
    return { solutions: [solution], reason: '', total: 1 };
  };
  const harness = makeHarness({
    copilot,
    script: {
      start: async ({ state }) => {
        startCount += 1;
        if (startCount === 1) {
          state.pushEvent(ev.chainStart('Fight'));
          state.pushEvent(ev.what('UnableToAgent'));
          return;
        }
        state.pushEvent(ev.chainStart('Copilot'));
        state.pushEvent(ev.drops(3));
        state.pushEvent(ev.chainDone('Copilot'));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY, TOUGH], code: '5-10', times: 2, difficulty: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'copilot');
  assert.equal(result.stars, 3);
  assert.equal(result.solutionId, 104178);
  assert.equal(result.sanity, 18, '抄作业每关只打 1 次');
  assert.equal(copilot.state.queries.length, 1);
  assert.equal(copilot.state.queries[0], '5-10');
  assert.equal(copilot.state.materialized.length, 1);

  const types = harness.session.calls.filter((call) => call.op === 'append').map((call) => call.args.type);
  assert.deepEqual(types, ['Fight', 'Copilot']);
  const copilotAppend = harness.session.calls.filter((call) => call.op === 'append')[1];
  assert.equal(copilotAppend.args.params.filename, 'C:\\tmp\\5-10-104178.json');
  assert.equal(copilotAppend.args.params.loop_times, 1);
  assert.equal(harness.session.calls.some((call) => call.op === 'stop'), true, '改抄作业前应先停止原任务链');
  assert.equal(harness.session.holds.hold, 2);
  assert.equal(harness.session.holds.release, 2);
  assert.equal(harness.ledger.calls.recordRun.at(-1)[1].method, 'copilot');
});

test('runner: 真实 MAA 的 StageQueueUnableToAgent 触发改抄作业（回归）', async () => {
  const solution = { id: 104178, stageName: 'main_05-10', title: '', uploader: '', opers: [], available: true, contentRaw: '{}' };
  let startCount = 0;
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions: [solution], reason: '', total: 1 }) }),
    script: {
      start: async ({ state }) => {
        startCount += 1;
        if (startCount === 1) {
          state.pushEvent(ev.chainStart('Fight'));
          state.pushEvent(ev.what('StageQueueUnableToAgent')); // docs/contracts.md §6 的真实 what
          return;
        }
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 });
  assert.equal(result.method, 'copilot');
});

test('runner: 任务链 error 无明确信号时也给抄作业一次机会', async () => {
  const solution = { id: 7, stageName: 'main_05-10', title: '', uploader: '', opers: [], available: true, contentRaw: '{}' };
  let startCount = 0;
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions: [solution], reason: '', total: 1 }) }),
    script: {
      start: async ({ state }) => {
        startCount += 1;
        if (startCount === 1) {
          state.pushEvent(ev.chainStart('Fight'));
          state.pushEvent(ev.chainError('Fight'));
          return;
        }
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 });
  assert.equal(result.method, 'copilot');
  assert.equal(result.solutionId, 7);
});

test('runner: StageQueueStageNotFound → 抛 E_STAGE_UNKNOWN 并记失败', async () => {
  const harness = makeHarness({
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.what('StageQueueStageNotFound'));
      },
    },
  });
  await assertRejectsCode(
    harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 }),
    'E_STAGE_UNKNOWN',
  );
  assert.deepEqual(harness.ledger.calls.recordFailure, [['5-10', { reason: 'stage-not-found' }]]);
  assert.equal(harness.session.calls.some((call) => call.op === 'stop'), true);
});

test('runner: append 返回 taskId<=0 → 抛 E_TASK_TYPE 并释放会话', async () => {
  const harness = makeHarness({ script: { append: async () => ({ taskId: 0 }) } });
  await assertRejectsCode(
    harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 }),
    'E_TASK_TYPE',
  );
  assert.equal(harness.session.holds.release, 1);
});

test('runner: 选 tough 难度时 Fight 用 -HARD 后缀导航（MAA 15 章及以后 = 常规/险地）', async () => {
  const harness = makeHarness({
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.chainStart('Fight'));
        state.pushEvent(ev.drops(3));
        state.pushEvent(ev.chainDone('Fight'));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: TOUGH, entries: [ENTRY, TOUGH], code: '5-10', times: 1, difficulty: 'tough' });
  assert.equal(result.method, 'fight');
  const fightCall = harness.session.calls.find((call) => call.op === 'append' && call.args.type === 'Fight');
  assert.deepEqual(fightCall.args.params, { stage: '5-10-HARD', times: 1 });
});

test('runner: tough 难度遇到 UnableToAgent 时抄作业带 is_raid + nav_name_override', async () => {
  const solution = { id: 99, stageName: 'tough_05-10', title: '', uploader: '', opers: [], available: true, contentRaw: '{}' };
  let started = 0;
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions: [solution], reason: '', total: 1 }) }),
    script: {
      start: async ({ state }) => {
        started += 1;
        if (started === 1) {
          state.pushEvent(ev.chainStart('Fight'));
          state.pushEvent(ev.what('StageQueueUnableToAgent'));
          return;
        }
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const result = await harness.runner.fightStage({ entry: TOUGH, entries: [ENTRY, TOUGH], code: '5-10', times: 1, difficulty: 'tough' });
  assert.equal(result.method, 'copilot');
  assert.equal(result.solutionId, 99);
  const copilotCall = harness.session.calls.find((call) => call.op === 'append' && call.args.type === 'Copilot');
  assert.equal(copilotCall.args.params.is_raid, true);
  assert.equal(copilotCall.args.params.nav_name_override, '5-10-HARD');
  assert.equal(started, 2);
});

test('runner: 抄作业没有可用作业 → E_NO_SOLUTION 且 hint 给出三条出路', async () => {
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions: [], reason: '作业站上没有 5-10 的作业。', total: 0 }) }),
  });
  await assert.rejects(
    harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto' }),
    (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_NO_SOLUTION');
      assert.match(String(error.hint), /人工参考/);
      assert.match(String(error.hint), /copilotId/);
      assert.match(String(error.hint), /file/);
      assert.match(String(error.hint), /不借干员/);
      assert.match(String(error.detail), /作业站上没有 5-10 的作业/);
      return true;
    },
  );
  assert.equal(harness.ledger.calls.recordFailure.length, 1);
  assert.equal(harness.ledger.calls.recordFailure[0][1].reason, 'no-solution');
});

test('runner: ArkRec 不可用时 E_NO_SOLUTION 仍能给出 copilotId/file 出路', async () => {
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions: [], reason: '', total: 0 }) }),
    arkrec: makeArkrec({
      describe: async () => {
        throw new Error('arkrec down');
      },
    }),
  });
  await assert.rejects(
    harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto' }),
    (error) => {
      assert.equal(error.code, 'E_NO_SOLUTION');
      assert.equal(String(error.hint).includes('人工参考'), false);
      assert.match(String(error.hint), /copilotId/);
      return true;
    },
  );
});

test('runner: copilot.enabled=false 且没有 file 时直接 E_NO_SOLUTION', async () => {
  const harness = makeHarness({
    config: normalizeConfig({ copilot: { enabled: false } }),
  });
  await assert.rejects(
    harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto' }),
    (error) => {
      assert.equal(error.code, 'E_NO_SOLUTION');
      assert.match(String(error.detail), /copilot\.enabled=false/);
      return true;
    },
  );
  assert.equal(harness.copilot.state.queries.length, 0, '关掉作业站后不应发查询');
});

test('runner: 抄作业成功时选候选并返回 solutionId', async () => {
  const solutions = [
    { id: 111, stageName: 'main_05-10', title: 'A', uploader: 'u1', opers: [], available: true, contentRaw: '{}' },
    { id: 222, stageName: 'main_05-10', title: 'B', uploader: 'u2', opers: [], available: true, contentRaw: '{}' },
  ];
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions, reason: '', total: 2 }) }),
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.drops(3));
      },
    },
  });
  const result = await harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY, TOUGH], code: '5-10', difficulty: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'copilot');
  assert.equal(result.solutionId, 111);
  assert.equal(result.solutionTitle, 'A');
  assert.equal(result.solutionUploader, 'u1');
  assert.equal(harness.copilot.state.picks.length, 1, '未指定 copilotId 时必须走 pick 过滤');
  assert.deepEqual(harness.ledger.calls.recordRun, [['5-10', { stars: 3, method: 'copilot', solutionId: 111 }]]);
});

test('runner: 抄作业逐份尝试，第一份未满星会继续下一份', async () => {
  const solutions = [
    { id: 111, stageName: 'main_05-10', title: 'A', uploader: '', opers: [], available: true, contentRaw: '{}' },
    { id: 222, stageName: 'main_05-10', title: 'B', uploader: '', opers: [], available: true, contentRaw: '{}' },
  ];
  let startCount = 0;
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions, reason: '', total: 2 }) }),
    script: {
      start: async ({ state }) => {
        startCount += 1;
        state.pushEvent(ev.drops(startCount === 1 ? 2 : 3));
      },
    },
  });
  const result = await harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto' });
  assert.equal(result.solutionId, 222);
  assert.equal(startCount, 2);
  assert.equal(harness.copilot.state.materialized.length, 2);
});

test('runner: 所有作业都没满星 → E_NO_SOLUTION（solutions-exhausted）', async () => {
  const solutions = [
    { id: 1, stageName: 'main_05-10', title: '', uploader: '', opers: [], available: true, contentRaw: '{}' },
  ];
  const harness = makeHarness({
    copilot: makeCopilot({ query: async () => ({ solutions, reason: '', total: 1 }) }),
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.drops(2));
      },
    },
  });
  await assert.rejects(
    harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto' }),
    (error) => {
      assert.equal(error.code, 'E_NO_SOLUTION');
      assert.match(error.message, /试了 1 份作业/);
      return true;
    },
  );
  assert.equal(harness.ledger.calls.recordFailure[0][1].reason, 'solutions-exhausted');
  assert.equal(harness.session.holds.release, 1);
});

test('runner: 本地作业文件（file=）跳过作业站查询', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-runner-'));
  try {
    const file = path.join(directory, 'local.json');
    await fs.writeFile(file, JSON.stringify({ stage_name: 'main_05-10', opers: [{ name: '德克萨斯' }] }), 'utf8');
    const harness = makeHarness({
      script: {
        start: async ({ state }) => {
          state.pushEvent(ev.drops(3));
        },
      },
    });
    const result = await harness.runner.copilotStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', difficulty: 'auto', file });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'copilot');
    assert.equal(result.solutionId, null, '本地作业没有站上 id');
    assert.equal(harness.copilot.state.queries.length, 0);
    assert.equal(harness.copilot.state.materialized.length, 0);
    const append = harness.session.calls.find((call) => call.op === 'append');
    assert.equal(append.args.params.filename, file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('runner: 任务一直 running 时抛 E_TIMEOUT（用 Date.now 快进，不真等）', async () => {
  const harness = makeHarness({ script: { running: async () => ({ running: true }) } });
  const realNow = Date.now;
  let ticks = 0;
  Date.now = () => {
    ticks += 1;
    // 第 1 次调用用来算 deadline；之后快进 10^12ms，让 waitForIdle 立刻超时。
    return ticks === 1 ? realNow() : realNow() + 10 ** 12;
  };
  try {
    await assertRejectsCode(
      harness.runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1 }),
      'E_TIMEOUT',
    );
    assert.equal(harness.session.calls.some((call) => call.op === 'stop'), true);
    assert.equal(harness.ledger.calls.recordFailure.length, 0, '超时不写 failures 记录（当前实现行为）');
    assert.equal(harness.session.holds.release, 1);
  } finally {
    Date.now = realNow;
  }
});

test('runner: waitForIdle 超时返回 timedOut（不抛错）', async () => {
  const harness = makeHarness({ script: { running: async () => ({ running: true }) } });
  const startedAt = Date.now();
  const waited = await harness.runner.waitForIdle({ timeoutMs: 5, shouldAbort: () => null });
  assert.equal(waited.timedOut, true);
  assert.equal(waited.aborted, null);
  // 内部轮询 1000ms 一次，所以至少花了 ~1s；不能无限等。
  assert.ok(Date.now() - startedAt >= 900, '应等待一次轮询间隔');
});

test('runner: runRogue 启动后立即返回（wait=false）', async () => {
  const harness = makeHarness({ script: { append: async ({ args }) => ({ taskId: args.type === 'Roguelike' ? 5 : 0 }) } });
  const result = await harness.runner.runRogue({});
  assert.equal(result.started, true);
  assert.equal(result.taskId, 5);
  assert.equal(result.theme, 'Sarkaz');
  assert.equal(result.mode, 'Exp');
  const append = harness.session.calls.find((call) => call.op === 'append');
  assert.deepEqual(append.args, { type: 'Roguelike', params: { theme: 'Sarkaz', mode: 'Exp', starts_count: 9999 } });
});

test('runner: runRogue 可指定主题/模式，append 失败抛 E_TASK_TYPE', async () => {
  const harness = makeHarness({ script: { append: async () => ({ taskId: 0 }) } });
  await assertRejectsCode(harness.runner.runRogue({ theme: 'Sami', mode: 'Invest' }), 'E_TASK_TYPE');
  assert.equal(harness.session.holds.release, 1);
});

test('runner: runRogue wait=true 等待任务链完成', async () => {
  const harness = makeHarness({
    script: {
      start: async ({ state }) => {
        state.pushEvent(ev.chainStart('Roguelike'));
        state.pushEvent(ev.chainDone('Roguelike'));
      },
    },
  });
  const result = await harness.runner.runRogue({ wait: true });
  assert.equal(result.finished, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.chains, [{ name: 'Roguelike', status: 'completed', at: result.chains[0].at }]);
});

test('runner: resolve 解析关卡并选难度', async () => {
  const harness = makeHarness();
  const auto = await harness.runner.resolve('5-10', 'auto');
  assert.equal(auto.code, '5-10');
  assert.equal(auto.entry.stageId, 'main_05-10');
  assert.equal(auto.entries.length, 2);

  const tough = await harness.runner.resolve('5-10', 'tough');
  assert.equal(tough.entry.stageId, 'tough_05-10');

  const byId = await harness.runner.resolve('main_05-10', undefined);
  assert.equal(byId.code, '5-10');

  await assertRejectsCode(harness.runner.resolve('CE-7', 'auto'), 'E_STAGE_UNKNOWN');
});

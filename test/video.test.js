/**
 * 视频兜底链路（lib/video.js）与 runner 接线的离线单元测试。
 *
 * 覆盖：extractCopilot / findCopilotInEvents / findNewCopilotFile / recognizeVideo，
 * 以及 `createRunner().fightStage({video})` 在「Fight 被 UnableToAgent 拦下 → 视频识别
 * → 拿回作业 → 按 Copilot 执行」这条链上的行为与 tough 难度接线。
 *
 * 全部离线：fake session 在 append(VideoRecognition) 时把作业 JSON 写进临时
 * `<userDir>/copilot/`，不联网、不跑 adb/MAA/模拟器。
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
import {
  extractCopilot,
  findCopilotInEvents,
  findNewCopilotFile,
  recognizeVideo,
} from '../lib/video.js';

/** 一份合法作业（含 stage_name 与 actions）。 */
const COPILOT = {
  stage_name: 'main_05-10',
  doc: { title: '视频识别作业', details: '自动生成' },
  opers: [{ name: '德克萨斯' }, { name: '能天使' }],
  actions: [{ type: 'SpeedUp' }, { type: 'Deploy', name: '德克萨斯' }],
};

/** 目标关卡条目（main_05-10）。 */
const ENTRY = {
  stageId: 'main_05-10',
  code: '5-10',
  prefix: 'main_',
  suffix: '05-10',
  apCost: 18,
  dropInfos: [],
};
/** 同一关的磨难条目（tough_05-10）。 */
const TOUGH = { ...ENTRY, stageId: 'tough_05-10', prefix: 'tough_' };

/**
 * 造一个临时目录并登记清理（测试内 finally 删除）。
 * @param {string} prefix - 前缀。
 * @returns {Promise<string>} 路径。
 */
async function makeTmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 断言 rejects 的是指定 code 的 ArkError。
 * @param {Promise<unknown>} promise - 待断言 promise。
 * @param {string} code - 期望错误码。
 * @returns {Promise<ArkError>} 错误对象。
 */
async function assertRejectsCode(promise, code) {
  let caught = null;
  await assert.rejects(promise, (error) => {
    caught = error;
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
  return caught;
}

// —— extractCopilot ——

test('extractCopilot: 从嵌套对象里挖出作业', () => {
  assert.deepEqual(extractCopilot({ payload: { data: COPILOT } }), COPILOT);
  assert.deepEqual(extractCopilot({ a: 1, b: { c: { copilot: COPILOT } } }), COPILOT);
});

test('extractCopilot: 支持 JSON 字符串与数组容器', () => {
  assert.deepEqual(extractCopilot(JSON.stringify(COPILOT)), COPILOT);
  assert.deepEqual(extractCopilot(JSON.stringify([{ foo: 1 }, COPILOT])), COPILOT);
  assert.deepEqual(extractCopilot([{ foo: 1 }, { nested: { copilot: COPILOT } }]), COPILOT);
  // groups 也算可执行动作（MAA 的另一种作业格式）
  const groups = { stage_name: 'tough_10-09', groups: [{ actions: [{ type: 'SpeedUp' }] }] };
  assert.deepEqual(extractCopilot({ data: groups }), groups);
});

test('extractCopilot: 拒绝缺 stage_name / actions 的对象与非 JSON 字符串', () => {
  assert.equal(extractCopilot({ stage_name: 'main_05-10' }), null);
  assert.equal(extractCopilot({ actions: [{ type: 'SpeedUp' }] }), null);
  assert.equal(extractCopilot('not-json'), null);
  assert.equal(extractCopilot('{"foo":1}'), null);
  assert.equal(extractCopilot('null'), null);
  assert.equal(extractCopilot(null), null);
  assert.equal(extractCopilot(undefined), null);
  assert.equal(extractCopilot(42), null);
});

test('extractCopilot: 递归深度上限 3', () => {
  const shallow = { a: { b: { c: { stage_name: 'main_05-10', actions: [{ type: 'SpeedUp' }] } } } };
  assert.notEqual(extractCopilot(shallow), null, '第 3 层应能找到');

  const deep = { a: { b: { c: { d: { stage_name: 'main_05-10', actions: [{ type: 'SpeedUp' }] } } } } };
  assert.equal(extractCopilot(deep), null, '第 4 层开始不再递归');
});

// —— findCopilotInEvents ——

test('findCopilotInEvents: 从事件 details 里挖作业并标出事件来源', () => {
  const state = {
    recentEvents: (limit, options) => {
      assert.equal(limit, 300);
      assert.equal(options.withDetails, true);
      return [
        { name: 'TaskChainStart', what: undefined, details: { taskchain: 'VideoRecognition' } },
        {
          name: 'SubTaskExtraInfo',
          what: 'VideoRecognitionResult',
          details: { payload: COPILOT },
        },
      ];
    },
  };
  const found = findCopilotInEvents(state);
  assert.notEqual(found, null);
  assert.equal(found.content.stage_name, 'main_05-10');
  assert.match(found.source, /事件 SubTaskExtraInfo\/VideoRecognitionResult/);
});

test('findCopilotInEvents: 没有作业事件时返回 null（含 state 缺方法）', () => {
  assert.equal(findCopilotInEvents({ recentEvents: () => [{ name: 'SubTaskExtraInfo', details: { what: 'StageDrops' } }] }), null);
  assert.equal(findCopilotInEvents({ recentEvents: () => [] }), null);
  assert.equal(findCopilotInEvents(null), null);
  assert.equal(findCopilotInEvents({}), null);
});

// —— findNewCopilotFile ——

test('findNewCopilotFile: 只返回开始后新写入的有效作业（旧文件/坏文件被跳过）', async () => {
  const dir = await makeTmp('dsh-ark-video-file-');
  try {
    const oldFile = path.join(dir, 'old.json');
    const newFile = path.join(dir, 'new.json');
    const brokenFile = path.join(dir, 'broken.json');
    const oldMtime = new Date(Date.now() - 60_000);
    await fs.writeFile(oldFile, JSON.stringify({ stage_name: 'main_01-07', actions: [{ type: 'SpeedUp' }] }), 'utf8');
    await fs.utimes(oldFile, oldMtime, oldMtime);
    await fs.writeFile(newFile, JSON.stringify(COPILOT), 'utf8');
    await fs.writeFile(brokenFile, '{ this is not json', 'utf8');

    const found = await findNewCopilotFile([path.join(dir, 'missing-dir'), dir], Date.now() - 10_000);
    assert.notEqual(found, null);
    assert.equal(found.content.stage_name, 'main_05-10');
    assert.match(found.source, /文件 /);
    assert.ok(found.source.includes('new.json'), `应命中 new.json，实际：${found.source}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findNewCopilotFile: 空目录 / 不存在的目录返回 null', async () => {
  const dir = await makeTmp('dsh-ark-video-file-empty-');
  try {
    assert.equal(await findNewCopilotFile([dir], 0), null);
    assert.equal(await findNewCopilotFile([path.join(dir, 'nope')], 0), null);
    assert.equal(await findNewCopilotFile([], 0), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// —— recognizeVideo ——

test('recognizeVideo: 视频不存在时抛 E_BAD_ARGS（不碰 session）', async () => {
  const missing = path.join(os.tmpdir(), `dsh-ark-video-missing-${Date.now()}.mp4`);
  const error = await assertRejectsCode(recognizeVideo({
    videoPath: missing,
    paths: { userDir: path.join(os.tmpdir(), 'dsh-ark-video-userdir-unused') },
    session: {}, // 不应被调用
    state: createState(),
    waitForIdle: async () => ({ timedOut: false, aborted: null }),
  }), 'E_BAD_ARGS');
  assert.match(error.message, /视频文件不存在/);
  assert.match(String(error.hint), /作战录屏/);
});

// —— runner 接线：视频识别后按 Copilot 执行 ——

/**
 * 造一个 fake session：在 append(VideoRecognition) 之后把作业写进 `<userDir>/copilot/`；
 * 在 start 时按次数推事件（Fight → UnableToAgent；VideoRecognition → 链完成；Copilot → 三星）。
 * @param {object} options - 参数。
 * @param {string} options.userDir - MAA userDir。
 * @param {ReturnType<typeof createState>} options.state - 真状态容器。
 * @returns {{ session: Record<string, any>, calls: any[], copilotAppends: any[] }} 结果。
 */
function makeVideoSession({ userDir, state }) {
  const calls = [];
  const copilotAppends = [];
  const copilotDir = path.join(userDir, 'copilot');
  let startCount = 0;
  const session = {
    async ensureStarted() {
      return { coreVersion: 'test', resourceLoaded: true };
    },
    hold() {},
    release() {},
    async request(op, args = {}) {
      calls.push({ op, args });
      if (op === 'append' && args.type === 'VideoRecognition') {
        // 模拟 MAA 在识别完成后把作业 JSON 落到 userDir/copilot/
        await fs.mkdir(copilotDir, { recursive: true });
        await fs.writeFile(path.join(copilotDir, 'recognized.json'), JSON.stringify({
          stage_name: 'tough_05-10',
          actions: [{ type: 'SpeedUp' }],
          opers: [{ name: '德克萨斯' }],
        }), 'utf8');
        return { taskId: 1 };
      }
      if (op === 'append' && args.type === 'Copilot') {
        copilotAppends.push(args);
        return { taskId: 3 };
      }
      if (op === 'append') return { taskId: 2 };
      if (op === 'start') {
        startCount += 1;
        if (startCount === 1) {
          // Fight 被拦：没有代理指挥（MaaCore 实际发的是 StageQueueUnableToAgent）
          state.pushEvent({ code: 10001, details: { taskchain: 'Fight' } });
          state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageQueueUnableToAgent' } });
        } else if (startCount === 2) {
          state.pushEvent({ code: 10001, details: { taskchain: 'VideoRecognition' } });
          state.pushEvent({ code: 10002, details: { taskchain: 'VideoRecognition' } });
        } else {
          state.pushEvent({ code: 10001, details: { taskchain: 'Copilot' } });
          state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3, stats: [] } });
          state.pushEvent({ code: 10002, details: { taskchain: 'Copilot' } });
        }
        return { running: true };
      }
      if (op === 'running') return { running: false };
      if (op === 'stop') return { running: false };
      return {};
    },
  };
  return { session, calls, copilotAppends };
}

/**
 * 造一个内存账本（只实现 runner 用到的接口）。
 * @returns {Record<string, any>} 账本。
 */
function makeLedger() {
  const calls = { recordRun: [], recordFailure: [] };
  return {
    calls,
    get: () => undefined,
    recordRun: (...args) => {
      calls.recordRun.push(args);
    },
    recordFailure: (...args) => {
      calls.recordFailure.push(args);
    },
    setPush: () => {},
    nextPushStage: () => '',
    pushView: () => ({}),
  };
}

test('runner+video: tough 难度下视频识别 → 抄作业执行，Copilot 参数带 is_raid/nav_name_override', async () => {
  const root = await makeTmp('dsh-ark-video-run-');
  try {
    const userDir = path.join(root, 'maa');
    const videoPath = path.join(root, 'fight.mp4');
    await fs.writeFile(videoPath, 'fake video bytes', 'utf8');
    const state = createState();
    const ledger = makeLedger();
    const { session, calls, copilotAppends } = makeVideoSession({ userDir, state });
    const copilot = {
      query: async () => ({ solutions: [], total: 0, reason: '' }),
      pick: () => [],
      materialize: async () => {
        throw new Error('视频作业自带 file，不应再 materialize');
      },
      hasExecutableActions: () => true,
    };
    const runner = createRunner({
      config: normalizeConfig(),
      paths: { userDir },
      env: { get: async () => ({}), clear: () => {}, peek: () => null },
      session,
      state,
      ledger,
      copilot,
      arkrec: { describe: async () => null },
      resources: async () => ({ stages: [ENTRY, TOUGH], itemNames: {} }),
      logger: { info() {}, warn() {} },
    });
    const result = await runner.fightStage({
      entry: TOUGH,
      entries: [ENTRY, TOUGH],
      code: '5-10',
      times: 1,
      difficulty: 'tough',
      video: videoPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.method, 'copilot');
    assert.equal(result.stars, 3);
    assert.equal(result.solutionId, null, '视频作业没有站上 id');

    // Fight 先按磨难导航
    const fightAppend = calls.find((call) => call.op === 'append' && call.args.type === 'Fight');
    assert.equal(fightAppend.args.params.stage, '5-10-HARD');
    // 视频识别把视频绝对路径交给 MAA
    const videoAppend = calls.find((call) => call.op === 'append' && call.args.type === 'VideoRecognition');
    assert.equal(videoAppend.args.params.filename, videoPath);
    // 识别出的作业走 Copilot 执行路径，且带 tough 难度接线
    assert.equal(copilotAppends.length, 1);
    const params = copilotAppends[0].params;
    assert.equal(params.is_raid, true);
    assert.equal(params.nav_name_override, '5-10-HARD');
    assert.equal(params.loop_times, 1);
    assert.equal(params.use_sanity_potion, false);
    assert.match(params.filename, /video-\d+\.json$/);
    // 结果写进账本
    assert.equal(ledger.calls.recordRun.length, 1);
    assert.equal(ledger.calls.recordRun[0][1].method, 'copilot');
    assert.deepEqual(ledger.calls.recordFailure, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runner+video: 视频路径不存在 → E_NO_SOLUTION（detail 说明视频识别失败，不抛裸异常）', async () => {
  const root = await makeTmp('dsh-ark-video-run-missing-');
  try {
    const userDir = path.join(root, 'maa');
    const state = createState();
    const ledger = makeLedger();
    const { session, calls, copilotAppends } = makeVideoSession({ userDir, state });
    const runner = createRunner({
      config: normalizeConfig(),
      paths: { userDir },
      env: { get: async () => ({}), clear: () => {}, peek: () => null },
      session,
      state,
      ledger,
      copilot: {
        query: async () => ({ solutions: [], total: 0, reason: '' }),
        pick: () => [],
        materialize: async () => '',
        hasExecutableActions: () => true,
      },
      arkrec: { describe: async () => null },
      resources: async () => ({ stages: [ENTRY, TOUGH], itemNames: {} }),
      logger: { info() {}, warn() {} },
    });
    const missingVideo = path.join(root, 'missing.mp4');
    let caught = null;
    await assert.rejects(
      runner.fightStage({ entry: ENTRY, entries: [ENTRY, TOUGH], code: '5-10', times: 1, video: missingVideo }),
      (error) => {
        caught = error;
        assert.ok(error instanceof ArkError);
        assert.equal(error.code, 'E_NO_SOLUTION');
        return true;
      },
    );
    assert.match(String(caught.detail), /视频识别失败/);
    assert.match(String(caught.detail), /E_BAD_ARGS|视频文件不存在/);
    assert.match(String(caught.hint), /copilotId/);
    assert.match(String(caught.hint), /file/);
    // 没有真的发起 Copilot 任务
    assert.equal(copilotAppends.length, 0);
    assert.equal(calls.some((call) => call.op === 'append' && call.args.type === 'Copilot'), false);
    assert.equal(ledger.calls.recordFailure.at(-1)[1].reason, 'no-solution');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runner+video: Fight 正常三星时不触发视频识别（视频只是兜底）', async () => {
  const root = await makeTmp('dsh-ark-video-run-skip-');
  try {
    const userDir = path.join(root, 'maa');
    const videoPath = path.join(root, 'unused.mp4');
    await fs.writeFile(videoPath, 'x', 'utf8');
    const state = createState();
    const calls = [];
    const session = {
      async ensureStarted() {
        return { coreVersion: 'test', resourceLoaded: true };
      },
      hold() {},
      release() {},
      async request(op, args = {}) {
        calls.push({ op, args });
        if (op === 'append') return { taskId: 1 };
        if (op === 'start') {
          state.pushEvent({ code: 10001, details: { taskchain: 'Fight' } });
          state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3, stats: [] } });
          return { running: true };
        }
        if (op === 'running') return { running: false };
        return {};
      },
    };
    const runner = createRunner({
      config: normalizeConfig(),
      paths: { userDir },
      env: { get: async () => ({}), clear: () => {}, peek: () => null },
      session,
      state,
      ledger: makeLedger(),
      copilot: {
        query: async () => {
          throw new Error('不应查询作业站');
        },
        pick: () => [],
        materialize: async () => '',
        hasExecutableActions: () => true,
      },
      arkrec: { describe: async () => null },
      resources: async () => ({ stages: [ENTRY], itemNames: {} }),
      logger: { info() {}, warn() {} },
    });
    const result = await runner.fightStage({ entry: ENTRY, entries: [ENTRY], code: '5-10', times: 1, video: videoPath });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'fight');
    assert.equal(calls.some((call) => call.op === 'append' && call.args.type === 'VideoRecognition'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

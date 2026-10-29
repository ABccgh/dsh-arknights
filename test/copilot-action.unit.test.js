/**
 * `lib/actions/copilot.js` 单元测试：抄作业回退的候选收集/单份执行，以及只读的
 * 作业查询动作（ark_solutions 用）。全部离线：假作业站 + 假 runtime 脚本事件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createState } from '../lib/state.js';
import {
  createCopilotFallback,
  createSolutionsAction,
  formatSolutionsText,
} from '../lib/actions/copilot.js';

/** 断言 rejects 的 code。 */
async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArkError, `应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** 造候选作业。 */
function solution(id, overrides = {}) {
  return {
    id,
    stageName: 'main_05-10',
    title: `作业${id}`,
    uploader: '博士',
    opers: ['德克萨斯', '能天使'],
    available: true,
    contentRaw: '{"actions":[{},{}]}',
    ratingLevel: id,
    ...overrides,
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
      return solutions;
    }),
    detail: options.detail ?? (async (id) => {
      state.details.push(id);
      return { id, contentRaw: '{"actions":[{},{}]}', stageName: 'main_05-10', hasActions: true };
    }),
    materialize: options.materialize ?? (async (candidate, code) => {
      state.materialized.push({ candidate, code });
      return `C:\\tmp\\${code}-${candidate.id ?? 'local'}.json`;
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
  return client;
}

/** 假运行时：记录 Copilot 链并推脚本事件。 */
function makeRuntime({ state, script = null, waited = null } = {}) {
  const calls = [];
  return {
    calls,
    async runTaskChain(input) {
      calls.push({ op: 'runTaskChain', type: input.type, params: input.params });
      state?.resetChain?.();
      if (typeof script === 'function') await script({ state, params: input.params });
      const aborted = typeof input.shouldAbort === 'function' ? input.shouldAbort() : null;
      return {
        taskId: 1,
        waited: waited ?? { timedOut: false, aborted },
        stars: state?.getStars?.() ?? null,
        drops: state?.getDrops?.() ?? {},
        chains: state?.getChains?.() ?? [],
      };
    },
    async stopQuietly() {
      calls.push({ op: 'stopQuietly' });
    },
    async dismissOverlays(times = 1) {
      calls.push({ op: 'dismissOverlays', times });
    },
    async waitForIdle() {
      return { timedOut: false, aborted: null };
    },
  };
}

/**
 * 造回退器依赖。
 * @param {Record<string, any>} [options] - 覆盖项。
 * @returns {Record<string, any>} harness。
 */
function makeHarness(options = {}) {
  const state = options.state ?? createState();
  const copilot = options.copilot ?? makeCopilot(options.copilotOptions);
  const runtime = options.runtime ?? makeRuntime({ state, script: options.script, waited: options.waited });
  const config = options.config ?? normalizeConfig();
  const session = { calls: [], hold() {}, release() {}, request: async () => ({}) };
  const fallback = createCopilotFallback({
    config,
    copilot,
    runtime,
    state,
    session,
    paths: { userDir: '' },
    logger: { info() {}, warn() {}, error() {} },
    ...(options.deps ?? {}),
  });
  return { fallback, state, copilot, runtime, config, session };
}

// —————————————————————————— 候选收集 ——————————————————————————

test('copilot collect: file= 优先，不查作业站', async () => {
  const local = { id: null, stageName: 'main_05-10', file: 'C:\\tmp\\local.json', contentRaw: '{"actions":[{}]}' };
  const harness = makeHarness({
    deps: { loadLocalSolution: async (file) => ({ ...local, file }) },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [], file: 'C:\\tmp\\local.json' });
  assert.equal(collected.candidates.length, 1);
  assert.equal(collected.candidates[0].file, 'C:\\tmp\\local.json');
  assert.equal(harness.copilot.state.queries.length, 0);
});

test('copilot collect: copilotId 精确过滤', async () => {
  const harness = makeHarness({
    copilotOptions: {
      query: async (code) => ({
        solutions: [solution(111), solution(222), solution(333)],
        reason: '',
        total: 3,
      }),
      pick: (solutions) => solutions,
    },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [], copilotId: 222 });
  assert.deepEqual(collected.candidates.map((candidate) => candidate.id), [222]);
});

test('copilot collect: 未指定 copilotId 时走 pick 难度过滤，并截到 maxSolutionsPerStage', async () => {
  let pickedInput = null;
  const harness = makeHarness({
    config: normalizeConfig({ copilot: { maxSolutionsPerStage: 2 } }),
    copilotOptions: {
      query: async () => ({ solutions: [solution(1), solution(2), solution(3)], reason: '', total: 3 }),
      pick: (solutions, input) => {
        pickedInput = input;
        return solutions.slice(0, 3);
      },
    },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [{ stageId: 'tough_05-10' }], difficulty: 'tough' });
  assert.equal(collected.candidates.length, 2, '最多尝试 config.copilot.maxSolutionsPerStage 份');
  assert.equal(pickedInput.difficulty, 'tough');
  assert.equal(pickedInput.code, '5-10');
});

test('copilot collect: copilot.enabled=false 且没有 file → 空候选 + 原因', async () => {
  const harness = makeHarness({ config: normalizeConfig({ copilot: { enabled: false } }) });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [] });
  assert.deepEqual(collected.candidates, []);
  assert.match(collected.reason, /copilot\.enabled=false/);
  assert.equal(harness.copilot.state.queries.length, 0);
});

test('copilot collect: 作业站为空时 video= 兜底成功', async () => {
  const recognized = {
    stageName: 'main_05-10',
    contentRaw: '{"actions":[{}]}',
    file: 'C:\\tmp\\video.json',
    opers: ['银灰'],
    title: '视频识别结果',
    source: '事件',
  };
  const harness = makeHarness({
    deps: { recognizeVideo: async () => recognized },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [], video: 'C:\\tmp\\fight.mp4' });
  assert.equal(collected.candidates.length, 1);
  assert.equal(collected.candidates[0].file, 'C:\\tmp\\video.json');
  assert.equal(collected.candidates[0].uploader, 'video');
});

test('copilot collect: video 失败不阻塞（作业站为空时给出原因，不抛异常）', async () => {
  const harness = makeHarness({
    deps: {
      recognizeVideo: async () => {
        throw new ArkError('E_NO_SOLUTION', '视频识别没有交付作业');
      },
    },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [], video: 'C:\\tmp\\fight.mp4' });
  assert.deepEqual(collected.candidates, []);
  assert.match(collected.reason, /视频识别失败/);
  assert.match(collected.reason, /作业站上没有 5-10 的作业/);
});

test('copilot collect: 作业站有候选时不跑视频识别（不阻塞）', async () => {
  let recognizeCalls = 0;
  const harness = makeHarness({
    copilotOptions: {
      query: async () => ({ solutions: [solution(9)], reason: '', total: 1 }),
      pick: (solutions) => solutions,
    },
    deps: {
      recognizeVideo: async () => {
        recognizeCalls += 1;
        throw new Error('不应被调用');
      },
    },
  });
  const collected = await harness.fallback.collect({ code: '5-10', entries: [], video: 'C:\\tmp\\fight.mp4' });
  assert.deepEqual(collected.candidates.map((candidate) => candidate.id), [9]);
  assert.equal(recognizeCalls, 0);
});

// —————————————————————————— 单份执行 ——————————————————————————

test('copilot run: 取完整作业→落盘→append Copilot→三星返回', async () => {
  const harness = makeHarness({
    script: ({ state }) => {
      state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3 } });
    },
  });
  const result = await harness.fallback.run({ code: '5-10', difficulty: 'easy' }, solution(104178));
  assert.equal(result.ok, true);
  assert.equal(result.method, 'copilot');
  assert.equal(result.stars, 3);
  assert.equal(result.solutionId, 104178);
  assert.equal(result.solutionTitle, '作业104178');
  assert.equal(harness.copilot.state.details.length, 1);
  assert.equal(harness.copilot.state.materialized.length, 1);
  assert.equal(harness.copilot.state.materialized[0].candidate.contentRaw, '{"actions":[{},{}]}');
  const chain = harness.runtime.calls.find((call) => call.op === 'runTaskChain');
  assert.equal(chain.type, 'Copilot');
  assert.equal(chain.params.filename, 'C:\\tmp\\5-10-104178.json');
  assert.equal(chain.params.loop_times, 1);
  assert.equal(chain.params.ignore_requirements, true);
  assert.equal(chain.params.use_sanity_potion, false);
  assert.equal(chain.params.is_raid, undefined);
});

test('copilot run: 磨难/险地显式带 is_raid + nav_name_override', async () => {
  const harness = makeHarness({
    script: ({ state }) => {
      state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3 } });
    },
  });
  const result = await harness.fallback.run({ code: '16-16', difficulty: 'tough' }, solution(5));
  assert.equal(result.ok, true);
  const chain = harness.runtime.calls.find((call) => call.op === 'runTaskChain');
  assert.equal(chain.params.is_raid, true);
  assert.equal(chain.params.nav_name_override, '16-16-HARD');
});

test('copilot run: 列表截断（没有 actions）→ 跳过，不跑 MAA', async () => {
  const harness = makeHarness({
    copilotOptions: {
      detail: async () => ({ id: 7, contentRaw: '{"stage_name":"main_05-10"}', stageName: 'main_05-10' }),
    },
  });
  const result = await harness.fallback.run({ code: '5-10' }, solution(7, { contentRaw: '{}' }));
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /没有可执行动作/);
  assert.equal(harness.runtime.calls.length, 0);
});

test('copilot run: 二星 → ok=false 且 dismissOverlays', async () => {
  const harness = makeHarness({
    script: ({ state }) => {
      state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 2 } });
    },
  });
  const result = await harness.fallback.run({ code: '5-10' }, solution(3));
  assert.equal(result.ok, false);
  assert.equal(result.stars, 2);
  assert.match(result.reason, /打出来是 2 星/);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'dismissOverlays'), true);
});

test('copilot run: 作业链 error → ok=false（带事件证据）', async () => {
  const harness = makeHarness({
    script: ({ state }) => {
      state.pushEvent({ code: 10001, details: { taskchain: 'Copilot' } });
      state.pushEvent({ code: 10000, details: { taskchain: 'Copilot' } });
    },
  });
  const result = await harness.fallback.run({ code: '5-10' }, solution(4));
  assert.equal(result.ok, false);
  assert.match(result.reason, /执行失败/);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'dismissOverlays'), true);
});

test('copilot run: 超时 → 停止任务链并返回 timedOut', async () => {
  const harness = makeHarness({ waited: { timedOut: true, aborted: null } });
  const result = await harness.fallback.run({ code: '5-10' }, solution(6));
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.reason, /抄作业超时/);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'stopQuietly'), true);
  assert.equal(harness.runtime.calls.some((call) => call.op === 'dismissOverlays'), true);
});

test('copilot run: use_sanity_potion=true 透传（安全闸由动作层负责）', async () => {
  const harness = makeHarness({
    script: ({ state }) => {
      state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3 } });
    },
  });
  await harness.fallback.run({ code: '5-10', useSanityPotion: true }, solution(8));
  const chain = harness.runtime.calls.find((call) => call.op === 'runTaskChain');
  assert.equal(chain.params.use_sanity_potion, true);
});

test('copilot run: 本地 file= 作业（loadLocalSolution 无 contentRaw）按文件内容校验后执行', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-copilot-'));
  try {
    const file = path.join(dir, 'local.json');
    await fs.writeFile(file, JSON.stringify({ stage_name: 'main_05-10', actions: [{}, {}] }), 'utf8');
    const harness = makeHarness({
      script: ({ state }) => {
        state.pushEvent({ code: 20003, name: 'SubTaskExtraInfo', details: { what: 'StageDrops', stars: 3 } });
      },
    });
    const result = await harness.fallback.run(
      { code: '5-10' },
      { id: null, stageName: 'main_05-10', title: '本地作业', opers: [], file },
    );
    assert.equal(result.ok, true);
    assert.equal(harness.copilot.state.materialized.length, 0, '本地作业不再落盘');
    const chain = harness.runtime.calls.find((call) => call.op === 'runTaskChain');
    assert.equal(chain.params.filename, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copilot run: 本地作业文件读不到 → skipped 而不是静默失败', async () => {
  const harness = makeHarness();
  const result = await harness.fallback.run(
    { code: '5-10' },
    { id: null, stageName: 'main_05-10', file: 'C:\\does-not-exist\\local.json' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /读不到本地作业文件/);
  assert.equal(harness.runtime.calls.length, 0);
});

// —————————————————————————— 只读作业查询（ark_solutions 用） ——————————————————————————

test('solutions action: 只读列出作业（难度过滤 + 文本）', async () => {
  const copilot = makeCopilot({
    query: async (code) => {
      copilot.state.queries.push(code);
      return { solutions: [solution(111), solution(222)], reason: '', total: 2 };
    },
    pick: (solutions) => solutions.slice(0, 2),
  });
  const action = createSolutionsAction({
    config: normalizeConfig(),
    copilot,
    resources: async () => ({
      stages: [
        { stageId: 'main_05-10', code: '5-10', prefix: 'main_', suffix: '05-10', apCost: 18 },
        { stageId: 'tough_05-10', code: '5-10', prefix: 'tough_', suffix: '05-10', apCost: 21 },
      ],
      itemNames: {},
    }),
  });
  const response = await action({ stage: '5-10', difficulty: 'auto' });
  assert.equal(response.ok, true);
  assert.equal(response.kind, 'solutions');
  assert.equal(response.stage, '5-10');
  assert.equal(response.total, 2);
  assert.deepEqual(response.solutions.map((item) => item.id), [111, 222]);
  assert.match(response.text, /id=111/);
  assert.match(response.text, /作业111/);
  assert.equal(copilot.state.queries[0], '5-10');
});

test('solutions action: copilot.enabled=false / 缺 stage 直接报错', async () => {
  const disabled = createSolutionsAction({
    config: normalizeConfig({ copilot: { enabled: false } }),
    copilot: makeCopilot(),
    resources: async () => ({ stages: [], itemNames: {} }),
  });
  await assertRejectsCode(disabled({ stage: '5-10' }), 'E_NO_SOLUTION');

  const action = createSolutionsAction({
    config: normalizeConfig(),
    copilot: makeCopilot(),
    resources: async () => ({ stages: [], itemNames: {} }),
  });
  await assertRejectsCode(action({}), 'E_BAD_ARGS');
});

test('formatSolutionsText: 空列表时给三条出路', () => {
  const text = formatSolutionsText({ code: '5-10', difficulty: 'easy', total: 0, reason: '作业站上没有 5-10 的作业。', solutions: [] });
  assert.match(text, /没有可用作业/);
  assert.match(text, /copilotId/);
  assert.match(text, /file=/);
  assert.match(text, /手动打一局/);
});

/**
 * lib/push.js 单元测试：推关计划（起点/章节/上限/跳过已满星）与执行语义
 * （全绿、关卡未解锁、无作业、连续失败阈值、账本进度）。全部离线。
 * 契约：lib/push.js JSDoc + lib/tools/push.js 的描述。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { ArkError } from '../lib/errors.js';
import { createPush } from '../lib/push.js';

/** 造一组主线关卡条目。 */
function makeStages(codes, { apCost = 18, prefix = 'main_' } = {}) {
  return codes.map((code) => ({ stageId: `${prefix}${code}`, code, apCost, prefix, suffix: code, dropInfos: [] }));
}

/** 造一个内存账本（只实现 push 需要的接口）。 */
function makeLedger({ records = {}, nextPush = '' } = {}) {
  const calls = { setPush: [], recordRun: [], recordFailure: [] };
  return {
    calls,
    get: (code) => records[code],
    nextPushStage: () => nextPush,
    pushView: () => ({ nextStage: nextPush, lastStopped: '', lastReason: '' }),
    setPush: (input) => { calls.setPush.push(input); },
    recordRun: (...args) => { calls.recordRun.push(args); },
    recordFailure: (...args) => { calls.recordFailure.push(args); },
  };
}

/** 造一个假执行器：`handler(request, index)` 决定结果或抛错。 */
function makeRunner(handler = () => ({ ok: true, stars: 3, method: 'fight', sanity: 18, drops: {} })) {
  const calls = [];
  return {
    calls,
    async fightStage(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

/** 造一个推关器 + 依赖（配置默认 maxStages=10；runner 通过工厂懒创建）。 */
function makePush(options = {}) {
  const stages = options.stages ?? makeStages(options.codes ?? ['5-1', '5-2', '5-3', '5-4', '5-5']);
  const ledger = options.ledger ?? makeLedger(options.ledgerOptions);
  const runner = options.runner ?? makeRunner();
  const progress = [];
  const factory = { calls: 0 };
  const config = options.config ?? normalizeConfig({ push: { maxStages: 10 } });
  const push = createPush({
    config,
    ledger,
    resources: async () => ({ stages }),
    runner: () => {
      factory.calls += 1;
      return runner;
    },
    onProgress: (line) => progress.push(line),
  });
  return { push, ledger, runner, stages, progress, factory };
}

/** 造带指定 code 的 ArkError。 */
function arkError(code) {
  return new ArkError(code);
}

test('push: plan 用 from 起点 + maxStages 截断，并给出下一关', async () => {
  const { push, factory } = makePush();
  const plan = await push.plan({ from: '5-2', maxStages: 2 });
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-2', '5-3']);
  assert.equal(plan.nextAfterQueue, '5-4');
  assert.equal(plan.nextAfterSkip, '5-5');
  assert.equal(plan.skipped, 0);
  assert.equal(plan.sanity, 36);
  assert.equal(plan.chapter, null);
  assert.equal(plan.from, '5-2');
  assert.equal(factory.calls, 0, '计划阶段不允许创建执行器（零副作用）');
});

test('push: plan 只给 chapter 时只推该章', async () => {
  const { push } = makePush({ stages: makeStages(['4-4', '5-1', '5-2']) });
  const plan = await push.plan({ chapter: 5 });
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-1', '5-2']);
  assert.equal(plan.chapter, 5);
  assert.equal(plan.from, '');
});

test('push: plan 跳过账本里已满星的关', async () => {
  const { push } = makePush({ ledgerOptions: { records: { '5-3': { fullStar: true } } } });
  const plan = await push.plan({ from: '5-2', maxStages: 3 });
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-2', '5-4', '5-5']);
  assert.equal(plan.skipped, 1);
});

test('push: skipLedgerFullStar=false 时不跳过已满星', async () => {
  const { push } = makePush({
    config: normalizeConfig({ push: { maxStages: 10, skipLedgerFullStar: false } }),
    ledgerOptions: { records: { '5-3': { fullStar: true } } },
  });
  const plan = await push.plan({ from: '5-2', maxStages: 2 });
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-2', '5-3']);
  assert.equal(plan.skipped, 0);
});

test('push: plan 缺省起点来自账本推关进度', async () => {
  const { push } = makePush({ ledgerOptions: { nextPush: '5-3' } });
  const plan = await push.plan({});
  assert.equal(plan.from, '5-3');
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-3', '5-4', '5-5']);
});

test('push: plan 缺省起点其次用配置 push.from', async () => {
  const { push } = makePush({ config: normalizeConfig({ push: { from: '5-4', maxStages: 10 } }) });
  const plan = await push.plan({});
  assert.equal(plan.from, '5-4');
  assert.deepEqual(plan.queue.map((entry) => entry.code), ['5-4', '5-5']);
});

test('push: plan 没有起点时抛 E_BAD_ARGS', async () => {
  const { push } = makePush();
  await assert.rejects(push.plan({}), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_BAD_ARGS');
    return true;
  });
});

test('push: plan 起点不在主线里时抛 E_STAGE_UNKNOWN', async () => {
  const { push } = makePush();
  await assert.rejects(push.plan({ from: 'CE-7' }), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_STAGE_UNKNOWN');
    return true;
  });
});

test('push: plan 章节不存在时抛 E_STAGE_UNKNOWN', async () => {
  const { push } = makePush();
  await assert.rejects(push.plan({ chapter: 99 }), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_STAGE_UNKNOWN');
    return true;
  });
});

test('push: 关卡表没有主线时抛 E_MAA_LOAD', async () => {
  const { push } = makePush({ stages: [] });
  await assert.rejects(push.plan({ from: '5-1' }), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_MAA_LOAD');
    return true;
  });
});

test('push: plan 理智合计按每关 1 次累加', async () => {
  const { push } = makePush({ stages: makeStages(['5-1', '5-2', '5-3'], { apCost: 15 }) });
  const plan = await push.plan({ chapter: 5, maxStages: 2 });
  assert.equal(plan.sanity, 30);
  assert.equal(plan.queue.length, 2);
});

test('push: run 全绿时逐关推进并写推关进度', async () => {
  const { push, ledger, runner, progress, factory } = makePush({ codes: ['5-1', '5-2'] });
  const result = await push.run({ from: '5-1' });
  assert.equal(factory.calls, 1, '执行时才创建执行器');
  assert.equal(result.pushed.length, 2);
  assert.equal(result.pushed.every((item) => item.ok === true), true);
  assert.deepEqual(result.stopped, { code: '', reason: 'queue-exhausted' });
  assert.deepEqual(progress, ['推关：5-1', '推关：5-2']);
  assert.equal(ledger.calls.setPush.length, 1);
  assert.equal(ledger.calls.setPush[0].lastReason, 'queue-exhausted');
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0].times, 1);
  assert.equal(runner.calls[0].difficulty, 'auto');
  assert.deepEqual(runner.calls[0].entries, [runner.calls[0].entry]);
});

test('push: run 遇到关卡未解锁（E_STAGE_UNKNOWN）立即停在原地', async () => {
  const runner = makeRunner(() => { throw arkError('E_STAGE_UNKNOWN'); });
  const { push, ledger } = makePush({ codes: ['5-1', '5-2'], runner });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed.length, 1);
  assert.equal(result.pushed[0].ok, false);
  assert.equal(result.pushed[0].reason, 'E_STAGE_UNKNOWN');
  assert.deepEqual(result.stopped, { code: '5-1', reason: 'stage-not-found' });
  assert.equal(ledger.calls.setPush[0].lastStopped, '5-1');
  assert.equal(ledger.calls.setPush[0].nextStage, '5-1');
});

test('push: run 已在第 2 关停下时 nextStage 指向第 2 关', async () => {
  const runner = makeRunner((_request, index) => {
    if (index === 1) throw arkError('E_STAGE_UNKNOWN');
    return { ok: true, stars: 3, method: 'fight', sanity: 18, drops: {} };
  });
  const { push, ledger } = makePush({ codes: ['5-1', '5-2', '5-3'], runner });
  const result = await push.run({ from: '5-1' });
  assert.deepEqual(result.stopped, { code: '5-2', reason: 'stage-not-found' });
  assert.equal(ledger.calls.setPush[0].nextStage, '5-2');
  assert.equal(ledger.calls.setPush[0].lastStopped, '5-2');
});

test('push: run 没有作业时按 stopOnNoSolution=true 停下', async () => {
  const runner = makeRunner(() => { throw arkError('E_NO_SOLUTION'); });
  const { push } = makePush({ codes: ['5-1', '5-2'], runner });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed.length, 1);
  assert.equal(result.pushed[0].reason, 'E_NO_SOLUTION');
  assert.deepEqual(result.stopped, { code: '5-1', reason: 'no-solution' });
});

test('push: stopOnNoSolution=false 时继续，连续失败到阈值才停', async () => {
  const runner = makeRunner(() => { throw arkError('E_NO_SOLUTION'); });
  const { push } = makePush({
    codes: ['5-1', '5-2', '5-3'],
    runner,
    config: normalizeConfig({ push: { maxStages: 10, stopOnNoSolution: false, maxConsecutiveFailures: 2 } }),
  });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed.length, 2);
  assert.deepEqual(result.stopped, { code: '5-2', reason: 'too-many-failures' });
});

test('push: run 连续未满星达到阈值时停下', async () => {
  const runner = makeRunner(() => ({ ok: false, stars: 2, method: 'fight', sanity: 18, drops: {} }));
  const { push } = makePush({
    codes: ['5-1', '5-2', '5-3'],
    runner,
    config: normalizeConfig({ push: { maxStages: 10, maxConsecutiveFailures: 2 } }),
  });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed.length, 2);
  assert.deepEqual(result.stopped, { code: '5-2', reason: 'not-three-stars' });
});

test('push: run 一次失败后成功会重置连续失败计数', async () => {
  const runner = makeRunner((_request, index) => {
    if (index === 0 || index === 2) return { ok: false, stars: 2, method: 'fight', sanity: 18, drops: {} };
    return { ok: true, stars: 3, method: 'copilot', sanity: 18, drops: {} };
  });
  const { push } = makePush({
    codes: ['5-1', '5-2', '5-3'],
    runner,
    config: normalizeConfig({ push: { maxStages: 10, maxConsecutiveFailures: 2 } }),
  });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed.length, 3);
  assert.equal(result.stopped.reason, 'queue-exhausted');
});

test('push: run 无代码错误（裸 Error）按 E_UNDEFINED 记录', async () => {
  const runner = makeRunner(() => { throw new Error('boom'); });
  const { push } = makePush({
    codes: ['5-1', '5-2'],
    runner,
    config: normalizeConfig({ push: { maxStages: 10, maxConsecutiveFailures: 2 } }),
  });
  const result = await push.run({ from: '5-1' });
  assert.equal(result.pushed[0].reason, 'E_UNDEFINED');
  assert.deepEqual(result.stopped, { code: '5-2', reason: 'too-many-failures' });
});

test('push: run 队列全被跳过时返回 nothing-to-push', async () => {
  const records = { '5-1': { fullStar: true }, '5-2': { fullStar: true } };
  const { push } = makePush({ codes: ['5-1', '5-2'], ledgerOptions: { records } });
  const result = await push.run({ from: '5-1' });
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.stopped, { code: '5-2', reason: 'nothing-to-push' });
  assert.equal(result.nextStage, '5-2', '下次从队列末尾之后继续（这里 5-2 是跳过边界）');
});

test('push: run 也可以直接注入 input.runner（不经过工厂）', async () => {
  const runner = makeRunner(() => ({ ok: true, stars: 3, method: 'fight', sanity: 18, drops: {} }));
  const { push } = makePush({ codes: ['5-1'], runner: makeRunner(() => { throw new Error('工厂不应被调用'); }) });
  const result = await push.run({ from: '5-1', runner });
  assert.equal(result.pushed.length, 1);
  assert.equal(runner.calls.length, 1, '显式注入的 runner 必须被使用');
});

test('push: run 既没有 input.runner 也没有 deps.runner 时抛 E_BAD_ARGS', async () => {
  const push = createPush({
    config: normalizeConfig({ push: { maxStages: 10 } }),
    ledger: makeLedger(),
    resources: async () => ({ stages: makeStages(['5-1']) }),
  });
  await assert.rejects(push.run({ from: '5-1' }), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_BAD_ARGS');
    return true;
  });
});

test('push: run 结果里带上星级/方式/理智/掉落', async () => {
  const runner = makeRunner(() => ({ ok: true, stars: 3, method: 'copilot', sanity: 18, drops: { 固源岩: 2 } }));
  const { push } = makePush({ codes: ['5-1'], runner });
  const result = await push.run({ from: '5-1' });
  assert.deepEqual(result.pushed[0], {
    code: '5-1',
    ok: true,
    stars: 3,
    method: 'copilot',
    sanity: 18,
    drops: { 固源岩: 2 },
  });
});

test.expectFailure('push: 同时给 from 与 chapter 时 chapter 应始终生效（lib 缺陷：过滤为空会被忽略）', async () => {
  const { push } = makePush({ stages: makeStages(['4-4', '5-1', '5-2']) });
  // 按 lib/tools/push.js 的描述「与 from 同时给时以 from 为起点、并且只推这一章」：
  // chapter=4 时不该推出 5-x 的关卡。当前实现过滤结果为空时会退化为不按章节过滤。
  const plan = await push.plan({ from: '5-1', chapter: 4 });
  assert.deepEqual(plan.queue.map((entry) => entry.code), []);
});

/**
 * lib/state.js 单元测试：事件环形缓冲、任务链状态机、星级/理智/掉落派生、状态快照脱敏。
 * 契约：docs/contracts.md §4（Node 侧事件模型）、§5（状态 JSON）。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_NAMES, createState } from '../lib/state.js';

/** 造一条 TaskChain* 事件。 */
function chainEvent(code, taskchain) {
  return { code, details: taskchain === undefined ? {} : { taskchain } };
}

/** 造一条 SubTaskExtraInfo（带 what）事件。 */
function whatEvent(what, details = {}) {
  return { code: 20003, name: 'SubTaskExtraInfo', details: { what, ...details } };
}

test('state: MESSAGE_NAMES 与契约 §6 一致', () => {
  assert.equal(MESSAGE_NAMES[0], 'InternalError');
  assert.equal(MESSAGE_NAMES[10000], 'TaskChainError');
  assert.equal(MESSAGE_NAMES[10001], 'TaskChainStart');
  assert.equal(MESSAGE_NAMES[10002], 'TaskChainCompleted');
  assert.equal(MESSAGE_NAMES[10004], 'TaskChainStopped');
  assert.equal(MESSAGE_NAMES[20003], 'SubTaskExtraInfo');
  assert.equal(MESSAGE_NAMES[30000], 'ReportRequest');
});

test('state: pushEvent 补齐 seq/name/ts/details 并返回事件', () => {
  const state = createState();
  const event = state.pushEvent({ code: 10001, details: { taskchain: 'Fight' }, ts: '2026-10-28T00:00:00.000Z' });
  assert.equal(event.seq, 1);
  assert.equal(event.code, 10001);
  assert.equal(event.name, 'TaskChainStart');
  assert.equal(event.task, 'Fight');
  assert.equal(event.ts, '2026-10-28T00:00:00.000Z');
  assert.deepEqual(event.details, { taskchain: 'Fight' });
  assert.equal(state.getLastSeq(), 1);
});

test('state: 名字可由码表推导，未知码回退 Code<n>', () => {
  const state = createState();
  assert.equal(state.pushEvent({ code: 10002 }).name, 'TaskChainCompleted');
  assert.equal(state.pushEvent({ code: 999 }).name, 'Code999');
  const explicit = state.pushEvent({ code: 20003, name: 'CustomName' });
  assert.equal(explicit.name, 'CustomName');
});

test('state: seq 缺失时自增，显式 seq 不回退', () => {
  const state = createState();
  assert.equal(state.pushEvent({ code: 2 }).seq, 1);
  assert.equal(state.pushEvent({ code: 2, seq: 10 }).seq, 10);
  assert.equal(state.pushEvent({ code: 2 }).seq, 11);
  assert.equal(state.getLastSeq(), 11);
});

test('state: TaskChainStart/Completed 状态机', () => {
  const state = createState();
  state.pushEvent(chainEvent(10001, 'Fight'));
  assert.equal(state.snapshot().tasks.running, true);
  assert.equal(state.snapshot().tasks.current, 'Fight');
  assert.deepEqual(state.getChains().map((chain) => [chain.name, chain.status]), [['Fight', 'running']]);

  state.pushEvent(chainEvent(10002, 'Fight'));
  const snapshot = state.snapshot();
  assert.equal(snapshot.tasks.running, false);
  assert.equal(snapshot.tasks.current, null);
  assert.deepEqual(state.getChains().map((chain) => [chain.name, chain.status]), [['Fight', 'completed']]);
});

test('state: TaskChainError / TaskChainStopped 结束态', () => {
  const errorState = createState();
  errorState.pushEvent(chainEvent(10001, 'Fight'));
  errorState.pushEvent(chainEvent(10000, 'Fight'));
  assert.equal(errorState.getChains()[0].status, 'error');
  assert.equal(errorState.snapshot().tasks.running, false);

  const stoppedState = createState();
  stoppedState.pushEvent(chainEvent(10001, 'Roguelike'));
  stoppedState.pushEvent(chainEvent(10004, 'Roguelike'));
  assert.equal(stoppedState.getChains()[0].status, 'stopped');
});

test('state: 无 taskchain 的链事件回退到 current / Unknown', () => {
  const state = createState();
  state.pushEvent({ code: 10001 });
  assert.deepEqual(state.getChains().map((chain) => chain.name), ['Unknown']);
  state.pushEvent({ code: 10002 });
  assert.equal(state.snapshot().tasks.current, null);
  assert.equal(state.getChains()[0].status, 'completed');
});

test('state: 结束事件只标记最近一条同名 running 链', () => {
  const state = createState();
  state.pushEvent(chainEvent(10001, 'Fight'));
  state.pushEvent(chainEvent(10002, 'Fight'));
  state.pushEvent(chainEvent(10001, 'Fight'));
  state.pushEvent({ code: 10002 });
  assert.deepEqual(state.getChains().map((chain) => chain.status), ['completed', 'completed']);
});

test('state: StageDrops 累计星级与掉落', () => {
  const state = createState();
  state.pushEvent(whatEvent('StageDrops', { stars: 2, stats: [{ itemName: '固源岩', quantity: 2 }] }));
  assert.equal(state.getStars(), 2);
  assert.deepEqual(state.getDrops(), { 固源岩: 2 });

  state.pushEvent(whatEvent('StageDrops', { stars: 3, stats: [{ itemName: '固源岩', quantity: 1 }, { itemName: '源岩', quantity: 4 }] }));
  assert.equal(state.getStars(), 3);
  assert.deepEqual(state.getDrops(), { 固源岩: 3, 源岩: 4 });
});

test('state: StageDrops 的坏字段被忽略，不产生 NaN', () => {
  const state = createState();
  state.pushEvent(whatEvent('StageDrops', { stars: 'abc', stats: [{ itemName: '', quantity: 1 }, { itemName: '源岩', quantity: 'x' }, null] }));
  assert.equal(state.getStars(), null);
  assert.deepEqual(state.getDrops(), {});
});

test('state: NotThreeStars 把星级压到 2（未知时记 0）', () => {
  const unknown = createState();
  unknown.pushEvent(whatEvent('NotThreeStars'));
  assert.equal(unknown.getStars(), 0);

  const two = createState();
  two.pushEvent(whatEvent('StageDrops', { stars: 2 }));
  two.pushEvent(whatEvent('NotThreeStars'));
  assert.equal(two.getStars(), 2);

  const three = createState();
  three.pushEvent(whatEvent('StageDrops', { stars: 3 }));
  three.pushEvent(whatEvent('NotThreeStars'));
  assert.equal(three.getStars(), 2);
});

test('state: SanityBeforeStage 记录当前/最大理智', () => {
  const state = createState();
  assert.deepEqual(state.snapshot().sanity, { current: null, max: null });
  state.pushEvent(whatEvent('SanityBeforeStage', { current_sanity: 100, max_sanity: 135 }));
  assert.deepEqual(state.snapshot().sanity, { current: 100, max: 135 });
  state.pushEvent(whatEvent('SanityBeforeStage', { current_sanity: null, max_sanity: null }));
  assert.deepEqual(state.snapshot().sanity, { current: null, max: null });
});

test('state: UnableToAgent 系列记录 branch', () => {
  const state = createState();
  assert.equal(state.getBranch(), null);
  state.pushEvent(whatEvent('UnableToAgent'));
  assert.equal(state.getBranch(), 'UnableToAgent');
  state.pushEvent(whatEvent('UnableToAgent2'));
  assert.equal(state.getBranch(), 'UnableToAgent2');
});

test('state: 真实 MAA 的 StageQueueUnableToAgent 也识别成 UnableToAgent 分支（回归）', () => {
  // docs/contracts.md §6 与 MaaCore.dll 的字面量都是 `StageQueueUnableToAgent`；
  // lib/state.js 用 includes('UnableToAgent') 匹配，所以这个真实事件必须命中。
  const state = createState();
  state.pushEvent(whatEvent('StageQueueUnableToAgent'));
  assert.equal(state.getBranch(), 'StageQueueUnableToAgent');
});

test('state: BattleStartAll / BattleOfficiallyBegin 标记开战', () => {
  const state = createState();
  assert.equal(state.isBattleStarted(), false);
  state.pushEvent(whatEvent('BattleStartAll'));
  assert.equal(state.isBattleStarted(), true);
  const other = createState();
  other.pushEvent(whatEvent('BattleOfficiallyBegin'));
  assert.equal(other.isBattleStarted(), true);
});

test('state: resetChain 清派生状态但保留事件缓冲与 seq', () => {
  const state = createState();
  state.pushEvent(chainEvent(10001, 'Fight'));
  state.pushEvent(whatEvent('StageDrops', { stars: 3, stats: [{ itemName: '源岩', quantity: 1 }] }));
  state.pushEvent(whatEvent('SanityBeforeStage', { current_sanity: 10, max_sanity: 135 }));
  state.pushEvent(whatEvent('UnableToAgent'));
  state.pushEvent(whatEvent('BattleStartAll'));
  const before = state.getLastSeq();

  state.resetChain();
  const snapshot = state.snapshot();
  assert.equal(snapshot.tasks.running, false);
  assert.deepEqual(state.getChains(), []);
  assert.equal(state.getStars(), null);
  assert.deepEqual(state.getDrops(), {});
  assert.equal(state.getBranch(), null);
  assert.equal(state.isBattleStarted(), false);
  // 事件与 seq 不清：
  assert.equal(state.getLastSeq(), before);
  assert.equal(snapshot.events.length, 5);
});

test('state: recentEvents 默认不带 details（状态 JSON 不泄漏 MAA 细节）', () => {
  const state = createState();
  state.pushEvent(whatEvent('StageDrops', { stars: 3, token: 'secret-ish-detail' }));
  const [event] = state.recentEvents();
  assert.equal(event.what, 'StageDrops');
  assert.equal('details' in event, false);
  const [withDetails] = state.recentEvents(1, { withDetails: true });
  assert.equal(withDetails.details.token, 'secret-ish-detail');
});

test('state: recentEvents 限制条数并保持时间正序', () => {
  const state = createState();
  for (let index = 0; index < 5; index += 1) state.pushEvent({ code: 20003, seq: index + 1 });
  assert.deepEqual(state.recentEvents(2).map((event) => event.seq), [4, 5]);
  assert.equal(state.recentEvents(100).length, 5);
  // 非法 limit 回退默认（10 条）
  assert.equal(state.recentEvents(0).length, 5);
  assert.equal(state.recentEvents(-3).length, 5);
});

test('state: 环形缓冲按 maxEvents 截断', () => {
  const state = createState({ maxEvents: 2 });
  state.pushEvent({ code: 1, seq: 1 });
  state.pushEvent({ code: 2, seq: 2 });
  state.pushEvent({ code: 3, seq: 3 });
  assert.deepEqual(state.recentEvents(10).map((event) => event.seq), [2, 3]);
  assert.equal(state.getLastSeq(), 3);
});

test('state: snapshot 是副本，修改它不影响内部状态', () => {
  const state = createState();
  state.pushEvent(chainEvent(10001, 'Fight'));
  state.pushEvent(whatEvent('StageDrops', { stars: 3, stats: [{ itemName: '源岩', quantity: 1 }] }));
  const snapshot = state.snapshot();
  snapshot.tasks.chains[0].status = 'hacked';
  snapshot.drops['源岩'] = 999;
  assert.equal(state.getChains()[0].status, 'running');
  assert.deepEqual(state.getDrops(), { 源岩: 1 });
});

test('state: hasWhat 在事件缓冲里查 what', () => {
  const state = createState();
  assert.equal(state.hasWhat('StageQueueStageNotFound'), false);
  state.pushEvent(whatEvent('StageQueueStageNotFound'));
  assert.equal(state.hasWhat('StageQueueStageNotFound'), true);
});

test('state: missingOperText 读取最近一次干员不匹配事件', () => {
  const state = createState();
  assert.equal(state.missingOperText(), '');
  state.pushEvent(whatEvent('BattleFormationOperbox1Unmatched', { oper_name: '德克萨斯' }));
  assert.equal(state.missingOperText(), '缺少干员：德克萨斯。');
  state.pushEvent(whatEvent('BattleFormationOperbox1Unmatched', { group_name: '近卫' }));
  assert.equal(state.missingOperText(), '缺少干员：近卫。');
  state.pushEvent(whatEvent('BattleStartAll'));
  assert.equal(state.missingOperText(), '缺少干员：近卫。');
});

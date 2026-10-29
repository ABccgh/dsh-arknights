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

test('state: SanityBeforeStage 记录当前/最大理智与时间', () => {
  const state = createState();
  assert.deepEqual(state.snapshot().sanity, { current: null, max: null, at: null });
  state.pushEvent(whatEvent('SanityBeforeStage', { current_sanity: 100, max_sanity: 135 }));
  const sanity = state.snapshot().sanity;
  assert.equal(sanity.current, 100);
  assert.equal(sanity.max, 135);
  assert.match(sanity.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.getSanityAt(), sanity.at);
  state.pushEvent(whatEvent('SanityBeforeStage', { current_sanity: null, max_sanity: null }));
  assert.deepEqual(
    { current: state.snapshot().sanity.current, max: state.snapshot().sanity.max },
    { current: null, max: null },
  );
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

// ---------------------------------------------------------------------------
// v2：环形缓冲 500 / run 快照 / 领域事件
// ---------------------------------------------------------------------------

test('state: 默认环形缓冲 500，状态 JSON 仍只带 10 条（无 details）', () => {
  const state = createState();
  for (let index = 1; index <= 520; index += 1) state.pushEvent({ code: 20003, seq: index, details: { what: 'StageDrops' } });
  assert.equal(state.recentEvents(1000).length, 500);
  assert.equal(state.recentEvents().length, 10);
  assert.equal(state.getLastSeq(), 520);
  const snapshot = state.snapshot();
  assert.equal(snapshot.events.length, 10);
  assert.equal('details' in snapshot.events[0], false);
});

test('state: setRun({run,lastRun}) 并入 snapshot（去掉大数组、截断 text）', () => {
  const state = createState();
  assert.equal(state.snapshot().run, null);
  assert.equal(state.snapshot().lastRun, null);

  state.setRun({
    run: {
      id: 'run-1',
      kind: 'fight',
      status: 'running',
      startedAt: '2026-10-29T00:00:00.000Z',
      planned: [{ stage: '5-10' }],
      executed: [{ stage: '5-10' }],
      events: [{ seq: 1 }],
      params: { big: true },
      text: 'x'.repeat(600),
      signal: { aborted: false },
      update: () => {},
    },
  });
  const snapshot = state.snapshot();
  assert.equal(snapshot.run.id, 'run-1');
  assert.equal(snapshot.run.status, 'running');
  assert.equal('planned' in snapshot.run, false);
  assert.equal('executed' in snapshot.run, false);
  assert.equal('events' in snapshot.run, false);
  assert.equal('params' in snapshot.run, false);
  assert.equal('signal' in snapshot.run, false);
  assert.equal(snapshot.run.text.length, 501);
  assert.equal(snapshot.lastRun, null);
  assert.deepEqual(state.getRun(), snapshot.run);

  state.setRun({ lastRun: { id: 'run-0', kind: 'daily', status: 'completed', endedAt: '2026-10-29T01:00:00.000Z' } });
  assert.equal(state.getLastRun().id, 'run-0');
  assert.equal(state.snapshot().run.id, 'run-1', '只更新传入的字段');

  // snapshot 是副本
  const copy = state.snapshot();
  copy.run.id = 'hacked';
  assert.equal(state.getRun().id, 'run-1');

  assert.deepEqual(state.setRun(null), { run: null, lastRun: null });
  assert.equal(state.snapshot().run, null);
  assert.equal(state.snapshot().lastRun, null);
});

test('state: 领域事件归一化（recruit / infrast / depot / operbox / copilot）', () => {
  const state = createState();

  state.pushEvent(whatEvent('RecruitTagsDetected', { tags: ['先锋', '近战位'] }));
  assert.deepEqual(state.snapshot().recruit.tags, ['先锋', '近战位']);
  state.pushEvent(whatEvent('RecruitResult', { tags: ['先锋'], level: 5, opers: ['德克萨斯'] }));
  assert.equal(state.snapshot().recruit.result.level, 5);
  assert.deepEqual(state.snapshot().recruit.result.opers, ['德克萨斯']);
  state.pushEvent(whatEvent('RecruitTagsRefreshed'));
  state.pushEvent(whatEvent('RecruitTagsRefreshed'));
  assert.equal(state.snapshot().recruit.refreshCount, 2);
  assert.equal(state.snapshot().recruit.noPermit, false);
  state.pushEvent(whatEvent('RecruitNoPermit'));
  assert.equal(state.snapshot().recruit.noPermit, true);

  state.pushEvent(whatEvent('EnterFacility', { facility: 'Mfg' }));
  assert.equal(state.snapshot().infrast.facility, 'Mfg');
  state.pushEvent(whatEvent('ProductOfFacility', { facility: 'Trade', product: '赤金', count: 5 }));
  assert.equal(state.snapshot().infrast.product.product, '赤金');
  state.pushEvent(whatEvent('NotEnoughStaff'));
  assert.equal(state.snapshot().infrast.notEnoughStaff, true);

  state.pushEvent(whatEvent('DepotInfo', { done: true, data: JSON.stringify({ 30061: 12, 30062: 3 }) }));
  assert.equal(state.snapshot().depot.total, 2);

  state.pushEvent(whatEvent('OperBoxInfo', {
    done: true,
    all_opers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    own_opers: [{ id: 'a' }, { id: 'b' }],
  }));
  assert.equal(state.snapshot().operbox.operators, 2);

  state.pushEvent(whatEvent('CopilotPrecheckFile', { file: 'C:\\\\x\\\\copilot.json' }));
  assert.equal(state.snapshot().copilot.precheck.file, 'C:\\\\x\\\\copilot.json');
});

test('state: 领域事件归一化（stage / routing / connection / chainExtra / AllTasksCompleted）', () => {
  const state = createState();
  state.pushEvent(whatEvent('StageInfo', { code: '5-10', name: '坍塌' }));
  assert.equal(state.snapshot().stage.info.code, '5-10');
  state.pushEvent(whatEvent('UnsupportedLevel', { level: 'XX-1' }));
  assert.equal(state.snapshot().stage.unsupported.level, 'XX-1');
  state.pushEvent(whatEvent('StageQueueStageNotFound', { stage: '5-99' }));
  assert.equal(state.snapshot().stage.notFound.stage, '5-99');

  state.pushEvent(whatEvent('RoutingRestart'));
  state.pushEvent(whatEvent('RoutingRestart'));
  assert.equal(state.snapshot().routingRestart, 2);

  state.pushEvent({ code: 2, name: 'ConnectionInfo', details: { what: 'ConnectSuccess' } });
  assert.equal(state.snapshot().connection.what, 'ConnectSuccess');

  state.pushEvent({ code: 10003, name: 'TaskChainExtraInfo', details: { taskchain: 'Fight', what: 'Extra' } });
  assert.equal(state.snapshot().chainExtra.length, 1);
  assert.equal(state.snapshot().chainExtra[0].task, 'Fight');
  assert.equal(state.snapshot().chainExtra[0].what, 'Extra');

  state.pushEvent({ code: 3, name: 'AllTasksCompleted', details: { taskchain: 'Fight' } });
  assert.equal(state.snapshot().allTasksCompleted.task, 'Fight');
  assert.equal(state.snapshot().tasks.running, false);
});

test('state: resetChain 清本轮派生（含 copilot/stage/routingRestart），保留周期快照', () => {
  const state = createState();
  state.pushEvent(whatEvent('RecruitTagsDetected', { tags: ['先锋'] }));
  state.pushEvent(whatEvent('DepotInfo', { done: true, data: '{"1":2}' }));
  state.pushEvent(whatEvent('CopilotPrecheckFile', { file: 'x.json' }));
  state.pushEvent(whatEvent('UnsupportedLevel', { level: 'XX' }));
  state.pushEvent(whatEvent('RoutingRestart'));
  state.pushEvent(chainEvent(10001, 'Fight'));
  state.resetChain();

  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.recruit.tags, ['先锋']);
  assert.equal(snapshot.depot.total, 1);
  assert.equal(snapshot.copilot.precheck, null);
  assert.equal(snapshot.stage.unsupported, null);
  assert.equal(snapshot.routingRestart, 0);
  assert.deepEqual(snapshot.chainExtra, []);
  assert.equal(snapshot.tasks.running, false);
  // run 快照不会被 resetChain 清掉
  state.setRun({ run: { id: 'run-1', kind: 'fight' } });
  state.resetChain();
  assert.equal(state.snapshot().run.id, 'run-1');
});

/**
 * lib/data/planner.js 单元测试：targets 解析、期望理智升序/最多 3 候选、合并去重、
 * 总期望理智、低样本提示、无掉率数据明确说明、排除过期活动关、preferEvent。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildResourceBundle } from '../lib/data/resources.js';
import {
  createPlanner,
  isExcluded,
  MAX_CANDIDATES_PER_ITEM,
  parseExclude,
  parseTargets,
  resolveTargetItem,
} from '../lib/data/planner.js';
import { ArkError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

/** 固定「现在」：2026-10-29 12:00 UTC。 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** 资源 bundle：用夹具的关卡/材料，干员留空。 */
const resources = buildResourceBundle({
  maaPath: 'X:/fixture',
  files: {},
  stagesRaw: readFixture('stages.sample.json'),
  itemsRaw: readFixture('items.sample.json'),
  recruitmentRaw: {},
  configRaw: {},
  versionRaw: {},
  warnings: [],
});

/** 造一个候选关卡。 */
function candidate(code, stageId, apCost, expectedSanity, extra = {}) {
  const times = extra.times ?? 1000;
  const quantity = expectedSanity > 0 ? (apCost * times) / expectedSanity : 0;
  return {
    code,
    stageId,
    apCost,
    expectedSanity,
    times,
    quantity,
    dropRate: quantity / times,
    lowSample: extra.lowSample === true,
    source: 'penguin-stats',
    ...extra,
  };
}

/** 假的掉率数据源：按材料 id 返回预设候选。 */
function dropsFor(itemId) {
  const table = {
    '30012': [
      candidate('6-5', 'main_06-05', 21, 42),
      candidate('2-12', 'main_02-12', 12, 60),
      candidate('AA-8', 'act999side_08_perm', 21, 2),
    ],
    '30013': [candidate('6-5', 'main_06-05', 21, 84)],
    '3003': [
      candidate('1-7', 'main_01-07', 6, 4.8),
      candidate('4-4', 'main_04-04', 18, 18),
      candidate('6-5', 'main_06-05', 21, 42),
      candidate('CE-1', 'CE-1', 30, 60, { lowSample: true }),
    ],
    '30103': {
      ok: false,
      source: 'penguin-stats',
      ageMs: null,
      stale: false,
      candidates: [],
      reason: '企鹅物流没有该材料的可用掉率样本。',
    },
  };
  const rows = table[itemId];
  if (Array.isArray(rows)) {
    return { ok: true, source: 'penguin-stats', ageMs: 3600000, stale: false, candidates: rows, reason: '' };
  }
  return rows ?? { ok: true, source: 'penguin-stats', ageMs: 3600000, stale: false, candidates: [], reason: '' };
}

/** 假活动日历：AA-8 过期、ZZ-8/ZZ-7 开放。 */
function activity(overrides = {}) {
  return {
    ok: true,
    stale: false,
    ageMs: 60000,
    activities: [],
    stages: [
      {
        value: 'AA-8', itemId: '30033', activityName: '旧活动', active: false, expired: true,
        start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 7, 15),
      },
      {
        value: 'ZZ-8', itemId: '30012', activityName: '当前活动', active: true, expired: false,
        start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 10),
      },
      {
        value: 'ZZ-7', itemId: '30033', activityName: '当前活动', active: true, expired: false,
        start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 10),
      },
    ],
    ...overrides,
  };
}

/** 造规划器。 */
function makePlanner(overrides = {}) {
  return createPlanner({
    resources,
    getDrops: async (itemId) => dropsFor(itemId),
    getActivity: async () => activity(),
    now: () => NOW,
    maxCandidates: MAX_CANDIDATES_PER_ITEM,
    lowSampleTimes: 300,
    ...overrides,
  });
}

test('planner: parseTargets 支持字符串/数组/多种分隔符', () => {
  assert.deepEqual(parseTargets('固源岩:10, 聚酸酯组:5').map((target) => [target.name, target.count]), [
    ['固源岩', 10],
    ['聚酸酯组', 5],
  ]);
  assert.deepEqual(parseTargets('固源岩：10；源岩：2\n赤金').map((target) => [target.name, target.count]), [
    ['固源岩', 10],
    ['源岩', 2],
    ['赤金', 1],
  ]);
  assert.deepEqual(parseTargets('固源岩 x10').map((target) => [target.name, target.count]), [['固源岩', 10]]);
  assert.deepEqual(parseTargets('RMA70-12:3').map((target) => [target.name, target.count]), [['RMA70-12', 3]]);
  assert.deepEqual(
    parseTargets([{ item: '固源岩', count: 10 }, { name: '赤金', count: 2 }, '源岩:1']).map((target) => [target.name, target.count]),
    [['固源岩', 10], ['赤金', 2], ['源岩', 1]],
  );
  assert.equal(parseTargets('固源岩:0')[0].count, 1, '数量至少 1');
  assert.equal(parseTargets('固源岩:99999')[0].count, 9999, '数量有上限');
  assert.throws(() => parseTargets(''), (error) => error instanceof ArkError && error.code === 'E_BAD_ARGS');
  assert.throws(() => parseTargets([]), (error) => error.code === 'E_BAD_ARGS');
  assert.throws(() => parseTargets(42), (error) => error.code === 'E_BAD_ARGS');
});

test('planner: parseExclude / isExcluded', () => {
  const exclude = parseExclude('CE-6, 5-10 main_05-10');
  assert.equal(isExcluded({ code: '5-10', stageId: 'main_05-10' }, exclude), true);
  assert.equal(isExcluded({ code: 'ce-6', stageId: 'CE-6' }, exclude), true);
  assert.equal(isExcluded({ code: '1-7', stageId: 'main_01-07' }, exclude), false);
  assert.deepEqual(parseExclude(undefined), { codes: new Set(), ids: new Set() });
});

test('planner: resolveTargetItem 精确/包含/歧义', () => {
  assert.equal(resolveTargetItem(resources, '固源岩').item?.itemId, '30012');
  assert.equal(resolveTargetItem(resources, '30012').item?.name, '固源岩');
  assert.equal(resolveTargetItem(resources, '聚酸酯').item?.itemId, '30032');
  const missing = resolveTargetItem(resources, '不存在的材料');
  assert.equal(missing.item, null);
  assert.equal(missing.suggestions.length > 0, true);
  assert.equal(resolveTargetItem(resources, '').item, null);
});

test('planner: 期望理智升序、最多 3 个候选、低样本标注', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '赤金:3' });
  assert.equal(result.ok, true);
  const target = result.targets[0];
  assert.equal(target.itemName, '赤金');
  assert.equal(target.candidates.length, 3, '最多 3 个候选');
  assert.deepEqual(target.candidates.map((entry) => entry.code), ['1-7', '4-4', '6-5']);
  assert.equal(target.best.code, '1-7');
  assert.deepEqual(target.alternatives.map((entry) => entry.code), ['4-4', '6-5'], 'alternatives 不含 best');
  assert.equal(target.expectedSanity, 14.4);
  assert.equal(target.lowSample, false, '低样本候选被截断时目标不应标低样本');
  assert.equal(result.totals.expectedSanity, 14.4);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].code, '1-7');
  assert.equal(result.stages[0].expectedSanity, 14.4);
  assert.equal(result.sources.penguin.ok, true);
  assert.equal(result.sources.penguin.ageMs, 3600000);
});

test('planner: 同一关可刷多种材料时合并去重并累加期望理智', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '固源岩:10, 固源岩组:5' });
  assert.equal(result.stages.length, 1, '两个目标共用 6-5 应合并成一关');
  const stage = result.stages[0];
  assert.equal(stage.code, '6-5');
  assert.equal(stage.covers.length, 2);
  assert.deepEqual(stage.covers.map((cover) => cover.itemName).sort(), ['固源岩', '固源岩组'].sort());
  assert.equal(stage.expectedSanity, 10 * 42 + 5 * 84);
  assert.equal(result.totals.expectedSanity, 840);
  assert.equal(result.totals.covered, 2);
  assert.equal(result.totals.estimated, 2);
});

test('planner: 排除已过期活动关（即便掉率数据里它最便宜）', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '固源岩:1' });
  const target = result.targets[0];
  assert.deepEqual(target.candidates.map((entry) => entry.code), ['6-5', '2-12'], 'AA-8 已过期应被排除');
  assert.equal(target.excluded.some((entry) => entry.code === 'AA-8'), true);
  assert.match(target.excluded.find((entry) => entry.code === 'AA-8').excludedReason, /过期/);
  assert.equal(result.warnings.some((warning) => warning.includes('已排除') && warning.includes('AA-8')), true);
  assert.equal(target.best.code, '6-5');
});

test('planner: exclude 参数排除指定关卡', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '赤金:1', exclude: '1-7' });
  assert.deepEqual(result.targets[0].candidates.map((entry) => entry.code), ['4-4', '6-5', 'CE-1']);
  assert.equal(result.warnings.some((warning) => warning.includes('用户排除')), true);
});

test('planner: 低样本时给出提示', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '赤金:1', exclude: '1-7, 4-4, 6-5' });
  const target = result.targets[0];
  assert.deepEqual(target.candidates.map((entry) => entry.code), ['CE-1']);
  assert.equal(target.lowSample, true);
  assert.equal(result.warnings.some((warning) => warning.includes('低样本')), true);
});

test('planner: 没有掉率数据时明确说明，不瞎排序', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: 'RMA70-12:2' });
  const target = result.targets[0];
  assert.equal(target.ok, false);
  assert.deepEqual(target.candidates, []);
  assert.match(target.reason, /掉率样本/);
  assert.equal(result.ok, false);
  assert.equal(result.totals.expectedSanity, null);
  assert.deepEqual(result.totals.uncovered, ['RMA70-12']);
  assert.equal(result.warnings.some((warning) => warning.includes('没有可用的掉率数据')), true);
});

test('planner: 材料表里没有的目标会给出候选建议而不是抛异常', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '不存在的材料:2' });
  const target = result.targets[0];
  assert.equal(target.ok, false);
  assert.match(target.reason, /材料表里没有/);
  assert.equal(target.suggestions.length > 0, true);
  assert.equal(result.targets[0].expectedSanity, null);
});

test('planner: preferEvent 优先推荐正在开放的活动关（缺数据时明确标注）', async () => {
  const planner = makePlanner();
  const result = await planner.plan({ targets: '固源岩:10', preferEvent: true });
  const target = result.targets[0];
  assert.equal(target.candidates[0].code, 'ZZ-8');
  assert.equal(target.candidates[0].source, 'activity');
  assert.equal(target.candidates[0].event.name, '当前活动');
  assert.equal(target.candidates[0].expectedSanity, null);
  assert.equal(Number.isFinite(target.candidates[0].event.end), true);
  assert.equal(target.expectedSanity, null, '活动关没有理智/掉率数据时不能编一个数');
  assert.equal(result.stages[0].code, 'ZZ-8');
  assert.equal(result.stages[0].expectedSanity, null);
  assert.equal(result.totals.expectedSanity, null);
  assert.equal(result.preferEvent, true);
});

test('planner: 活动日历不可用时仍能规划掉率数据，并给 warning', async () => {
  const planner = makePlanner({ getActivity: async () => ({ ok: false, stages: [], warnings: ['活动日历不可用。'] }) });
  const result = await planner.plan({ targets: '固源岩:1', preferEvent: true });
  // 拿不到活动日历就无法知道 AA-8 已过期，只能按掉率数据排（降级但不编数据）。
  assert.equal(result.targets[0].best.code, 'AA-8');
  assert.equal(result.warnings.some((warning) => warning.includes('活动日历不可用')), true);

  const throwing = makePlanner({ getActivity: async () => { throw new Error('boom'); } });
  const result2 = await throwing.plan({ targets: '固源岩:1' });
  assert.equal(result2.targets[0].ok, true);
});

test('planner: 掉率数据源抛异常也不影响其他目标', async () => {
  const planner = createPlanner({
    resources,
    getDrops: async (itemId) => {
      if (itemId === '30012') throw new Error('掉率服务炸了');
      return { ok: true, candidates: [candidate('CE-1', 'CE-1', 30, 30)], ageMs: 0, stale: false };
    },
    getActivity: async () => activity(),
    now: () => NOW,
  });
  const result = await planner.plan({ targets: '固源岩:1, 赤金:1' });
  // 固源岩掉率失败时只能用活动关兜底（ZZ-8），如实标注无法估算。
  assert.equal(result.targets[0].candidates[0].code, 'ZZ-8');
  assert.equal(result.targets[0].expectedSanity, null);
  assert.match(result.targets[0].reason, /炸了/);
  assert.equal(result.targets[1].ok, true);
  assert.equal(result.targets[1].expectedSanity, 30);
  assert.equal(result.totals.expectedSanity, 30);
});

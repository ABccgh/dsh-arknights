/**
 * lib/data/activity.js 单元测试：StageActivityV2 抽取（sideStoryStage/resourceCollection/miniGame）、
 * 时区换 epoch、开放/过期判定、活动关查询、6h 缓存与失败降级。全部离线。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createActivityData,
  normalizeStageActivity,
  parseActivityTime,
  recomputeWindow,
} from '../lib/data/activity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'data', 'activity.sample.json'), 'utf8'));

/** 固定「现在」：2026-10-29 12:00 UTC（北京时间 20:00）。 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** @type {string[]} */
const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-activity-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造按需返回夹具/失败的假 fetch。 */
function makeFetch(options = {}) {
  const calls = [];
  let fail = options.fail === true;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('网络不可用');
    return { ok: true, status: 200, json: async () => fixture };
  };
  return {
    fetchImpl,
    calls,
    setFail(value) {
      fail = value;
    },
  };
}

test('activity: parseActivityTime 把「TimeZone 本地时间」换算成 epoch', () => {
  const value = parseActivityTime('2026/08/22 04:00:00', 8);
  assert.equal(value, Date.UTC(2026, 7, 21, 20, 0, 0), 'UTC+8 的 04:00 应为前一天 20:00Z');
  assert.equal(parseActivityTime('2026-08-22T04:00:00', 8), value);
  assert.equal(parseActivityTime('2026/08/22 04:00:00', -7), Date.UTC(2026, 7, 22, 11, 0, 0));
  assert.equal(parseActivityTime('2026/08/22', 8), null, '只有日期没有时分时不猜');
  assert.equal(parseActivityTime('不是时间', 8), null);
  assert.equal(parseActivityTime(undefined, 8), null);
});

test('activity: normalizeStageActivity 抽 Official 的活动/活动关/资源收集/小游戏', () => {
  const result = normalizeStageActivity(fixture, { client: 'Official', now: NOW });
  assert.equal(result.client, 'Official');
  assert.equal(result.activities.length, 5, 'AA/ZZ/FF + 资源收集 + 小游戏');
  assert.equal(result.stages.length, 5, 'AA 2 + ZZ 2 + FF 1');
  assert.equal(result.resourceCollection?.category, 'resourceCollection');
  assert.equal(result.miniGame.length, 1);
  assert.deepEqual(result.warnings, []);

  const byKey = Object.fromEntries(result.activities.map((activity) => [activity.key, activity]));
  assert.equal(byKey.AA.name, '旧活动');
  assert.equal(byKey.AA.expired, true);
  assert.equal(byKey.AA.active, false);
  assert.equal(byKey.ZZ.active, true);
  assert.equal(byKey.ZZ.expired, false);
  assert.equal(byKey.FF.active, false);
  assert.equal(byKey.FF.expired, false, '未来活动既不开也没过期');
  assert.equal(byKey.FF.started, false);
  assert.equal(byKey.resourceCollection.expired, true);
  assert.equal(byKey['MiniGame@ZZ@Begin'].category, 'miniGame');

  const stages = Object.fromEntries(result.stages.map((stage) => [stage.value, stage]));
  assert.equal(stages['ZZ-8'].itemId, '30012');
  assert.equal(stages['ZZ-8'].activityName, '当前活动');
  assert.equal(stages['ZZ-8'].active, true);
  assert.equal(stages['AA-8'].expired, true);
  assert.equal(stages['AA-8'].itemId, '30033');
  assert.equal(stages['SSReopen-AA'].itemId, null, 'Drop 不是材料 id 时 itemId 为 null');
  assert.equal(stages['SSReopen-AA'].drop, '代理1~8关');
});

test('activity: 按客户端抽取（缺客户端给空 + warning）', () => {
  const jp = normalizeStageActivity(fixture, { client: 'YoStarJP', now: NOW });
  assert.equal(jp.activities.length, 1);
  assert.equal(jp.resourceCollection?.timeZone, 9);
  assert.equal(jp.stages.length, 0);
  const missing = normalizeStageActivity(fixture, { client: 'NotARealClient', now: NOW });
  assert.equal(missing.activities.length, 0);
  assert.equal(missing.warnings.length, 1);
  assert.equal(normalizeStageActivity(null, { now: NOW }).activities.length, 0);
});

test('activity: recomputeWindow 用当前时间重算开放/过期标记', () => {
  const base = { start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 10), stages: [{ value: 'ZZ-8' }] };
  const open = recomputeWindow(base, Date.UTC(2026, 9, 29));
  assert.equal(open.active, true);
  const closed = recomputeWindow(base, Date.UTC(2026, 10, 11));
  assert.equal(closed.active, false);
  assert.equal(closed.expired, true);
  assert.equal(closed.stages[0].expired, true);
  const unknown = recomputeWindow({ start: null, end: null, stages: [] }, NOW);
  assert.equal(unknown.active, true, '时间未知时保守当开放');
});

test('activity: load 走缓存（6h TTL），lookupStage/stagesForItem 只查活动关', async () => {
  const fake = makeFetch();
  let clock = NOW;
  const client = createActivityData({
    cacheFile: path.join(tempDir(), 'activity.json'),
    now: () => clock,
    fetchImpl: fake.fetchImpl,
  });
  const first = await client.load();
  assert.equal(first.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(first.stages.length, 5);
  assert.equal(first.ageMs, 0);

  const zz = await client.lookupStage('zz-8');
  assert.equal(zz?.active, true);
  assert.equal(zz?.itemId, '30012');
  assert.equal(await client.lookupStage('不存在'), null);
  const activeForRock = await client.stagesForItem('30012');
  assert.deepEqual(activeForRock.map((stage) => stage.value), ['ZZ-8']);
  assert.deepEqual((await client.stagesForItem('30033')).map((stage) => stage.value), ['ZZ-7'], 'AA-8 已过期，不参与推荐');
  assert.deepEqual(await client.stagesForItem('99999'), []);
  assert.deepEqual(await client.stagesForItem(''), []);

  const cached = await client.load();
  assert.equal(fake.calls.length, 1, 'TTL 内命中缓存');
  assert.equal(cached.ok, true);
  assert.equal(cached.ageMs, 0);

  clock += 6 * 3600000 + 1;
  const refreshed = await client.load();
  assert.equal(fake.calls.length, 2, '超过 6h 应重新拉取');
  assert.equal(refreshed.stale, false);
});

test('activity: 缓存内的时间窗按「现在」重算（不重新联网也能变过期）', async () => {
  const fake = makeFetch();
  let clock = NOW;
  const client = createActivityData({
    cacheFile: path.join(tempDir(), 'activity.json'),
    now: () => clock,
    fetchImpl: fake.fetchImpl,
    cacheTtlHours: 24 * 30,
  });
  const first = await client.load();
  assert.equal(first.stages.find((stage) => stage.value === 'ZZ-8')?.active, true);
  clock = Date.UTC(2026, 10, 11, 0, 0, 0);
  const second = await client.load();
  assert.equal(fake.calls.length, 1, '30 天 TTL 内不联网');
  assert.equal(second.stages.find((stage) => stage.value === 'ZZ-8')?.active, false);
  assert.equal(second.stages.find((stage) => stage.value === 'ZZ-8')?.expired, true);
});

test('activity: 网络失败降级——无缓存给空结果，有旧缓存给 stale，不抛异常', async () => {
  const failing = makeFetch({ fail: true });
  const cold = createActivityData({ cacheFile: path.join(tempDir(), 'activity.json'), now: () => NOW, fetchImpl: failing.fetchImpl });
  const empty = await cold.load();
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.activities, []);
  assert.equal(empty.error instanceof Error, true);
  assert.equal(empty.warnings.length >= 1, true);

  const fake = makeFetch();
  let clock = NOW;
  const warm = createActivityData({
    cacheFile: path.join(tempDir(), 'activity.json'),
    now: () => clock,
    fetchImpl: fake.fetchImpl,
    cacheTtlHours: 1,
  });
  await warm.load();
  fake.setFail(true);
  clock += 3 * 3600000;
  const stale = await warm.load();
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.stages.length, 5);
});

test('activity: status 只读缓存（不联网）', async () => {
  const fake = makeFetch();
  const client = createActivityData({ cacheFile: path.join(tempDir(), 'activity.json'), now: () => NOW, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.status(), { ok: false, ageMs: null, stages: null });
  await client.load();
  const status = await client.status();
  assert.equal(status.ok, true);
  assert.equal(status.stages, 5);
  assert.equal(fake.calls.length, 1);
});

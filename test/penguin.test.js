/**
 * lib/data/penguin.js 单元测试：掉率数学（含 times=0 保护）、时间窗过滤、低样本标注、
 * 按材料 TTL 缓存、网络失败降级。全部离线：掉率夹具由假 fetch 提供，关卡表用假的 stageById。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeDropRate,
  computeExpectedSanity,
  createPenguinData,
  normalizeItemId,
  normalizeMatrixRows,
} from '../lib/data/penguin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'penguin-matrix.sample.json'), 'utf8'));

/** 测试用固定「现在」：2026-10-29 12:00 UTC。 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** @type {string[]} */
const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-penguin-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 关卡表（只用于把 stageId 换成 code/apCost）。 */
const STAGES = {
  'main_01-07': { stageId: 'main_01-07', code: '1-7', apCost: 6, prefix: 'main_' },
  'main_04-04': { stageId: 'main_04-04', code: '4-4', apCost: 18, prefix: 'main_' },
  'main_05-10': { stageId: 'main_05-10', code: '5-10', apCost: 18, prefix: 'main_' },
  'tough_05-10': { stageId: 'tough_05-10', code: '5-10', apCost: 18, prefix: 'tough_' },
  'main_05-09': { stageId: 'main_05-09', code: '5-9', apCost: 18, prefix: 'main_' },
  'easy_05-09': { stageId: 'easy_05-09', code: '5-9', apCost: 18, prefix: 'easy_' },
  'main_06-05': { stageId: 'main_06-05', code: '6-5', apCost: 21, prefix: 'main_' },
  'main_02-12': { stageId: 'main_02-12', code: '2-12', apCost: 12, prefix: 'main_' },
  'main_05-12': { stageId: 'main_05-12', code: '5-12', apCost: null, prefix: 'main_' },
  'act999side_08_perm': { stageId: 'act999side_08_perm', code: 'AA-8', apCost: 21, prefix: '' },
  'act888side_08_perm': { stageId: 'act888side_08_perm', code: 'BB-8', apCost: 21, prefix: '' },
  'act777side_08_perm': { stageId: 'act777side_08_perm', code: 'CC-8', apCost: 21, prefix: '' },
  'main_10-09': { stageId: 'main_10-09', code: '10-9', apCost: 18, prefix: 'main_' },
};

/** 造假的 matrix 客户端。 */
function makeClient(options = {}) {
  const calls = [];
  let fail = options.fail === true;
  let clock = NOW;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('网络不可用');
    const match = /itemFilter=(\d+)/.exec(String(url));
    const itemId = match?.[1] ?? '';
    return { ok: true, status: 200, json: async () => ({ matrix: fixture[itemId]?.matrix ?? [] }) };
  };
  const client = createPenguinData({
    api: 'https://penguin.example.test',
    cacheDir: tempDir(),
    now: () => clock,
    fetchImpl,
    getStage: (stageId) => STAGES[stageId] ?? null,
    lowSampleTimes: 300,
  });
  return {
    client,
    calls,
    setFail(value) {
      fail = value;
    },
    advance(ms) {
      clock += ms;
    },
    setClock(value) {
      clock = value;
    },
  };
}

test('penguin: 掉率数学与 times=0 / quantity=0 保护', () => {
  assert.equal(computeDropRate(1250, 1000), 1.25);
  assert.equal(computeDropRate(0, 1000), 0);
  assert.equal(computeDropRate(100, 0), null);
  assert.equal(computeDropRate(100, -1), null);
  assert.equal(computeDropRate(NaN, 1), null);
  assert.equal(computeExpectedSanity(6, 1000, 1250), 4.8);
  assert.equal(computeExpectedSanity(21, 400, 200), 42);
  assert.equal(computeExpectedSanity(6, 0, 0), null);
  assert.equal(computeExpectedSanity(6, 100, 0), null);
  assert.equal(computeExpectedSanity(null, 1, 1), null);
  assert.equal(computeExpectedSanity(6, 10, 3), 20);
  assert.equal(normalizeItemId(30012), '30012');
  assert.equal(normalizeItemId(' 30012 '), '30012');
  assert.equal(normalizeItemId('abc'), '');
  assert.equal(normalizeItemId(null), '');
});

test('penguin: normalizeMatrixRows 跳过坏行并算掉率', () => {
  const rows = normalizeMatrixRows([
    { stageId: 'main_01-07', itemId: '30012', times: 10, quantity: 5, start: 1, end: null },
    { stageId: 'main_01-07', itemId: 30012, times: 0, quantity: 0 },
    { stageId: '', itemId: '30012', times: 1, quantity: 1 },
    { stageId: 'x', itemId: 'abc' },
    null,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dropRate, 0.5);
  assert.equal(rows[1].dropRate, null);
  assert.equal(rows[0].start, 1);
  assert.equal(rows[0].end, null);
});

test('penguin: matrix 计算期望理智、过滤未来/已结束/零样本/未知关卡', async () => {
  const harness = makeClient();
  const result = await harness.client.matrix('30012');
  assert.equal(harness.calls.length, 1);
  assert.match(harness.calls[0], /server=CN/);
  assert.match(harness.calls[0], /itemFilter=30012/);
  assert.equal(result.ok, true);
  assert.equal(result.itemId, '30012');
  assert.equal(result.rows.length, 13);
  assert.equal(result.excluded.notStarted, 1, '未来关卡应被排除');
  assert.equal(result.excluded.ended, 1, '已结束关卡应被排除');
  assert.equal(result.excluded.zeroSample, 1, 'times=0 应被排除而不是除零');
  assert.equal(result.excluded.unknownStage, 3, '关卡未知/没理智的行应被排除（不瞎排）');

  const byCode = Object.fromEntries(result.candidates.map((candidate) => [candidate.code, candidate]));
  assert.equal(result.candidates.length, 7);
  assert.equal(result.candidates[0].code, '1-7');
  assert.equal(result.candidates[0].expectedSanity, 4.8);
  assert.equal(result.candidates[0].dropRate, 1.25);
  assert.equal(result.candidates[0].times, 1000);
  assert.equal(result.candidates[0].lowSample, false);
  assert.equal(result.candidates[0].active, true);

  assert.equal(byCode['5-10'].expectedSanity, 18, '同一 code 的多个难度应去重');
  assert.equal(byCode['5-10'].stageId, 'tough_05-10');
  assert.equal(byCode['2-12'].lowSample, true, '样本 50 < 300 应标低样本');
  assert.equal(byCode['2-12'].expectedSanity, 60);
  assert.equal(byCode['6-5'].expectedSanity, 42);
  assert.equal(byCode['AA-8'].expectedSanity, 210);
  assert.equal(byCode['CC-8'].expectedSanity, 210);
  assert.equal(byCode['BB-8'], undefined, '已结束的活动关不应出现');
  assert.equal(byCode['10-9'], undefined, '未开始的关卡不应出现');
  assert.equal(byCode['5-12'], undefined, '没有理智数据的关卡不应出现');

  const expected = result.candidates.map((candidate) => candidate.expectedSanity);
  const sorted = [...expected].sort((a, b) => a - b);
  assert.deepEqual(expected, sorted, '候选应按期望理智升序');
});

test('penguin: 按材料缓存 + TTL + refresh + peek 不联网', async () => {
  const harness = makeClient();
  const first = await harness.client.matrix('30033');
  assert.equal(first.ok, true);
  assert.equal(first.candidates[0].code, '5-9');
  assert.equal(first.candidates[0].expectedSanity, 36);
  assert.deepEqual(first.candidates.map((candidate) => candidate.code), ['5-9', '6-5', 'AA-8']);

  const second = await harness.client.matrix(30033);
  assert.equal(harness.calls.length, 1, 'TTL 内应命中缓存');
  assert.equal(second.ok, true);
  assert.equal(second.candidates.length, first.candidates.length);

  const peeked = await harness.client.peek('30033');
  assert.equal(peeked.ok, true);
  assert.equal(peeked.cached, true);
  assert.equal(harness.calls.length, 1, 'peek 绝不联网');

  const missingPeek = await harness.client.peek('3003');
  assert.equal(missingPeek.ok, false);
  assert.equal(missingPeek.cached, false);
  assert.match(missingPeek.reason, /未缓存/);

  harness.advance(168 * 3600000 + 1);
  const third = await harness.client.matrix('30033');
  assert.equal(harness.calls.length, 2, 'TTL 过期应重新拉取');
  assert.equal(third.ageMs, 0);

  await harness.client.matrix('30033', { fresh: true });
  assert.equal(harness.calls.length, 3, 'fresh=true 强制刷新');
});

test('penguin: 网络失败降级——无缓存给 ok:false，有旧缓存给 stale，不抛异常', async () => {
  const harness = makeClient({ fail: true });
  const empty = await harness.client.matrix('30012');
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.rows.length, 0);
  assert.equal(typeof empty.reason, 'string');
  assert.notEqual(empty.reason, '');
  assert.equal(harness.calls.length >= 1, true);

  const failing = makeClient();
  await failing.client.matrix('30012');
  failing.setFail(true);
  failing.advance(200 * 3600000);
  const stale = await failing.client.matrix('30012');
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.candidates.length > 0, true);
  assert.equal(stale.ageMs >= 200 * 3600000, true);
});

test('penguin: 非法材料 id 返回结构化失败（不抛）', async () => {
  const harness = makeClient();
  const result = await harness.client.matrix('固源岩');
  assert.equal(result.ok, false);
  assert.match(result.reason, /材料 id 不合法/);
  assert.equal(harness.calls.length, 0);
});

test('penguin: status 反映最近一次拉取（不联网）', async () => {
  const harness = makeClient();
  assert.deepEqual(await harness.client.status(), { ok: false, ageMs: null, items: 0 });
  await harness.client.matrix('30012');
  const status = await harness.client.status();
  assert.equal(status.ok, true);
  assert.equal(status.items, 1);
  assert.equal(Number.isFinite(status.ageMs), true);
});

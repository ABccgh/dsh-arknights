/**
 * lib/data/query.js 集成测试：createData 门面的 stage/item/operator/activity/search/drops/plan/status。
 * 全部离线：MAA 资源来自夹具临时目录，网络由假 fetch 提供（ArkRec / 企鹅物流 / 活动日历）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createData } from '../lib/data/query.js';
import { ArkError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');

/** 固定「现在」：2026-10-29 12:00 UTC。 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** @type {string[]} */
const dirs = [];

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function tempDir(prefix = 'dsh-ark-query-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 造只含五件套资源的假 MAA 目录。 */
async function makeMaaDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-query-maa-'));
  dirs.push(root);
  await fsp.mkdir(path.join(root, 'resource'), { recursive: true });
  const files = {
    'stages.json': 'stages.sample.json',
    'item_index.json': 'items.sample.json',
    'recruitment.json': 'recruitment.sample.json',
    'config.json': 'config.sample.json',
    'version.json': 'version.sample.json',
  };
  for (const [target, source] of Object.entries(files)) {
    await fsp.writeFile(path.join(root, 'resource', target), JSON.stringify(readFixture(source)), 'utf8');
  }
  return root;
}

/** 假网络：按 URL 返回对应夹具。 */
function makeFetch() {
  const menu = readFixture('arkrec-menu.sample.json');
  const hard = readFixture('arkrec-hard-operations.sample.json');
  const activity = readFixture('activity.sample.json');
  const penguin = readFixture('penguin-matrix.sample.json');
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/api/menu')) return { ok: true, status: 200, json: async () => menu };
    if (target.includes('/api/hard-operations')) return { ok: true, status: 200, json: async () => hard };
    if (target.includes('StageActivityV2')) return { ok: true, status: 200, json: async () => activity };
    if (target.includes('/result/matrix')) {
      const match = /itemFilter=(\d+)/.exec(target);
      return { ok: true, status: 200, json: async () => ({ matrix: penguin[match?.[1] ?? '']?.matrix ?? [] }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetchImpl, calls };
}

/** @type {ReturnType<typeof createData>} */
let data;
/** @type {ReturnType<typeof makeFetch>} */
let fake;

before(async () => {
  const maaPath = await makeMaaDir();
  const cacheDir = tempDir();
  fake = makeFetch();
  data = createData({
    config: {},
    paths: {
      dataCacheDir: cacheDir,
      arkrecCacheDir: path.join(cacheDir, 'arkrec'),
      penguinCacheDir: path.join(cacheDir, 'penguin'),
      activityCacheFile: path.join(cacheDir, 'activity.json'),
    },
    maaPath,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
  });
});

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('query: stage 按代码解析（理智/内部 id/掉落/ArkRec 中文名）', async () => {
  const result = await data.stage('5-10');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'stage');
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match.code, '5-10');
  assert.equal(match.displayName, '5-10 长夜终尽');
  assert.equal(match.apCost, 18);
  assert.deepEqual(match.internalIds.map((entry) => entry.stageId).sort(), ['main_05-10', 'tough_05-10']);
  assert.equal(match.arkrec.group, '第5章 长夜终尽');
  assert.equal(match.arkrec.minOperators, 2);
  assert.equal((await data.stage('5-9')).matches[0].arkrec.challenge, '不能使用重装');
  assert.deepEqual(match.drops.map((drop) => drop.name), ['固源岩', '固源岩组']);
  assert.equal(result.sources.maa.ok, true);
  assert.equal(result.sources.arkrec.ok, true);
  assert.equal(result.sources.activity.ok, true);
});

test('query: stage 支持内部 id 与全角/空白，未知关卡给 E_STAGE_UNKNOWN', async () => {
  assert.equal((await data.stage('  main_05-10 ')).matches[0].code, '5-10');
  assert.equal((await data.stage('５－１０')).matches[0].code, '5-10');
  await assert.rejects(data.stage('CE-7'), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_STAGE_UNKNOWN');
    assert.match(String(error.detail), /CE-1/);
    return true;
  });
});

test('query: stage 能定位活动关（stages.json 里没有也能导航）', async () => {
  const result = await data.stage('ZZ-8');
  const match = result.matches[0];
  assert.equal(match.code, 'ZZ-8');
  assert.equal(match.apCost, null);
  assert.deepEqual(match.internalIds, []);
  assert.equal(match.activity.active, true);
  assert.equal(match.activity.name, '当前活动');
  assert.equal(match.displayName, 'ZZ-8（当前活动）');
  assert.deepEqual(match.drops, [{ itemId: '30012', name: '固源岩' }]);
});

test('query: stage 空查询列出正在开放的活动关', async () => {
  const result = await data.stage('');
  assert.equal(result.ok, true);
  const codes = result.matches.map((match) => match.code).sort();
  assert.deepEqual(codes, ['ZZ-7', 'ZZ-8']);
  assert.match(result.note, /没有给 q/);
});

test('query: item 查材料（常驻掉落关、活动掉落、掉率与期望理智）', async () => {
  const result = await data.item('固源岩');
  assert.equal(result.item.itemId, '30012');
  assert.equal(result.item.name, '固源岩');
  assert.equal(result.permanentStageCount >= 4, true);
  assert.equal(result.permanentStages[0].code, '1-7');
  assert.equal(result.permanentStages[0].apCost, 6);
  assert.deepEqual(result.activityStages.map((stage) => stage.code), ['ZZ-8']);
  assert.equal(result.drops.ok, true);
  const candidates = Object.fromEntries(result.drops.candidates.map((candidate) => [candidate.code, candidate]));
  assert.equal(candidates['1-7'].expectedSanity, 4.8);
  assert.equal(candidates['2-12'].lowSample, true);
  assert.equal(result.sources.penguin.ok, true);

  const byId = await data.item('30033');
  assert.equal(byId.item.name, '聚酸酯组');
  await assert.rejects(data.item('不存在的材料'), (error) => error.code === 'E_BAD_ARGS');
});

test('query: operator 查干员（名字/标签/空查询）', async () => {
  const angel = await data.operator('能天使');
  assert.equal(angel.total, 8);
  assert.equal(angel.matches[0].name, '能天使');
  assert.equal(angel.matches[0].rarity, 6);
  const byTag = await data.operator('资深干员');
  assert.equal(byTag.matches.length, 2);
  const all = await data.operator('');
  assert.equal(all.matches.length, 8);
  assert.match(all.note, /没有给 q/);
});

test('query: activity 返回活动日历（含资源收集/小游戏/关卡）', async () => {
  const result = await data.activity();
  assert.equal(result.ok, true);
  assert.equal(result.client, 'Official');
  assert.equal(result.activities.length, 5);
  assert.equal(result.resourceCollection.isResourceCollection, true);
  assert.equal(result.miniGame.length, 1);
  assert.equal(result.stages.length, 5);
  assert.equal(result.stale, false);
  assert.equal(Number.isFinite(result.ageMs), true);
  assert.equal(result.sources.activity.ok, true);
});

test('query: search 跨关卡/材料/干员/活动', async () => {
  const byStage = await data.search('5-10');
  assert.equal(byStage.stages.some((stage) => stage.code === '5-10'), true);
  const byItem = await data.search('固源');
  assert.equal(byItem.items.some((item) => item.name === '固源岩'), true);
  const byOperator = await data.search('能天使');
  assert.equal(byOperator.operators.some((operator) => operator.name === '能天使'), true);
  const byActivity = await data.search('活动');
  assert.equal(byActivity.activities.length >= 2, true);
  await assert.rejects(data.search(''), (error) => error.code === 'E_BAD_ARGS');
});

test('query: drops 掉率候选与 refresh', async () => {
  const result = await data.drops('固源岩');
  assert.equal(result.ok, true);
  assert.equal(result.item.name, '固源岩');
  assert.equal(result.candidates[0].code, '1-7');
  assert.equal(result.candidates[0].expectedSanity, 4.8);
  const before = fake.calls.filter((url) => url.includes('/result/matrix')).length;
  await data.drops('固源岩');
  const afterCached = fake.calls.filter((url) => url.includes('/result/matrix')).length;
  assert.equal(afterCached, before, 'TTL 内应命中缓存');
  await data.drops('固源岩', { refresh: true });
  const afterRefresh = fake.calls.filter((url) => url.includes('/result/matrix')).length;
  assert.equal(afterRefresh, before + 1);
});

test('query: plan 端到端（掉率排序 + 排除过期活动 + 总期望理智）', async () => {
  const result = await data.plan({ targets: '固源岩:10, 聚酸酯组:5' });
  assert.equal(result.kind, 'plan');
  assert.equal(result.ok, true);
  const rock = result.targets.find((target) => target.itemName === '固源岩');
  assert.deepEqual(rock.candidates.map((candidate) => candidate.code), ['1-7', '4-4', '5-10']);
  assert.equal(rock.best.code, '1-7');
  assert.equal(rock.expectedSanity, 48);
  assert.equal(rock.excluded.some((candidate) => candidate.code === 'AA-8'), true, '过期活动关应被排除');
  const ester = result.targets.find((target) => target.itemName === '聚酸酯组');
  assert.equal(ester.best.code, '5-9');
  assert.equal(ester.expectedSanity, 180);
  assert.equal(result.totals.expectedSanity, 228);
  assert.deepEqual(result.stages.map((stage) => stage.code), ['1-7', '5-9']);
  assert.equal(result.sources.maa.ok, true);
});

test('query: plan 的 preferEvent / exclude / 无数据', async () => {
  const prefer = await data.plan({ targets: '固源岩:1', preferEvent: true });
  assert.equal(prefer.targets[0].candidates[0].code, 'ZZ-8');
  assert.equal(prefer.targets[0].candidates[0].source, 'activity');
  const excluded = await data.plan({ targets: '赤金:1', exclude: '1-7' });
  assert.equal(excluded.targets[0].candidates.some((candidate) => candidate.code === '1-7'), false);
  const noData = await data.plan({ targets: 'RMA70-12:2' });
  assert.equal(noData.targets[0].ok, false);
  assert.equal(noData.totals.expectedSanity, null);
  await assert.rejects(data.plan({ targets: '' }), (error) => error.code === 'E_BAD_ARGS');
});

test('query: status 汇总（只读缓存，不联网）', async () => {
  const callsBefore = fake.calls.length;
  const status = await data.status();
  assert.equal(status.ok, true);
  assert.equal(status.stages, 15);
  assert.equal(status.items, 9);
  assert.equal(status.operators, 8);
  assert.equal(status.version.configVersion, '1.0');
  assert.equal(status.arkrec.ok, true);
  assert.equal(status.activity.ok, true);
  assert.equal(status.penguin.ok, true);
  assert.equal(fake.calls.length, callsBefore, 'status 不应联网');
});

test('query: meta() 是同步只读快照（状态面板 data 字段用，不联网）', async () => {
  const callsBefore = fake.calls.length;
  const meta = data.meta();
  assert.equal(meta.ok, true);
  assert.equal(meta.stages, 15);
  assert.equal(meta.items, 9);
  assert.equal(meta.operators, 8);
  assert.equal(meta.arkrec.ok, true);
  assert.equal(meta.activity.ok, true);
  assert.equal(meta.penguin.ok, true);
  assert.equal(fake.calls.length, callsBefore, 'meta() 不应联网');

  const cold = createData({ config: {}, paths: {}, offline: true, now: () => NOW });
  const coldMeta = cold.meta();
  assert.equal(coldMeta.ok, false);
  assert.equal(coldMeta.stages, null);
  assert.equal(coldMeta.arkrec.ok, false);
});

test('query: offline:true 时绝不联网，仍能用本地关卡表', async () => {
  const maaPath = await makeMaaDir();
  const cacheDir = tempDir('dsh-ark-query-offline-');
  let networkCalls = 0;
  const offline = createData({
    config: {},
    paths: { dataCacheDir: cacheDir, activityCacheFile: path.join(cacheDir, 'activity.json') },
    maaPath,
    offline: true,
    now: () => NOW,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('离线模式不应联网');
    },
  });
  const stage = await offline.stage('1-7');
  assert.equal(stage.matches[0].apCost, 6);
  const item = await offline.item('固源岩');
  assert.equal(item.drops.ok, false);
  assert.match(item.drops.reason, /离线/);
  const activity = await offline.activity();
  assert.equal(activity.ok, false);
  assert.equal(networkCalls, 0, 'offline 模式一次网络都不该发');
});

test('query: resourceBundle 注入（不读 MAA 文件也能查）', async () => {
  const { buildResourceBundle } = await import('../lib/data/resources.js');
  const bundle = buildResourceBundle({
    maaPath: 'X:/memory',
    files: {},
    stagesRaw: readFixture('stages.sample.json'),
    itemsRaw: readFixture('items.sample.json'),
    recruitmentRaw: readFixture('recruitment.sample.json'),
    configRaw: {},
    versionRaw: {},
    warnings: [],
  });
  const memoryOnly = createData({
    config: {},
    paths: {},
    resourceBundle: bundle,
    offline: true,
    now: () => NOW,
  });
  const result = await memoryOnly.stage('1-7');
  assert.equal(result.matches[0].apCost, 6);
  const status = await memoryOnly.status();
  assert.equal(status.stages, 15);
});

/**
 * lib/data/resources.js 与 lib/data/operators.js 单元测试：MAA 五件套读取与索引、
 * mtime 缓存、缺文件降级、错误收口（E_DATA_UNAVAILABLE）、干员搜索。全部离线。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOperatorIndex, searchOperators } from '../lib/data/operators.js';
import {
  buildResourceBundle,
  clearResourceBundleCache,
  loadResourceBundle,
  normalizeItem,
  normalizeStage,
  RESOURCE_FILES,
} from '../lib/data/resources.js';
import { ArkError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');

/** @type {string[]} */
const dirs = [];

/** 读夹具。 */
function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

/** 造一个只含 resource/ 五件套的假 MAA 目录。 */
async function makeMaaDir(overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-res-'));
  dirs.push(root);
  await fsp.mkdir(path.join(root, 'resource'), { recursive: true });
  const files = {
    [RESOURCE_FILES.stages]: readFixture('stages.sample.json'),
    [RESOURCE_FILES.items]: readFixture('items.sample.json'),
    [RESOURCE_FILES.recruitment]: readFixture('recruitment.sample.json'),
    [RESOURCE_FILES.config]: readFixture('config.sample.json'),
    [RESOURCE_FILES.version]: readFixture('version.sample.json'),
    ...overrides,
  };
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, 'resource', name);
    if (value === null) continue;
    await fsp.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  return root;
}

before(() => clearResourceBundleCache());
after(() => {
  clearResourceBundleCache();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('resources: loadResourceBundle 索引关卡/材料/干员/包名/版本', async () => {
  const root = await makeMaaDir();
  const bundle = await loadResourceBundle(root);
  assert.equal(bundle.maaPath, path.resolve(root));
  assert.equal(bundle.stages.length, 15);
  assert.equal(bundle.items.length, 9);
  assert.equal(bundle.operators.length, 8);
  assert.equal(bundle.packageNames.Official, 'com.hypergryph.arknights');
  assert.equal(bundle.version.configVersion, '1.0');
  assert.equal(bundle.version.lastUpdated, '2026-10-29 09:51:13.000');
  assert.deepEqual(bundle.warnings, []);
  assert.equal(bundle.itemNames['30012'], '固源岩');
});

test('resources: 按 code 与 stageId 双索引（同一代码多难度）', async () => {
  const root = await makeMaaDir();
  const bundle = await loadResourceBundle(root);
  const byCode = bundle.stageByCode('5-10');
  assert.deepEqual(byCode.map((entry) => entry.stageId).sort(), ['main_05-10', 'tough_05-10']);
  assert.equal(bundle.stageByCode('５－１０').length, 2, '全角代码也要能解析');
  assert.deepEqual(bundle.stageByCode('CE-1').map((entry) => entry.stageId), ['CE-1']);
  assert.deepEqual(bundle.stageByCode('不存在'), []);
  assert.equal(bundle.stageById('Tough_05-10')?.code, '5-10');
  assert.equal(bundle.stageById('missing'), null);
  assert.equal(bundle.stageByCode('main_05-10').length, 1, '内部 id 也能查');
});

test('resources: 材料按 id/名字解析，坏条目被跳过', async () => {
  const root = await makeMaaDir();
  const bundle = await loadResourceBundle(root);
  assert.equal(bundle.itemById('30012')?.name, '固源岩');
  assert.equal(bundle.itemById('missing'), null);
  assert.equal(bundle.itemByName('固源岩')?.itemId, '30012');
  assert.equal(bundle.itemByName('30012')?.name, '固源岩', '名字查询也接受 id');
  assert.equal(bundle.itemByName('不存在的材料'), null);
  assert.equal(bundle.itemById('31000'), null, '没有 name 的坏条目应被跳过');
});

test('resources: 干员索引（recruitment.json）与搜索', async () => {
  const root = await makeMaaDir();
  const bundle = await loadResourceBundle(root);
  assert.equal(bundle.operatorByName('能天使')?.rarity, 6);
  assert.equal(bundle.operatorById('char_103_angel')?.name, '能天使');
  assert.equal(bundle.operatorByName('不存在'), null);
  assert.equal(bundle.tagTable['输出']?.count, 4);

  const byTag = bundle.operatorIndex.search('资深干员');
  assert.deepEqual(byTag.map((operator) => operator.name).sort(), ['玛恩纳', '能天使'].sort());
  const index = buildOperatorIndex(readFixture('recruitment.sample.json'));
  assert.equal(index.total, 8);
  assert.equal(searchOperators(index, '能天使', { limit: 1 })[0].name, '能天使');
  assert.equal(searchOperators(index, '')?.length, 8);
  assert.deepEqual(searchOperators(null, '能天使'), []);
});

test('resources: mtime 缓存——文件没变复用对象，改了 mtime 重读', async () => {
  const root = await makeMaaDir();
  const first = await loadResourceBundle(root);
  const second = await loadResourceBundle(root);
  assert.equal(second, first, 'mtime 没变应复用同一个 bundle');

  const stagesFile = path.join(root, 'resource', RESOURCE_FILES.stages);
  const stages = readFixture('stages.sample.json');
  stages.push({ stageId: 'main_99-01', code: '99-1', apCost: 6, dropInfos: [] });
  await fsp.writeFile(stagesFile, JSON.stringify(stages), 'utf8');
  // 显式改 mtime，绕开文件系统时间精度
  const future = new Date(Date.now() + 5000);
  await fsp.utimes(stagesFile, future, future);
  const third = await loadResourceBundle(root);
  assert.notEqual(third, first);
  assert.equal(third.stages.length, first.stages.length + 1);
  assert.equal(third.stageByCode('99-1').length, 1);
});

test('resources: 读不到 MAA 目录/关卡表时给 E_DATA_UNAVAILABLE（不抛裸异常）', async () => {
  await assert.rejects(loadResourceBundle(''), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_DATA_UNAVAILABLE');
    return true;
  });
  await assert.rejects(loadResourceBundle(path.join(os.tmpdir(), 'dsh-ark-definitely-missing')), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_DATA_UNAVAILABLE');
    assert.match(String(error.detail), /stages\.json/);
    return true;
  });
  const broken = await makeMaaDir({ [RESOURCE_FILES.stages]: '{不是数组' });
  await assert.rejects(loadResourceBundle(broken), (error) => error.code === 'E_DATA_UNAVAILABLE');
  const notArray = await makeMaaDir({ [RESOURCE_FILES.stages]: { not: 'array' } });
  await assert.rejects(loadResourceBundle(notArray), (error) => error.code === 'E_DATA_UNAVAILABLE');
  const empty = await makeMaaDir({ [RESOURCE_FILES.stages]: [] });
  await assert.rejects(loadResourceBundle(empty), (error) => error.code === 'E_DATA_UNAVAILABLE');
});

test('resources: 可选文件缺失只降级 + warning', async () => {
  const root = await makeMaaDir({
    [RESOURCE_FILES.items]: null,
    [RESOURCE_FILES.recruitment]: null,
    [RESOURCE_FILES.config]: null,
    [RESOURCE_FILES.version]: null,
  });
  const bundle = await loadResourceBundle(root);
  assert.equal(bundle.stages.length, 15);
  assert.deepEqual(bundle.items, []);
  assert.deepEqual(bundle.operators, []);
  assert.deepEqual(bundle.packageNames, {});
  assert.equal(bundle.version.configVersion, null);
  assert.equal(bundle.warnings.length, 4);
});

test('resources: 关卡表损坏但已有旧缓存时沿用旧缓存（degraded）', async () => {
  const root = await makeMaaDir();
  const first = await loadResourceBundle(root);
  await fsp.writeFile(path.join(root, 'resource', RESOURCE_FILES.stages), '{broken', 'utf8');
  const future = new Date(Date.now() + 6000);
  await fsp.utimes(path.join(root, 'resource', RESOURCE_FILES.stages), future, future);
  const second = await loadResourceBundle(root);
  assert.equal(second.stages.length, first.stages.length);
  assert.equal(second.degraded, true);
  assert.equal(second.warnings.length, 1);
});

test('resources: normalizeStage/normalizeItem 对坏数据返回 null', () => {
  assert.equal(normalizeStage(null), null);
  assert.equal(normalizeStage({ code: 'X' }), null);
  assert.equal(normalizeStage({ stageId: 'main_01-07', code: '1-7', apCost: 6, dropInfos: [{ itemId: 'x' }, null] })?.dropItems.join(','), 'x');
  assert.equal(normalizeItem('1', null), null);
  assert.equal(normalizeItem('', { name: 'x' }), null);
  assert.equal(normalizeItem('1', { name: 'x' })?.itemId, '1');
});

test('resources: buildResourceBundle 是纯函数，可直接喂原始 JSON', () => {
  const bundle = buildResourceBundle({
    maaPath: 'X:/fake',
    files: {},
    stagesRaw: [{ stageId: 'main_01-07', code: '1-7', apCost: 6, dropInfos: [] }],
    itemsRaw: { 30012: { name: '固源岩' } },
    recruitmentRaw: { operators: [{ id: 'a', name: 'A', rarity: 1, tags: [] }] },
    configRaw: { packageName: { Official: 'pkg' } },
    versionRaw: {},
    warnings: [],
  });
  assert.equal(bundle.stages.length, 1);
  assert.equal(bundle.itemByName('固源岩').itemId, '30012');
  assert.equal(bundle.operatorById('a').name, 'A');
  assert.equal(bundle.packageNames.Official, 'pkg');
  assert.equal(bundle.stageByCode('1-7')[0].apCost, 6);
});

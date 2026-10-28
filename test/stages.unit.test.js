/**
 * lib/stages.js 单元测试：资源加载（fixture 临时目录）、关卡解析、难度选择、主线序列、
 * 理智估算、掉落材料名。契约：docs/contracts.md 与 lib/stages.js 的 JSDoc。全部离线。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  candidatesText,
  chapterStages,
  clearResourceCache,
  describeDrops,
  difficultyTier,
  displayName,
  estimateSanity,
  loadResources,
  mainlineStages,
  nextMainlineStage,
  normalizeCode,
  pickDifficulty,
  resolveStage,
} from '../lib/stages.js';
import { ArkError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读 fixture。 */
async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(here, 'fixtures', name), 'utf8'));
}

/** 断言抛出的是带指定 code 的 ArkError。 */
function assertArkCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArkError, `${label} 应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

/** @type {string} */
let root;
/** @type {Awaited<ReturnType<typeof loadResources>>} */
let resources;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-stages-'));
  const stages = await readFixture('stages.sample.json');
  const items = await readFixture('items.sample.json');
  await fs.mkdir(path.join(root, 'resource'), { recursive: true });
  await fs.writeFile(path.join(root, 'resource', 'stages.json'), JSON.stringify(stages), 'utf8');
  await fs.writeFile(path.join(root, 'resource', 'item_index.json'), JSON.stringify(items), 'utf8');
  clearResourceCache();
  resources = await loadResources(root);
});

after(async () => {
  clearResourceCache();
  if (typeof root === 'string' && root !== '') await fs.rm(root, { recursive: true, force: true });
});

test('stages: loadResources 读关卡表并过滤掉没有 stageId 的坏条目', () => {
  assert.equal(Array.isArray(resources.stages), true);
  assert.equal(resources.stages.length, 17);
  assert.equal(resources.stages.some((entry) => entry.code === 'BROKEN'), false);
  assert.equal(resources.stages.some((entry) => entry.stageId === 'bad_02'), true);
});

test('stages: loadResources 拆出 prefix/suffix/dropItems', () => {
  const main = resources.stages.find((entry) => entry.stageId === 'main_05-10');
  assert.equal(main.prefix, 'main_');
  assert.equal(main.suffix, '05-10');
  assert.deepEqual(main.dropItems, ['30012', '30011', '30061', '30099']);
  assert.equal(main.apCost, 18);

  const bad = resources.stages.find((entry) => entry.stageId === 'bad_02');
  assert.deepEqual(bad.dropItems, []);
  const ce = resources.stages.find((entry) => entry.stageId === 'CE-1');
  assert.equal(ce.prefix, '');
  assert.equal(ce.suffix, 'CE-1');
});

test('stages: loadResources 读材料名（空名字/缺名字的条目被忽略）', () => {
  assert.equal(Object.keys(resources.itemNames).length, 5);
  assert.equal(resources.itemNames['30012'], '固源岩');
  assert.equal('31000' in resources.itemNames, false);
  assert.equal('31001' in resources.itemNames, false);
});

test('stages: loadResources 按路径缓存，fresh 强制重读', async () => {
  const cached = await loadResources(root);
  assert.equal(cached, resources);
  const fresh = await loadResources(root, { fresh: true });
  assert.notEqual(fresh, resources);
  assert.deepEqual(fresh.stages.map((entry) => entry.stageId), resources.stages.map((entry) => entry.stageId));
});

test('stages: loadResources 缺目录时抛 E_MAA_LOAD', async () => {
  const missing = path.join(root, 'definitely-missing');
  await assert.rejects(loadResources(missing), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_MAA_LOAD');
    return true;
  });
});

test('stages: loadResources 关卡表不是数组时抛 E_MAA_LOAD', async () => {
  const badRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-bad-stages-'));
  try {
    await fs.mkdir(path.join(badRoot, 'resource'), { recursive: true });
    await fs.writeFile(path.join(badRoot, 'resource', 'stages.json'), '{"not":"an array"}', 'utf8');
    await assert.rejects(loadResources(badRoot), (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_MAA_LOAD');
      return true;
    });
  } finally {
    clearResourceCache(badRoot);
    await fs.rm(badRoot, { recursive: true, force: true });
  }
});

test('stages: 缺 item_index.json 只丢材料名，不影响关卡表', async () => {
  const noItems = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-no-items-'));
  try {
    await fs.mkdir(path.join(noItems, 'resource'), { recursive: true });
    await fs.writeFile(path.join(noItems, 'resource', 'stages.json'), JSON.stringify(await readFixture('stages.sample.json')), 'utf8');
    const loaded = await loadResources(noItems);
    assert.equal(loaded.stages.length, 17);
    assert.deepEqual(loaded.itemNames, {});
  } finally {
    clearResourceCache(noItems);
    await fs.rm(noItems, { recursive: true, force: true });
  }
});

test('stages: resolveStage 按代码解析（同一代码的多个难度一起返回）', () => {
  const resolved = resolveStage(resources.stages, '5-10');
  assert.equal(resolved.code, '5-10');
  assert.equal(resolved.byId, null);
  assert.deepEqual(resolved.entries.map((entry) => entry.stageId).sort(), ['main_05-10', 'tough_05-10']);
});

test('stages: resolveStage 按内部 id 解析', () => {
  const resolved = resolveStage(resources.stages, 'tough_05-10');
  assert.equal(resolved.code, '5-10');
  assert.equal(resolved.byId?.stageId, 'tough_05-10');
  assert.equal(resolved.entries.length, 2);
});

test('stages: resolveStage 容忍空白、大小写与全角字符', () => {
  assert.equal(resolveStage(resources.stages, ' 5-10 ').code, '5-10');
  assert.equal(resolveStage(resources.stages, '５－１０').code, '5-10');
  assert.equal(resolveStage(resources.stages, 'MAIN_05-10').byId?.stageId, 'main_05-10');
});

test('stages: resolveStage 未知关卡抛 E_STAGE_UNKNOWN 并给候选', () => {
  assert.throws(() => resolveStage(resources.stages, 'CE-7'), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_STAGE_UNKNOWN');
    assert.equal(typeof error.detail, 'string');
    assert.match(error.detail, /CE-1/);
    assert.match(error.detail, /CE-2/);
    assert.match(String(error.hint), /main_05-10/);
    return true;
  });
});

test('stages: resolveStage 空输入抛 E_BAD_ARGS', () => {
  assertArkCode(() => resolveStage(resources.stages, ''), 'E_BAD_ARGS');
  assertArkCode(() => resolveStage(resources.stages, '   '), 'E_BAD_ARGS');
  assertArkCode(() => resolveStage(resources.stages, null), 'E_BAD_ARGS');
});

test('stages: pickDifficulty auto/easy/tough', () => {
  const entries = resolveStage(resources.stages, '5-10').entries;
  assert.equal(pickDifficulty(entries, 'tough').stageId, 'tough_05-10');
  assert.equal(pickDifficulty(entries, 'easy').stageId, 'main_05-10');
  assert.equal(pickDifficulty(entries, 'auto').stageId, 'main_05-10');
  assert.equal(pickDifficulty(entries).stageId, 'main_05-10');
});

test('stages: pickDifficulty 优先 easy_ 前缀', () => {
  const entries = resolveStage(resources.stages, '5-9').entries;
  assert.deepEqual(entries.map((entry) => entry.stageId), ['main_05-09', 'easy_05-09']);
  assert.equal(pickDifficulty(entries, 'auto').stageId, 'easy_05-09');
  assert.equal(pickDifficulty(entries, 'easy').stageId, 'easy_05-09');
});

test('stages: pickDifficulty 空候选抛 E_STAGE_UNKNOWN', () => {
  assertArkCode(() => pickDifficulty([], 'auto'), 'E_STAGE_UNKNOWN');
  assertArkCode(() => pickDifficulty(null, 'auto'), 'E_STAGE_UNKNOWN');
});

test('stages: mainlineStages 只保留数字章-关，去重且排除 tough', () => {
  const mainline = mainlineStages(resources.stages);
  assert.deepEqual(mainline.map((entry) => entry.code), ['0-1', '4-4', '5-3', '5-9', '5-10', '5-11', '5-12', '10-09', '17-17']);
  assert.equal(mainline.every((entry) => entry.prefix !== 'tough_'), true);
  // 同代码 main_/easy_ 去重时优先 easy_
  assert.equal(mainline.find((entry) => entry.code === '5-9')?.stageId, 'easy_05-09');
  // tough 在前也不影响：5-10 保留 main_
  assert.equal(mainline.find((entry) => entry.code === '5-10')?.stageId, 'main_05-10');
  assert.equal(mainline.every((entry) => Number.isInteger(entry.chapter) && Number.isInteger(entry.index)), true);
});

test('stages: mainlineStages 按 (章, 序号) 升序', () => {
  const mainline = mainlineStages(resources.stages);
  for (let index = 1; index < mainline.length; index += 1) {
    const previous = mainline[index - 1];
    const current = mainline[index];
    const ordered = previous.chapter < current.chapter
      || (previous.chapter === current.chapter && previous.index < current.index);
    assert.equal(ordered, true, `${previous.code} 应在 ${current.code} 之前`);
  }
  assert.equal(mainline[0].code, '0-1');
  assert.equal(mainline[mainline.length - 1].code, '17-17');
});

test('stages: mainlineStages 空输入给空数组', () => {
  assert.deepEqual(mainlineStages([]), []);
  assert.deepEqual(mainlineStages([{ stageId: 'CE-1', code: 'CE-1', prefix: '', suffix: 'CE-1' }]), []);
});

test('stages: chapterStages 过滤章节', () => {
  const mainline = mainlineStages(resources.stages);
  assert.deepEqual(chapterStages(mainline, 5).map((entry) => entry.code), ['5-3', '5-9', '5-10', '5-11', '5-12']);
  assert.deepEqual(chapterStages(mainline, 99), []);
});

test('stages: nextMainlineStage 找下一关', () => {
  const mainline = mainlineStages(resources.stages);
  assert.equal(nextMainlineStage(mainline, '5-11')?.code, '5-12');
  assert.equal(nextMainlineStage(mainline, ' 5-3 ')?.code, '5-9');
  assert.equal(nextMainlineStage(mainline, '17-17'), null);
  assert.equal(nextMainlineStage(mainline, 'CE-1'), null);
  assert.equal(nextMainlineStage(mainline, ''), null);
});

test('stages: estimateSanity 按次数乘 apCost', () => {
  const entry = resolveStage(resources.stages, '5-10').entries[0];
  assert.equal(estimateSanity(entry, 3), 54);
  assert.equal(estimateSanity(entry, 1), 18);
  assert.equal(estimateSanity(entry, 0), 18);
  assert.equal(estimateSanity(entry, NaN), 18);
  assert.equal(estimateSanity(null, 1), null);
  assert.equal(estimateSanity(undefined, 1), null);
  const noCost = resolveStage(resources.stages, '5-12').entries[0];
  assert.equal(noCost.apCost, null);
  assert.equal(estimateSanity(noCost, 2), null);
});

test('stages: describeDrops 用材料名、去重、跳过家具', () => {
  assert.equal(describeDrops(resources, ['30012', '30011', '30012', '30061', '30099']), '固源岩、源岩、赤金');
  assert.equal(describeDrops(resources, ['30012', '30011'], 1), '固源岩');
  assert.equal(describeDrops(resources, ['missing-id', '31000', '30013']), '固源岩组');
  assert.equal(describeDrops(resources, []), '');
});

test('stages: normalizeCode 去空白、全角转半角、大写', () => {
  assert.equal(normalizeCode(' 5 - 10 '), '5-10');
  assert.equal(normalizeCode('ｃｅ－７'), 'CE-7');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

test('stages: difficultyTier 区分 tough 与其他', () => {
  assert.equal(difficultyTier('tough_'), 'tough');
  assert.equal(difficultyTier('main_'), 'easy');
  assert.equal(difficultyTier('easy_'), 'easy');
  assert.equal(difficultyTier(''), 'easy');
});

test('stages: displayName 拼接 ArkRec 中文名', () => {
  const entry = { code: '5-10' };
  assert.equal(displayName(entry, { cn_name: '长夜终尽' }), '5-10 长夜终尽');
  assert.equal(displayName(entry, { cn_name: '  ' }), '5-10');
  assert.equal(displayName(entry, undefined), '5-10');
  assert.equal(displayName(entry, null), '5-10');
});

test('stages: candidatesText 给出相似候选并限制条数', () => {
  const text = candidatesText(resources.stages, 'CE-7');
  assert.match(text, /CE-1/);
  const limited = candidatesText(resources.stages, 'CE-7', 1);
  assert.equal(limited.split('、').length, 1);
});

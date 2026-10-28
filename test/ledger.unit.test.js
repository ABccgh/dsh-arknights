/**
 * lib/ledger.js 单元测试：统计、原子落盘、失败记录上限、损坏文件降级、推关进度。
 * 契约：docs/contracts.md §10（账本格式与原子写）。全部离线（只用临时目录）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../lib/ledger.js';
import { ArkError } from '../lib/errors.js';

/** 造一个临时账本文件路径。 */
async function tempFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-ledger-'));
  return { directory, file: path.join(directory, 'progress.json') };
}

/** 等落盘完成（recordRun 内部是 fire-and-forget 的 flush）。 */
async function settle(ledger) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ledger.flush();
}

/** 删临时目录（账本的 fire-and-forget flush 可能还在跑，失败重试几次）。 */
async function cleanup(directory) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

/** 造一个记录日志的 logger。 */
function makeLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

test('ledger: createLedger 需要 file', () => {
  for (const options of [undefined, {}, { file: '' }]) {
    assert.throws(() => createLedger(options), (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_BAD_ARGS');
      return true;
    });
  }
});

test('ledger: 新账本统计全 0、推关进度为空', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    assert.equal(ledger.file, file);
    assert.deepEqual(ledger.stats(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0 });
    assert.deepEqual(ledger.view(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0, entries: [] });
    assert.equal(ledger.nextPushStage(), '');
    assert.deepEqual(ledger.pushView(), { nextStage: '', lastStopped: '', lastReason: '' });
    assert.equal(ledger.get('5-10'), undefined);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: recordRun 统计（满星/未满星/已领源石）', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('5-10', { stars: 3, method: 'copilot', solutionId: 104178 });
    ledger.recordRun('5-11', { stars: 2, method: 'fight' });
    assert.deepEqual(ledger.stats(), { fullStar: 1, missing: 1, primeClaimed: 1, total: 2 });
    const full = ledger.get('5-10');
    assert.equal(full.stars, 3);
    assert.equal(full.fullStar, true);
    assert.equal(full.primeClaimed, true);
    assert.equal(full.method, 'copilot');
    assert.equal(full.solutionId, 104178);
    assert.equal(typeof full.lastRunAt, 'string');
    const partial = ledger.get('5-11');
    assert.equal(partial.fullStar, false);
    assert.equal(partial.primeClaimed, false);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: primeClaimed 只在满星时为 true', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('5-12', { stars: 2 });
    assert.equal(ledger.get('5-12').primeClaimed, false);
    ledger.recordRun('5-12', { stars: 3 });
    assert.equal(ledger.get('5-12').fullStar, true);
    assert.equal(ledger.get('5-12').primeClaimed, true);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 已满星的记录不会被后来的低星覆盖', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('5-10', { stars: 3 });
    ledger.recordRun('5-10', { stars: 1 });
    assert.equal(ledger.get('5-10').fullStar, true);
    assert.equal(ledger.get('5-10').primeClaimed, true);
    assert.equal(ledger.get('5-10').stars, 1, 'stars 记最新一次');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 星级收敛到 0..3 的整数', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    assert.equal(ledger.recordRun('A-1', { stars: 9 }).stars, 3);
    assert.equal(ledger.recordRun('A-2', { stars: -2 }).stars, 0);
    assert.equal(ledger.recordRun('A-3', { stars: 2.9 }).stars, 2);
    assert.equal(ledger.recordRun('A-4', {}).stars, null);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: flush 原子写入合法 JSON（无 .tmp 残留）', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('5-10', { stars: 3 });
    ledger.setPush({ nextStage: '5-11' });
    await settle(ledger);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(typeof parsed.updatedAt, 'string');
    assert.equal(parsed.stages['5-10'].stars, 3);
    assert.equal(parsed.push.nextStage, '5-11');
    const names = await fs.readdir(directory);
    assert.deepEqual(names, ['progress.json'], '临时文件必须被 rename 掉');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 落盘后重新构造能读回数据', async () => {
  const { directory, file } = await tempFile();
  try {
    const first = createLedger({ file });
    first.recordRun('5-10', { stars: 3, method: 'copilot' });
    first.setPush({ nextStage: '5-11', lastStopped: '5-11', lastReason: 'not-three-stars' });
    await settle(first);

    const second = createLedger({ file });
    assert.deepEqual(second.stats(), { fullStar: 1, missing: 0, primeClaimed: 1, total: 1 });
    assert.equal(second.get('5-10').method, 'copilot');
    assert.equal(second.nextPushStage(), '5-11');
    assert.deepEqual(second.pushView(), { nextStage: '5-11', lastStopped: '5-11', lastReason: 'not-three-stars' });
  } finally {
    await cleanup(directory);
  }
});

test('ledger: recordFailure 记录原因、详情、方法与作业 id', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    const entry = ledger.recordFailure('5-11', { reason: 'not-three-stars', method: 'copilot', solutionId: 9, detail: 'x'.repeat(400) });
    assert.equal(entry.failures.length, 1);
    assert.equal(entry.failures[0].reason, 'not-three-stars');
    assert.equal(entry.failures[0].detail.length, 300);
    assert.equal(entry.method, 'copilot');
    assert.equal(entry.solutionId, 9);
    assert.equal(ledger.stats().missing, 1);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: failures 最多保留 10 条，满星后清空', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    for (let index = 0; index < 12; index += 1) ledger.recordFailure('5-11', { reason: `reason-${index}` });
    const failures = ledger.get('5-11').failures;
    assert.equal(failures.length, 10);
    assert.equal(failures[failures.length - 1].reason, 'reason-11');
    ledger.recordRun('5-11', { stars: 3 });
    assert.deepEqual(ledger.get('5-11').failures, []);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: recordFailure 缺 reason 时记 unknown', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    assert.equal(ledger.recordFailure('5-11', {}).failures[0].reason, 'unknown');
    assert.equal(ledger.recordFailure('5-11', undefined).failures[0].reason, 'unknown');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: setPush 归一化关卡代码并合并字段', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.setPush({ nextStage: ' 5-10 ' });
    assert.equal(ledger.nextPushStage(), '5-10');
    ledger.setPush({ lastStopped: '5-11', lastReason: 'stage-not-found' });
    assert.deepEqual(ledger.pushView(), { nextStage: '5-10', lastStopped: '5-11', lastReason: 'stage-not-found' });
    ledger.setPush({ nextStage: 'ｃｅ－７' });
    assert.equal(ledger.nextPushStage(), 'CE-7');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: get 对代码做归一化（空白/全角/大小写）', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('ce-7', { stars: 3 });
    assert.equal(ledger.get('CE-7').stars, 3);
    assert.equal(ledger.get(' ＣＥ－７ ').stars, 3);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: view 最多 30 条且不泄漏 failures', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    for (let index = 1; index <= 35; index += 1) ledger.recordRun(`5-${index}`, { stars: index % 2 === 0 ? 3 : 2 });
    const view = ledger.view();
    assert.equal(view.entries.length, 30);
    assert.equal(view.total, 35);
    for (const entry of view.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['code', 'fullStar', 'lastRunAt', 'method', 'primeClaimed', 'stars']);
      assert.equal('failures' in entry, false);
    }
    assert.deepEqual(ledger.stats(), { fullStar: 17, missing: 18, primeClaimed: 17, total: 35 });
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 损坏的账本文件按空账本继续并告警', async () => {
  const { directory, file } = await tempFile();
  try {
    await fs.writeFile(file, '{ this is not json', 'utf8');
    const logger = makeLogger();
    const ledger = createLedger({ file, logger });
    assert.deepEqual(ledger.stats(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0 });
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /账本读取失败/);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: stages 结构不对时按空账本继续', async () => {
  const { directory, file } = await tempFile();
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, stages: null, push: null }), 'utf8');
    const ledger = createLedger({ file });
    assert.equal(ledger.stats().total, 0);
    assert.deepEqual(ledger.pushView(), { nextStage: '', lastStopped: '', lastReason: '' });
  } finally {
    await cleanup(directory);
  }
});

test('ledger: flush 会自动创建父目录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-ledger-'));
  try {
    const file = path.join(directory, 'nested', 'deep', 'progress.json');
    const ledger = createLedger({ file });
    ledger.recordRun('5-10', { stars: 3 });
    await settle(ledger);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.stages['5-10'].stars, 3);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 写入失败只告警，不抛出（E_BAD_ARGS 之外的失败）', async () => {
  // 用一个非法文件名（Windows 下路径里含 \0 写入必失败）验证降级。
  const logger = makeLogger();
  const ledger = createLedger({ file: path.join(os.tmpdir(), 'bad\u0000name.json'), logger });
  ledger.recordRun('5-10', { stars: 3 });
  await settle(ledger);
  assert.ok(logger.warnings.some((message) => message.includes('账本写入失败')));
  assert.equal(ledger.stats().fullStar, 1);
});

/**
 * lib/ledger.js（v2）+ lib/history.js + lib/box.js 单元测试：
 * 统计、难度/attempts/lastFailure、每日标记、v1→v2 迁移、损坏降级、原子落盘；
 * JSONL 历史（上限重写）；仓库/干员快照（部分识别保护）。
 * 契约：docs/contracts.md §7.1 / §7.2 / §7.3。全部离线（只用临时目录）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../lib/ledger.js';
import { createHistory } from '../lib/history.js';
import { createBox } from '../lib/box.js';
import { ArkError } from '../lib/errors.js';

/** 造一个临时目录 + 文件路径。 */
async function tempFile(name = 'progress.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-ledger-'));
  return { directory, file: path.join(directory, name) };
}

/** 等落盘完成（recordRun 内部是 fire-and-forget 的 flush）。 */
async function settle(target) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await target.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** 删临时目录（fire-and-forget flush 可能还在跑，失败重试几次）。 */
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
  const infos = [];
  return { warnings, infos, warn: (message) => warnings.push(String(message)), info: (message) => infos.push(String(message)) };
}

/** 今天的本地日期键（与 ledger 内部一致）。 */
function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 目录里的文件名（排序）。 */
async function entries(directory) {
  return (await fs.readdir(directory)).sort();
}

// ---------------------------------------------------------------------------
// ledger：构造与基础
// ---------------------------------------------------------------------------

test('ledger: createLedger 需要 file', () => {
  for (const options of [undefined, {}, { file: '' }]) {
    assert.throws(() => createLedger(options), (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_BAD_ARGS');
      return true;
    });
  }
});

test('ledger: 新账本 version=2、统计全 0、推关进度为空', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    assert.equal(ledger.file, file);
    assert.equal(ledger.getVersion(), 2);
    assert.deepEqual(ledger.stats(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0 });
    assert.deepEqual(ledger.view(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0, entries: [] });
    assert.equal(ledger.nextPushStage(), '');
    assert.deepEqual(ledger.pushView(), { nextStage: '', lastStopped: '', lastReason: '' });
    assert.equal(ledger.get('5-10'), undefined);
    assert.deepEqual(ledger.viewDaily(), { date: todayKey(), tasks: {} });
    assert.deepEqual(ledger.dailyView(), { date: todayKey(), tasks: {} });
  } finally {
    await cleanup(directory);
  }
});

test('ledger: recordRun 统计（满星/未满星/已领源石）+ attempts', async () => {
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
    assert.equal(full.attempts, 1);
    assert.equal(typeof full.lastRunAt, 'string');
    assert.equal(full.lastFailure, null);
    assert.deepEqual(full.difficulty, { easy: { stars: null, at: null }, tough: { stars: null, at: null } });
    const partial = ledger.get('5-11');
    assert.equal(partial.fullStar, false);
    assert.equal(partial.primeClaimed, false);
    assert.equal(partial.attempts, 1);
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
    assert.equal(ledger.get('5-12').attempts, 2);
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

test('ledger: difficulty 记录（recordRun / recordDifficulty，auto 忽略）', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('16-16', { stars: 3, difficulty: 'tough', method: 'copilot', solutionId: 108079 });
    assert.deepEqual(ledger.get('16-16').difficulty.tough.stars, 3);
    assert.equal(typeof ledger.get('16-16').difficulty.tough.at, 'string');
    assert.equal(ledger.get('16-16').difficulty.easy.stars, null);

    ledger.recordRun('16-16', { stars: 2, difficulty: 'easy' });
    assert.equal(ledger.get('16-16').difficulty.easy.stars, 2);

    ledger.recordDifficulty('16-16', 'tough', 3);
    assert.equal(ledger.get('16-16').difficulty.tough.stars, 3);

    const entry = ledger.recordDifficulty('5-10', 'auto', 3);
    assert.deepEqual(entry.difficulty, { easy: { stars: null, at: null }, tough: { stars: null, at: null } });
    assert.equal(ledger.getVersion(), 2);
  } finally {
    await cleanup(directory);
  }
});

test('ledger: flush 原子写入合法 JSON（version=2，无 .tmp 残留）', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    ledger.recordRun('5-10', { stars: 3 });
    ledger.setPush({ nextStage: '5-11' });
    await settle(ledger);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 2);
    assert.equal(typeof parsed.updatedAt, 'string');
    assert.equal(parsed.stages['5-10'].stars, 3);
    assert.equal(parsed.stages['5-10'].attempts, 1);
    assert.deepEqual(parsed.daily, { date: '', tasks: {} });
    assert.equal(parsed.push.nextStage, '5-11');
    assert.deepEqual(await entries(directory), ['progress.json'], '临时文件必须被 rename 掉');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 落盘后重新构造能读回数据（v2）', async () => {
  const { directory, file } = await tempFile();
  try {
    const first = createLedger({ file });
    first.recordRun('5-10', { stars: 3, method: 'copilot', difficulty: 'easy' });
    first.setPush({ nextStage: '5-11', lastStopped: '5-11', lastReason: 'not-three-stars' });
    await settle(first);

    const second = createLedger({ file });
    assert.equal(second.getVersion(), 2);
    assert.deepEqual(second.stats(), { fullStar: 1, missing: 0, primeClaimed: 1, total: 1 });
    assert.equal(second.get('5-10').method, 'copilot');
    assert.equal(second.get('5-10').difficulty.easy.stars, 3);
    assert.equal(second.nextPushStage(), '5-11');
    assert.deepEqual(second.pushView(), { nextStage: '5-11', lastStopped: '5-11', lastReason: 'not-three-stars' });
  } finally {
    await cleanup(directory);
  }
});

// ---------------------------------------------------------------------------
// ledger：失败记录
// ---------------------------------------------------------------------------

test('ledger: recordFailure 记录原因/详情/方法/作业 id + lastFailure/attempts', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    const entry = ledger.recordFailure('5-11', {
      reason: 'not-three-stars',
      method: 'copilot',
      solutionId: 9,
      detail: 'x'.repeat(400),
      screenshot: 'C:\\shots\\a.png',
    });
    assert.equal(entry.failures.length, 1);
    assert.equal(entry.failures[0].reason, 'not-three-stars');
    assert.equal(entry.failures[0].detail.length, 301); // 300 + 省略号
    assert.equal(entry.attempts, 1);
    assert.equal(entry.lastFailure.reason, 'not-three-stars');
    assert.match(entry.lastFailure.screenshot, /a\.png$/);
    assert.equal(entry.method, 'copilot');
    assert.equal(entry.solutionId, 9);
    assert.equal(ledger.stats().missing, 1);

    ledger.recordFailure('5-11', { code: 'E_TIMEOUT', message: '超时了' });
    assert.equal(ledger.get('5-11').attempts, 2);
    assert.equal(ledger.get('5-11').lastFailure.code, 'E_TIMEOUT');
    assert.equal(ledger.get('5-11').lastFailure.message, '超时了');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: failures 最多保留 20 条，满星后清空 lastFailure', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    for (let index = 0; index < 22; index += 1) ledger.recordFailure('5-11', { reason: `reason-${index}` });
    const failures = ledger.get('5-11').failures;
    assert.equal(failures.length, 20);
    assert.equal(failures[failures.length - 1].reason, 'reason-21');
    assert.equal(ledger.get('5-11').attempts, 22);
    ledger.recordRun('5-11', { stars: 3 });
    assert.deepEqual(ledger.get('5-11').failures, []);
    assert.equal(ledger.get('5-11').lastFailure, null);
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

// ---------------------------------------------------------------------------
// ledger：推关 / 归一化 / 视图
// ---------------------------------------------------------------------------

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

test('ledger: view 最多 30 条，带 difficulty/attempts/lastFailure 且不泄漏 failures', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    for (let index = 1; index <= 35; index += 1) ledger.recordRun(`5-${index}`, { stars: index % 2 === 0 ? 3 : 2 });
    ledger.recordFailure('5-1', { reason: 'not-three-stars' });
    const view = ledger.view();
    assert.equal(view.entries.length, 30);
    assert.equal(view.total, 35);
    for (const entry of view.entries) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'attempts',
        'code',
        'difficulty',
        'fullStar',
        'lastFailure',
        'lastRunAt',
        'method',
        'primeClaimed',
        'stars',
      ]);
      assert.equal('failures' in entry, false);
    }
    const failed = view.entries.find((entry) => entry.code === '5-1');
    assert.equal(failed.lastFailure.reason, 'not-three-stars');
    assert.equal(failed.attempts, 2);
    assert.deepEqual(ledger.stats(), { fullStar: 17, missing: 18, primeClaimed: 17, total: 35 });
  } finally {
    await cleanup(directory);
  }
});

// ---------------------------------------------------------------------------
// ledger：每日标记
// ---------------------------------------------------------------------------

test('ledger: markDaily 单任务 + 批量合并 + 过期视为空', async () => {
  const { directory, file } = await tempFile();
  try {
    const ledger = createLedger({ file });
    const today = todayKey();
    const marked = ledger.markDaily('award', true);
    assert.equal(marked.date, today);
    assert.equal(marked.tasks.award.ok, true);
    assert.match(marked.tasks.award.at, /^\d{4}-\d{2}-\d{2}T/);
    // 按项合并（同日）
    ledger.markDaily({ tasks: { mall: { ok: true, text: '买完了' } } });
    let daily = ledger.dailyView();
    assert.equal(daily.date, today);
    assert.equal(daily.tasks.award.ok, true);
    assert.equal(daily.tasks.mall.ok, true);
    assert.equal(daily.tasks.mall.text, '买完了');

    // 同项再次标记会覆盖 ok
    ledger.markDaily('award', { ok: false, text: '失败了' });
    daily = ledger.dailyView();
    assert.equal(daily.tasks.award.ok, false);
    assert.equal(daily.tasks.award.text, '失败了');

    // 换到「昨天」→ 今天视图为空
    ledger.markDaily({ date: '2000-01-01', tasks: { award: { ok: true } } });
    assert.deepEqual(ledger.dailyView(), { date: today, tasks: {} });
    assert.equal(ledger.dump().daily.date, '2000-01-01');

    // 落盘后重新读回今天的标记（切回今天时只保留切回后的任务）
    ledger.markDaily('infrast', { ok: true });
    await settle(ledger);
    const second = createLedger({ file });
    const reloaded = second.dailyView();
    assert.equal(reloaded.date, today);
    assert.equal(reloaded.tasks.infrast.ok, true);
    assert.equal(reloaded.tasks.award, undefined, '换了日期再切回来只保留新日期的任务（单日结构）');
  } finally {
    await cleanup(directory);
  }
});

// ---------------------------------------------------------------------------
// ledger：迁移 / 损坏 / 降级
// ---------------------------------------------------------------------------

test('ledger: v1 → v2 迁移先写 progress.json.v1.bak，数据保留', async () => {
  const { directory, file } = await tempFile();
  try {
    const v1 = {
      version: 1,
      updatedAt: '2026-10-28T00:00:00.000Z',
      stages: {
        '5-10': {
          code: '5-10',
          stars: 3,
          fullStar: true,
          primeClaimed: true,
          method: 'copilot',
          solutionId: 104178,
          lastRunAt: '2026-10-28T00:00:00.000Z',
          failures: [],
        },
        '5-11': {
          code: '5-11',
          stars: 2,
          fullStar: false,
          primeClaimed: false,
          method: 'fight',
          solutionId: null,
          lastRunAt: '2026-10-28T01:00:00.000Z',
          failures: [{ at: '2026-10-28T01:00:00.000Z', reason: 'not-three-stars' }],
        },
      },
      push: { nextStage: '5-12' },
    };
    await fs.writeFile(file, JSON.stringify(v1, null, 2), 'utf8');
    const logger = makeLogger();
    const ledger = createLedger({ file, logger });
    assert.equal(ledger.getVersion(), 2);
    assert.ok(logger.infos.some((message) => message.includes('迁移')), `应记录迁移日志：${logger.infos}`);
    // 备份原文件
    const backup = await fs.readFile(`${file}.v1.bak`, 'utf8');
    assert.equal(JSON.parse(backup).version, 1);
    // 数据保留 + 补齐 v2 字段
    assert.equal(ledger.get('5-10').stars, 3);
    assert.equal(ledger.get('5-10').attempts, 1);
    assert.deepEqual(ledger.get('5-10').difficulty, { easy: { stars: null, at: null }, tough: { stars: null, at: null } });
    assert.equal(ledger.get('5-11').attempts, 2);
    assert.equal(ledger.get('5-11').lastFailure.reason, 'not-three-stars');
    assert.deepEqual(ledger.pushView(), { nextStage: '5-12', lastStopped: '', lastReason: '' });
    assert.deepEqual(ledger.dailyView(), { date: todayKey(), tasks: {} });
    await settle(ledger);
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.ok((await entries(directory)).includes('progress.json.v1.bak'));
  } finally {
    await cleanup(directory);
  }
});

test('ledger: 损坏的账本文件备份为 .corrupt-<ts> 后按空账本继续', async () => {
  const { directory, file } = await tempFile();
  try {
    await fs.writeFile(file, '{ this is not json', 'utf8');
    const logger = makeLogger();
    const ledger = createLedger({ file, logger });
    assert.deepEqual(ledger.stats(), { fullStar: 0, missing: 0, primeClaimed: 0, total: 0 });
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /账本读取失败/);
    const names = await entries(directory);
    assert.ok(names.some((name) => name.startsWith('progress.json.corrupt-')), `应留损坏备份：${names}`);
    assert.equal(names.includes('progress.json'), true, '原损坏文件保留（由用户决定删不删）');
  } finally {
    await cleanup(directory);
  }
});

test('ledger: stages 结构不对时按空账本继续（v1 迁移路径）', async () => {
  const { directory, file } = await tempFile();
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, stages: null, push: null }), 'utf8');
    const ledger = createLedger({ file });
    assert.equal(ledger.getVersion(), 2);
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
    assert.equal(raw.version, 2);
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
  assert.ok(logger.warnings.some((message) => message.includes('账本写入失败')), `warnings=${logger.warnings}`);
  assert.equal(ledger.stats().fullStar, 1);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('history: 需要 file；空文件读到空数组', async () => {
  assert.throws(() => createHistory({}), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_BAD_ARGS');
    return true;
  });
  const { directory, file } = await tempFile('history.jsonl');
  try {
    const history = createHistory({ file });
    assert.equal(history.file, file);
    assert.deepEqual(await history.read(), []);
  } finally {
    await cleanup(directory);
  }
});

test('history: append 写 JSONL、read 取最近 N 条、精简大字段', async () => {
  const { directory, file } = await tempFile('history.jsonl');
  try {
    const history = createHistory({ file, maxEntries: 10 });
    await history.append({
      id: 'run-1',
      kind: 'fight',
      status: 'completed',
      startedAt: '2026-10-29T00:00:00.000Z',
      endedAt: '2026-10-29T00:01:00.000Z',
      planned: [{ stage: '5-10' }],
      executed: [{ stage: '5-10' }],
      events: [{ seq: 1 }],
      params: { big: true },
      text: 'x'.repeat(1200),
    });
    await history.append({ id: 'run-2', kind: 'daily', status: 'failed', text: 'ok' });
    await history.flush();

    const lines = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line);
    const stored = JSON.parse(lines[0]);
    assert.equal(stored.id, 'run-1');
    assert.equal('planned' in stored, false);
    assert.equal('executed' in stored, false);
    assert.equal('events' in stored, false);
    assert.equal('params' in stored, false);
    assert.equal(stored.text.length, 1001);

    const recent = await history.read(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, 'run-2');
    assert.equal(history.count(), 2);
  } finally {
    await cleanup(directory);
  }
});

test('history: 超过 maxEntries 时重写保留最近 N 条', async () => {
  const { directory, file } = await tempFile('history.jsonl');
  try {
    const history = createHistory({ file, maxEntries: 3 });
    for (let index = 1; index <= 6; index += 1) await history.append({ id: `run-${index}`, kind: 'fight' });
    await history.flush();
    const stored = await history.read(10);
    assert.deepEqual(stored.map((entry) => entry.id), ['run-4', 'run-5', 'run-6']);
    const lines = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 3, '写满后文件里只保留最近 N 条');
    assert.equal(history.count(), 3);
  } finally {
    await cleanup(directory);
  }
});

test('history: 损坏行被跳过，重新构造能读回合法行', async () => {
  const { directory, file } = await tempFile('history.jsonl');
  try {
    await fs.writeFile(file, '{"id":"run-1"}\nnot-json\n{"id":"run-2"}\n', 'utf8');
    const history = createHistory({ file });
    const stored = await history.read(10);
    assert.deepEqual(stored.map((entry) => entry.id), ['run-1', 'run-2']);
  } finally {
    await cleanup(directory);
  }
});

// ---------------------------------------------------------------------------
// box
// ---------------------------------------------------------------------------

test('box: 需要 file；空快照 summary 全 0', async () => {
  assert.throws(() => createBox({}), (error) => {
    assert.ok(error instanceof ArkError);
    assert.equal(error.code, 'E_BAD_ARGS');
    return true;
  });
  const { directory, file } = await tempFile('box.json');
  try {
    const box = createBox({ file });
    assert.equal(box.file, file);
    assert.deepEqual(box.summary(), { operators: 0, depotItems: 0, updatedAt: null, partial: false });
    assert.deepEqual(box.read(), {
      version: 1,
      updatedAt: '',
      partial: false,
      operators: { all: [], own: [] },
      depot: { items: {} },
    });
    assert.deepEqual(box.detail({ target: 'both' }), { operators: [], depot: [] });
  } finally {
    await cleanup(directory);
  }
});

test('box: saveOperBox 接受 MAA OperBoxInfo details，落盘可读回', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    const box = createBox({ file });
    const summary = box.saveOperBox({
      done: true,
      all_opers: [
        { id: 'char_002_amiya', name: '阿米娅', rarity: 5, own: true },
        { id: 'char_103_angel', name: '能天使', rarity: 6, own: true },
      ],
      own_opers: [
        { id: 'char_103_angel', name: '能天使', rarity: 6, elite: 2, level: 90, potential: 1, own: true },
      ],
    });
    assert.equal(summary.operators, 1);
    assert.equal(summary.depotItems, 0);
    assert.equal(summary.partial, false);
    assert.match(summary.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const data = box.read();
    assert.equal(data.operators.all.length, 2);
    assert.deepEqual(data.operators.all[0], { id: 'char_002_amiya', name: '阿米娅', rarity: 5, own: true });
    assert.deepEqual(data.operators.own[0], {
      id: 'char_103_angel',
      name: '能天使',
      rarity: 6,
      elite: 2,
      level: 90,
      potential: 1,
      own: true,
    });
    await settle(box);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.partial, false);
    assert.equal(onDisk.operators.own.length, 1);
  } finally {
    await cleanup(directory);
  }
});

test('box: 部分识别（done:false）不覆盖完整快照', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    const box = createBox({ file });
    box.saveOperBox({ done: true, all_opers: [{ id: 'char_1', name: 'A', rarity: 6, own: true }], own_opers: [] });
    assert.equal(box.summary().partial, false);
    const before = box.summary();

    box.saveOperBox({ done: false, all_opers: [{ id: 'char_2', name: 'B', rarity: 1, own: true }], own_opers: [] });
    const after = box.summary();
    assert.equal(after.partial, false);
    assert.equal(after.operators, before.operators);
    assert.equal(box.read().operators.all[0].id, 'char_1', '部分结果不能覆盖完整快照');

    // 没有完整快照时，部分结果本身可以落盘（标 partial:true）
    const other = path.join(directory, 'box-partial.json');
    const partialBox = createBox({ file: other });
    partialBox.saveOperBox({ done: false, all_opers: [{ id: 'char_3', name: 'C', rarity: 3, own: true }] });
    assert.equal(partialBox.summary().partial, true);
    await settle(partialBox);
    const disk = JSON.parse(await fs.readFile(other, 'utf8'));
    assert.equal(disk.partial, true);
    assert.equal(disk.operators.all[0].id, 'char_3');
  } finally {
    await cleanup(directory);
  }
});

test('box: saveDepot 解析 MAA DepotInfo.data 并用 itemNames 补名', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    const box = createBox({ file });
    const summary = box.saveDepot(
      { done: true, data: JSON.stringify({ 30061: 12, 30062: 3 }) },
      { itemNames: { 30061: { name: '固源岩' }, 30062: '源岩' } },
    );
    assert.equal(summary.depotItems, 2);
    assert.deepEqual(box.read().depot.items, {
      30061: { name: '固源岩', count: 12 },
      30062: { name: '源岩', count: 3 },
    });
    // 归一化 + 数字形态也收
    box.saveDepot({ items: { 30061: { count: 20 }, 999: 1 } }, { itemNames: new Map([['999', '无名称']]) });
    assert.deepEqual(box.read().depot.items, {
      30061: { name: '', count: 20 },
      999: { name: '无名称', count: 1 },
    });
    // detail 按数量降序
    assert.deepEqual(box.detail({ target: 'depot' }).depot, [
      { itemId: '30061', name: '', count: 20 },
      { itemId: '999', name: '无名称', count: 1 },
    ]);
  } finally {
    await cleanup(directory);
  }
});

test('box: detail 支持 target/limit（面板 query 用）', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    const box = createBox({ file });
    box.saveOperBox({
      done: true,
      all_opers: [],
      own_opers: Array.from({ length: 5 }, (_, index) => ({
        id: `char_${index}`,
        name: `干员${index}`,
        rarity: 4,
        elite: 1,
        level: 50,
        potential: 2,
      })),
    });
    const operators = box.detail({ target: 'operators', limit: 2 }).operators;
    assert.equal(operators.length, 2);
    assert.deepEqual(operators[0], {
      id: 'char_0',
      name: '干员0',
      rarity: 4,
      elite: 1,
      level: 50,
      potential: 2,
      own: true,
    });
    assert.equal('depot' in box.detail({ target: 'operators' }), false);
    assert.equal('operators' in box.detail({ target: 'depot' }), false);
  } finally {
    await cleanup(directory);
  }
});

test('box: 损坏文件备份 .corrupt-<ts> 后从空快照开始', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    await fs.writeFile(file, '{ broken', 'utf8');
    const logger = makeLogger();
    const box = createBox({ file, logger });
    assert.deepEqual(box.summary(), { operators: 0, depotItems: 0, updatedAt: null, partial: false });
    assert.ok(logger.warnings.some((message) => message.includes('仓库快照读取失败')));
    const names = await entries(directory);
    assert.ok(names.some((name) => name.startsWith('box.json.corrupt-')), `应留损坏备份：${names}`);
  } finally {
    await cleanup(directory);
  }
});

test('box: 落盘后重新构造能读回完整快照', async () => {
  const { directory, file } = await tempFile('box.json');
  try {
    const first = createBox({ file });
    first.saveOperBox({ done: true, all_opers: [{ id: 'char_1', name: 'A', rarity: 6, own: true }], own_opers: [] });
    first.saveDepot({ done: true, data: JSON.stringify({ 30061: 5 }) }, { itemNames: { 30061: '固源岩' } });
    await settle(first);

    const second = createBox({ file });
    const summary = second.summary();
    assert.equal(summary.operators, 1);
    assert.equal(summary.depotItems, 1);
    assert.equal(summary.partial, false);
    assert.match(summary.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(second.read().depot.items['30061'].name, '固源岩');
  } finally {
    await cleanup(directory);
  }
});

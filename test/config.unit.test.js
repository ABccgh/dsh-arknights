/**
 * lib/config.js 单元测试：默认值、枚举收敛、整数边界、非法类型回退、默认路径。
 * 契约：docs/contracts.md（配置项见 cordis.patch.yml）。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DIFFICULTIES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  ROGUE_MODES,
  ROGUE_THEMES,
  TOUCH_MODES,
  defaultArkrecCacheDir,
  defaultCopilotCacheDir,
  defaultLedgerFile,
  defaultUserDir,
  normalizeConfig,
  resolvePaths,
} from '../lib/config.js';

test('config: 常量与契约/版本一致', async () => {
  // 版本号以 package.json 为准（升级时不必再改这条测试）
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(PROTOCOL_VERSION, '1.0.0');
  assert.deepEqual(DIFFICULTIES, ['auto', 'easy', 'tough']);
  assert.deepEqual(TOUCH_MODES, ['minitouch', 'maatouch', 'adb', 'macplaytools']);
  assert.deepEqual(ROGUE_THEMES, ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden']);
  assert.deepEqual(ROGUE_MODES, ['Exp', 'Invest', 'Start', 'DeepExploration']);
});

test('config: 空配置回退到全部默认值', () => {
  const config = normalizeConfig();
  assert.equal(config.maaPath, '');
  assert.equal(config.pythonPath, '');
  assert.equal(config.userDir, '');
  assert.equal(config.adbPath, '');
  assert.equal(config.address, '');
  assert.equal(config.ledgerFile, '');
  assert.equal(config.connectionConfig, 'MuMuEmulator12');
  assert.equal(config.clientType, 'Official');
  assert.equal(config.touchMode, 'minitouch');
  assert.equal(config.deploymentWithPause, false);
  assert.equal(config.requestTimeoutMs, 20000);
  assert.equal(config.connectTimeoutMs, 120000);
  assert.equal(config.startupTimeoutMs, 300000);
  assert.equal(config.idleTimeoutMs, 600000);
  assert.equal(config.defaultDifficulty, 'auto');
  assert.equal(config.confirmRequired, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.webStatus, true);
});

test('config: 嵌套默认值', () => {
  const config = normalizeConfig();
  assert.deepEqual(config.emulator, { managerPath: '', installPath: '', vmIndex: 0, launchTimeoutMs: 120000 });
  assert.deepEqual(config.copilot, {
    enabled: true,
    api: 'https://prts.maa.plus',
    timeoutMs: 15000,
    maxCandidates: 20,
    maxSolutionsPerStage: 3,
    allowBorrowedOper: false,
    cacheDir: '',
  });
  assert.deepEqual(config.arkrec, {
    enabled: true,
    api: 'https://wiki.arkrec.com/v1',
    timeoutMs: 15000,
    cacheTtlHours: 168,
  });
  assert.deepEqual(config.rogue, { theme: 'Sarkaz', mode: 'Exp', startsCount: 9999 });
  assert.deepEqual(config.push, { from: '', maxStages: 10, stopOnNoSolution: true, maxConsecutiveFailures: 2, skipLedgerFullStar: true });
});

test('config: null/undefined/标量/数组都当作空配置，不抛错', () => {
  for (const raw of [null, undefined, 'nope', 42, [], true]) {
    const config = normalizeConfig(raw);
    assert.equal(config.connectionConfig, 'MuMuEmulator12');
    assert.equal(config.defaultDifficulty, 'auto');
    assert.equal(config.push.maxStages, 10);
  }
});

test('config: 路径字段 trim，空串保持空串（=自动探测）', () => {
  const config = normalizeConfig({ maaPath: '  D:\\MAA  ', pythonPath: '   ', userDir: ' C:\\u ' });
  assert.equal(config.maaPath, 'D:\\MAA');
  assert.equal(config.pythonPath, '');
  assert.equal(config.userDir, 'C:\\u');
});

test('config: touchMode 大小写不敏感收敛，非法值回退 minitouch', () => {
  assert.equal(normalizeConfig({ touchMode: 'MAATOUCH' }).touchMode, 'maatouch');
  assert.equal(normalizeConfig({ touchMode: ' Adb ' }).touchMode, 'adb');
  assert.equal(normalizeConfig({ touchMode: 'macPlayTools' }).touchMode, 'macplaytools');
  assert.equal(normalizeConfig({ touchMode: 'nonsense' }).touchMode, 'minitouch');
  assert.equal(normalizeConfig({ touchMode: 123 }).touchMode, 'minitouch');
});

test('config: defaultDifficulty 收敛，非法值回退 auto', () => {
  assert.equal(normalizeConfig({ defaultDifficulty: 'TOUGH' }).defaultDifficulty, 'tough');
  assert.equal(normalizeConfig({ defaultDifficulty: 'Easy' }).defaultDifficulty, 'easy');
  assert.equal(normalizeConfig({ defaultDifficulty: 'nightmare' }).defaultDifficulty, 'auto');
});

test('config: 肉鸽主题/模式收敛', () => {
  assert.equal(normalizeConfig({ rogue: { theme: 'mizuki' } }).rogue.theme, 'Mizuki');
  assert.equal(normalizeConfig({ rogue: { theme: 'JieGarden' } }).rogue.theme, 'JieGarden');
  assert.equal(normalizeConfig({ rogue: { theme: 'unknown' } }).rogue.theme, 'Sarkaz');
  assert.equal(normalizeConfig({ rogue: { mode: 'INVEST' } }).rogue.mode, 'Invest');
  assert.equal(normalizeConfig({ rogue: { mode: 'deepExploration' } }).rogue.mode, 'DeepExploration');
  assert.equal(normalizeConfig({ rogue: { mode: 'deep exploration' } }).rogue.mode, 'Exp');
});

test('config: 整数字段收敛到边界内', () => {
  assert.equal(normalizeConfig({ requestTimeoutMs: 1000 }).requestTimeoutMs, 2000);
  assert.equal(normalizeConfig({ requestTimeoutMs: 99_999_999 }).requestTimeoutMs, 300000);
  assert.equal(normalizeConfig({ requestTimeoutMs: '30000' }).requestTimeoutMs, 30000);
  assert.equal(normalizeConfig({ connectTimeoutMs: 1 }).connectTimeoutMs, 5000);
  assert.equal(normalizeConfig({ startupTimeoutMs: 1 }).startupTimeoutMs, 5000);
  assert.equal(normalizeConfig({ idleTimeoutMs: 1 }).idleTimeoutMs, 30000);
  assert.equal(normalizeConfig({ emulator: { vmIndex: -5 } }).emulator.vmIndex, 0);
  assert.equal(normalizeConfig({ emulator: { vmIndex: 100 } }).emulator.vmIndex, 64);
  assert.equal(normalizeConfig({ push: { maxStages: 0 } }).push.maxStages, 1);
  assert.equal(normalizeConfig({ push: { maxStages: 1000 } }).push.maxStages, 200);
  assert.equal(normalizeConfig({ push: { maxConsecutiveFailures: 0 } }).push.maxConsecutiveFailures, 1);
  assert.equal(normalizeConfig({ rogue: { startsCount: 0 } }).rogue.startsCount, 1);
  assert.equal(normalizeConfig({ copilot: { maxCandidates: 0 } }).copilot.maxCandidates, 1);
  assert.equal(normalizeConfig({ copilot: { maxSolutionsPerStage: 99 } }).copilot.maxSolutionsPerStage, 20);
  assert.equal(normalizeConfig({ arkrec: { cacheTtlHours: 24 * 365 } }).arkrec.cacheTtlHours, 24 * 30);
});

test('config: 非法整数值回退默认，不产生 NaN', () => {
  for (const value of ['abc', null, undefined, false, {}, NaN]) {
    assert.equal(normalizeConfig({ requestTimeoutMs: value }).requestTimeoutMs, 20000);
  }
  assert.equal(normalizeConfig({ push: { maxStages: 'x' } }).push.maxStages, 10);
});

test('config: 布尔字段只接受真正的布尔值', () => {
  assert.equal(normalizeConfig({ deploymentWithPause: true }).deploymentWithPause, true);
  assert.equal(normalizeConfig({ deploymentWithPause: 'true' }).deploymentWithPause, false);
  assert.equal(normalizeConfig({ deploymentWithPause: 1 }).deploymentWithPause, false);
  assert.equal(normalizeConfig({ confirmRequired: false }).confirmRequired, false);
  assert.equal(normalizeConfig({ confirmRequired: 0 }).confirmRequired, true);
  assert.equal(normalizeConfig({ dryRun: 'yes' }).dryRun, false);
});

test('config: 嵌套字段类型错误时逐层回退', () => {
  assert.deepEqual(normalizeConfig({ copilot: 'x' }).copilot.api, 'https://prts.maa.plus');
  assert.deepEqual(normalizeConfig({ emulator: [] }).emulator, { managerPath: '', installPath: '', vmIndex: 0, launchTimeoutMs: 120000 });
  assert.deepEqual(normalizeConfig({ push: null }).push.from, '');
  assert.equal(normalizeConfig({ copilot: { enabled: false } }).copilot.enabled, false);
});

test('config: 文本字段 trim 后回退，自定义值保留', () => {
  assert.equal(normalizeConfig({ connectionConfig: '  ' }).connectionConfig, 'MuMuEmulator12');
  assert.equal(normalizeConfig({ clientType: 'Bilibili' }).clientType, 'Bilibili');
  assert.equal(normalizeConfig({ copilot: { api: ' https://example.test/ ' } }).copilot.api, 'https://example.test/');
  assert.equal(normalizeConfig({ push: { from: ' 5-3 ' } }).push.from, '5-3');
});

test('config: 用户给的合法值原样保留', () => {
  const config = normalizeConfig({
    maaPath: 'D:\\MAA',
    pythonPath: 'C:\\py\\python.exe',
    requestTimeoutMs: 4000,
    defaultDifficulty: 'easy',
    copilot: { enabled: false, maxCandidates: 5, allowBorrowedOper: true },
    arkrec: { enabled: false, cacheTtlHours: 24 },
    rogue: { theme: 'Sami', mode: 'Start', startsCount: 3 },
    push: { from: '4-4', maxStages: 3, stopOnNoSolution: false },
  });
  assert.equal(config.maaPath, 'D:\\MAA');
  assert.equal(config.pythonPath, 'C:\\py\\python.exe');
  assert.equal(config.requestTimeoutMs, 4000);
  assert.equal(config.defaultDifficulty, 'easy');
  assert.equal(config.copilot.enabled, false);
  assert.equal(config.copilot.maxCandidates, 5);
  assert.equal(config.copilot.allowBorrowedOper, true);
  assert.equal(config.arkrec.cacheTtlHours, 24);
  assert.equal(config.rogue.theme, 'Sami');
  assert.equal(config.rogue.mode, 'Start');
  assert.equal(config.push.from, '4-4');
  assert.equal(config.push.stopOnNoSolution, false);
});

test('config: 默认路径函数都是绝对路径且落在 dsh-arknights 目录', () => {
  for (const file of [defaultUserDir(), defaultLedgerFile(), defaultCopilotCacheDir(), defaultArkrecCacheDir()]) {
    assert.equal(path.isAbsolute(file), true);
    assert.match(file, /dsh-arknights/i);
  }
  assert.match(defaultUserDir(), /maa$/);
  assert.match(defaultLedgerFile(), /progress\.json$/);
  assert.match(defaultCopilotCacheDir(), /copilot$/);
  assert.match(defaultArkrecCacheDir(), /arkrec$/);
});

test('config: resolvePaths 把空路径换成绝对默认路径', () => {
  const paths = resolvePaths(normalizeConfig());
  assert.equal(paths.userDir, defaultUserDir());
  assert.equal(paths.ledgerFile, defaultLedgerFile());
  assert.equal(paths.copilotCacheDir, defaultCopilotCacheDir());
  assert.equal(paths.arkrecCacheDir, defaultArkrecCacheDir());
  for (const value of Object.values(paths)) assert.equal(path.isAbsolute(value), true);
});

test('config: resolvePaths 尊重配置里自定义的路径', () => {
  const paths = resolvePaths(normalizeConfig({
    userDir: 'C:\\tmp\\maa-user',
    ledgerFile: 'C:\\tmp\\ledger.json',
    copilot: { cacheDir: 'C:\\tmp\\copilot' },
  }));
  assert.equal(paths.userDir, 'C:\\tmp\\maa-user');
  assert.equal(paths.ledgerFile, 'C:\\tmp\\ledger.json');
  assert.equal(paths.copilotCacheDir, 'C:\\tmp\\copilot');
});

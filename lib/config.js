/**
 * 配置归一化与默认路径（契约见 docs/contracts.md，配置项见 cordis.patch.yml）。
 *
 * 本插件不导出 Cordis `Config`：包通过 `link:` 安装在 DSH 安装作用域之外，不能 import
 * `@deepseek-ai/*`，所以由这里的 `normalizeConfig` 兜底 —— 写错的字段回退默认值，
 * 而不是让整个插件装不上（与本工作区其它 6 个插件一致）。
 *
 * @module @local/arknights/config
 */

import os from 'node:os';
import path from 'node:path';

/** 插件版本（与 package.json 一致，`test/plugin.test.js` 会校验）。 */
export const PLUGIN_VERSION = '0.2.0';
/** 侧车线路协议版本（与 docs/contracts.md 一致）。 */
export const PROTOCOL_VERSION = '1.0.0';

/** 允许的难度取值。 */
export const DIFFICULTIES = ['auto', 'easy', 'tough'];
/** 允许的触摸模式（MaaCore InstanceOptionType.TouchMode 的取值）。 */
export const TOUCH_MODES = ['minitouch', 'maatouch', 'adb', 'macplaytools'];
/** 肉鸽主题（MaaCore Roguelike.theme）。 */
export const ROGUE_THEMES = ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'];
/** 肉鸽模式（MaaCore Roguelike.mode）。 */
export const ROGUE_MODES = ['Exp', 'Invest', 'Start', 'DeepExploration'];

/** 只保留非空字符串。 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取非空字符串，否则回退。 */
function textOr(value, fallback) {
  const text = trimmed(value);
  return text === '' ? fallback : text;
}

/** 取布尔值，否则回退。 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 取有界整数，非法值回退。 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** 取枚举值（大小写不敏感），非法值回退。 */
function enumOr(value, fallback, allowed, { caseInsensitive = true } = {}) {
  const text = trimmed(value);
  if (text === '') return fallback;
  for (const candidate of allowed) {
    if (caseInsensitive ? candidate.toLowerCase() === text.toLowerCase() : candidate === text) return candidate;
  }
  return fallback;
}

/** 取对象，否则回退成空对象。 */
function objectOr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 默认 userDir：`%LOCALAPPDATA%\dsh-arknights\maa`（MAA 的日志/debug 图都写这里）。
 * @returns {string} 绝对路径。
 */
export function defaultUserDir() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights', 'maa');
}

/**
 * 默认账本文件：`%LOCALAPPDATA%\dsh-arknights\progress.json`。
 * @returns {string} 绝对路径。
 */
export function defaultLedgerFile() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights', 'progress.json');
}

/**
 * 默认作业缓存目录：`%LOCALAPPDATA%\dsh-arknights\copilot`。
 * @returns {string} 绝对路径。
 */
export function defaultCopilotCacheDir() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights', 'copilot');
}

/**
 * 默认 ArkRec 缓存目录：`%LOCALAPPDATA%\dsh-arknights\arkrec`。
 * @returns {string} 绝对路径。
 */
export function defaultArkrecCacheDir() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights', 'arkrec');
}

/**
 * 把 loader 传来的配置收进合法范围。
 * @param {unknown} raw - cordis.patch.yml 里 `config` 的内容。
 * @returns {ReturnType<typeof normalizeConfig> extends never ? never : any} 生效配置（结构见下）。
 */
export function normalizeConfig(raw = {}) {
  const base = objectOr(raw);
  const emulator = objectOr(base.emulator);
  const copilot = objectOr(base.copilot);
  const arkrec = objectOr(base.arkrec);
  const rogue = objectOr(base.rogue);
  const push = objectOr(base.push);
  return {
    // —— 路径（空串=自动探测，见 lib/detect.js）——
    maaPath: trimmed(base.maaPath),
    pythonPath: trimmed(base.pythonPath),
    userDir: trimmed(base.userDir),
    adbPath: trimmed(base.adbPath),
    address: trimmed(base.address),
    ledgerFile: trimmed(base.ledgerFile),
    connectionConfig: textOr(base.connectionConfig, 'MuMuEmulator12'),
    clientType: textOr(base.clientType, 'Official'),
    touchMode: enumOr(base.touchMode, 'minitouch', TOUCH_MODES),
    deploymentWithPause: boolOr(base.deploymentWithPause, false),
    // —— 超时 ——
    requestTimeoutMs: intIn(base.requestTimeoutMs, 20000, 2000, 300000),
    connectTimeoutMs: intIn(base.connectTimeoutMs, 120000, 5000, 600000),
    startupTimeoutMs: intIn(base.startupTimeoutMs, 300000, 5000, 900000),
    idleTimeoutMs: intIn(base.idleTimeoutMs, 600000, 30000, 3600000),
    // —— 行为 ——
    defaultDifficulty: enumOr(base.defaultDifficulty, 'auto', DIFFICULTIES),
    confirmRequired: boolOr(base.confirmRequired, true),
    dryRun: boolOr(base.dryRun, false),
    webStatus: boolOr(base.webStatus, true),
    emulator: {
      managerPath: trimmed(emulator.managerPath),
      installPath: trimmed(emulator.installPath),
      vmIndex: intIn(emulator.vmIndex, 0, 0, 64),
      launchTimeoutMs: intIn(emulator.launchTimeoutMs, 120000, 10000, 600000),
    },
    copilot: {
      enabled: boolOr(copilot.enabled, true),
      api: textOr(copilot.api, 'https://prts.maa.plus'),
      timeoutMs: intIn(copilot.timeoutMs, 15000, 2000, 60000),
      maxCandidates: intIn(copilot.maxCandidates, 20, 1, 100),
      maxSolutionsPerStage: intIn(copilot.maxSolutionsPerStage, 3, 1, 20),
      allowBorrowedOper: boolOr(copilot.allowBorrowedOper, false),
      cacheDir: trimmed(copilot.cacheDir),
    },
    arkrec: {
      enabled: boolOr(arkrec.enabled, true),
      api: textOr(arkrec.api, 'https://wiki.arkrec.com/v1'),
      timeoutMs: intIn(arkrec.timeoutMs, 15000, 2000, 60000),
      cacheTtlHours: intIn(arkrec.cacheTtlHours, 168, 1, 24 * 30),
    },
    rogue: {
      theme: enumOr(rogue.theme, 'Sarkaz', ROGUE_THEMES),
      mode: enumOr(rogue.mode, 'Exp', ROGUE_MODES),
      startsCount: intIn(rogue.startsCount, 9999, 1, 100000),
    },
    push: {
      from: trimmed(push.from),
      maxStages: intIn(push.maxStages, 10, 1, 200),
      stopOnNoSolution: boolOr(push.stopOnNoSolution, true),
      maxConsecutiveFailures: intIn(push.maxConsecutiveFailures, 2, 1, 20),
      skipLedgerFullStar: boolOr(push.skipLedgerFullStar, true),
    },
  };
}

/**
 * 把配置里的空路径替换成实际默认路径。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @returns {{ userDir: string, ledgerFile: string, copilotCacheDir: string, arkrecCacheDir: string }} 绝对路径。
 */
export function resolvePaths(config) {
  return {
    userDir: config.userDir !== '' ? config.userDir : defaultUserDir(),
    ledgerFile: config.ledgerFile !== '' ? config.ledgerFile : defaultLedgerFile(),
    copilotCacheDir: config.copilot.cacheDir !== '' ? config.copilot.cacheDir : defaultCopilotCacheDir(),
    arkrecCacheDir: defaultArkrecCacheDir(),
  };
}

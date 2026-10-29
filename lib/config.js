/**
 * 配置归一化与默认路径（契约见 docs/contracts.md，配置项见 cordis.patch.yml）。
 *
 * 本插件不导出 Cordis `Config`：包通过 `link:` 安装在 DSH 安装作用域之外，不能 import
 * `@deepseek-ai/*`，所以由这里的 `normalizeConfig` 兜底 —— 写错的字段回退默认值，
 * 而不是让整个插件装不上。
 *
 * v2（1.0.0）在 v1 基础上新增 safety / daily / box / history / penguin / activity /
 * startup 等段；所有 v1 键保持原义，旧配置文件不需要改也能跑。
 *
 * @module @local/arknights/config
 */

import os from 'node:os';
import path from 'node:path';

import {
  DIFFICULTIES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  ROGUE_MODES,
  ROGUE_THEMES,
  TOUCH_MODES,
} from './contracts.js';

export { PLUGIN_VERSION, PROTOCOL_VERSION, DIFFICULTIES, TOUCH_MODES, ROGUE_THEMES, ROGUE_MODES };

/** 每日任务可选项。 */
export const DAILY_TASKS = ['award', 'mall', 'infrast', 'recruit', 'box'];
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

/** 取字符串数组（去空、去重、截断）。 */
function stringArray(value, limit = 40) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = trimmed(item);
    if (text === '' || out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** `%LOCALAPPDATA%\dsh-arknights`；拿不到环境变量时回退家目录。 */
function localBase() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights');
}

/**
 * 默认 userDir：`%LOCALAPPDATA%\dsh-arknights\maa`。
 * @returns {string} 绝对路径。
 */
export function defaultUserDir() {
  return path.join(localBase(), 'maa');
}

/**
 * 默认账本文件。
 * @returns {string} 绝对路径。
 */
export function defaultLedgerFile() {
  return path.join(localBase(), 'progress.json');
}

/**
 * 默认作业缓存目录。
 * @returns {string} 绝对路径。
 */
export function defaultCopilotCacheDir() {
  return path.join(localBase(), 'copilot');
}

/**
 * 默认 ArkRec 缓存目录。
 * @returns {string} 绝对路径。
 */
export function defaultArkrecCacheDir() {
  return path.join(localBase(), 'arkrec');
}

/**
 * 默认数据缓存目录。
 * @returns {string} 绝对路径。
 */
export function defaultDataCacheDir() {
  return path.join(localBase(), 'cache');
}

/**
 * 默认仓库/干员快照文件。
 * @returns {string} 绝对路径。
 */
export function defaultBoxFile() {
  return path.join(localBase(), 'box.json');
}

/**
 * 默认运行历史文件。
 * @returns {string} 绝对路径。
 */
export function defaultHistoryFile() {
  return path.join(localBase(), 'history.jsonl');
}

/**
 * 默认截图目录。
 * @returns {string} 绝对路径。
 */
export function defaultScreenshotDir() {
  return path.join(localBase(), 'shots');
}

/**
 * 默认 penguin-stats 缓存目录。
 * @returns {string} 绝对路径。
 */
export function defaultPenguinCacheDir() {
  return path.join(localBase(), 'cache', 'penguin');
}

/**
 * 默认活动日历缓存文件。
 * @returns {string} 绝对路径。
 */
export function defaultActivityCacheFile() {
  return path.join(localBase(), 'cache', 'activity.json');
}

/**
 * 把 loader 传来的配置收进合法范围。
 * @param {unknown} raw - cordis.patch.yml 里 `config` 的内容。
 * @returns {Record<string, any>} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  const base = objectOr(raw);
  const emulator = objectOr(base.emulator);
  const copilot = objectOr(base.copilot);
  const arkrec = objectOr(base.arkrec);
  const rogue = objectOr(base.rogue);
  const push = objectOr(base.push);
  const safety = objectOr(base.safety);
  const daily = objectOr(base.daily);
  const box = objectOr(base.box);
  const history = objectOr(base.history);
  const penguin = objectOr(base.penguin);
  const activity = objectOr(base.activity);
  const startup = objectOr(base.startup);
  const dailyTasks = stringArray(daily.tasks, 10).filter((task) => DAILY_TASKS.includes(task));

  return {
    // —— 路径（空串=自动探测，见 lib/detect.js）——
    maaPath: trimmed(base.maaPath),
    pythonPath: trimmed(base.pythonPath),
    userDir: trimmed(base.userDir),
    adbPath: trimmed(base.adbPath),
    address: trimmed(base.address),
    ledgerFile: trimmed(base.ledgerFile),
    cacheDir: trimmed(base.cacheDir),
    connectionConfig: textOr(base.connectionConfig, 'MuMuEmulator12'),
    clientType: textOr(base.clientType, 'Official'),
    touchMode: enumOr(base.touchMode, 'minitouch', TOUCH_MODES),
    deploymentWithPause: boolOr(base.deploymentWithPause, false),
    gpuOcr: textOr(base.gpuOcr, 'auto'),
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
    startup: {
      enabled: boolOr(startup.enabled, true),
      startGameEnabled: boolOr(startup.startGameEnabled, true),
      timeoutMs: intIn(startup.timeoutMs, 300000, 10000, 900000),
    },
    safety: {
      allowSanityPotion: boolOr(safety.allowSanityPotion, false),
      allowOriginitePrime: boolOr(safety.allowOriginitePrime, false),
      allowRecruitPermits: boolOr(safety.allowRecruitPermits, false),
      allowExpedite: boolOr(safety.allowExpedite, false),
    },
    copilot: {
      enabled: boolOr(copilot.enabled, true),
      api: textOr(copilot.api, 'https://prts.maa.plus'),
      timeoutMs: intIn(copilot.timeoutMs, 15000, 2000, 60000),
      maxCandidates: intIn(copilot.maxCandidates, 20, 1, 100),
      maxSolutionsPerStage: intIn(copilot.maxSolutionsPerStage, 3, 1, 20),
      allowBorrowedOper: boolOr(copilot.allowBorrowedOper, false),
      ignoreRequirements: boolOr(copilot.ignoreRequirements, true),
      cacheDir: trimmed(copilot.cacheDir),
    },
    arkrec: {
      enabled: boolOr(arkrec.enabled, true),
      api: textOr(arkrec.api, 'https://wiki.arkrec.com/v1'),
      timeoutMs: intIn(arkrec.timeoutMs, 15000, 2000, 60000),
      cacheTtlHours: intIn(arkrec.cacheTtlHours, 168, 1, 24 * 30),
    },
    penguin: {
      enabled: boolOr(penguin.enabled, true),
      api: textOr(penguin.api, 'https://penguin-stats.cn'),
      timeoutMs: intIn(penguin.timeoutMs, 15000, 2000, 60000),
      cacheTtlHours: intIn(penguin.cacheTtlHours, 168, 1, 24 * 30),
    },
    activity: {
      enabled: boolOr(activity.enabled, true),
      api: textOr(activity.api, 'https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json'),
      timeoutMs: intIn(activity.timeoutMs, 15000, 2000, 60000),
      cacheTtlHours: intIn(activity.cacheTtlHours, 6, 1, 24 * 30),
    },
    rogue: {
      theme: enumOr(rogue.theme, 'Sarkaz', ROGUE_THEMES),
      mode: enumOr(rogue.mode, 'Exp', ROGUE_MODES),
      startsCount: intIn(rogue.startsCount, 9999, 1, 100000),
      squad: trimmed(rogue.squad),
      roles: trimmed(rogue.roles),
      coreChars: stringArray(rogue.coreChars, 3),
      difficulty: intIn(rogue.difficulty, -1, -1, 30),
      params: objectOr(rogue.params),
    },
    push: {
      from: trimmed(push.from),
      maxStages: intIn(push.maxStages, 10, 1, 200),
      stopOnNoSolution: boolOr(push.stopOnNoSolution, true),
      maxConsecutiveFailures: intIn(push.maxConsecutiveFailures, 2, 1, 20),
      skipLedgerFullStar: boolOr(push.skipLedgerFullStar, true),
    },
    daily: {
      tasks: dailyTasks.length > 0 ? dailyTasks : ['award', 'mall', 'infrast'],
      skipDone: boolOr(daily.skipDone, true),
      award: objectOr(daily.award),
      mall: objectOr(daily.mall),
      infrast: objectOr(daily.infrast),
      recruit: objectOr(daily.recruit),
      box: objectOr(daily.box),
    },
    box: {
      file: trimmed(box.file),
      operboxTimeoutMs: intIn(box.operboxTimeoutMs, 1200000, 30000, 3600000),
      depotTimeoutMs: intIn(box.depotTimeoutMs, 1200000, 30000, 3600000),
    },
    history: {
      file: trimmed(history.file),
      maxEntries: intIn(history.maxEntries, 200, 10, 5000),
    },
  };
}

/**
 * 把配置里的空路径替换成实际默认路径。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @returns {{ userDir: string, ledgerFile: string, copilotCacheDir: string, arkrecCacheDir: string,
 *   dataCacheDir: string, boxFile: string, historyFile: string, screenshotDir: string,
 *   penguinCacheDir: string, activityCacheFile: string }} 绝对路径。
 */
export function resolvePaths(config) {
  const dataCacheDir = config.cacheDir !== '' ? config.cacheDir : defaultDataCacheDir();
  return {
    userDir: config.userDir !== '' ? config.userDir : defaultUserDir(),
    ledgerFile: config.ledgerFile !== '' ? config.ledgerFile : defaultLedgerFile(),
    copilotCacheDir: config.copilot.cacheDir !== '' ? config.copilot.cacheDir : defaultCopilotCacheDir(),
    arkrecCacheDir: defaultArkrecCacheDir(),
    dataCacheDir,
    boxFile: config.box.file !== '' ? config.box.file : defaultBoxFile(),
    historyFile: config.history.file !== '' ? config.history.file : defaultHistoryFile(),
    screenshotDir: defaultScreenshotDir(),
    penguinCacheDir: path.join(dataCacheDir, 'penguin'),
    activityCacheFile: path.join(dataCacheDir, 'activity.json'),
  };
}

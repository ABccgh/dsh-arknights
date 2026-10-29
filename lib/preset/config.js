/**
 * 预设作用域插件的配置归一（与全局插件分开：这里只关心「现场排查 + 作业站」需要的路径）。
 *
 * 空串 = 自动探测（复用 `lib/detect.js`），所以默认配置零填写即可用。
 *
 * 1.0.0 起预设只暴露 2 个工具（`ark_diag` / `ark_solutions`），因此配置里不再有
 * 账本 / ArkRec 这类只有全局插件才用的键；`copilot` 仍然保留（`ark_solutions` 要查作业站）。
 *
 * @module @local/arknights/preset/config
 */

import os from 'node:os';
import path from 'node:path';

/** 预设作用域插件的版本（与 docs/contracts.md §13 一致）。 */
export const PRESET_VERSION = '1.0.0';

/** 只保留非空字符串。 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取非空字符串，否则回退。 */
function textOr(value, fallback) {
  const text = trimmed(value);
  return text === '' ? fallback : text;
}

/** 取有界整数。 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** 取字符串数组（去空、去重）；空数组回退。 */
function listOr(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const item of value) {
    const text = trimmed(item);
    if (text !== '' && !out.includes(text)) out.push(text);
  }
  return out.length > 0 ? out : [...fallback];
}

/** 默认截图目录：`%TEMP%\dsh-arknights\shots`。 */
export function defaultScreenshotDir() {
  return path.join(os.tmpdir(), 'dsh-arknights', 'shots');
}

/** 默认 MAA userDir：`%LOCALAPPDATA%\dsh-arknights\maa`（日志在它的 debug/ 下）。 */
export function defaultUserDir() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-arknights', 'maa');
}

/** 默认作业站接口。 */
const DEFAULT_COPILOT_API = 'https://prts.maa.plus';
/** 默认白名单：方舟工具、PRTS wiki、键鼠/截图（真机排查会用到）。 */
const DEFAULT_ALLOW = ['ark_', 'prts_', 'input_'];

/**
 * 把 patch 里的 `config` 收进合法范围。
 * @param {unknown} raw - 预设子行的 config。
 * @returns {Record<string, any>} 生效配置。
 */
export function normalizePresetConfig(raw = {}) {
  const base = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const copilot = base.copilot !== null && typeof base.copilot === 'object' ? base.copilot : {};
  return {
    maaPath: trimmed(base.maaPath),
    userDir: trimmed(base.userDir),
    pythonPath: trimmed(base.pythonPath),
    adbPath: trimmed(base.adbPath),
    address: trimmed(base.address),
    mumuInstallPath: trimmed(base.mumuInstallPath),
    managerPath: trimmed(base.managerPath),
    vmIndex: intIn(base.vmIndex, 0, 0, 64),
    logFile: trimmed(base.logFile),
    screenshotDir: trimmed(base.screenshotDir),
    maxScreenshots: intIn(base.maxScreenshots, 20, 1, 200),
    maxLogLines: intIn(base.maxLogLines, 400, 10, 5000),
    clientType: textOr(base.clientType, 'Official'),
    launchTimeoutMs: intIn(base.launchTimeoutMs, 120000, 10000, 600000),
    allowGlobalToolPrefixes: listOr(base.allowGlobalToolPrefixes, DEFAULT_ALLOW),
    copilot: {
      api: textOr(copilot.api, DEFAULT_COPILOT_API),
      timeoutMs: intIn(copilot.timeoutMs, 15000, 2000, 60000),
      maxCandidates: intIn(copilot.maxCandidates, 20, 1, 100),
    },
  };
}

/**
 * 把空路径补成默认值。
 * @param {ReturnType<typeof normalizePresetConfig>} config - 生效配置。
 * @returns {{ userDir: string, logFile: string, screenshotDir: string, copilotCacheDir: string }} 绝对路径。
 */
export function resolvePresetPaths(config) {
  const userDir = config.userDir !== '' ? config.userDir : defaultUserDir();
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return {
    userDir,
    logFile: config.logFile !== '' ? config.logFile : path.join(userDir, 'debug', 'asst.log'),
    screenshotDir: config.screenshotDir !== '' ? config.screenshotDir : defaultScreenshotDir(),
    copilotCacheDir: path.join(base, 'dsh-arknights', 'copilot'),
  };
}

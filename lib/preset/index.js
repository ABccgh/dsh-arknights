/**
 * 预设作用域入口：给「明日方舟」智能体注册 2 个辅助工具，并屏蔽与方舟无关的全局工具。
 *
 * 与全局插件（`@local/arknights` 的 `lib/index.js`）的分工：
 * - 全局：13 个动作/资料工具 + 面板 + `/ark` 命令 + 状态路由（所有会话可见）；
 * - 本文件：只在预设会话里出现的 2 个**现场排查 / 作业站**工具
 *   （`ark_diag` / `ark_solutions`），全部走 adb / MuMuManager / 本地文件 / 作业站 HTTP，
 *   **不持有 MaaCore 会话**，因此不会与全局插件抢实例。
 *
 * 三条硬约束（与 ck3moddev 相同，踩过坑）：
 * 1. 不 import 任何 `@deepseek-ai/*`（link 安装的 bundle 在 DSH 安装作用域之外）；
 * 2. `apply` 不返回值（Cordis 会把返回值当 effect 收集）；
 * 3. 所有注册走 `ctx.effect`；定时器用全局 `setTimeout`（`ctx.setTimeout` 需要 inject timer，会抛）。
 *
 * @module @local/arknights/preset
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCopilot } from '../copilot.js';
import { findAdb, findMaaPath, findMuMu, findPython, probeEmulator, readVmConfig } from '../detect.js';
import { normalizePresetConfig, PRESET_VERSION, resolvePresetPaths } from './config.js';
import { runAdb, runCli, runCliBuffer, sleep } from './shared.js';
import { createDiagTools } from './tools/diag.js';
import { createSolutionsTools } from './tools/solutions.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'arknights-preset';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 基础探测（MAA / MuMu / adb / 模拟器三态；不碰 Python、不启动任何东西）。
 * @param {ReturnType<typeof normalizePresetConfig>} config - 生效配置。
 * @param {{ fresh?: boolean }} [options] - 是否绕过模拟器探测的短缓存。
 * @returns {Promise<Record<string, any>>} 探测结果（`pythonPath` 为空串）。
 */
async function detectBase(config, options = {}) {
  const maa = await findMaaPath({ maaPath: config.maaPath });
  const mumu = await findMuMu({ emulator: { installPath: config.mumuInstallPath, managerPath: config.managerPath } });
  const vm = mumu.path !== '' ? await readVmConfig(mumu.path, config.vmIndex) : null;
  const adb = await findAdb({ adbPath: config.adbPath }, { mumuInstallPath: mumu.path, maaPath: maa.path });
  const vmIndex = vm?.vmIndex ?? config.vmIndex;
  const address = config.address !== '' ? config.address : `127.0.0.1:${vm?.adbPort ?? 16384}`;
  const emulator = await probeEmulator(
    { managerPath: mumu.managerPath, vmIndex, adbPath: adb.path, address },
    { fresh: options.fresh === true },
  );
  return {
    maaPath: maa.path,
    maaTried: maa.tried,
    mumuInstallPath: mumu.path,
    managerPath: mumu.managerPath,
    mumuTried: mumu.tried,
    vmConfig: vm,
    vmIndex,
    adbPath: adb.path,
    adbTried: adb.tried,
    address,
    emulator,
    pythonPath: '',
    pythonVersion: '',
    pythonTried: [],
  };
}

/**
 * 组装依赖（`overrides` 是测试接缝：可注入 detect / run / copilot / sleep / logger / reportFile）。
 * @param {unknown} rawConfig - 预设子行 config。
 * @param {Record<string, any>} [overrides] - 测试接缝。
 * @returns {Record<string, any>} 依赖对象。
 */
export function createDeps(rawConfig, overrides = {}) {
  const config = normalizePresetConfig(rawConfig);
  const paths = resolvePresetPaths(config);
  const logger = overrides.logger;
  /** @type {Record<string, any> | null} 基础探测缓存。 */
  let cachedBase = null;
  /** @type {{ path: string, version: string, tried: string[] } | null} Python 探测缓存。 */
  let cachedPython = null;

  /**
   * 探测环境；`includePython` 为 true 时才额外探测 Python（`ark_diag action=probe` 用）。
   * 默认不探 Python：它要 spawn 解释器，放在每次抓图/查作业的路径上没必要。
   * @param {{ fresh?: boolean, includePython?: boolean }} [input] - 选项。
   * @returns {Promise<Record<string, any>>} 探测结果。
   */
  const detect = async (input = {}) => {
    const fresh = input.fresh === true;
    const includePython = input.includePython === true;
    if (fresh || cachedBase === null) cachedBase = await detectBase(config, { fresh });
    if (includePython && (fresh || cachedPython === null)) {
      const finder = typeof overrides.findPython === 'function' ? overrides.findPython : findPython;
      cachedPython = await finder({ pythonPath: config.pythonPath });
    }
    return {
      ...cachedBase,
      pythonPath: cachedPython?.path ?? '',
      pythonVersion: cachedPython?.version ?? '',
      pythonTried: cachedPython?.tried ?? [],
    };
  };

  const copilot = overrides.copilot ?? createCopilot({
    api: config.copilot.api,
    timeoutMs: config.copilot.timeoutMs,
    maxCandidates: config.copilot.maxCandidates,
    maxSolutionsPerStage: 20,
    allowBorrowedOper: true,
    cacheDir: paths.copilotCacheDir,
    logger,
    ...(typeof overrides.fetchImpl === 'function' ? { fetchImpl: overrides.fetchImpl } : {}),
  });

  return {
    config,
    paths,
    detect: overrides.detect ?? detect,
    run: overrides.run ?? { cli: runCli, cliBuffer: runCliBuffer, adb: runAdb },
    sleep: overrides.sleep ?? sleep,
    copilot,
    logger,
  };
}

/**
 * 造全部工具定义（顺序即工具表顺序，与 lib/contracts.js 的 PRESET_TOOL_NAMES 一致）。
 * @param {ReturnType<typeof createDeps>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createTools(deps) {
  return [
    ...createDiagTools(deps),
    ...createSolutionsTools(deps),
  ];
}

/**
 * 在预设作用域内屏蔽与方舟无关的全局工具。
 *
 * 只 deny **确实存在**的工具名（`restrict` 遇到未知名字会抛），先读 `ctx.tools.schemas()` 求差集；
 * 预设是急切激活的，Host 工具可能还没注册完，2 秒后再补一次（restrictions 取交集，重复无害）。
 * @param {any} ctx - 插件上下文。
 * @param {ReturnType<typeof normalizePresetConfig>} config - 生效配置。
 * @returns {{ skip: boolean, deny: () => string[] }} 诊断信息。
 */
export function installGlobalToolMask(ctx, config) {
  const prefixes = config.allowGlobalToolPrefixes;
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[arknights-preset] ${message}`);
    } catch {
      // 日志失败不影响插件。
    }
  };

  let lastDeny = [];
  if (!Array.isArray(prefixes) || prefixes.length === 0) return { skip: true, deny: () => lastDeny };

  const computeDeny = () => {
    let schemas;
    try {
      schemas = ctx.tools.schemas();
    } catch (error) {
      log('warn', `读取工具表失败，跳过屏蔽：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!Array.isArray(schemas)) return null;
    const names = schemas
      .map((schema) => String(schema?.name ?? ''))
      .filter((toolName) => toolName !== '' && toolName !== 'run_code');
    return names.filter((toolName) => !prefixes.some((prefix) => toolName.startsWith(prefix)));
  };

  const applyMask = () => {
    const deny = computeDeny();
    if (deny === null || deny.length === 0) return undefined;
    try {
      lastDeny = deny;
      log('info', `在方舟会话内隐藏 ${deny.length} 个无关工具（保留 ${prefixes.join(' / ')}）。`);
      return ctx.tools.restrict({ deny });
    } catch (error) {
      log('warn', `屏蔽工具失败（不影响工具本身）：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();
  effect(() => applyMask());
  effect(() => {
    const handle = setTimeout(() => applyMask(), 2000);
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearTimeout(handle);
  });
  return { skip: false, deny: () => lastDeny };
}

/**
 * 激活现场的默认路径（`%TEMP%\arknights-preset-activation.json`）。
 * @returns {string} 绝对路径。
 */
export function activationReportFile() {
  return path.join(os.tmpdir(), 'arknights-preset-activation.json');
}

/**
 * 写激活现场（预设激活失败时客户端只显示 broken，这是唯一可外部读取的现场）。
 *
 * 测试里 `NODE_TEST_CONTEXT` 存在且没显式给 `file` 时跳过，避免 node --test 覆盖真实现场。
 * @param {Record<string, unknown>} payload - 报告内容。
 * @param {{ file?: string }} [options] - 指定文件（测试接缝）。
 * @returns {string | null} 实际写入路径；跳过或失败为 null。
 */
export function writeActivationReport(payload, options = {}) {
  const explicit = typeof options.file === 'string' && options.file !== '';
  if (!explicit && process.env.NODE_TEST_CONTEXT !== undefined) return null;
  const file = explicit ? options.file : activationReportFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const report = { presetVersion: PRESET_VERSION, at: new Date().toISOString(), ...payload };
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 装配插件。
 * @param {any} ctx - Cordis 上下文（硬依赖 `tools`）。
 * @param {Record<string, unknown>} config - 预设子行 config。
 * @param {Record<string, any>} [overrides] - 测试接缝。
 * @returns {Promise<void>} 无。**不要返回任何值**。
 */
export async function apply(ctx, config, overrides = {}) {
  let registered = [];
  try {
    const deps = createDeps(config, { ...overrides, logger: overrides.logger ?? ctx.logger });
    const tools = createTools(deps);
    const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();
    for (const definition of tools) effect(() => ctx.tools.register(definition));
    registered = tools.map((tool) => tool.name);

    const mask = installGlobalToolMask(ctx, deps.config);
    try {
      ctx.logger?.info?.(
        `[arknights-preset] 就绪：${tools.length} 个工具（${registered.join(', ')}）；`
        + `MAA ${deps.config.maaPath || '自动探测'}；`
        + (mask.skip ? '未配置白名单，跳过屏蔽。' : `保留前缀 ${deps.config.allowGlobalToolPrefixes.join(' / ')}。`),
      );
    } catch {
      // 日志不可用无所谓。
    }
    writeActivationReport({
      ok: true,
      tools: registered,
      allowGlobalToolPrefixes: deps.config.allowGlobalToolPrefixes,
      maskedGlobals: mask.deny(),
    }, { file: overrides.reportFile });
  } catch (error) {
    writeActivationReport({
      ok: false,
      tools: registered,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }, { file: overrides.reportFile });
    throw error;
  }
}

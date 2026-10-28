/**
 * 预设作用域入口：给「明日方舟」智能体注册 7 个辅助工具，并屏蔽与方舟无关的全局工具。
 *
 * 与全局插件（`@local/arknights` 的 `lib/index.js`）的分工：
 * - 全局：5 个打关卡工具 + 面板 + `/ark` 命令 + 状态路由（所有会话可见）；
 * - 本文件：只在预设会话里出现的**查询/排查**工具，全部走 adb / MuMuManager / 本地文件，
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

import { createArkrec } from '../arkrec.js';
import { createCopilot } from '../copilot.js';
import { findAdb, findMaaPath, findMuMu, probeEmulator, readVmConfig } from '../detect.js';
import { createLedger } from '../ledger.js';
import { normalizePresetConfig, PRESET_VERSION, resolvePresetPaths } from './config.js';
import { runAdb, runCli, runCliBuffer } from './shared.js';
import { createDeviceTools } from './tools/device.js';
import { createEmulatorTools } from './tools/emulator.js';
import { createGameTools } from './tools/game.js';
import { createLogsTools } from './tools/logs.js';
import { createScreenTools } from './tools/screen.js';
import { createSolutionsTools } from './tools/solutions.js';
import { createStagesTools } from './tools/stages.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'arknights-preset';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 组装依赖（`overrides` 是测试接缝：可注入 detect / copilot / arkrec / ledger / logger）。
 * @param {unknown} rawConfig - 预设子行 config。
 * @param {Record<string, any>} [overrides] - 测试接缝。
 * @returns {Record<string, any>} 依赖对象。
 */
export function createDeps(rawConfig, overrides = {}) {
  const config = normalizePresetConfig(rawConfig);
  const paths = resolvePresetPaths(config);
  const logger = overrides.logger;
  /** @type {Record<string, any> | null} */
  let cached = null;

  /**
   * 探测 MAA / MuMu / adb（不碰 Python，也不需要 MaaCore 会话）。
   * @param {{ fresh?: boolean }} [input] - 是否强制重探。
   * @returns {Promise<Record<string, any>>} 探测结果。
   */
  const detect = async (input = {}) => {
    const fresh = input.fresh === true;
    if (!fresh && cached !== null) return cached;
    const maa = await findMaaPath({ maaPath: config.maaPath });
    const mumu = await findMuMu({ emulator: { installPath: config.mumuInstallPath, managerPath: config.managerPath } });
    const vm = mumu.path !== '' ? await readVmConfig(mumu.path, config.vmIndex) : null;
    const adb = await findAdb({ adbPath: config.adbPath }, { mumuInstallPath: mumu.path, maaPath: maa.path });
    const vmIndex = vm?.vmIndex ?? config.vmIndex;
    const address = config.address !== '' ? config.address : `127.0.0.1:${vm?.adbPort ?? 16384}`;
    const emulator = await probeEmulator(
      { managerPath: mumu.managerPath, vmIndex, adbPath: adb.path, address },
      { fresh },
    );
    cached = {
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
    };
    return cached;
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
  const arkrec = overrides.arkrec ?? createArkrec({
    api: config.arkrec.api,
    timeoutMs: config.arkrec.timeoutMs,
    cacheTtlHours: config.arkrec.cacheTtlHours,
    cacheDir: paths.arkrecCacheDir,
    logger,
    ...(typeof overrides.fetchImpl === 'function' ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  const ledger = overrides.ledger ?? createLedger({ file: paths.ledgerFile, logger });

  return {
    config,
    paths,
    detect: overrides.detect ?? detect,
    run: overrides.run ?? { cli: runCli, cliBuffer: runCliBuffer, adb: runAdb },
    copilot,
    arkrec,
    ledger,
    logger,
  };
}

/**
 * 造全部工具定义（顺序即工具表顺序）。
 * @param {ReturnType<typeof createDeps>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createTools(deps) {
  return [
    ...createStagesTools(deps),
    ...createSolutionsTools(deps),
    ...createScreenTools(deps),
    ...createDeviceTools(deps),
    ...createGameTools(deps),
    ...createEmulatorTools(deps),
    ...createLogsTools(deps),
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
 * 写激活现场（预设激活失败时客户端只显示 broken，这是唯一可外部读取的现场）。
 * @param {Record<string, unknown>} payload - 报告内容。
 * @returns {void}
 */
function writeActivationReport(payload) {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return;
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), 'arknights-preset-activation.json'),
      `${JSON.stringify({ presetVersion: PRESET_VERSION, ...payload }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 写不了报告不影响插件。
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
      at: new Date().toISOString(),
      tools: registered,
      allowGlobalToolPrefixes: deps.config.allowGlobalToolPrefixes,
      maskedGlobals: mask.deny(),
    });
  } catch (error) {
    writeActivationReport({
      ok: false,
      at: new Date().toISOString(),
      tools: registered,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw error;
  }
}

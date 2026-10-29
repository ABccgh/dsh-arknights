/**
 * 测试公共工具：临时目录、假 logger、工具调用器、可控时钟。
 *
 * 只服务于测试；不 import 任何产品状态。
 *
 * @module @local/arknights/test/helpers
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 造一个临时目录。
 * @param {string} [prefix] - 前缀。
 * @returns {string} 绝对路径。
 */
export function makeTempDir(prefix = 'dsh-arknights-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 递归删除目录（尽力而为）。
 * @param {string} dir - 目录。
 * @returns {void}
 */
export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论。
  }
}

/**
 * 捕获日志的假 logger。
 * @returns {{ info: Function, warn: Function, error: Function, entries: Array<{level:string,message:string}> }} logger。
 */
export function makeLogger() {
  const entries = [];
  const push = (level) => (message) => {
    entries.push({ level, message: String(message) });
  };
  return { info: push('info'), warn: push('warn'), error: push('error'), entries };
}

/**
 * 可控时钟：每次调用前进固定毫秒。
 * @param {{ start?: number, stepMs?: number }} [options] - 选项。
 * @returns {() => Date} 时钟。
 */
export function makeClock(options = {}) {
  let current = Number.isFinite(options.start) ? options.start : Date.parse('2026-10-29T00:00:00.000Z');
  const step = Number.isFinite(options.stepMs) ? options.stepMs : 1000;
  return () => {
    const value = new Date(current);
    current += step;
    return value;
  };
}

/**
 * 调一个工具 definition，返回原始结果。
 * @param {Array<Record<string, any>>} tools - 工具定义数组。
 * @param {string} name - 工具名。
 * @param {Record<string, any>} [args] - 参数。
 * @param {Record<string, any>} [exec] - 执行上下文。
 * @returns {Promise<{ text?: string }>} 结果。
 */
export async function callTool(tools, name, args = {}, exec = {}) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new Error(`没有工具 ${name}`);
  return definition.execute(args, exec);
}

/**
 * 读 JSON 文件（不存在返回 null）。
 * @param {string} file - 文件。
 * @returns {any} 解析结果。
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把 run store 的快照拍平成便于断言的形状。
 * @param {ReturnType<typeof import('../lib/actions/shared.js').createRunStore>} store - run store。
 * @returns {{ run: any, lastRun: any }} 快照。
 */
export function runSnapshot(store) {
  return store.snapshot();
}

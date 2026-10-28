/**
 * 预设作用域 7 个辅助工具共用的薄工具层：跑 adb / 跑 MuMuManager / 文本与字节格式化。
 *
 * 与全局插件一样**零外部依赖**（只 node:* 与自己的模块），并保持「失败给现场与建议」的风格。
 *
 * @module @local/arknights/preset/shared
 */

import { execFile } from 'node:child_process';

/**
 * 跑一个可执行文件（utf8 输出）。
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options] - 选项。
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number | null }>} 结果。
 */
export function runCli(file, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 4 * 1024 * 1024;
  return new Promise((resolve) => {
    if (typeof file !== 'string' || file === '') {
      resolve({ ok: false, stdout: '', stderr: '可执行文件路径为空', code: null });
      return;
    }
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (error ? error.message : '')),
        code: error === null || error === undefined ? 0 : (typeof error.code === 'number' ? error.code : null),
      });
    });
  });
}

/**
 * 跑一个可执行文件并拿**二进制** stdout（`adb exec-out screencap -p` 用）。
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options] - 选项。
 * @returns {Promise<{ ok: boolean, buffer: Buffer, stderr: string }>} 结果。
 */
export function runCliBuffer(file, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 32 * 1024 * 1024;
  return new Promise((resolve) => {
    if (typeof file !== 'string' || file === '') {
      resolve({ ok: false, buffer: Buffer.alloc(0), stderr: '可执行文件路径为空' });
      return;
    }
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        buffer: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8', 0, Math.min(stderr.length, 800)) : String(stderr ?? ''),
      });
    });
  });
}

/**
 * 跑一条 adb shell 命令。
 * @param {string} adbPath - adb 路径。
 * @param {string} address - `host:port`。
 * @param {string[]} command - shell 命令（如 `['shell','wm','size']`）。
 * @param {{ timeoutMs?: number }} [options] - 选项。
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>} 结果。
 */
export function runAdb(adbPath, address, command, options = {}) {
  if (typeof adbPath !== 'string' || adbPath === '' || typeof address !== 'string' || address === '') {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'adb 路径或设备地址为空' });
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  return new Promise((resolve) => {
    execFile(
      adbPath,
      ['-s', address, ...command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null || error === undefined,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (error ? error.message : '')),
        });
      },
    );
  });
}

/**
 * 人类可读的字节数。
 * @param {number} bytes - 字节数。
 * @returns {string} 文本。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 取一个在范围内的整数。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
export function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 等一会儿。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 无。
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 截断长文本（报告里用）。
 * @param {string} text - 文本。
 * @param {number} max - 上限。
 * @returns {string} 文本。
 */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断 ${value.length - max} 字符）`;
}

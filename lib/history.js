/**
 * 运行历史：`history.jsonl`，每行一个 run 信封精简版（契约 §7.3）。
 *
 * 设计取舍：
 * - 只用 append 追加，避免每次动作都重写整份文件；
 * - 超过 `maxEntries` 才整体原子重写，保留最近 N 条；
 * - 任何一行解析失败都跳过（日志文件不能因为半行损坏就整体不可用）；
 * - 写入失败只告警，绝不影响动作本身。
 *
 * @module @local/arknights/history
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from './errors.js';

/** 默认保留条数（与 config.history.maxEntries 的默认值一致）。 */
export const DEFAULT_MAX_ENTRIES = 200;
/** 每条记录里文本字段的截断长度。 */
const TEXT_LIMIT = 1000;

/** 只保留 JSON 安全的字段（去掉大数组与函数）。 */
function compactEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined || typeof value === 'function') continue;
    if (key === 'signal' || key === 'update') continue;
    // 历史只留精简版：计划/执行/事件明细/参数摘要都在面板 run 快照里，不重复落盘。
    if (key === 'planned' || key === 'executed' || key === 'events' || key === 'params') continue;
    if (key === 'text' && typeof value === 'string') {
      out.text = value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      // 不可序列化的字段丢弃。
    }
  }
  return out;
}

/**
 * 造一个运行历史对象。
 * @param {{ file: string, maxEntries?: number, logger?: { warn?: Function, info?: Function } }} options - 选项。
 * @returns {object} 历史 API：`append(entry)` / `read(limit)` / `file`。
 */
export function createHistory(options) {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : '';
  if (file === '') throw arkError('E_BAD_ARGS', 'createHistory 需要 file。');
  const logger = options.logger;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;

  /** @type {Array<Record<string, any>>} */
  let entries = [];
  let lineCount = 0;

  // 构造时同步读一遍（文件通常只有几百行，读失败就当作空历史）。
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (text === '') continue;
      lineCount += 1;
      try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
      } catch {
        // 半截/损坏的行直接跳过。
      }
    }
    if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[arknights] 运行历史读取失败，按空历史继续：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 串行化写操作，避免 append 与 rewrite 交错。 @type {Promise<void>} */
  let writeChain = Promise.resolve();
  let writeCounter = 0;

  /** 原子重写整个文件（保留最近 maxEntries 条）。 */
  const rewrite = async () => {
    const temp = `${file}.${process.pid}.${writeCounter}.tmp`;
    writeCounter += 1;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
      await fsp.writeFile(temp, body === '' ? '' : `${body}\n`, 'utf8');
      await fsp.rename(temp, file);
      lineCount = entries.length;
    } catch (error) {
      try {
        await fsp.rm(temp, { force: true });
      } catch {
        // 忽略清理失败。
      }
      logger?.warn?.(`[arknights] 运行历史重写失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * 追加一条运行记录（自动截断大字段；超过上限时原子重写保留最近 N 条）。
   * @param {Record<string, any>} entry - run 信封。
   * @returns {Promise<void>} 无。
   */
  const append = (entry) => {
    writeChain = writeChain.then(async () => {
      const compact = compactEntry(entry);
      if (compact === null) return;
      entries.push(compact);
      const overflow = entries.length > maxEntries || lineCount >= maxEntries * 2;
      if (overflow) {
        if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
        await rewrite();
        return;
      }
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, `${JSON.stringify(compact)}\n`, 'utf8');
        lineCount += 1;
      } catch (error) {
        logger?.warn?.(`[arknights] 运行历史写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }, async () => {
      // 前面某次写入失败也不阻塞后续写入。
    });
    return writeChain;
  };

  /**
   * 读最近 N 条历史（时间正序）。
   * @param {number} [limit] - 最多几条，默认 50。
   * @returns {Promise<Array<Record<string, any>>>} 记录副本。
   */
  const read = async (limit = 50) => {
    const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 50;
    return entries.slice(Math.max(0, entries.length - count)).map((entry) => JSON.parse(JSON.stringify(entry)));
  };

  /** 强制重写一次（测试/收尾用）。 */
  const flush = () => {
    writeChain = writeChain.then(rewrite, rewrite);
    return writeChain;
  };

  return {
    append,
    read,
    flush,
    /** 内存里的条数（不含尚未落盘的追加）。 */
    count: () => entries.length,
    maxEntries,
    file,
  };
}

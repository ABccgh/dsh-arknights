/**
 * `ark_log`：读 MAA 日志尾部（`<userDir>/debug/asst.log`）。
 *
 * 排查「为什么没开打」最有效的一步：MAA 会在日志里写清每个子任务在等什么
 * （本轮的「理智不足」「作业缺 actions」「找不到开始按钮」都是这样定位的）。
 *
 * @module @local/arknights/preset/tools/logs
 */

import fsp from 'node:fs/promises';

import { arkError, describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { formatBytes, intIn, truncate } from '../shared.js';

/** 日志级别匹配。 */
const LEVEL_PATTERNS = {
  error: /\[(ERR|FTL)\]/,
  warn: /\[(WRN|ERR|FTL)\]/,
};

/**
 * 造 `ark_log`。
 * @param {object} deps - 依赖（config / paths）。
 * @returns {object[]} 工具定义。
 */
export function createLogsTools(deps) {
  return [
    defineTool({
      name: 'ark_log',
      description:
        '读 MAA 日志（asst.log）的最后若干行，可按级别过滤（error=错误/致命，warn=警告及以上）。用于排查「为什么没开打」「卡在哪个识别」——比猜测可靠。只读。',
      parameters: {
        lines: {
          type: 'integer',
          description: '最多返回多少行，默认 80，上限 400。',
        },
        level: {
          type: 'string',
          enum: ['all', 'warn', 'error'],
          description: 'all（默认）/ warn（WRN 及以上）/ error（ERR/FTL）。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const lines = intIn(args.lines, 80, 1, deps.config.maxLogLines);
          const level = typeof args.level === 'string' && args.level !== '' ? args.level : 'all';
          const file = deps.paths.logFile;
          let stat;
          try {
            stat = await fsp.stat(file);
          } catch {
            throw arkError('E_BAD_ARGS', `还没有日志文件：${file}`, {
              hint: '先让 MAA 跑一次任务（ark_fight 会启动侧车），日志就会生成；也可以在配置里用 logFile 指定路径。',
            });
          }
          const raw = await fsp.readFile(file, 'utf8');
          const all = raw.split(/\r?\n/).filter((line) => line !== '');
          const pattern = LEVEL_PATTERNS[level];
          const filtered = pattern === undefined ? all : all.filter((line) => pattern.test(line));
          const tail = filtered.slice(-lines);
          const head = [
            `日志：${file}（${formatBytes(stat.size)}，更新于 ${stat.mtime.toISOString()}）`,
            `筛选：${level} · 匹配 ${filtered.length} 行 · 显示最后 ${tail.length} 行`,
            '',
          ];
          if (tail.length === 0) head.push(`（${level} 过滤后没有匹配行）`);
          return text(truncate([...head, ...tail].join('\n'), 20000));
        } catch (error) {
          return text(`读取日志失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

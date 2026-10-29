/**
 * 工具层共享件：统一的文本输出、错误收口、常用参数 spec。
 *
 * 所有 `ark_*` 工具都返回一段有界中文文本（见 docs/contracts.md §工具输出）；
 * 面板/自动化需要结构化数据时走 HTTP，而不是让模型读 JSON。
 *
 * @module @local/arknights/tools/shared
 */

import { TEXT_OUTPUT, defineTool } from '../tool-kit.js';
import { describeError } from '../errors.js';

/** 通用 `confirm` 参数。 */
export const CONFIRM_PARAM = {
  type: 'boolean',
  description: '是否确认执行。默认 false 只返回计划（零消耗）；确认无误后传 true 才真正执行。',
};

/** 通用 `difficulty` 参数。 */
export const DIFFICULTY_PARAM = {
  type: 'string',
  enum: ['auto', 'easy', 'tough'],
  description: '难度：auto（默认，优先标准/常规）、easy（标准/常规）、tough（磨难/险地/突袭）。tough 会加 MAA 的 -HARD 后缀；抄作业同时带 is_raid 与 nav_name_override。',
};

/** 通用 `medicine` 参数。 */
export const MEDICINE_PARAM = {
  type: 'integer',
  description: '允许使用的理智药数量，默认 0。默认配置下 >0 会被安全闸拒绝，需用户明确同意并打开 safety.allowSanityPotion。',
};

/** 通用 `stone` 参数。 */
export const STONE_PARAM = {
  type: 'integer',
  description: '允许碎石的数量，默认 0。默认配置下 >0 会被安全闸拒绝，需用户明确同意并打开 safety.allowOriginitePrime。',
};

/** 通用 `times` 参数。 */
export const TIMES_PARAM = {
  type: 'integer',
  description: '每关打几次，默认 1。严格按给定次数执行，不自动加次数。',
};

/**
 * 定义一个 `ark_*` 工具：文本输出 + 异常收口。
 * @param {{ name: string, description: string, parameters?: Record<string, any>,
 *   execute: (args: Record<string, any>, exec: any) => Promise<string | { text: string }>,
 *   concurrencySafe?: boolean, timeoutMs?: number, failurePrefix?: string }} spec - 工具规格。
 * @returns {object} 工具 definition。
 */
export function defineArkTool(spec) {
  if (typeof spec?.execute !== 'function') throw new TypeError(`工具 ${spec?.name} 缺少 execute`);
  const definition = defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? {},
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const value = await spec.execute(args, exec);
        return typeof value === 'string' ? { text: value } : { text: String(value?.text ?? '') };
      } catch (error) {
        const prefix = typeof spec.failurePrefix === 'string' && spec.failurePrefix !== '' ? `${spec.failurePrefix}\n` : '';
        return { text: `${prefix}${describeError(error)}` };
      }
    },
  });
  definition.isConcurrencySafe = () => spec.concurrencySafe === true;
  if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) definition.timeoutMs = spec.timeoutMs;
  return definition;
}

/**
 * 把多行内容收成一段文本（去空行、保留顺序）。
 * @param {Array<string | false | null | undefined>} lines - 行。
 * @returns {string} 文本。
 */
export function lines(...lines) {
  return lines.flat().filter((line) => typeof line === 'string' && line !== '').join('\n');
}

/**
 * 统一的错误文本（工具内兜底用）。
 * @param {unknown} error - 错误。
 * @param {string} [prefix] - 前缀。
 * @returns {string} 文本。
 */
export function errorText(error, prefix = '') {
  const body = describeError(error);
  return prefix === '' ? body : `${prefix}\n${body}`;
}

/**
 * 把布尔值渲染成中文。
 * @param {boolean | undefined} value - 值。
 * @returns {string} `是`/`否`/`未知`。
 */
export function yesNo(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  return '未知';
}

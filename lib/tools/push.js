/**
 * `ark_push`：按主线顺序推关（打未满星/被锁的关，直到进度边界）。
 *
 * @module @local/arknights/tools/push
 */

import { describeError } from '../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../tool-kit.js';

/**
 * 造 `ark_push`。
 * @param {object} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createPushTools(deps) {
  return [
    defineTool({
      name: 'ark_push',
      description:
        '按主线关卡顺序推关：从起点开始一关接一关打（先试代理指挥，没有代理指挥就抄作业），账本里已满星的关自动跳过；遇到还没解锁的关就停下并回报「已推到哪里」。默认先返回计划（要推哪几关、预计理智），必须再传 confirm=true 才会真的消耗理智开推。',
      parameters: {
        from: {
          type: 'string',
          description: '起点关卡代码，例如 "5-3" 或 "10-1"。不填则用账本里记录的推关进度，其次用配置里的 push.from。',
        },
        chapter: {
          type: 'integer',
          description: '可选：只推某一章（例如 5），与 from 同时给时以 from 为起点、并且只推这一章。',
        },
        maxStages: {
          type: 'integer',
          description: '本次最多推几关，默认取配置 push.maxStages（10），上限 200。',
        },
        confirm: {
          type: 'boolean',
          description: '是否确认执行。默认 false 只返回计划；确认后传 true 才真正开推。',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          const result = await deps.actions.push(args);
          return text(result.text);
        } catch (error) {
          return text(`推关失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

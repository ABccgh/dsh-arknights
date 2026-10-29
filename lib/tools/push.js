/**
 * `ark_push`：按主线顺序推关（一关接一关，遇到进度边界停下）。
 *
 * @module @local/arknights/tools/push
 */

import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** `ark_push` 名称。 */
export const PUSH_TOOL_NAME = 'ark_push';

/**
 * 造 `ark_push`。
 * @param {{ actions: { push: (params: Record<string, any>) => Promise<Record<string, any>> } }} deps - 依赖。
 * @returns {object} 工具 definition。
 */
export function createPushTool(deps) {
  const action = deps?.actions?.push;
  if (typeof action !== 'function') throw new TypeError('ark_push 需要 deps.actions.push');
  return defineArkTool({
    name: PUSH_TOOL_NAME,
    description:
      '按主线关卡顺序推关：从起点开始一关接一关打（先试代理指挥，没有代理指挥就抄作业），账本里已满星的关自动跳过；遇到还没解锁的关就停下并回报「已推到哪里」，连续失败也会停下。默认先返回计划（要推哪几关、预计理智），必须再传 confirm=true 才会真的消耗理智开推。不消耗理智药/源石。',
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
      confirm: CONFIRM_PARAM,
    },
    timeoutMs: 4 * 60 * 60 * 1000,
    concurrencySafe: false,
    failurePrefix: '推关失败。',
    async execute(args) {
      const response = await action(args);
      return { text: String(response?.text ?? '') };
    },
  });
}

/**
 * 造 `ark_push` 工具数组（与旧工具工厂同形）。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义数组。
 */
export function createPushTools(deps) {
  return [createPushTool(deps)];
}

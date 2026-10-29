/**
 * `ark_infrast`：基建换班。
 *
 * @module @local/arknights/tools/infrast
 */

import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** 工具超时：30 分钟。 */
const TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 造 `ark_infrast`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createInfrastTools(deps) {
  return [
    defineArkTool({
      name: 'ark_infrast',
      description:
        '明日方舟基建换班（MAA Infrast）。默认模式 mode=0 自动换班；mode=10000 自定义排班（需要 customFile，可加 planIndex）；mode=20000 一键轮换。可指定设施、无人机用途与心情阈值，换班结果会汇总进入的设施、产物与「干员不足」提示。不消耗理智/源石/招聘许可；指定无人机时会用掉基建无人机库存。默认只返回计划，必须再传 confirm=true 才会真正执行。',
      parameters: {
        mode: {
          type: 'integer',
          enum: [0, 10000, 20000],
          description: '换班模式：0=默认自动（默认），10000=自定义排班（需 customFile），20000=一键轮换。',
        },
        facility: {
          type: 'array',
          items: { type: 'string' },
          description: '要换班的设施，默认 ["Mfg","Trade","Power","Control","Reception","Office","Dorm"]。可选 Mfg/Trade/Power/Control/Reception/Office/Recycle/Dorm/Processing/Training/AssistantChange。',
        },
        drones: {
          type: 'string',
          enum: ['_NotUse', 'Money', 'SyntheticJade', 'CombatRecord', 'PureGold', 'OriginStone', 'Chip'],
          description: '无人机用途，默认 _NotUse（不使用）。mode=10000 时无效。',
        },
        threshold: {
          type: 'number',
          description: '工作心情阈值，0–1，默认 0.3。',
        },
        customFile: {
          type: 'string',
          description: '自定义换班排班 JSON 的路径（相对 MAA userDir 或绝对路径）；给了它但没给 mode 时自动切 mode=10000。',
        },
        planIndex: {
          type: 'integer',
          description: '自定义排班里使用的方案序号（从 0 开始，取 MAA 的 plan_index）。',
        },
        confirm: CONFIRM_PARAM,
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.infrast(args);
        return response.text ?? '';
      },
    }),
  ];
}

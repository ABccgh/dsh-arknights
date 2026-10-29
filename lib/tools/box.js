/**
 * `ark_box`：识别仓库与干员 box 并写入本地快照。
 *
 * @module @local/arknights/tools/box
 */

import { defineArkTool } from './shared.js';

/** 工具超时：40 分钟。 */
const TIMEOUT_MS = 40 * 60 * 1000;

/**
 * 造 `ark_box`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createBoxTools(deps) {
  return [
    defineArkTool({
      name: 'ark_box',
      description:
        '识别明日方舟仓库与干员 box，写入本地快照（不需要确认，不消耗资源）。target=both 先识别干员（MAA OperBox）再识别仓库（MAA Depot）；只等 done=true 的完整结果，超时不会拿半成品覆盖已有完整快照。快照供 ark_data/面板/抄作业干员检查使用。',
      parameters: {
        target: {
          type: 'string',
          enum: ['both', 'operbox', 'depot'],
          description: '识别目标：both（默认，干员+仓库）、operbox（只干员）、depot（只仓库）。',
        },
        refresh: {
          type: 'boolean',
          description: '是否强制重新识别（默认 true；该动作总是跑一次 MAA 识别）。',
        },
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.box(args);
        return response.text ?? '';
      },
    }),
  ];
}

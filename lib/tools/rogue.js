/**
 * `ark_rogue`：跑集成战略（肉鸽）。
 *
 * @module @local/arknights/tools/rogue
 */

import { describeError } from '../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../tool-kit.js';

/**
 * 造 `ark_rogue`。
 * @param {object} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createRogueTools(deps) {
  return [
    defineTool({
      name: 'ark_rogue',
      description:
        '启动明日方舟集成战略（肉鸽）自动化：按主题与模式跑 MAA 的 Roguelike 任务。默认立即返回（任务会在后台继续），用 ark_status 看进度、ark_stop 停止；传 wait=true 则等到任务结束再返回（可能很久）。',
      parameters: {
        theme: {
          type: 'string',
          enum: ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'],
          description: '肉鸽主题：Phantom(傀影)/Mizuki(水月)/Sami(萨米)/Sarkaz(萨卡兹)/JieGarden(界园)。默认取配置 rogue.theme（Sarkaz）。',
        },
        mode: {
          type: 'string',
          enum: ['Exp', 'Invest', 'Start', 'DeepExploration'],
          description: '模式：Exp(刷等级)/Invest(刷源石锭)/Start(刷开局)/DeepExploration(深入探索)。默认取配置（Exp）。',
        },
        startsCount: {
          type: 'integer',
          description: '开始次数上限，默认 9999。',
        },
        wait: {
          type: 'boolean',
          description: '是否等到任务结束再返回。默认 false（启动即返回）。',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          const result = await deps.actions.rogue(args);
          return text(result.text);
        } catch (error) {
          return text(`启动肉鸽失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

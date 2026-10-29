/**
 * `ark_award`：领取各类日常奖励。
 *
 * @module @local/arknights/tools/award
 */

import { defineArkTool } from './shared.js';

/** 工具超时：30 分钟。 */
const TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 造 `ark_award`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createAwardTools(deps) {
  return [
    defineArkTool({
      name: 'ark_award',
      description:
        '领取明日方舟各种奖励（MAA Award），不需要确认：每日/每周任务奖励（award，默认开）、邮件（mail）、限定池每日免费单抽（dailyPull）、幸运墙合成玉（orundum）、限时开采许可（mining）、赠送月卡（specialAccess）、限时签到（signInEvent）。不消耗理智/源石/招聘许可。MAA 不回传领取明细，结果只能确认任务链是否跑完；某个奖励已经领过时 MAA 会跳过，不会报错。',
      parameters: {
        award: {
          type: 'boolean',
          description: '每日/每周任务奖励，默认 true。',
        },
        mail: {
          type: 'boolean',
          description: '领取所有邮件奖励，默认 false。',
        },
        dailyPull: {
          type: 'boolean',
          description: '领取限定池赠送的每日免费单抽，默认 false。',
        },
        orundum: {
          type: 'boolean',
          description: '领取幸运墙的合成玉奖励，默认 false。',
        },
        mining: {
          type: 'boolean',
          description: '领取限时开采许可的合成玉奖励，默认 false。',
        },
        specialAccess: {
          type: 'boolean',
          description: '领取赠送的月卡奖励，默认 false。',
        },
        signInEvent: {
          type: 'boolean',
          description: '领取限时签到活动奖励（仅支持常见横向版型），默认 false。',
        },
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.award(args);
        return response.text ?? '';
      },
    }),
  ];
}

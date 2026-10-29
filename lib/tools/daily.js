/**
 * `ark_daily`：跑日常（领奖 → 信用商店 → 基建换班 → 公招识别 → 可选仓库识别）。
 *
 * @module @local/arknights/tools/daily
 */

import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** 工具超时：2 小时（五项串起来可能很久）。 */
const TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * 造 `ark_daily`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createDailyTools(deps) {
  return [
    defineArkTool({
      name: 'ark_daily',
      description:
        '跑明日方舟日常：按固定顺序执行 StartUp（回主界面）→ 领奖 → 信用商店 → 基建换班 → 公招识别（只识别 tags/组合，不消耗招聘许可）→ 可选仓库/干员识别。每项是独立的 MAA 任务链，某一项失败不会中断后面的项，逐项结果在 result.daily.tasks 里。默认会按账本跳过当天已完成的领奖/信用商店/基建；全部已完成时不会启动 MAA。计划阶段会逐项说明消耗（本动作默认 0 理智/源石/招聘许可）。默认只返回计划，必须再传 confirm=true 才会真正执行。',
      parameters: {
        tasks: {
          type: 'string',
          description: '要做的日常项，逗号分隔，可选 award/mall/infrast/recruit/box；不传用配置 daily.tasks（默认 award,mall,infrast）。执行顺序固定为 award → mall → infrast → recruit → box。',
        },
        skipDone: {
          type: 'boolean',
          description: '是否按账本跳过当天已完成的领奖/信用商店/基建，默认 true（配置 daily.skipDone）。recruit/box 只读，永远会跑。',
        },
        award: {
          type: 'object',
          description: '覆盖领奖子任务参数（对象，等价于 ark_award 的参数，例如 {"mail":true}）。',
        },
        mall: {
          type: 'object',
          description: '覆盖信用商店子任务参数（对象，等价于 ark_mall 的参数，例如 {"buyFirst":["招聘许可"]}）。',
        },
        infrast: {
          type: 'object',
          description: '覆盖基建换班子任务参数（对象，等价于 ark_infrast 的参数，例如 {"drones":"Money"}）。',
        },
        recruit: {
          type: 'object',
          description: '覆盖公招子任务参数（日常里强制只识别，mode 会被忽略）。',
        },
        box: {
          type: 'object',
          description: '覆盖仓库/干员识别子任务参数（对象，等价于 ark_box 的参数，例如 {"target":"depot"}）。',
        },
        confirm: CONFIRM_PARAM,
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.daily(args);
        return response.text ?? '';
      },
    }),
  ];
}

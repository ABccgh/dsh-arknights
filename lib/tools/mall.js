/**
 * `ark_mall`：领取信用点与信用商店购物。
 *
 * @module @local/arknights/tools/mall
 */

import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** 工具超时：30 分钟。 */
const TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 造 `ark_mall`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createMallTools(deps) {
  return [
    defineArkTool({
      name: 'ark_mall',
      description:
        '明日方舟信用领取与信用商店购物（MAA Mall）：默认访问好友基建拿信用，再按「优先购买 → 从左到右避开黑名单 → 信用溢出时无视黑名单」的顺序购物。只消耗游戏内信用点，不消耗理智/源石/招聘许可。MAA 不回传购买清单与信用变化，结果里会如实说明「识别不到明细」。默认只返回计划，必须再传 confirm=true 才会真正执行。',
      parameters: {
        visitFriends: {
          type: 'boolean',
          description: '是否访问好友基建领取信用，默认 true。',
        },
        shopping: {
          type: 'boolean',
          description: '是否购物，默认 true。',
        },
        buyFirst: {
          type: 'array',
          items: { type: 'string' },
          description: '优先购买列表（商品名），例如 ["招聘许可","龙门币"]。',
        },
        blacklist: {
          type: 'array',
          items: { type: 'string' },
          description: '购物黑名单（商品名），例如 ["家具零件"]。',
        },
        onlyDiscount: {
          type: 'boolean',
          description: '是否只买折扣商品（只作用于第二轮购买），默认 false。',
        },
        forceWhenFull: {
          type: 'boolean',
          description: '信用点溢出时是否无视黑名单继续买，默认 false（MAA force_shopping_if_credit_full）。',
        },
        reserveMaxCredit: {
          type: 'boolean',
          description: '信用点低于 300 时是否停止购买（只作用于第二轮），默认 false。',
        },
        confirm: CONFIRM_PARAM,
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.mall(args);
        return response.text ?? '';
      },
    }),
  ];
}

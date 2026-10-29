/**
 * `ark_rogue`：跑集成战略（肉鸽）。
 *
 * @module @local/arknights/tools/rogue
 */

import { ROGUE_MODES, ROGUE_THEMES } from '../contracts.js';
import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** `ark_rogue` 名称。 */
export const ROGUE_TOOL_NAME = 'ark_rogue';

/**
 * 造 `ark_rogue`。
 * @param {{ actions: { rogue: (params: Record<string, any>) => Promise<Record<string, any>> } }} deps - 依赖。
 * @returns {object} 工具 definition。
 */
export function createRogueTool(deps) {
  const action = deps?.actions?.rogue;
  if (typeof action !== 'function') throw new TypeError('ark_rogue 需要 deps.actions.rogue');
  return defineArkTool({
    name: ROGUE_TOOL_NAME,
    description:
      '启动明日方舟集成战略（肉鸽）自动化：按主题、模式、分队等参数跑 MAA 的 Roguelike 任务。默认立即返回（任务在后台继续），用 ark_status 看进度、ark_stop 停止；传 wait=true 则等到任务结束再返回（最长 6 小时）。模式用友好名，内部映射成 MAA 6.21 要求的数字 mode。默认先返回计划，必须再传 confirm=true 才会真的启动。',
    parameters: {
      theme: {
        type: 'string',
        enum: ROGUE_THEMES,
        description: '肉鸽主题：Phantom(傀影)/Mizuki(水月)/Sami(萨米)/Sarkaz(萨卡兹)/JieGarden(界园)/BlackFlow(黑流树海)。默认取配置 rogue.theme（Sarkaz）。',
      },
      mode: {
        type: 'string',
        enum: ROGUE_MODES,
        description: '模式（友好名，映射到 MAA 数字 mode）：Exp 刷等级=0 / Invest 刷源石锭=1 / Start 刷开局=4 / Collapse 刷坍缩=5 / Monthly 月度小队=6 / DeepExploration 深入探索=7 / QuickFirstLayer=10001 / JieGardenNode=20001 / BlackFlowStart=30003。默认取配置（Exp）。',
      },
      startsCount: {
        type: 'integer',
        description: '开始次数上限，默认 9999。',
      },
      squad: {
        type: 'string',
        description: '可选：分队名（与游戏内一致），默认不指定。',
      },
      roles: {
        type: 'string',
        description: '可选：职业组，例如“近卫重装”（与 MAA 界面上的职业组名一致），默认不指定。',
      },
      coreChars: {
        type: 'string',
        description: '可选：核心干员名，多个用逗号分隔（如“银灰,史尔特尔”）；默认不指定。',
      },
      difficulty: {
        type: 'integer',
        description: '可选：难度（MAA Roguelike 的 difficulty，-1 表示默认；常用 0~30），默认 -1。',
      },
      params: {
        type: 'object',
        description: '可选高级项：原样并入 MAA Roguelike 任务参数（会覆盖上面的同名字段），谨慎使用。',
      },
      confirm: CONFIRM_PARAM,
      wait: {
        type: 'boolean',
        description: '是否等到任务结束再返回。默认 false（启动即返回）。',
      },
    },
    timeoutMs: 24 * 60 * 60 * 1000,
    concurrencySafe: false,
    failurePrefix: '启动肉鸽失败。',
    async execute(args) {
      const response = await action(args);
      return { text: String(response?.text ?? '') };
    },
  });
}

/**
 * 造 `ark_rogue` 工具数组（与旧工具工厂同形）。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义数组。
 */
export function createRogueTools(deps) {
  return [createRogueTool(deps)];
}

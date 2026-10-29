/**
 * `ark_fight`：打指定关卡（严格按给定关卡与次数，不猜关、不换关）。
 *
 * 工具只负责参数契约与文本输出；计划/确认/安全闸/执行都在 `lib/actions/fight.js`。
 *
 * @module @local/arknights/tools/fight
 */

import {
  CONFIRM_PARAM,
  DIFFICULTY_PARAM,
  MEDICINE_PARAM,
  STONE_PARAM,
  TIMES_PARAM,
  defineArkTool,
} from './shared.js';

/** `ark_fight` 名称。 */
export const FIGHT_TOOL_NAME = 'ark_fight';

/**
 * 造 `ark_fight`。
 * @param {{ actions: { fight: (params: Record<string, any>) => Promise<Record<string, any>> } }} deps - 依赖。
 * @returns {object} 工具 definition。
 */
export function createFightTool(deps) {
  const action = deps?.actions?.fight;
  if (typeof action !== 'function') throw new TypeError('ark_fight 需要 deps.actions.fight');
  return defineArkTool({
    name: FIGHT_TOOL_NAME,
    description:
      '打明日方舟的指定关卡：你说打哪关就打哪关，按给定顺序与次数执行，不猜关、不自动换关。每关先试代理指挥（Fight），若该关没有代理指挥（未满星或借过干员）会自动改用作业站抄作业（Copilot）打通；都没有就报错并给三条出路。支持磨难/险地/突袭难度（difficulty=tough）。默认先返回计划（哪几关、什么难度、预计理智），必须再传 confirm=true 才会真的消耗理智开打。medicine/stone/useSanityPotion 默认 0/false；任何资源消耗默认会被安全闸拒绝，需用户明确同意并打开对应 safety 开关。',
    parameters: {
      stages: {
        type: 'string',
        required: true,
        description: '关卡代码，一个或多个；多个用逗号/顿号/空格分隔，按给定顺序逐关打。例如 "5-10" 或 "5-10,6-5"；也可传内部 id（main_05-10）。',
      },
      times: TIMES_PARAM,
      difficulty: DIFFICULTY_PARAM,
      medicine: MEDICINE_PARAM,
      stone: STONE_PARAM,
      useSanityPotion: {
        type: 'boolean',
        description: '抄作业时若理智不足是否允许自动用理智药（MAA Copilot 的 use_sanity_potion）。默认 false；为 true 时默认被安全闸拒绝。',
      },
      series: {
        type: 'integer',
        description: '代理指挥连战倍率（MAA Fight 的 series）：-1 禁用切换、0 自动最大、1~10 指定。默认不传（MAA 默认 1）。',
      },
      drops: {
        type: 'object',
        description: '目标掉落（MAA Fight 的 drops）：材料名或 itemId → 数量，达到任一数量即停止。指定时必须同时给 times。例：{"固源岩": 10} 或 {"30011": 10}。',
      },
      copilotId: {
        type: 'integer',
        description: '可选：指定作业站上的作业 id（配合 stages 使用；Fight 无法代理时用它抄作业）。',
      },
      file: {
        type: 'string',
        description: '可选：本地 MAA 作业 JSON 的绝对路径（跳过作业站；Fight 无法代理时用它抄作业）。',
      },
      video: {
        type: 'string',
        description: '可选：本地作战录屏的绝对路径。会交给 MAA 的 VideoRecognition 生成作业再执行（best-effort：MAA 没交付作业时会提示改用 file=；不阻塞 file/copilotId）。',
      },
      confirm: CONFIRM_PARAM,
      wait: {
        type: 'boolean',
        description: '是否等到打完再返回。默认 true；wait=false 时立即返回 runId（后台继续，用 ark_status 看进度）。',
      },
    },
    timeoutMs: 2 * 60 * 60 * 1000,
    concurrencySafe: false,
    failurePrefix: '打关卡失败。',
    async execute(args) {
      const response = await action(args);
      return { text: String(response?.text ?? '') };
    },
  });
}

/**
 * 造 `ark_fight` 工具数组（与旧工具工厂同形）。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义数组。
 */
export function createFightTools(deps) {
  return [createFightTool(deps)];
}

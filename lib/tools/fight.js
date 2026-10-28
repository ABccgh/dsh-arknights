/**
 * `ark_fight`：打指定关卡（严格按给定关卡与次数，不猜关、不换关）。
 *
 * @module @local/arknights/tools/fight
 */

import { describeError } from '../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../tool-kit.js';

/**
 * 造 `ark_fight`。
 * @param {object} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createFightTools(deps) {
  return [
    defineTool({
      name: 'ark_fight',
      description:
        '打明日方舟的指定关卡：你说打哪关就打哪关，按给定顺序与次数执行，不猜关、不自动换关。每关先试代理指挥（Fight），若该关没有代理指挥（未满星或借过干员）会自动改用作业站抄作业（Copilot）打通；都没有就报错并给三条出路。支持磨难/险地/突袭难度（difficulty=tough）。默认先返回计划（哪几关、什么难度、预计理智），必须再传 confirm=true 才会真的消耗理智开打。',
      parameters: {
        stages: {
          type: 'string',
          required: true,
          description: '关卡代码，一个或多个；多个用逗号/顿号/空格分隔，按给定顺序逐关打。例如 "5-10" 或 "5-10,6-5"；也可传内部 id（main_05-10）。',
        },
        times: {
          type: 'integer',
          description: '每关打几次，默认 1。可代理的关按这个次数打；走抄作业时只打 1 次（拿满星）。',
        },
        difficulty: {
          type: 'string',
          enum: ['auto', 'easy', 'tough'],
          description: '难度：auto（默认，优先简单/普通）、easy（标准/常规）、tough（磨难/险地/突袭）。tough 会把关卡名加上 MAA 的 -HARD 后缀导航（10-14 章=磨难，15 章及以后=险地）；抄作业时同时带 is_raid 与 nav_name_override。',
        },
        confirm: {
          type: 'boolean',
          description: '是否确认执行。默认 false 只返回计划；确认无误后传 true 才真正开打。',
        },
        file: {
          type: 'string',
          description: '可选：本地 MAA 作业 JSON 的绝对路径（跳过作业站）。',
        },
        video: {
          type: 'string',
          description: '可选：本地作战录屏的绝对路径。会交给 MAA 的 VideoRecognition 生成作业再执行（best-effort：MAA 没交付作业时会提示改用 file=）。',
        },
        copilotId: {
          type: 'integer',
          description: '可选：指定作业站上的作业 id（配合 stages 使用）。',
        },
        medicine: {
          type: 'integer',
          description: '可选：理智不足时允许使用几个理智药（MAA Fight 的 medicine 参数）。默认 0 = 不用。',
        },
        useSanityPotion: {
          type: 'boolean',
          description: '可选：抄作业时若理智不足是否允许自动用理智药（MAA Copilot 的 use_sanity_potion）。默认 false。',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          const result = await deps.actions.fight(args);
          return text(result.text);
        } catch (error) {
          return text(`打关卡失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * `ark_recruit`：公开招募识别（analyze）与执行（execute）。
 *
 * @module @local/arknights/tools/recruit
 */

import { CONFIRM_PARAM, defineArkTool } from './shared.js';

/** 工具超时：10 分钟。 */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 造 `ark_recruit`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createRecruitTools(deps) {
  return [
    defineArkTool({
      name: 'ark_recruit',
      description:
        '明日方舟公开招募。mode=analyze（默认）不需要确认：只跑 MAA Recruit 的识别（times=0、select=[]、confirm=[]、refresh=false），解析 RecruitTagsDetected/RecruitResult，返回当前槽位的 tags、最高星级与各组合可能招募到的干员；不消耗招聘许可、不刷新标签、不确认招募。mode=execute 需要 confirm=true，并且必须在配置里打开 safety.allowRecruitPermits 才会真正招募（expedite=true 还需要 safety.allowExpedite）。',
      parameters: {
        mode: {
          type: 'string',
          enum: ['analyze', 'execute'],
          description: 'analyze（默认，只识别不消耗）或 execute（真正招募，需要 confirm=true 且 safety.allowRecruitPermits=true）。',
        },
        times: {
          type: 'integer',
          description: 'execute 模式下最多招募几次（≥1，默认 1）。analyze 模式忽略（固定 times=0）。',
        },
        confirmLevels: {
          type: 'array',
          items: { type: 'integer' },
          description: 'execute 模式下会自动确认的星级，例如 [3,4]（默认 [3,4]）。空数组表示不自动确认。',
        },
        selectLevels: {
          type: 'array',
          items: { type: 'integer' },
          description: 'execute 模式下会去点击标签的星级，例如 [4,5]（默认 [4,5]）。空数组表示不点标签。',
        },
        refresh: {
          type: 'boolean',
          description: 'execute 模式下是否刷新三星标签，默认 false。',
        },
        expedite: {
          type: 'boolean',
          description: 'execute 模式下是否使用加急许可，默认 false。默认配置下 true 会被安全闸拒绝，需打开 safety.allowExpedite。',
        },
        permitReserve: {
          type: 'integer',
          description: '3 星招募保留的招聘许可数量（MAA level3_recruitment_permit_reserve），默认 0=禁用。当前许可 ≤ 该值时跳过 3 星招募。',
        },
        firstTags: {
          type: 'array',
          items: { type: 'string' },
          description: '首选 Tags（仅 3 星标签时生效），例如 ["支援机械"]。默认空。',
        },
        preserveTags: {
          type: 'array',
          items: { type: 'string' },
          description: '识别到就保留并跳过当前槽位的 Tags，例如 ["支援机械"]。默认空。',
        },
        confirm: CONFIRM_PARAM,
      },
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute(args) {
        const response = await deps.actions.recruit(args);
        return response.text ?? '';
      },
    }),
  ];
}

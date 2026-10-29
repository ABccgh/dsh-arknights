/**
 * `ark_stop`：立即中止当前任务链。
 *
 * @module @local/arknights/tools/stop
 */

import { defineArkTool } from './shared.js';

/** 工具超时：30 分钟（与其他 30 分钟档工具一致；动作内部另有 15s 请求超时）。 */
const TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 造 `ark_stop`。
 * @param {Record<string, any>} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createStopTools(deps) {
  return [
    defineArkTool({
      name: 'ark_stop',
      description:
        '立即中止明日方舟当前正在执行的任务链（打关卡/推关/肉鸽/日常都适用，战斗中也有效）。不需要确认：先中止本地 run，再让 MAA 清空任务链。侧车没在跑时不会报错。停止后不会自动继续，需要重新发起动作。',
      parameters: {},
      timeoutMs: TIMEOUT_MS,
      concurrencySafe: false,
      async execute() {
        const response = await deps.actions.stop();
        return response.text ?? '';
      },
    }),
  ];
}

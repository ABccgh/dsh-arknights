/**
 * `ark_stop`：立即中止当前任务链。
 *
 * @module @local/arknights/tools/stop
 */

import { describeError } from '../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../tool-kit.js';

/**
 * 造 `ark_stop`。
 * @param {object} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createStopTools(deps) {
  return [
    defineTool({
      name: 'ark_stop',
      description:
        '立即中止明日方舟当前正在执行的任务链（打关卡/推关/肉鸽都适用，战斗中也有效）。停止后不会自动继续，需要重新发起动作。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute() {
        try {
          const result = await deps.actions.stop();
          return text(result.text);
        } catch (error) {
          return text(`停止失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

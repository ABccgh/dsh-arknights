/**
 * `ark_status`：只读诊断（MAA、Python、adb、模拟器、连接、任务、账本）。
 *
 * @module @local/arknights/tools/status
 */

import { describeError } from '../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../tool-kit.js';

/**
 * 造 `ark_status`。
 * @param {object} deps - 依赖（含 actions）。
 * @returns {object[]} 工具定义。
 */
export function createStatusTools(deps) {
  return [
    defineTool({
      name: 'ark_status',
      description:
        '查看明日方舟自动化链路的状态：MaaCore 版本与资源是否加载、Python/adb/MuMu 路径、模拟器是否开机、adb 是否在线、MAA 是否已连接、当前任务链、理智、以及关卡账本统计（满星/未满星/已领源石）和推关进度。只读，不会启动模拟器或侧车。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        try {
          const { text: body } = await deps.actions.status();
          return text(body);
        } catch (error) {
          return text(`读取状态失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

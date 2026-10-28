/**
 * `ark_emulator`：MuMu 模拟器状态 / 启动 / 关闭（走 MuMuManager）。
 *
 * @module @local/arknights/preset/tools/emulator
 */

import { arkError, describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { formatBytes, sleep } from '../shared.js';

/**
 * 造 `ark_emulator`。
 * @param {object} deps - 依赖（config / detect）。
 * @returns {object[]} 工具定义。
 */
export function createEmulatorTools(deps) {
  return [
    defineTool({
      name: 'ark_emulator',
      description:
        '查看/控制 MuMu 模拟器（走 MuMuManager）：status 看进程与安卓是否启动、adb 是否在线；start 拉起模拟器并等到安卓启动；stop 关闭模拟器。start/stop 会改变模拟器状态（打关卡时全局插件也会自动拉起，一般不需要手动调用）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description: 'status（默认）/ start / stop。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'status';
          const detected = await deps.detect({ fresh: true });
          if (detected.managerPath === '') {
            throw arkError('E_EMULATOR_NOT_FOUND', '没找到 MuMuManager.exe。', {
              detail: `试过：${detected.mumuTried.slice(0, 6).join('；')}`,
              hint: '在预设行的 config 里写 emulator.installPath（MuMu 安装目录）。',
            });
          }
          const vmIndex = detected.vmIndex ?? 0;
          if (action === 'status') return text(renderStatus(detected));
          if (action === 'stop') {
            const result = await deps.run.cli(detected.managerPath, ['control', '-v', String(vmIndex), 'shutdown'], { timeoutMs: 30000 });
            if (!result.ok) throw arkError('E_EMULATOR_START', '关闭模拟器失败。', { detail: result.stderr.slice(0, 300) });
            return text(`已发送关闭指令（实例 #${vmIndex}）。`);
          }
          if (action !== 'start') throw arkError('E_BAD_ARGS', 'action 只能是 status / start / stop。');

          if (detected.emulator?.androidStarted === true) return text(`模拟器已经开机。\n${renderStatus(detected)}`);
          const launched = await deps.run.cli(detected.managerPath, ['control', '-v', String(vmIndex), 'launch'], { timeoutMs: 30000 });
          if (!launched.ok) {
            throw arkError('E_EMULATOR_START', '拉起模拟器失败。', {
              detail: launched.stderr.slice(0, 300),
              hint: '手动启动一次 MuMu，确认能进桌面。',
            });
          }
          const deadline = Date.now() + deps.config.launchTimeoutMs;
          let last = detected;
          while (Date.now() < deadline) {
            await sleep(3000);
            last = await deps.detect({ fresh: true });
            if (last.emulator?.androidStarted === true) {
              return text(`模拟器已开机（用时约 ${Math.round((deps.config.launchTimeoutMs - (deadline - Date.now())) / 1000)}s）。\n${renderStatus(last)}`);
            }
          }
          throw arkError('E_EMULATOR_START', `模拟器在 ${Math.round(deps.config.launchTimeoutMs / 1000)}s 内没有开机完成。`, {
            detail: renderStatus(last),
            hint: '手动启动一次 MuMu，确认能进桌面后再重试。',
          });
        } catch (error) {
          return text(`模拟器操作失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 渲染模拟器状态。
 * @param {Record<string, any>} detected - 探测结果。
 * @returns {string} 文本。
 */
export function renderStatus(detected) {
  const emulator = detected.emulator ?? {};
  const lines = [
    `实例：#${detected.vmIndex ?? 0}${emulator.name ? ` ${emulator.name}` : ''}`,
    `进程：${emulator.running ? '运行中' : '未运行'} · 安卓：${emulator.androidStarted ? '已启动' : '未启动'} · adb：${emulator.adbOnline ? '在线' : '离线'}`,
    `adb 地址：${detected.address || '未知'}${detected.vmConfig?.width ? ` · 分辨率 ${detected.vmConfig.width}×${detected.vmConfig.height}` : ''}`,
    `MuMuManager：${detected.managerPath}`,
  ];
  if (emulator.errorCode !== null && emulator.errorCode !== undefined && emulator.errorCode !== 0) {
    lines.push(`MuMu 错误码：${emulator.errorCode}`);
  }
  return lines.join('\n');
}

/** 供测试用。 */
export { formatBytes };

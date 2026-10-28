/**
 * `ark_device`：设备与连接自检（adb / 分辨率 / 机型 / 前台包名 / 模拟器三态）。
 *
 * 排查「为什么打不了」的第一步：先确认 adb 在线、游戏在前台，再怀疑 MAA。
 *
 * @module @local/arknights/preset/tools/device
 */

import { describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';

/** 明日方舟（官方渠道）包名。 */
const GAME_PACKAGE = 'com.hypergryph.arknights';

/**
 * 造 `ark_device`。
 * @param {object} deps - 依赖（detect / config）。
 * @returns {object[]} 工具定义。
 */
export function createDeviceTools(deps) {
  return [
    defineTool({
      name: 'ark_device',
      description:
        '明日方舟设备自检：adb 是否在线、屏幕分辨率、机型、当前前台包名（判断游戏是否在前台）、模拟器三态（进程/安卓/adb）、MAA/Python/adb 探测到的路径。只读，不会启动或连接任何东西；失败时直接给出修复步骤。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        try {
          const detected = await deps.detect({ fresh: true });
          const lines = [];
          lines.push(`adb：${detected.adbPath || '未找到'} · 设备 ${detected.address || '未知'} · ${detected.emulator?.adbOnline ? '在线' : '离线'}`);
          lines.push(
            `模拟器：${detected.emulator?.managerFound ? (detected.emulator.androidStarted ? '已开机' : '未开机') : '未找到 MuMu'}`
            + `（${detected.emulator?.name || '未知实例'} #${detected.emulator?.vmIndex ?? 0}）`,
          );
          lines.push(`MAA：${detected.maaPath || '未找到'}${detected.vmConfig?.width ? ` · 实例分辨率 ${detected.vmConfig.width}×${detected.vmConfig.height}` : ''}`);

          if (detected.adbPath === '' || detected.emulator?.adbOnline !== true) {
            lines.push('');
            lines.push('结论：adb 不可用，先解决这一步（游戏画面/分辨率都读不到）。');
            lines.push('建议：① ark_emulator start 或手动开 MuMu；② 确认 MuMu 的 adb 端口（默认 16384）没被占；③ 必要时在配置里写 adbPath。');
            return text(lines.join('\n'));
          }

          const size = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'wm', 'size']);
          const model = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'getprop', 'ro.product.model']);
          const activity = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'dumpsys', 'activity', 'activities']);
          const resolution = parseWmSize(size.stdout);
          const foreground = parseForeground(activity.stdout);
          lines.push('');
          lines.push(`分辨率：${resolution ?? '未知'}（MAA 需要 16:9）`);
          lines.push(`机型：${model.stdout.trim() || '未知'}`);
          lines.push(`前台：${foreground ?? '识别不到'}`);
          if (foreground !== null) {
            lines.push(foreground === GAME_PACKAGE || foreground.startsWith(`${GAME_PACKAGE}/`)
              ? '游戏在前台 ✅'
              : `游戏不在前台（前台是 ${foreground}）——MAA 会自己启动/切回游戏，但手动排查时值得注意。`);
          }
          if (resolution !== null && !is169(resolution)) {
            lines.push('⚠️ 当前不是 16:9 分辨率，MAA 会拒绝识别；请在 MuMu 设置里改成 1920×1080。');
          }
          return text(lines.join('\n'));
        } catch (error) {
          return text(`设备自检失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 解析 `wm size` 输出。
 * @param {string} stdout - 命令输出。
 * @returns {string | null} `宽x高` 或 null。
 */
export function parseWmSize(stdout) {
  const match = /(\d+)\s*x\s*(\d+)/.exec(String(stdout ?? ''));
  if (match === null) return null;
  return `${match[1]}x${match[2]}`;
}

/**
 * 解析前台包名（从 `dumpsys activity activities` 里找 ResumedActivity）。
 * @param {string} stdout - 命令输出。
 * @returns {string | null} 包名（可能带 `/Activity`）或 null。
 */
export function parseForeground(stdout) {
  const text = String(stdout ?? '');
  const resumed = /ResumedActivity[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
  if (resumed !== null) return `${resumed[1]}/${resumed[2]}`;
  const top = /topResumedActivity[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
  if (top !== null) return `${top[1]}/${top[2]}`;
  return null;
}

/**
 * 判断分辨率是否 16:9。
 * @param {string} resolution - `宽x高`。
 * @returns {boolean} 是 16:9 为 true。
 */
function is169(resolution) {
  const match = /^(\d+)x(\d+)$/.exec(resolution);
  if (match === null) return true;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) return true;
  return Math.abs(width / height - 16 / 9) < 0.02;
}

/** 供测试用。 */
export { is169, GAME_PACKAGE };

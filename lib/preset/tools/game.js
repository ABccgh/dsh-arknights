/**
 * `ark_game`：启动 / 关闭明日方舟本体（adb `am start` / `am force-stop`）。
 *
 * 包名与启动组件优先从 MAA 的 `resource/config.json` 读（`packageName` + `connection[General].start`），
 * 读不到再退回官方渠道的默认值，避免把包名写死。
 *
 * @module @local/arknights/preset/tools/game
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError, describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';

/** 官方渠道包名（兜底）。 */
const DEFAULT_PACKAGE = 'com.hypergryph.arknights';
/** 官方渠道启动组件（兜底）。 */
const DEFAULT_COMPONENT = 'com.u8.sdk.U8UnityContext';

/**
 * 造 `ark_game`。
 * @param {object} deps - 依赖（config / detect）。
 * @returns {object[]} 工具定义。
 */
export function createGameTools(deps) {
  return [
    defineTool({
      name: 'ark_game',
      description:
        '启动或关闭模拟器里的明日方舟本体（adb am start / am force-stop）。包名与启动组件从 MAA 的 resource/config.json 读取，读取不到时用官方渠道默认值。会改变游戏进程状态；正常打关卡不需要它（MAA 的 StartUp 会自己启动游戏）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          required: true,
          description: 'start=启动游戏；stop=强制关闭游戏。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const action = String(args.action ?? '');
          if (action !== 'start' && action !== 'stop') {
            throw arkError('E_BAD_ARGS', 'action 只能是 start 或 stop。');
          }
          const detected = await deps.detect();
          if (detected.adbPath === '' || detected.emulator?.adbOnline !== true) {
            throw arkError('E_CONNECT', 'adb 不在线，操作不了游戏进程。', {
              hint: '先 ark_emulator start，或用 ark_device 看现场。',
            });
          }
          const target = await resolveGameTarget(detected.maaPath, deps.config.clientType);
          if (action === 'start') {
            const result = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'am', 'start', '-n', `${target.packageName}/${target.component}`]);
            if (!result.ok && !/Warning|Error type 3/.test(result.stderr)) {
              throw arkError('E_CONNECT', 'am start 失败。', { detail: result.stderr.slice(0, 300) });
            }
            return text(
              `已发送启动：${target.packageName}/${target.component}${target.source === 'maa' ? '（包名来自 MAA config.json）' : '（兜底默认包名）'}\n`
              + '游戏启动到主界面大约 30–90 秒；之后用 ark_device 或 ark_screen 确认。',
            );
          }
          const result = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'am', 'force-stop', target.packageName]);
          if (!result.ok) throw arkError('E_CONNECT', 'am force-stop 失败。', { detail: result.stderr.slice(0, 300) });
          return text(`已强制关闭 ${target.packageName}。`);
        } catch (error) {
          return text(`操作游戏失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 从 MAA 的 `resource/config.json` 解出包名与启动组件。
 * @param {string} maaPath - MAA 安装根。
 * @param {string} clientType - Official/Bilibili/…
 * @returns {Promise<{ packageName: string, component: string, source: 'maa' | 'default' }>} 目标。
 */
export async function resolveGameTarget(maaPath, clientType = 'Official') {
  const fallback = { packageName: DEFAULT_PACKAGE, component: DEFAULT_COMPONENT, source: 'default' };
  if (typeof maaPath !== 'string' || maaPath === '') return fallback;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(maaPath, 'resource', 'config.json'), 'utf8'));
    const packageName = typeof raw?.packageName?.[clientType] === 'string' && raw.packageName[clientType] !== ''
      ? raw.packageName[clientType]
      : (typeof raw?.packageName?.Official === 'string' ? raw.packageName.Official : '');
    if (packageName === '') return fallback;
    const connections = Array.isArray(raw?.connection) ? raw.connection : [];
    const general = connections.find((item) => item?.configName === 'General');
    const startTemplate = typeof general?.start === 'string' ? general.start : '';
    const component = parseStartComponent(startTemplate) ?? DEFAULT_COMPONENT;
    return { packageName, component, source: 'maa' };
  } catch {
    return fallback;
  }
}

/**
 * 从 MAA 的 `start` 模板里抽组件名（`… am start -n [PackageName]/com.x.Y`）。
 * @param {string} template - 模板。
 * @returns {string | null} 组件名或 null。
 */
export function parseStartComponent(template) {
  const match = /-n\s+\[PackageName\]\/([A-Za-z0-9_.$]+)/.exec(String(template ?? ''));
  return match === null ? null : match[1];
}

/** 供测试用。 */
export { DEFAULT_COMPONENT, DEFAULT_PACKAGE };

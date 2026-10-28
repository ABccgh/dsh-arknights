/**
 * `ark_screen`：抓**游戏画面**（adb screencap），存 PNG 供 `read_image` 看。
 *
 * 为什么不用 MAA 的 `AsstGetImage`：预设作用域没有 MaaCore 会话（不抢全局插件的实例），
 * 而 adb 抓屏对「现在卡在哪」这种排查完全够用，且与 MAA 是否连接无关。
 *
 * @module @local/arknights/preset/tools/screen
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError, describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { formatBytes, intIn } from '../shared.js';

/** PNG 魔数。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * 造 `ark_screen`。
 * @param {object} deps - 依赖（config / paths / detect）。
 * @returns {object[]} 工具定义。
 */
export function createScreenTools(deps) {
  return [
    defineTool({
      name: 'ark_screen',
      description:
        '抓一张模拟器里**当前游戏画面**存成 PNG（走 adb screencap，与 MAA 是否连接无关），返回绝对路径，随后可以用 read_image 直接看。用于确认「游戏现在卡在哪个界面/有没有弹窗」。只读游戏画面，不点击、不消耗任何资源。',
      parameters: {
        keep: {
          type: 'integer',
          description: '截图目录里最多保留多少张（默认取配置 maxScreenshots=20），更旧的会被删掉。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const detected = await deps.detect();
          if (detected.adbPath === '') {
            return text(`没找到 adb，抓不了图。试过：${detected.adbTried.slice(0, 6).join('；')}`);
          }
          if (detected.emulator?.androidStarted !== true) {
            throw arkError('E_CONNECT', '模拟器没有开机（android 未启动），抓不到画面。', {
              hint: '先 ark_emulator start，或手动开 MuMu。',
            });
          }
          const result = await deps.run.cliBuffer(detected.adbPath, ['-s', detected.address, 'exec-out', 'screencap', '-p'], {
            timeoutMs: 20000,
          });
          if (!result.ok || result.buffer.length === 0 || !result.buffer.subarray(0, 4).equals(PNG_MAGIC)) {
            throw arkError('E_CONNECT', `screencap 没拿到有效 PNG（${formatBytes(result.buffer.length)}）。`, {
              detail: result.stderr.slice(0, 400),
              hint: '确认 adb 在线（ark_device 可查）、游戏画面没有黑屏；必要时重开模拟器。',
            });
          }
          const keep = intIn(args.keep, deps.config.maxScreenshots, 1, 200);
          const dir = deps.paths.screenshotDir;
          await fsp.mkdir(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const file = path.join(dir, `shot-${stamp}.png`);
          await fsp.writeFile(file, result.buffer);
          await pruneShots(dir, keep);
          return text(
            `已抓图：${file}\n大小 ${formatBytes(result.buffer.length)}；用 read_image 打开这个路径即可看当前游戏画面。`,
          );
        } catch (error) {
          return text(`抓图失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 只保留最近 keep 张截图。
 * @param {string} dir - 截图目录。
 * @param {number} keep - 保留数量。
 * @returns {Promise<void>} 无。
 */
async function pruneShots(dir, keep) {
  try {
    const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.png')).sort();
    const excess = names.slice(0, Math.max(0, names.length - keep));
    await Promise.all(excess.map((name) => fsp.rm(path.join(dir, name), { force: true }).catch(() => {})));
  } catch {
    // 清理失败不影响本次截图。
  }
}

/** 供测试用。 */
export { pruneShots, PNG_MAGIC };

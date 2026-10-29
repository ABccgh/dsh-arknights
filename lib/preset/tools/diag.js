/**
 * `ark_diag`：预设作用域的**现场排查**入口 —— 六个显式动作，全部不持有 MaaCore 会话。
 *
 * | action | 做什么 | 会不会改变状态 |
 * |---|---|---|
 * | `screen` | adb `exec-out screencap` 抓游戏画面存 PNG，返回路径 + 由 PNG 块解析出的尺寸 | 只写截图目录（环形保留最近 N 张） |
 * | `logs` | 读 MAA `asst.log` 尾部，按 `all/warn/error` 过滤 | 只读 |
 * | `device` | adb 设备 / 分辨率 / 机型 / 前台包名 + 模拟器三态 | 只读 |
 * | `emulator` | MuMuManager `info` / `control`（status / start / stop） | start/stop 改变模拟器状态 |
 * | `game` | 从 MAA `resource/config.json` 读包名，adb `am start` / `am force-stop` | 改变游戏进程 |
 * | `probe` | 重新探测 MAA / Python / MuMu / adb 路径与模拟器状态 | 只读 |
 *
 * 为什么截图不走 MAA 的 `AsstGetImage`：预设作用域没有 MaaCore 会话（不抢全局插件的实例），
 * 而 adb 抓屏对「现在卡在哪」这种排查完全够用，且与 MAA 是否连接无关。
 *
 * @module @local/arknights/preset/tools/diag
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError, describeError } from '../../errors.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { formatBytes, intIn, truncate } from '../shared.js';

/** PNG 文件头（8 字节签名）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 官方渠道包名（`game` 动作的兜底值；优先读 MAA 的 config.json）。 */
const DEFAULT_PACKAGE = 'com.hypergryph.arknights';
/** 官方渠道启动组件（兜底）。 */
const DEFAULT_COMPONENT = 'com.u8.sdk.U8UnityContext';
/** 明日方舟（官方渠道）包名，用于判断游戏是否在前台。 */
const GAME_PACKAGE = DEFAULT_PACKAGE;

/** 日志级别匹配（MAA 的级别标记形如 `[ERR]` / `[WRN]` / `[FTL]`）。 */
const LEVEL_PATTERNS = {
  error: /\[(ERR|FTL)\]/,
  warn: /\[(WRN|ERR|FTL)\]/,
};

/** 读日志时最多读文件尾部多少字节（避免把 100 MB 日志整个读进内存）。 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** 截图/日志的展示上限（字符）。 */
const MAX_REPORT_CHARS = 20_000;

/**
 * 造 `ark_diag`。
 * @param {object} deps - 依赖（config / paths / detect / run / sleep）。
 * @returns {object[]} 工具定义。
 */
export function createDiagTools(deps) {
  return [
    defineTool({
      name: 'ark_diag',
      description:
        '明日方舟现场排查（预设作用域，不碰 MaaCore 会话）。按 action 显式选择：'
        + 'screen=抓当前游戏画面存 PNG 返回路径与尺寸（配合 read_image 看「卡在哪」）；'
        + 'logs=读 MAA asst.log 尾部（level=all/warn/error）；'
        + 'device=adb/分辨率/机型/前台包名自检；'
        + 'emulator=MuMu 状态/启动/关闭（emulatorAction=status/start/stop）；'
        + 'game=启动/关闭游戏本体（gameAction=start/stop，包名读 MAA config.json）；'
        + 'probe=重新探测 MAA/Python/MuMu/adb 路径。'
        + '只读或只动模拟器/游戏进程，不消耗理智；失败时给出可执行的修复步骤。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['screen', 'logs', 'device', 'emulator', 'game', 'probe'],
          description: '要做的排查动作，必填（-screen/logs/device/emulator/game/probe）。',
        },
        keep: {
          type: 'integer',
          description: 'action=screen：截图目录最多保留多少张，默认取配置 maxScreenshots（20），上限 200。',
        },
        lines: {
          type: 'integer',
          description: 'action=logs：最多返回多少行，默认 80，上限取配置 maxLogLines（400）。',
        },
        level: {
          type: 'string',
          enum: ['all', 'warn', 'error'],
          description: 'action=logs：all（默认）/ warn（WRN 及以上）/ error（ERR/FTL）。',
        },
        emulatorAction: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description: 'action=emulator：status（默认，只读）/ start（拉起并等安卓启动）/ stop（关闭）。',
        },
        gameAction: {
          type: 'string',
          enum: ['start', 'stop'],
          description: 'action=game 时必填：start=启动游戏；stop=强制关闭游戏。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args.action ?? '').trim();
        try {
          switch (action) {
            case 'screen':
              return await screenAction(deps, args);
            case 'logs':
              return await logsAction(deps, args);
            case 'device':
              return await deviceAction(deps);
            case 'emulator':
              return await emulatorAction(deps, args);
            case 'game':
              return await gameAction(deps, args);
            case 'probe':
              return await probeAction(deps);
            default:
              throw arkError('E_BAD_ARGS', `action 只能是 screen / logs / device / emulator / game / probe，收到「${action || '空'}」。`, {
                hint: '例如 ark_diag action=screen；排查链路从 action=device 或 action=probe 开始。',
              });
          }
        } catch (error) {
          return text(`排查动作 ${action || '（未指定）'} 失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

// —— 1. screen ——

/**
 * 抓当前游戏画面。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} args - 工具参数。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function screenAction(deps, args) {
  const detected = await deps.detect();
  if (detected.adbPath === '') {
    return text(
      `没找到 adb，抓不了图。试过：${attemptsText(detected.adbTried)}\n`
      + '建议：在预设行 config 里写 adbPath，然后 ark_diag action=probe 复测。',
    );
  }
  if (detected.emulator?.androidStarted !== true) {
    throw arkError('E_CONNECT', '模拟器没有开机（android 未启动），抓不到画面。', {
      hint: '先 ark_diag action=emulator emulatorAction=start，或手动开 MuMu。',
    });
  }
  const result = await deps.run.cliBuffer(
    detected.adbPath,
    ['-s', detected.address, 'exec-out', 'screencap', '-p'],
    { timeoutMs: 20000 },
  );
  const raw = Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.alloc(0);
  if (!result.ok || raw.length === 0 || !raw.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw arkError('E_CONNECT', `screencap 没拿到有效 PNG（${formatBytes(raw.length)}）。`, {
      detail: String(result.stderr ?? '').slice(0, 400),
      hint: '确认 adb 在线（ark_diag action=device）、游戏画面没有黑屏；必要时重开模拟器。',
    });
  }
  const size = parsePngSize(raw);
  const keep = intIn(args.keep, deps.config.maxScreenshots, 1, 200);
  const dir = deps.paths.screenshotDir;
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const file = path.join(dir, `shot-${stamp}.png`);
  await fsp.writeFile(file, raw);
  await pruneShots(dir, keep);
  const sizeText = size === null ? '尺寸未知（PNG 头解析失败）' : `${size.width}×${size.height}`;
  return text(
    `已抓图：${file}\n`
    + `尺寸 ${sizeText} · 大小 ${formatBytes(raw.length)} · 目录只保留最近 ${keep} 张。\n`
    + '用 read_image 打开这个路径即可看当前游戏画面。',
  );
}

/**
 * 从 PNG 的块结构里解析宽高（只走到 IHDR，不解码像素）。
 *
 * 只认真正的 PNG：8 字节签名 + 逐块读 `长度/类型/数据/CRC` 直到 IHDR。
 * 截断、非 PNG、块长度越界都返回 null（不抛错，交给调用方决定怎么提示）。
 * @param {Buffer} buffer - PNG 字节。
 * @param {{ maxChunks?: number }} [options] - 最多扫描多少块（防异常文件）。
 * @returns {{ width: number, height: number } | null} 尺寸；解析不出来为 null。
 */
export function parsePngSize(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) return null;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const maxChunks = intIn(options.maxChunks, 32, 1, 256);
  let offset = PNG_SIGNATURE.length;
  for (let index = 0; index < maxChunks; index += 1) {
    if (offset + 8 > buffer.length) return null;
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    if (length > buffer.length) return null;
    if (type === 'IHDR') {
      if (length < 8 || offset + 16 > buffer.length) return null;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    const next = offset + 8 + length + 4;
    if (next <= offset || next > buffer.length) return null;
    offset = next;
  }
  return null;
}

/**
 * 截图目录只保留最近 `keep` 张 PNG（按文件名排序，名字里带可排序时间戳）。
 * @param {string} dir - 截图目录。
 * @param {number} keep - 保留数量。
 * @returns {Promise<void>} 无。
 */
export async function pruneShots(dir, keep) {
  try {
    const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.png')).sort();
    const excess = names.slice(0, Math.max(0, names.length - keep));
    await Promise.all(excess.map((name) => fsp.rm(path.join(dir, name), { force: true }).catch(() => {})));
  } catch {
    // 清理失败不影响本次截图。
  }
}

// —— 2. logs ——

/**
 * 读日志窗口（文件尾部最多 4 MB，再取最后 `windowLines` 行）。
 * @param {string} file - 日志路径。
 * @param {number} windowLines - 窗口行数。
 * @returns {Promise<{ lines: string[], truncated: boolean, size: number, mtime: Date }>} 窗口。
 */
export async function readLogWindow(file, windowLines) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, start + read);
      if (result.bytesRead <= 0) break;
      read += result.bytesRead;
    }
    let value = buffer.subarray(0, read).toString('utf8');
    let truncated = start > 0;
    if (truncated) {
      // 从中间开始读时，第一行可能是半行：丢掉。
      const newline = value.indexOf('\n');
      value = newline < 0 ? '' : value.slice(newline + 1);
    }
    const all = value.split(/\r?\n/).filter((line) => line !== '');
    return { lines: all.slice(-Math.max(1, windowLines)), truncated, size: stat.size, mtime: stat.mtime };
  } finally {
    await handle.close();
  }
}

/**
 * 读 MAA 日志尾部。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} args - 工具参数。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function logsAction(deps, args) {
  const level = args.level === 'warn' || args.level === 'error' ? args.level : 'all';
  const maxLines = Math.max(10, deps.config.maxLogLines);
  const lines = intIn(args.lines, 80, 1, maxLines);
  const file = deps.paths.logFile;
  let window;
  try {
    window = await readLogWindow(file, maxLines);
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
    throw arkError('E_BAD_ARGS', missing ? `还没有日志文件：${file}` : `读不了日志文件：${file}`, {
      detail: error instanceof Error ? error.message : String(error),
      hint: missing
        ? '先让 MAA 跑一次任务（ark_fight 会启动侧车），日志就会生成；也可以在预设 config 里用 logFile 指定路径。'
        : '确认文件没有被别的程序独占、当前用户有读权限；也可以在预设 config 里用 logFile 换一个路径。',
    });
  }
  const pattern = LEVEL_PATTERNS[level];
  const filtered = pattern === undefined ? window.lines : window.lines.filter((line) => pattern.test(line));
  const tail = filtered.slice(-lines);
  const head = [
    `日志：${file}（${formatBytes(window.size)}，更新于 ${window.mtime.toISOString()}）`,
    `筛选：${level} · 窗口最后 ${maxLines} 行内匹配 ${filtered.length} 行 · 显示 ${tail.length} 行`
    + (window.truncated ? '（文件较大，只读取了尾部 4 MB）' : ''),
    '',
  ];
  if (tail.length === 0) head.push(`（${level} 过滤后没有匹配行；可以 level=all 或加大 lines。）`);
  return text(truncate([...head, ...tail].join('\n'), MAX_REPORT_CHARS));
}

// —— 3. device ——

/**
 * adb / 分辨率 / 机型 / 前台包名自检。
 * @param {object} deps - 依赖。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function deviceAction(deps) {
  const detected = await deps.detect({ fresh: true });
  const lines = [
    `adb：${detected.adbPath || '未找到'} · 设备 ${detected.address || '未知'} · ${detected.emulator?.adbOnline ? '在线' : '离线'}`,
    `模拟器：${detected.emulator?.managerFound ? (detected.emulator.androidStarted ? '已开机' : '未开机') : '未找到 MuMu'}`
    + `（${detected.emulator?.name || '未知实例'} #${detected.emulator?.vmIndex ?? 0}）`,
    `MAA：${detected.maaPath || '未找到'}${detected.vmConfig?.width ? ` · 实例分辨率 ${detected.vmConfig.width}×${detected.vmConfig.height}` : ''}`,
  ];

  if (detected.adbPath === '' || detected.emulator?.adbOnline !== true) {
    lines.push('');
    lines.push('结论：adb 不可用，先解决这一步（游戏画面/分辨率/前台都读不到）。');
    lines.push('建议：① ark_diag action=emulator emulatorAction=start，或手动开 MuMu；'
      + '② 确认 MuMu 的 adb 端口（默认 16384）没被占；'
      + '③ 必要时在预设 config 里写 adbPath，然后 ark_diag action=probe 复测。');
    return text(lines.join('\n'));
  }

  const size = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'wm', 'size']);
  const model = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'getprop', 'ro.product.model']);
  const activity = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'dumpsys', 'activity', 'activities']);
  const resolution = parseWmSize(size.stdout);
  const foreground = parseForeground(activity.stdout);
  lines.push('');
  lines.push(`分辨率：${resolution ?? '未知'}（MAA 需要 16:9）`);
  lines.push(`机型：${String(model.stdout ?? '').trim() || '未知'}`);
  lines.push(`前台：${foreground ?? '识别不到'}`);
  if (foreground !== null) {
    lines.push(
      foreground === GAME_PACKAGE || foreground.startsWith(`${GAME_PACKAGE}/`)
        ? '游戏在前台 ✅'
        : `游戏不在前台（前台是 ${foreground}）——MAA 会自己启动/切回游戏，但手动排查时值得注意。`,
    );
  }
  if (resolution !== null && !is169(resolution)) {
    lines.push('⚠️ 当前不是 16:9 分辨率，MAA 会拒绝识别；请在 MuMu 设置里改成 1920×1080。');
  } else if (resolution !== null && isPortraitSize(resolution)) {
    lines.push(`（wm size 报 ${resolution} 是竖屏尺寸；旋转后实际为横屏 16:9，MAA 以截图分辨率为准。）`);
  }
  return text(lines.join('\n'));
}

/**
 * 解析 `wm size` 输出。
 * @param {string} stdout - 命令输出。
 * @returns {string | null} `宽x高` 或 null。
 */
export function parseWmSize(stdout) {
  const match = /(\d+)\s*x\s*(\d+)/.exec(String(stdout ?? ''));
  return match === null ? null : `${match[1]}x${match[2]}`;
}

/**
 * 解析前台包名（从 `dumpsys activity activities` 里找 ResumedActivity / topResumedActivity）。
 * @param {string} stdout - 命令输出。
 * @returns {string | null} 包名（可能带 `/Activity`）或 null。
 */
export function parseForeground(stdout) {
  const value = String(stdout ?? '');
  const resumed = /ResumedActivity[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(value);
  if (resumed !== null) return `${resumed[1]}/${resumed[2]}`;
  const top = /topResumedActivity[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(value);
  if (top !== null) return `${top[1]}/${top[2]}`;
  return null;
}

/**
 * 判断分辨率是否 16:9（横竖屏都算：MuMu 的 `wm size` 常报竖屏物理尺寸，实际截图是横屏）。
 * @param {string} resolution - `宽x高`。
 * @returns {boolean} 是 16:9 为 true。
 */
export function is169(resolution) {
  const match = /^(\d+)x(\d+)$/.exec(String(resolution ?? ''));
  if (match === null) return true;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) return true;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return Math.abs(ratio - 16 / 9) < 0.02;
}

/**
 * 分辨率是否是竖屏报告（`wm size` 报 1080x1920 这类）。
 * @param {string} resolution - `宽x高`。
 * @returns {boolean} 宽小于高为 true。
 */
function isPortraitSize(resolution) {
  const match = /^(\d+)x(\d+)$/.exec(String(resolution ?? ''));
  if (match === null) return false;
  return Number.parseInt(match[1], 10) < Number.parseInt(match[2], 10);
}

// —— 4. emulator ——

/**
 * MuMu 状态 / 启动 / 关闭（走 MuMuManager）。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} args - 工具参数。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function emulatorAction(deps, args) {
  const requested = args.emulatorAction === undefined ? 'status' : String(args.emulatorAction).trim();
  if (requested !== 'status' && requested !== 'start' && requested !== 'stop') {
    throw arkError('E_BAD_ARGS', `emulatorAction 只能是 status / start / stop，收到「${requested || '空'}」。`, {
      hint: '例如 ark_diag action=emulator emulatorAction=status。',
    });
  }
  const action = requested;
  const detected = await deps.detect({ fresh: true });
  if (detected.managerPath === '') {
    throw arkError('E_EMULATOR_NOT_FOUND', '没找到 MuMuManager.exe。', {
      detail: `试过：${attemptsText(detected.mumuTried)}`,
      hint: '在预设行 config 里写 mumuInstallPath 或 managerPath，然后 ark_diag action=probe 复测。',
    });
  }
  const vmIndex = detected.vmIndex ?? 0;
  if (action === 'status') return text(renderEmulatorStatus(detected));
  if (action === 'stop') {
    const result = await deps.run.cli(detected.managerPath, ['control', '-v', String(vmIndex), 'shutdown'], { timeoutMs: 30000 });
    if (!result.ok) {
      throw arkError('E_EMULATOR_START', '关闭模拟器失败。', {
        detail: String(result.stderr ?? '').slice(0, 300),
        hint: '手动关闭 MuMu 窗口；若进程卡死，用任务管理器结束 MuMu 相关进程。',
      });
    }
    return text(`已发送关闭指令（实例 #${vmIndex}）。`);
  }

  if (detected.emulator?.androidStarted === true) {
    return text(`模拟器已经开机，不需要再 start。\n${renderEmulatorStatus(detected)}`);
  }
  const launched = await deps.run.cli(detected.managerPath, ['control', '-v', String(vmIndex), 'launch'], { timeoutMs: 30000 });
  if (!launched.ok) {
    throw arkError('E_EMULATOR_START', '拉起模拟器失败。', {
      detail: String(launched.stderr ?? '').slice(0, 300),
      hint: '手动启动一次 MuMu，确认能进桌面。',
    });
  }
  const startedAt = Date.now();
  const deadline = startedAt + deps.config.launchTimeoutMs;
  let last = detected;
  while (Date.now() < deadline) {
    await deps.sleep(3000);
    last = await deps.detect({ fresh: true });
    if (last.emulator?.androidStarted === true) {
      return text(`模拟器已开机（用时约 ${Math.round((Date.now() - startedAt) / 1000)}s）。\n${renderEmulatorStatus(last)}`);
    }
  }
  throw arkError('E_EMULATOR_START', `模拟器在 ${Math.round(deps.config.launchTimeoutMs / 1000)}s 内没有开机完成。`, {
    detail: renderEmulatorStatus(last),
    hint: '手动启动一次 MuMu，确认能进桌面后再重试；也可以在预设 config 里加大 launchTimeoutMs。',
  });
}

/**
 * 渲染模拟器状态。
 * @param {Record<string, any>} detected - 探测结果。
 * @returns {string} 文本。
 */
export function renderEmulatorStatus(detected) {
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

// —— 5. game ——

/**
 * 启动 / 关闭游戏本体（adb `am start` / `am force-stop`）。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} args - 工具参数。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function gameAction(deps, args) {
  const action = String(args.gameAction ?? '').trim();
  if (action !== 'start' && action !== 'stop') {
    throw arkError('E_BAD_ARGS', 'action=game 必须显式给 gameAction=start 或 stop。', {
      hint: '例如 ark_diag action=game gameAction=start；MAA 的 StartUp 一般会自己启动游戏，正常打关不需要手动调用。',
    });
  }
  const detected = await deps.detect();
  if (detected.adbPath === '' || detected.emulator?.adbOnline !== true) {
    throw arkError('E_CONNECT', 'adb 不在线，操作不了游戏进程。', {
      hint: '先 ark_diag action=emulator emulatorAction=start，或用 ark_diag action=device 看现场。',
    });
  }
  const target = await resolveGameTarget(detected.maaPath, deps.config.clientType);
  if (action === 'start') {
    const result = await deps.run.adb(
      detected.adbPath,
      detected.address,
      ['shell', 'am', 'start', '-n', `${target.packageName}/${target.component}`],
    );
    if (!result.ok && !/Warning|Error type 3/.test(String(result.stderr ?? ''))) {
      throw arkError('E_CONNECT', 'am start 失败。', { detail: String(result.stderr ?? '').slice(0, 300) });
    }
    return text(
      `已发送启动：${target.packageName}/${target.component}`
      + `${target.source === 'maa' ? '（包名来自 MAA config.json）' : '（兜底默认包名）'}\n`
      + '游戏启动到主界面大约 30–90 秒；之后用 ark_diag action=screen 或 action=device 确认。',
    );
  }
  const result = await deps.run.adb(detected.adbPath, detected.address, ['shell', 'am', 'force-stop', target.packageName]);
  if (!result.ok) throw arkError('E_CONNECT', 'am force-stop 失败。', { detail: String(result.stderr ?? '').slice(0, 300) });
  return text(`已强制关闭 ${target.packageName}。`);
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
    const component = parseStartComponent(typeof general?.start === 'string' ? general.start : '') ?? DEFAULT_COMPONENT;
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

// —— 6. probe ——

/**
 * 重新探测环境（MAA / Python / MuMu / adb / 模拟器三态）。
 * @param {object} deps - 依赖。
 * @returns {Promise<{ text: string }>} 文本结果。
 */
async function probeAction(deps) {
  const detected = await deps.detect({ fresh: true, includePython: true });
  const lines = ['环境探测（只读：不启动 MAA / 模拟器，也不连接设备）', ''];

  lines.push(`MAA：${detected.maaPath || '未找到'}`);
  if (!detected.maaPath) {
    lines.push(`  试过：${attemptsText(detected.maaTried)}`);
  } else {
    const resources = await hasMaaResources(detected.maaPath);
    lines.push(`  资源：${resources ? 'resource/stages.json 存在' : '缺 resource/stages.json（MAA 资源可能不完整，需要启动一次 MAA 更新）'}`);
  }

  lines.push(`Python：${detected.pythonPath ? `${detected.pythonPath}（${detected.pythonVersion}）` : '未找到'}`);
  if (!detected.pythonPath) {
    lines.push(`  试过：${attemptsText(detected.pythonTried)}`);
    lines.push('  提示：全局插件需要可用 Python；Store 版 python.exe 是占位符，探测会跳过。');
  }

  lines.push(`MuMu：${detected.mumuInstallPath || '未找到'}`);
  if (detected.managerPath) lines.push(`  MuMuManager：${detected.managerPath}`);
  if (!detected.mumuInstallPath) lines.push(`  试过：${attemptsText(detected.mumuTried)}`);

  lines.push(`adb：${detected.adbPath || '未找到'} · 设备 ${detected.address || '未知'} · ${detected.emulator?.adbOnline ? '在线' : '离线'}`);
  if (!detected.adbPath) lines.push(`  试过：${attemptsText(detected.adbTried)}`);

  lines.push('');
  lines.push(renderEmulatorStatus(detected));

  const problems = [];
  if (!detected.maaPath) problems.push('MAA 路径没探测到：在预设 config 写 maaPath（含 MaaCore.dll 的那一层）。');
  if (!detected.pythonPath) problems.push('Python 没探测到：全局插件需要它，可检查 .dsh 运行时或配置 pythonPath。');
  if (!detected.mumuInstallPath) problems.push('MuMu 没探测到：在预设 config 写 mumuInstallPath（MuMu 安装目录）。');
  if (!detected.adbPath) problems.push('adb 没探测到：在预设 config 写 adbPath（一般用 MuMu 自带的 shell\\adb.exe）。');
  if (detected.adbPath !== '' && detected.emulator?.adbOnline !== true) {
    problems.push('adb 离线：先 ark_diag action=emulator emulatorAction=start，再复测。');
  }
  lines.push('');
  if (problems.length === 0) {
    lines.push('结论：链路探测全部通过。进一步排查用 action=device / screen / logs，或全局 ark_status。');
  } else {
    lines.push('结论：有未通过项（按顺序处理）：');
    for (const problem of problems) lines.push(`- ${problem}`);
  }
  return text(truncate(lines.join('\n'), MAX_REPORT_CHARS));
}

/**
 * MAA 资源是否可见（只看 `resource/stages.json`）。
 * @param {string} maaPath - MAA 安装根。
 * @returns {Promise<boolean>} 存在为 true。
 */
async function hasMaaResources(maaPath) {
  try {
    await fsp.access(path.join(maaPath, 'resource', 'stages.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把「试过的路径」渲染成一行。
 * @param {unknown} tried - 路径数组。
 * @returns {string} 文本。
 */
function attemptsText(tried) {
  if (!Array.isArray(tried) || tried.length === 0) return '（没有候选路径）';
  return tried.slice(0, 6).join('；');
}

/** 供测试用。 */
export { DEFAULT_COMPONENT, DEFAULT_PACKAGE, GAME_PACKAGE, MAX_TAIL_BYTES, PNG_SIGNATURE };

/**
 * 环境探测：MAA / Python / MuMu / adb 的路径与运行时状态。
 *
 * 设计原则：
 * - **有界**：只扫固定盘根的一层目录 + 少量已知位置，不做全盘递归；
 * - **可解释**：每个探测不到的东西都带回「试过哪些路径」，直接进错误提示；
 * - **不捣乱**：探测只读文件系统与 `MuMuManager info`，绝不启动模拟器、绝不碰 MAA。
 *
 * @module @local/arknights/detect
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 盘符候选（找不到就跳过，不报错）。 */
const DRIVES = ['C:', 'D:', 'E:', 'F:'];
/** 目录名里出现这些词就当作 MAA / MuMu 候选。 */
const MAA_DIR_HINT = /maa|maaassistant|mvia/i;
const MUMU_DIR_HINT = /mumu|yxarknights|netease|网易/i;
/** 已探测结果的短时缓存（状态路由每 3s 轮询，不能每次都 spawn）。 */
const emulatorCache = new Map();

/**
 * 文件是否存在。
 * @param {string} target - 路径。
 * @returns {Promise<boolean>} 存在为 true。
 */
async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列目录（失败给空数组）。
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 子项名。
 */
async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * 列出「可能装着 MAA / MuMu 的父目录」（固定盘根、Program Files、Games 等）。
 * 有些用户把模拟器装在盘根的 Program Files 下（而不是系统盘），所以这些目录都要扫。
 * @returns {Promise<string[]>} 父目录绝对路径。
 */
async function listCandidateParents() {
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const drive of DRIVES) {
    dirs.add(`${drive}\\`);
    dirs.add(`${drive}\\Program Files`);
    dirs.add(`${drive}\\Program Files (x86)`);
    dirs.add(`${drive}\\Games`);
  }
  for (const extra of [
    process.env.LOCALAPPDATA ?? '',
    process.env.ProgramFiles ?? '',
    process.env['ProgramFiles(x86)'] ?? '',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
  ]) {
    if (extra !== '') dirs.add(extra);
  }
  return [...dirs];
}

/**
 * 列出所有候选安装目录（父目录的子项，一层）。
 * @returns {Promise<string[]>} 候选目录。
 */
async function listInstallCandidates() {
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const parent of await listCandidateParents()) {
    for (const name of await readdirSafe(parent)) {
      const full = path.join(parent, name);
      candidates.add(full);
    }
  }
  return [...candidates];
}

/**
 * 找 MAA 安装根（含 `MaaCore.dll` 的那一层）。
 * @param {{ maaPath?: string }} config - 生效配置。
 * @returns {Promise<{ path: string, tried: string[] }>} 结果；找不到时 path 为空串。
 */
export async function findMaaPath(config = {}) {
  const tried = [];
  const direct = typeof config.maaPath === 'string' ? config.maaPath.trim() : '';
  if (direct !== '') {
    tried.push(direct);
    if (await exists(path.join(direct, 'MaaCore.dll'))) return { path: direct, tried };
  }

  const candidates = new Set();
  for (const candidate of await listInstallCandidates()) {
    if (MAA_DIR_HINT.test(path.basename(candidate))) candidates.add(candidate);
  }

  for (const candidate of candidates) {
    tried.push(candidate);
    if (await exists(path.join(candidate, 'MaaCore.dll'))) return { path: candidate, tried };
    // 有些发行版多套一层
    for (const child of await readdirSafe(candidate)) {
      const nested = path.join(candidate, child);
      if (MAA_DIR_HINT.test(child) && (await exists(path.join(nested, 'MaaCore.dll')))) {
        tried.push(nested);
        return { path: nested, tried };
      }
    }
  }
  return { path: '', tried };
}

/**
 * 候选 Python 列表（按优先级）。
 * @param {{ pythonPath?: string }} config - 生效配置。
 * @returns {Promise<string[]>} 候选路径。
 */
export async function pythonCandidates(config = {}) {
  /** @type {string[]} */
  const list = [];
  const configured = typeof config.pythonPath === 'string' ? config.pythonPath.trim() : '';
  if (configured !== '') list.push(configured);

  // .dsh 运行时自带的 python（本机实测可用）
  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  for (const name of await readdirSafe(runtimes)) {
    list.push(path.join(runtimes, name, 'dependencies', 'python', 'python.exe'));
  }
  // 常见安装位置
  for (const extra of [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files'),
    'C:\\',
  ]) {
    if (extra === '') continue;
    for (const name of await readdirSafe(extra)) {
      if (/^python3?\d*/i.test(name)) {
        list.push(path.join(extra, name, 'python.exe'));
        list.push(path.join(extra, name, 'python3.exe'));
      }
    }
  }
  // 环境变量里登记的解释器
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '')
    .map((entry) => path.join(entry, 'python.exe'));
  list.push(...fromPath);

  return [...new Set(list)];
}

/**
 * 验证一个 python 是否真的能跑（Store 占位符会失败）。
 * @param {string} pythonPath - 解释器路径。
 * @returns {Promise<{ path: string, version: string } | null>} 可用时返回版本。
 */
export function probePython(pythonPath) {
  return new Promise((resolve) => {
    if (typeof pythonPath !== 'string' || pythonPath === '') {
      resolve(null);
      return;
    }
    execFile(
      pythonPath,
      ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          resolve(null);
          return;
        }
        const version = String(stdout ?? '').trim();
        resolve(/^\d+\.\d+\.\d+$/.test(version) ? { path: pythonPath, version } : null);
      },
    );
  });
}

/**
 * 找可用的 Python。
 * @param {{ pythonPath?: string }} config - 生效配置。
 * @returns {Promise<{ path: string, version: string, tried: string[] }>} 结果；找不到时 path 为空串。
 */
export async function findPython(config = {}) {
  const candidates = await pythonCandidates(config);
  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (!(await exists(candidate))) continue;
    const probed = await probePython(candidate);
    if (probed !== null) return { path: probed.path, version: probed.version, tried };
  }
  return { path: '', version: '', tried };
}

/**
 * 找 MuMu 安装目录（含 `shell\\MuMuManager.exe`）。
 * @param {{ emulator?: { installPath?: string } }} config - 生效配置。
 * @returns {Promise<{ path: string, managerPath: string, tried: string[] }>} 结果。
 */
export async function findMuMu(config = {}) {
  const tried = [];
  const configured = typeof config?.emulator?.installPath === 'string' ? config.emulator.installPath.trim() : '';
  if (configured !== '') {
    tried.push(configured);
    const managerPath = path.join(configured, 'shell', 'MuMuManager.exe');
    if (await exists(managerPath)) return { path: configured, managerPath, tried };
  }
  const managerConfigured = typeof config?.emulator?.managerPath === 'string' ? config.emulator.managerPath.trim() : '';
  if (managerConfigured !== '' && (await exists(managerConfigured))) {
    return { path: path.dirname(path.dirname(managerConfigured)), managerPath: managerConfigured, tried };
  }

  for (const candidate of await listInstallCandidates()) {
    if (!MUMU_DIR_HINT.test(path.basename(candidate))) continue;
    tried.push(candidate);
    const managerPath = path.join(candidate, 'shell', 'MuMuManager.exe');
    if (await exists(managerPath)) return { path: candidate, managerPath, tried };
    for (const child of await readdirSafe(candidate)) {
      const nested = path.join(candidate, child);
      if (!MUMU_DIR_HINT.test(child)) continue;
      const nestedManager = path.join(nested, 'shell', 'MuMuManager.exe');
      if (await exists(nestedManager)) {
        tried.push(nested);
        return { path: nested, managerPath: nestedManager, tried };
      }
    }
  }
  return { path: '', managerPath: '', tried };
}

/**
 * 读 MuMu 实例配置（adb 端口、分辨率、实例名）。
 * @param {string} installPath - MuMu 安装目录。
 * @param {number} [vmIndex] - 实例序号（按 vms 目录名排序）。
 * @returns {Promise<{ vmIndex: number, adbPort: number, width: number, height: number, vmsDir: string } | null>} 结果。
 */
export async function readVmConfig(installPath, vmIndex = 0) {
  const vmsDir = path.join(installPath, 'vms');
  const instances = (await readdirSafe(vmsDir)).sort();
  const chosen = instances[vmIndex] ?? instances[0];
  if (chosen === undefined) return null;

  let adbPort = 16384;
  let width = 0;
  let height = 0;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(vmsDir, chosen, 'configs', 'vm_config.json'), 'utf8'));
    const port = Number.parseInt(String(raw?.vm?.nat?.port_forward?.adb?.host_port ?? ''), 10);
    if (Number.isFinite(port) && port > 0) adbPort = port;
  } catch {
    // 端口读不到就用默认 16384
  }
  try {
    const shellRaw = JSON.parse(await fsp.readFile(path.join(vmsDir, chosen, 'configs', 'shell_config.json'), 'utf8'));
    const w = Math.round(Number(shellRaw?.renderer?.resolution?.width ?? 0));
    const h = Math.round(Number(shellRaw?.renderer?.resolution?.height ?? 0));
    if (w > 0 && h > 0) {
      width = w;
      height = h;
    }
  } catch {
    // 分辨率读不到就留空
  }
  return { vmIndex: instances.indexOf(chosen), adbPort, width, height, vmsDir: path.join(vmsDir, chosen) };
}

/**
 * 找 adb。
 * @param {{ adbPath?: string }} config - 生效配置。
 * @param {{ mumuInstallPath?: string, maaPath?: string }} hints - 已探测到的安装目录。
 * @returns {Promise<{ path: string, tried: string[] }>} 结果。
 */
export async function findAdb(config = {}, hints = {}) {
  const tried = [];
  const configured = typeof config.adbPath === 'string' ? config.adbPath.trim() : '';
  if (configured !== '') {
    tried.push(configured);
    if (await exists(configured)) return { path: configured, tried };
  }
  for (const candidate of [
    hints.mumuInstallPath ? path.join(hints.mumuInstallPath, 'shell', 'adb.exe') : '',
    hints.maaPath ? path.join(hints.maaPath, 'adb.exe') : '',
    hints.maaPath ? path.join(hints.maaPath, 'externals', 'platform-tools', 'adb.exe') : '',
  ]) {
    if (candidate === '') continue;
    tried.push(candidate);
    if (await exists(candidate)) return { path: candidate, tried };
  }
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry === '') continue;
    const candidate = path.join(entry, 'adb.exe');
    if (await exists(candidate)) {
      tried.push(candidate);
      return { path: candidate, tried };
    }
  }
  return { path: '', tried };
}

/**
 * 跑 `MuMuManager info -v <index>` 拿运行状态。
 * @param {string} managerPath - MuMuManager.exe。
 * @param {number} vmIndex - 实例序号。
 * @returns {Promise<Record<string, any> | null>} 解析后的 JSON；失败为 null。
 */
export function queryMuMuInfo(managerPath, vmIndex) {
  return new Promise((resolve) => {
    if (typeof managerPath !== 'string' || managerPath === '') {
      resolve(null);
      return;
    }
    execFile(
      managerPath,
      ['info', '-v', String(vmIndex)],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout ?? ''));
          resolve(parsed !== null && typeof parsed === 'object' ? parsed : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * 在设备上跑一条 adb shell 命令（用来关闭弹窗这类轻量操作）。
 * @param {string} adbPath - adb 路径。
 * @param {string} address - `host:port`。
 * @param {string[]} command - shell 命令参数（如 `['input','keyevent','4']`）。
 * @returns {Promise<{ ok: boolean, stdout: string }>} 结果。
 */
export function adbShell(adbPath, address, command) {
  return new Promise((resolve) => {
    if (typeof adbPath !== 'string' || adbPath === '' || typeof address !== 'string' || address === ''
      || !Array.isArray(command) || command.length === 0) {
      resolve({ ok: false, stdout: '' });
      return;
    }
    execFile(
      adbPath,
      ['-s', address, 'shell', ...command],
      { timeout: 10000, windowsHide: true },
      (error, stdout) => resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') }),
    );
  });
}

/**
 * 判断 adb 上有没有目标设备。
 * @param {string} adbPath - adb 路径。
 * @param {string} address - `host:port`。
 * @returns {Promise<boolean>} 在线为 true。
 */
export function adbDeviceOnline(adbPath, address) {
  return new Promise((resolve) => {
    if (typeof adbPath !== 'string' || adbPath === '' || typeof address !== 'string' || address === '') {
      resolve(false);
      return;
    }
    execFile(
      adbPath,
      ['devices'],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          resolve(false);
          return;
        }
        const text = String(stdout ?? '');
        resolve(text.split(/\r?\n/).some((line) => line.startsWith(address) && /\bdevice\b/.test(line)));
      },
    );
  });
}

/**
 * 主动让 adb 连一次（adb connect），忽略结果，只为了后续 devices 能看到。
 * @param {string} adbPath - adb 路径。
 * @param {string} address - `host:port`。
 * @returns {Promise<void>} 无。
 */
export function adbConnect(adbPath, address) {
  return new Promise((resolve) => {
    if (typeof adbPath !== 'string' || adbPath === '' || typeof address !== 'string' || address === '') {
      resolve();
      return;
    }
    execFile(adbPath, ['connect', address], { timeout: 10000, windowsHide: true }, () => resolve());
  });
}

/**
 * 探测整套环境（**不启动任何东西**）。
 * @param {any} config - 生效配置。
 * @param {{ fresh?: boolean }} [options] - 忽略缓存。
 * @returns {Promise<Record<string, any>>} 探测结果。
 */
export async function detectAll(config, options = {}) {
  const maa = await findMaaPath(config);
  const [python, mumu] = await Promise.all([findPython(config), findMuMu(config)]);
  const vm = mumu.path !== '' ? await readVmConfig(mumu.path, config?.emulator?.vmIndex ?? 0) : null;
  const adb = await findAdb(config, { mumuInstallPath: mumu.path, maaPath: maa.path });

  const adbPort = vm?.adbPort ?? 16384;
  const address = typeof config.address === 'string' && config.address !== ''
    ? config.address
    : `127.0.0.1:${adbPort}`;

  const emulator = await probeEmulator({ managerPath: mumu.managerPath, vmIndex: vm?.vmIndex ?? 0, adbPath: adb.path, address }, options);

  return {
    maaPath: maa.path,
    maaTried: maa.tried,
    pythonPath: python.path,
    pythonVersion: python.version,
    pythonTried: python.tried,
    mumuInstallPath: mumu.path,
    managerPath: mumu.managerPath,
    mumuTried: mumu.tried,
    vmConfig: vm,
    adbPath: adb.path,
    adbTried: adb.tried,
    address,
    adbPort,
    emulator,
  };
}

/**
 * 探测模拟器状态（带 TTL 缓存，避免状态路由每 3s 都 spawn 一次）。
 * @param {{ managerPath: string, vmIndex: number, adbPath: string, address: string }} input - 探测输入。
 * @param {{ fresh?: boolean, ttlMs?: number }} [options] - 缓存选项。
 * @returns {Promise<Record<string, any>>} 状态。
 */
export async function probeEmulator(input, options = {}) {
  const key = `${input.managerPath}|${input.vmIndex}|${input.address}`;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 5000;
  const cached = emulatorCache.get(key);
  const fresh = options.fresh === true;
  if (!fresh && cached !== undefined && Date.now() - cached.at < ttlMs) return cached.value;

  const info = await queryMuMuInfo(input.managerPath, input.vmIndex);
  const online = await adbDeviceOnline(input.adbPath, input.address);
  const value = {
    managerFound: input.managerPath !== '',
    running: info?.is_process_started === true,
    androidStarted: info?.is_android_started === true,
    adbOnline: online,
    vmIndex: input.vmIndex,
    name: typeof info?.name === 'string' ? info.name : '',
    errorCode: Number.isInteger(info?.error_code) ? info.error_code : null,
  };
  emulatorCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 清掉模拟器探测缓存（启动/关闭模拟器后调用）。
 * @returns {void}
 */
export function clearEmulatorCache() {
  emulatorCache.clear();
}

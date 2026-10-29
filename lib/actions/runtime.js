/**
 * 动作运行时：把「环境就绪 + 追加任务 + 等待链结束 + 关弹窗」收成可复用原语。
 *
 * P2（战斗）与 P3（日常）都只通过这里动 MAA，避免各写一套 ensureReady / waitForIdle。
 * 不持有 run store：单飞与确认在更上层（lib/actions/shared.js + 各动作）。
 *
 * @module @local/arknights/actions/runtime
 */

import { execFile } from 'node:child_process';

import { adbConnect, adbDeviceOnline, adbShell, clearEmulatorCache } from '../detect.js';
import { arkError } from '../errors.js';
import { sleep, waitFor } from './shared.js';

/** 状态轮询间隔。 */
const POLL_MS = 1000;

/**
 * 造动作运行时。
 * @param {{ config: Record<string, any>, paths: Record<string, any>, env: any, session: any,
 *   state: any, logger?: any }} deps - 依赖。
 * @returns {Record<string, any>} 运行时。
 */
export function createRuntime(deps) {
  const { config, env, session, state, logger } = deps;
  /**
   * 跑外部命令（模拟器控制用）。
   * @param {string} file - 可执行文件。
   * @param {string[]} args - 参数。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<{ok:boolean,stdout:string,error?:string}>} 结果。
   */
  const run = (file, args, timeoutMs) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        stdout: String(stdout ?? ''),
        ...(error === null || error === undefined ? {} : { error: String(stderr ?? error.message) }),
      });
    });
  });

  /**
   * 准备「能打」的状态：模拟器开机 → adb 在线 → MaaCore 连接。
   * @param {{ autoStart?: boolean, startup?: boolean, signal?: AbortSignal }} [options] - 选项。
   * @returns {Promise<Record<string, any>>} 连接信息与探测结果。
   */
  const ensureReady = async (options = {}) => {
    const autoStart = options.autoStart !== false;
    env.clear();
    const detected = await env.get({ fresh: true });

    if (detected.pythonPath === '') {
      throw arkError('E_PYTHON_NOT_FOUND', '没有找到可用的 Python 解释器。', {
        detail: `试过：${detected.pythonTried.slice(0, 8).join('；')}`,
        hint: '在 cordis.patch.yml 的 arknights 行里把 pythonPath 指到可用的 python.exe。',
      });
    }
    if (detected.maaPath === '') {
      throw arkError('E_MAA_NOT_FOUND', '没有找到 MAA 的 MaaCore.dll。', {
        detail: `试过：${detected.maaTried.slice(0, 8).join('；')}`,
        hint: '把 maaPath 指到 MAA 安装目录（含 MaaCore.dll 的那层）。',
      });
    }
    if (detected.managerPath === '') {
      throw arkError('E_EMULATOR_NOT_FOUND', '没有找到 MuMuManager.exe。', {
        detail: `试过：${detected.mumuTried.slice(0, 8).join('；')}`,
        hint: '在配置里指定 emulator.installPath（MuMu 安装目录）。',
      });
    }
    if (detected.adbPath === '') {
      throw arkError('E_ADB_NOT_FOUND', '没有找到 adb。', {
        detail: `试过：${detected.adbTried.slice(0, 8).join('；')}`,
        hint: '默认用 MuMu 自带的 shell\\adb.exe；被移动过就配置 adbPath。',
      });
    }

    // 1) 模拟器开机
    let current = detected;
    if (!current.emulator.androidStarted) {
      if (!autoStart) {
        throw arkError('E_EMULATOR_START', '模拟器没有开机（autoStart=false，不会自动拉起）。', {
          hint: '先手动启动 MuMu，或允许自动拉起。',
        });
      }
      logger?.info?.('[arknights] 模拟器未开机，正在拉起…');
      await run(current.managerPath, ['control', '-v', String(current.emulator.vmIndex ?? 0), 'launch'], 30000);
      clearEmulatorCache();
      const deadline = Date.now() + config.emulator.launchTimeoutMs;
      let started = false;
      while (Date.now() < deadline) {
        if (options.signal?.aborted === true) throw arkError('E_ABORTED', '操作被中止。');
        env.clear();
        current = await env.get({ fresh: true });
        if (current.emulator.androidStarted) {
          started = true;
          break;
        }
        await sleep(3000);
      }
      if (!started) {
        throw arkError('E_EMULATOR_START', `模拟器在 ${Math.round(config.emulator.launchTimeoutMs / 1000)}s 内没有开机完成。`, {
          hint: '手动启动一次 MuMu，确认能进桌面后再重试。',
        });
      }
    }

    // 2) adb 连上
    await adbConnect(current.adbPath, current.address);
    const adbDeadline = Date.now() + config.connectTimeoutMs;
    let online = await adbDeviceOnline(current.adbPath, current.address);
    while (!online && Date.now() < adbDeadline) {
      if (options.signal?.aborted === true) throw arkError('E_ABORTED', '操作被中止。');
      await sleep(2000);
      await adbConnect(current.adbPath, current.address);
      online = await adbDeviceOnline(current.adbPath, current.address);
    }
    if (!online) {
      throw arkError('E_CONNECT', `adb 在 ${Math.round(config.connectTimeoutMs / 1000)}s 内没看到设备 ${current.address}。`, {
        hint: '确认模拟器已开机；MuMu 的 adb 端口默认 16384（可在 MuMu 设置里查）。',
      });
    }
    clearEmulatorCache();
    env.clear();

    // 3) MaaCore 连接
    const initInfo = await session.ensureStarted();
    logger?.info?.(`[arknights] MaaCore ${initInfo.coreVersion ?? '?'} 就绪。`);
    const connected = await session.request('connected', {}, { timeoutMs: 10000 });
    if (connected.connected !== true) {
      await session.request('connect', {
        adbPath: current.adbPath,
        address: current.address,
        config: config.connectionConfig,
        clientType: config.clientType,
      }, { timeoutMs: config.connectTimeoutMs });
    }

    // 4) 可选：回主界面（StartUp 任务零理智；日常/仓库/战斗前使用）
    if (options.startup === true && config.startup?.enabled !== false) {
      const startup = await runTaskChain({
        type: 'StartUp',
        params: {
          client_type: config.clientType,
          start_game_enabled: config.startup?.startGameEnabled === true,
        },
        timeoutMs: config.startup?.timeoutMs ?? config.startupTimeoutMs,
        signal: options.signal,
      });
      const chainFailed = Array.isArray(startup.chains) && startup.chains.some((chain) => chain?.status === 'error');
      if (startup.waited.timedOut === true || chainFailed) {
        throw arkError('E_NOT_READY', 'StartUp 没有把游戏带到主界面。', {
          detail: `超时=${startup.waited.timedOut === true}；链错误=${chainFailed}；最近事件见 ark_status。`,
          hint: '确认游戏已安装/已登录；必要时手动打开一次游戏，或把 startup.startGameEnabled 设为 true。',
        });
      }
    }

    if (typeof deps.onReady === 'function') {
      try {
        deps.onReady({ address: current.address, detection: current, initInfo });
      } catch {
        // 连接状态回调失败不影响动作。
      }
    }
    return { address: current.address, detection: current, initInfo };
  };

  /**
   * 等到任务链空闲（或超时 / 命中中止条件）。
   * @param {{ timeoutMs: number, shouldAbort?: () => string | null, signal?: AbortSignal }} options - 选项。
   * @returns {Promise<{timedOut:boolean,aborted:string|null}>} 结果。
   */
  const waitForIdle = async (options) => {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (options.signal?.aborted === true) return { timedOut: false, aborted: 'stopped' };
      const abortReason = typeof options.shouldAbort === 'function' ? options.shouldAbort() : null;
      if (abortReason !== null) return { timedOut: false, aborted: abortReason };
      const running = await session.request('running', {}, { timeoutMs: 10000 });
      if (running.running !== true) return { timedOut: false, aborted: null };
      await sleep(POLL_MS);
    }
    return { timedOut: true, aborted: null };
  };

  /**
   * 只追加并启动，不等待（肉鸽后台模式用）。
   * @param {string} type - 任务类型。
   * @param {Record<string, any>} params - 参数。
   * @returns {Promise<{taskId:number}>} 结果。
   */
  const appendAndStart = async (type, params) => {
    const appended = await session.request('append', { type, params });
    if (!Number.isFinite(appended.taskId) || appended.taskId <= 0) {
      throw arkError('E_TASK_TYPE', `MAA 不接受 ${type} 任务参数。`);
    }
    await session.request('start', {}, { timeoutMs: 15000 });
    return { taskId: appended.taskId };
  };

  /**
   * 追加任务、启动、等到链结束（一次只跑一条链）。
   * @param {{ type: string, params: Record<string, any>, timeoutMs: number,
   *   shouldAbort?: () => string | null, signal?: AbortSignal }} input - 输入。
   * @returns {Promise<{taskId:number, waited:{timedOut:boolean,aborted:string|null},
   *   stars:number|null, drops:Record<string,number>, chains:Array<Record<string,any>>,
   *   branch:string|null}>} 结果。
   */
  const runTaskChain = async (input) => {
    state.resetChain();
    session.hold();
    try {
      const { taskId } = await appendAndStart(input.type, input.params);
      const waited = await waitForIdle({
        timeoutMs: input.timeoutMs,
        ...(typeof input.shouldAbort === 'function' ? { shouldAbort: input.shouldAbort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        taskId,
        waited,
        stars: state.getStars(),
        drops: state.getDrops(),
        chains: state.getChains(),
        branch: state.getBranch(),
      };
    } finally {
      session.release();
    }
  };

  /** 尽力停一下（失败无所谓）。 */
  const stopQuietly = async () => {
    try {
      await session.request('stop', {}, { timeoutMs: 15000 });
    } catch {
      // 停不下来也要让上层继续报原始错误。
    }
  };

  /**
   * 关掉挡在前面的弹窗（理智不足对话框等），按 BACK 一到两次。
   * @param {number} [times] - 按几次。
   * @returns {Promise<void>} 无。
   */
  const dismissOverlays = async (times = 1) => {
    try {
      const detected = await env.get();
      for (let index = 0; index < times; index += 1) {
        await adbShell(detected.adbPath, detected.address, ['input', 'keyevent', '4']);
        await sleep(700);
      }
    } catch {
      // 关不掉也不影响后续报错。
    }
  };

  /**
   * 截图（优先 sidecar 的 AsstGetImage，失败回退 adb）。
   * @param {{ dir: string, prefix?: string }} options - 落盘目录与前缀。
   * @returns {Promise<{path:string,method:string}>} 结果。
   */
  const screenshot = async (options) => {
    if (typeof session.screenshot === 'function') {
      try {
        const shot = await session.screenshot({ dir: options.dir, prefix: options.prefix });
        if (shot?.path) return { path: shot.path, method: 'maa' };
      } catch {
        // 回退 adb。
      }
    }
    const detected = await env.get();
    const target = `${options.dir}/${options.prefix ?? 'shot'}-${Date.now()}.png`;
    const result = await adbShell(detected.adbPath, detected.address, ['exec-out', 'screencap', '-p']);
    if (!result.ok || typeof result.stdout !== 'string') {
      throw arkError('E_DIAGNOSE', '截图失败（MAA 与 adb 都不可用）。');
    }
    const fs = await import('node:fs/promises');
    await fs.mkdir(options.dir, { recursive: true });
    await fs.writeFile(target, Buffer.from(result.stdout, 'binary'));
    return { path: target, method: 'adb' };
  };

  return {
    ensureReady,
    waitForIdle,
    appendAndStart,
    runTaskChain,
    stopQuietly,
    dismissOverlays,
    screenshot,
  };
}

/**
 * 单关执行器：把「打这一关」翻译成 MAA 任务，并把结果判成几种结局。
 *
 * 判据全部来自事件（docs/contracts.md §6），不猜画面：
 * - `StageDrops.stars=3` → 满星；
 * - `StageDrops.stars<3` / `NotThreeStars` → 打通但未满星；
 * - `UnableToAgent*` → 没有代理指挥（未满星或借过干员），MAA 会在开战前 Stop（零理智）→ 改抄作业；
 * - `StageQueueStageNotFound` → 关卡未解锁/代码不对 → 停在原地，不换关。
 *
 * @module @local/arknights/runner
 */

import { execFile } from 'node:child_process';

import { ArkError, arkError, describeError } from './errors.js';
import { adbConnect, adbDeviceOnline, adbShell, clearEmulatorCache } from './detect.js';
import { loadLocalSolution } from './copilot.js';
import { estimateSanity, pickDifficulty, resolveStage } from './stages.js';
import { recognizeVideo } from './video.js';

/** 轮询间隔。 */
const POLL_MS = 1000;
/** 单关兜底超时上限。 */
const MAX_STAGE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 造一个执行器。
 * @param {{ config: any, paths: any, env: any, session: any, state: any, ledger: any,
 *   copilot: any, arkrec: any, resources: () => Promise<{ stages: Array<Record<string, any>>, itemNames: Record<string, string> }>,
 *   logger?: any }} deps - 依赖。
 * @returns {object} 执行器。
 */
export function createRunner(deps) {
  const { config, session, state, ledger, copilot, arkrec, env, logger, resources } = deps;

  /**
   * 跑一个外部命令（模拟器控制用）。
   * @param {string} file - 可执行文件。
   * @param {string[]} args - 参数。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<{ ok: boolean, stdout: string, error?: string }>} 结果。
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
   * @param {{ autoStart?: boolean }} [options] - 是否自动拉起模拟器。
   * @returns {Promise<{ address: string, detection: Record<string, any> }>} 连接信息。
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
      await sleep(2000);
      await adbConnect(current.adbPath, current.address);
      online = await adbDeviceOnline(current.adbPath, current.address);
    }
    if (!online) {
      throw arkError('E_CONNECT', `adb 在 ${Math.round(config.connectTimeoutMs / 1000)}s 内没看到设备 ${current.address}。`, {
        hint: '确认模拟器已开机；MuMu 的 adb 端口默认 16384（可在 MuMu 设置里查）。',
      });
    }
    // adb 刚连上时探测缓存里的 adbOnline 还是旧值，清掉让状态显示真实结果
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
    return { address: current.address, detection: current };
  };

  /**
   * 等到任务链空闲（或超时 / 命中中止条件）。
   * @param {{ timeoutMs: number, shouldAbort?: () => string | null }} options - 选项。
   * @returns {Promise<{ timedOut: boolean, aborted: string | null }>} 结果。
   */
  const waitForIdle = async (options) => {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const abortReason = typeof options.shouldAbort === 'function' ? options.shouldAbort() : null;
      if (abortReason !== null) return { timedOut: false, aborted: abortReason };
      const running = await session.request('running', {}, { timeoutMs: 10000 });
      if (running.running !== true) return { timedOut: false, aborted: null };
      await sleep(POLL_MS);
    }
    return { timedOut: true, aborted: null };
  };

  /**
   * 关掉挡在前面的弹窗（理智不足对话框等），按 BACK 一到两次。
   *
   * MAA 在「理智不足 / 无法代理」这类拦阻后会把界面留在弹窗上，后面的 Copilot 会因此
   * 找不到「开始行动」。这里用 adb 的 BACK 键兜一下，失败不影响主流程。
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
   * 打一关（唯一入口）：能代理用 Fight，不能代理抄作业。
   * @param {{ entry: Record<string, any>, entries?: Array<Record<string, any>>, code: string, times: number,
   *   difficulty: 'auto'|'easy'|'tough', file?: string, copilotId?: number, medicine?: number,
   *   useSanityPotion?: boolean }} request - 请求。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const fightStage = async (request) => {
    const { entry, code } = request;
    const times = Number.isFinite(request.times) && request.times > 0 ? Math.trunc(request.times) : 1;
    const difficulty = request.difficulty ?? 'auto';
    const medicine = Number.isFinite(request.medicine) && request.medicine > 0 ? Math.trunc(request.medicine) : 0;
    // 磨难/险地/突袭：MAA 靠关卡名后缀 `-HARD` 切难度（15 章及以后 = 常规/险地）
    const navStage = difficulty === 'tough' ? `${code}-HARD` : code;

    state.resetChain();
    session.hold();
    try {
      const appended = await session.request('append', {
        type: 'Fight',
        params: { stage: navStage, times, ...(medicine > 0 ? { medicine } : {}) },
      });
      if (!Number.isFinite(appended.taskId) || appended.taskId <= 0) {
        throw arkError('E_TASK_TYPE', 'MAA 不接受 Fight 任务参数。');
      }
      await session.request('start', {}, { timeoutMs: 15000 });

      const perStageTimeout = Math.min(MAX_STAGE_TIMEOUT_MS, Math.max(120_000, 180_000 * times));
      const waited = await waitForIdle({
        timeoutMs: perStageTimeout,
        shouldAbort: () => {
          const branch = state.getBranch();
          // MaaCore 实际发的是 StageQueueUnableToAgent（兼容 UnableToAgent2）
          if (typeof branch === 'string' && branch.includes('UnableToAgent')) return 'no-agent';
          if (state.hasWhat('StageQueueStageNotFound')) return 'stage-not-found';
          if (state.getChains().some((chain) => chain.status === 'error')) return 'chain-error';
          return null;
        },
      });

      if (waited.aborted === 'no-agent') {
        await stopQuietly();
        await dismissOverlays(1);
        return copilotStage({ ...request, times, fightFailure: 'no-agent' });
      }
      if (waited.aborted === 'stage-not-found') {
        await stopQuietly();
        const error = arkError('E_STAGE_UNKNOWN', `MAA 找不到「${code}」（可能尚未解锁）。`, {
          detail: lastEventText(state),
          hint: '确认这一关是否已经解锁；推关遇到它说明已到进度边界。',
        });
        ledger.recordFailure(code, { reason: 'stage-not-found' });
        throw error;
      }
      if (waited.timedOut) {
        await stopQuietly();
        throw arkError('E_TIMEOUT', `打 ${code} 超时（${Math.round(perStageTimeout / 1000)}s）。`, {
          detail: lastEventText(state),
        });
      }
      if (waited.aborted === 'chain-error') {
        // 没有明确「无法代理」信号的失败（常见：理智不足弹窗），关掉弹窗后给抄作业一次机会
        await stopQuietly();
        await dismissOverlays(1);
        return copilotStage({ ...request, times, fightFailure: 'chain-error' });
      }

      const stars = state.getStars();
      const result = {
        code,
        ok: stars === 3,
        method: 'fight',
        stars: stars ?? null,
        reason: stars === 3 ? 'full-star' : stars === null ? 'unknown-stars' : 'not-three-stars',
        sanity: estimateSanity(entry, times),
        drops: state.getDrops(),
        solutionId: null,
      };
      recordResult(result);
      return result;
    } finally {
      session.release();
    }
  };

  /**
   * 用抄作业打一关（逐份尝试，直到满星或作业用尽）。
   * @param {{ entry: Record<string, any>, entries?: Array<Record<string, any>>, code: string,
   *   difficulty: string, file?: string, copilotId?: number }} request - 请求。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const copilotStage = async (request) => {
    const { entry, code, difficulty } = request;
    /** @type {Array<Record<string, any>>} */
    let candidates = [];
    let emptyReason = '';
    const entries = Array.isArray(request.entries) && request.entries.length > 0 ? request.entries : [entry];

    if (typeof request.video === 'string' && request.video !== '') {
      // 视频兜底：先让 MAA 识别录屏 → 拿回作业 → 走同一个 Copilot 执行路径
      try {
        const recognized = await recognizeVideo({
          videoPath: request.video,
          paths: deps.paths,
          session,
          state,
          waitForIdle,
        });
        candidates = [{
          id: null,
          stageName: recognized.stageName,
          title: recognized.title,
          uploader: 'video',
          opers: recognized.opers,
          available: true,
          contentRaw: recognized.contentRaw,
          file: recognized.file,
          source: recognized.source,
        }];
      } catch (error) {
        emptyReason = `视频识别失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (typeof request.file === 'string' && request.file !== '') {
      candidates = [await loadLocalSolution(request.file)];
    } else if (config.copilot.enabled !== true) {
      emptyReason = '配置里关掉了作业站（copilot.enabled=false），且没有指定 file。';
    } else {
      const queried = await copilot.query(code);
      if (queried.solutions.length === 0) {
        emptyReason = queried.reason !== '' ? queried.reason : `作业站上没有 ${code} 的作业。`;
      } else {
        let pool = queried.solutions;
        if (Number.isFinite(request.copilotId)) {
          const wanted = pool.filter((solution) => solution.id === request.copilotId);
          pool = wanted.length > 0 ? wanted : pool;
        } else {
          pool = copilot.pick(pool, { entries, code, difficulty });
        }
        candidates = pool;
        if (candidates.length === 0) {
          emptyReason = `作业站有 ${queried.total} 份 ${code} 的作业，但没有匹配 ${targetStageNames(entries)} 这一难度的。`;
        }
      }
    }

    if (candidates.length === 0) {
      const info = await arkrec?.describe?.(code).catch(() => null) ?? null;
      const hints = [];
      if (info?.url) {
        const record = info.minOperators ? `少人纪录 ${info.minOperators} 人` : '少人打法';
        hints.push(`人工参考：${info.url}（${record}）`);
      }
      hints.push(`指定作业：ark_fight stages=${code} copilotId=<作业id>`);
      hints.push(`本地作业：ark_fight stages=${code} file=<作业.json 路径>`);
      hints.push('自己手动打一局：不借干员拿到满星后，这一关就能用代理指挥刷。');
      const fightNote = request.fightFailure === 'chain-error'
        ? `在此之前 Fight 也没能开打（关卡需要 ${entry.apCost ?? '?'} 理智）：常见原因是理智不足（可用 medicine=N 或 useSanityPotion=true）或该关没有代理指挥。`
        : request.fightFailure === 'no-agent'
          ? '该关没有代理指挥（未满星或借过干员）。'
          : '';
      ledger.recordFailure(code, { reason: 'no-solution', detail: [emptyReason, fightNote].filter(Boolean).join(' ') });
      throw arkError('E_NO_SOLUTION', `「${code}」没有可用作业。`, {
        detail: [emptyReason, fightNote].filter(Boolean).join(' '),
        hint: hints.join('\n'),
      });
    }

    session.hold();
    let lastReason = '';
    try {
      for (const solution of candidates) {
        state.resetChain();
        // 列表接口的内容是截断版（没有 actions），必须按 id 取完整作业；否则 MAA 会 ret=0
        let full = solution;
        if (solution.file === undefined && Number.isFinite(solution.id) && typeof copilot.detail === 'function') {
          const detail = await copilot.detail(solution.id);
          if (detail !== null) full = { ...solution, ...detail };
        }
        const executable = typeof copilot.hasExecutableActions === 'function'
          ? copilot.hasExecutableActions(full.contentRaw)
          : true;
        if (!executable) {
          lastReason = `作业 ${solution.id ?? 'local'} 没有可执行动作（可能是列表截断或作业本身为空）。`;
          continue;
        }
        let file;
        try {
          file = full.file ?? await copilot.materialize(full, code);
        } catch (error) {
          lastReason = describeError(error);
          continue;
        }
        const appended = await session.request('append', {
          type: 'Copilot',
          params: {
            filename: file,
            formation: false,
            ignore_requirements: true,
            use_sanity_potion: request.useSanityPotion === true,
            loop_times: 1,
            // 磨难/险地/突袭：显式覆盖导航关卡名并标记突袭模式
            ...(difficulty === 'tough' ? { nav_name_override: `${code}-HARD`, is_raid: true } : {}),
          },
        });
        if (!Number.isFinite(appended.taskId) || appended.taskId <= 0) {
          lastReason = 'MAA 不接受该 Copilot 任务。';
          continue;
        }
        await session.request('start', {}, { timeoutMs: 15000 });
        const waited = await waitForIdle({
          timeoutMs: Math.min(MAX_STAGE_TIMEOUT_MS, 300_000),
          shouldAbort: () => (state.getChains().some((chain) => chain.status === 'error') ? 'chain-error' : null),
        });
        if (waited.timedOut) {
          await stopQuietly();
          lastReason = '抄作业超时。';
          await dismissOverlays(1);
          continue;
        }
        const stars = state.getStars();
        if (stars === 3) {
          const result = {
            code,
            ok: true,
            method: 'copilot',
            stars: 3,
            reason: 'full-star',
            sanity: estimateSanity(entry, 1),
            drops: state.getDrops(),
            solutionId: solution.id ?? null,
            solutionTitle: solution.title ?? '',
            solutionUploader: solution.uploader ?? '',
          };
          recordResult(result);
          return result;
        }
        lastReason = waited.aborted === 'chain-error'
          ? `作业 ${solution.id ?? 'local'} 执行失败（${lastEventText(state)}）。`
          : `作业 ${solution.id ?? 'local'} 打出来是 ${stars ?? '未知'} 星。`;
        const missing = state.missingOperText();
        if (missing !== '') lastReason += ` ${missing}`;
        await dismissOverlays(1);
      }

      ledger.recordFailure(code, { reason: 'solutions-exhausted', detail: lastReason });
      throw arkError('E_NO_SOLUTION', `「${code}」试了 ${candidates.length} 份作业都没能满星。`, {
        detail: lastReason,
        hint: '换一份作业（copilotId=）、换本地作业（file=），或自己手动打一局。',
      });
    } finally {
      session.release();
    }
  };

  /**
   * 记结果到账本。
   * @param {Record<string, any>} result - 执行结果。
   * @returns {void}
   */
  const recordResult = (result) => {
    if (Number.isFinite(result.stars)) {
      ledger.recordRun(result.code, { stars: result.stars, method: result.method, solutionId: result.solutionId });
    } else {
      ledger.recordFailure(result.code, { reason: result.reason ?? 'unknown' });
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
   * 跑肉鸽。
   * @param {{ theme?: string, mode?: string, startsCount?: number, wait?: boolean }} input - 参数。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const runRogue = async (input = {}) => {
    const theme = typeof input.theme === 'string' && input.theme !== '' ? input.theme : config.rogue.theme;
    const mode = typeof input.mode === 'string' && input.mode !== '' ? input.mode : config.rogue.mode;
    const startsCount = Number.isFinite(input.startsCount) ? input.startsCount : config.rogue.startsCount;

    state.resetChain();
    session.hold();
    try {
      const appended = await session.request('append', {
        type: 'Roguelike',
        params: { theme, mode, starts_count: startsCount },
      });
      if (!Number.isFinite(appended.taskId) || appended.taskId <= 0) {
        throw arkError('E_TASK_TYPE', 'MAA 不接受 Roguelike 任务参数。');
      }
      await session.request('start', {}, { timeoutMs: 15000 });
      if (input.wait !== true) return { started: true, theme, mode, taskId: appended.taskId };

      const waited = await waitForIdle({
        timeoutMs: 6 * 60 * 60 * 1000,
        shouldAbort: () => (state.getChains().some((chain) => chain.status === 'error') ? 'chain-error' : null),
      });
      return {
        started: true,
        theme,
        mode,
        taskId: appended.taskId,
        finished: !waited.timedOut,
        timedOut: waited.timedOut,
        chains: state.getChains(),
      };
    } finally {
      session.release();
    }
  };

  /**
   * 解析关卡 + 选难度（供 fight/push 共用）。
   * @param {string} input - 关卡代码。
   * @param {'auto'|'easy'|'tough'} [difficulty] - 难度。
   * @returns {Promise<{ code: string, entries: Array<Record<string, any>>, entry: Record<string, any> }>} 结果。
   */
  const resolve = async (input, difficulty) => {
    const loaded = await resources();
    const resolved = resolveStage(loaded.stages, input);
    const entry = pickDifficulty(resolved.entries, difficulty ?? config.defaultDifficulty);
    return { code: resolved.code, entries: resolved.entries, entry };
  };

  return { ensureReady, fightStage, copilotStage, runRogue, resolve, waitForIdle, stopQuietly };
}

/**
 * 取最近几条事件，拼成诊断文本。
 * @param {any} state - 状态容器。
 * @returns {string} 文本。
 */
function lastEventText(state) {
  const events = state.recentEvents(3);
  if (events.length === 0) return '没有收到任何 MAA 事件。';
  return events.map((event) => `${event.name}${event.what ? `/${event.what}` : ''}`).join(' → ');
}

/**
 * 目标关卡内部 id 列表（错误消息用）。
 * @param {Array<Record<string, any>>} entries - 候选。
 * @returns {string} 文本。
 */
function targetStageNames(entries) {
  return entries.map((entry) => entry.stageId).join(' 或 ');
}

/**
 * 等一会儿（**不要 unref**：这是被 await 的等待，unref 会让 Node 提前退出）。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 无。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 导出给测试用。 */
export { ArkError };

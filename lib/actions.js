/**
 * 动作层：工具、`/ark` 命令、状态路由共用的唯一真源。
 *
 * 这里负责四件事：
 * 1. **计划文本**（零副作用）：要打哪几关、什么难度、预计理智、会不会抄作业；
 * 2. **确认机制**（`confirmRequired` / `dryRun`）：没确认就只回计划；
 * 3. **顺序与并发**：同一时刻只允许一个动作在跑，第二个直接 `E_BUSY`；
 * 4. **状态快照**：`GET /arknights/status` 与 `ark_status` 用同一个函数，且**绝不触发**
 *    拉侧车 / 启模拟器（只读内存 + 已有探测缓存）。
 *
 * @module @local/arknights/actions
 */

import { arkError, describeError, normalizeError } from './errors.js';
import { estimateSanity, loadResources } from './stages.js';

/**
 * 造动作层。
 * @param {{ config: any, paths: any, env: any, session: any, state: any, ledger: any,
 *   runner: any, push: any, arkrec: any, logger?: any }} deps - 依赖。
 * @returns {object} 动作层。
 */
export function createActions(deps) {
  const { config, env, session, state, ledger, runner, push: pusher, arkrec, logger } = deps;
  /** @type {Promise<any> | null} */
  let busy = null;
  /** @type {{ connected: boolean, address: string, at: string } | null} */
  let lastConnection = null;
  let lastEmulatorRefreshAt = 0;

  /** 懒加载关卡资源（依赖已探测到的 maaPath）。 */
  const resources = async () => {
    const detected = await env.get();
    return loadResources(detected.maaPath);
  };

  /**
   * 用一个「忙碌槽」包住动作，避免两条命令同时驱动 MAA。
   * @param {string} name - 动作名。
   * @param {() => Promise<any>} action - 动作。
   * @returns {Promise<any>} 动作结果。
   */
  const exclusive = async (name, action) => {
    if (busy !== null) {
      throw arkError('E_BUSY', `还有一个动作在跑（${name}），等它结束或先 /ark stop。`, {
        hint: '用 ark_status 查看当前任务；需要中止就用 ark_stop。',
      });
    }
    const task = (async () => {
      try {
        return await action();
      } finally {
        busy = null;
      }
    })();
    busy = task;
    return task;
  };

  /**
   * 把关卡计划渲染成给人看的文本。
   * @param {Record<string, any>} plan - 计划。
   * @returns {string} 文本。
   */
  const renderPlan = (plan) => {
    const lines = [];
    const first = plan.stages[0];
    lines.push(`打关卡计划：${plan.stages.length} 关，每关 ${plan.times} 次。`);
    for (const stage of plan.stages) {
      const sanity = stage.sanity === null ? '未知' : `${stage.sanity} 理智`;
      const cnName = stage.cnName ? `（${stage.cnName}）` : '';
      const ledgerNote = stage.ledgerFullStar
        ? ' · 账本：已满星（仍按你的指令再打）'
        : stage.ledgerStars !== null && stage.ledgerStars !== undefined
          ? ` · 账本：上次 ${stage.ledgerStars} 星`
          : '';
      lines.push(`- ${stage.code}${cnName} · 难度 ${stage.difficultyLabel} · 每次 ${sanity}${ledgerNote}`);
    }
    const total = plan.stages.reduce((sum, stage) => sum + (stage.sanity ?? 0), 0);
    lines.push(`预计理智合计：${total}（不含理智药/碎石，且未满星关卡会改走抄作业，次数不叠加）。`);
    lines.push(plan.copilotEnabled
      ? '执行方式：先试代理指挥（Fight），若该关没有代理指挥则自动改抄作业（Copilot）。'
      : '执行方式：只试代理指挥（Fight）；配置里关掉了作业站，未满星关卡会直接失败。');
    if (first !== undefined && first.challenge) lines.push(`突袭条件：${first.challenge}`);
    if (config.confirmRequired && plan.confirmed !== true) {
      lines.push('这一步**没有消耗任何理智**。确认无误后，用同一个工具再加 confirm=true（命令里加 --yes）才会真的开打。');
    }
    return lines.join('\n');
  };

  /**
   * 打关卡（核心动作）。
   * @param {{ stages: string, times?: number, difficulty?: string, confirm?: boolean, file?: string,
   *   copilotId?: number }} input - 参数。
   * @returns {Promise<{ text: string, planned: boolean }>} 结果。
   */
  const fight = async (input) => {
    const rawStages = String(input?.stages ?? '').trim();
    if (rawStages === '') throw arkError('E_BAD_ARGS', '缺少 stages：告诉我要打哪一关，例如 5-10。');
    const split = rawStages.split(/[,，、\s]+/).map((item) => item.trim()).filter((item) => item !== '');
    if (split.length === 0) throw arkError('E_BAD_ARGS', 'stages 里没有有效的关卡代码。');
    const times = Number.isFinite(input?.times) && input.times > 0 ? Math.trunc(input.times) : 1;
    const difficulty = typeof input?.difficulty === 'string' && input.difficulty !== ''
      ? input.difficulty
      : config.defaultDifficulty;

    // —— 计划（零副作用）——
    const planned = [];
    for (const raw of split) {
      const resolved = await runner.resolve(raw, difficulty);
      const record = ledger.get(resolved.code);
      const info = await arkrec?.describe?.(resolved.code).catch(() => null) ?? null;
      planned.push({
        code: resolved.code,
        entries: resolved.entries,
        entry: resolved.entry,
        difficultyLabel: difficultyLabelFor(difficulty, resolved.entry),
        sanity: estimateSanity(resolved.entry, times),
        cnName: info?.cn_name ?? '',
        challenge: info?.challenge ?? '',
        ledgerFullStar: record?.fullStar === true,
        ledgerStars: record?.stars ?? null,
      });
    }

    const plan = {
      stages: planned,
      times,
      difficulty,
      copilotEnabled: config.copilot.enabled === true,
      confirmed: input?.confirm === true,
    };

    if (config.dryRun === true) {
      return { text: `[dry-run] 不会真的开打。\n${renderPlan(plan)}`, planned: true };
    }
    if (config.confirmRequired !== false && input?.confirm !== true) {
      return { text: renderPlan(plan), planned: true };
    }

    return exclusive('fight', async () => {
      await runner.ensureReady({ autoStart: true });
      lastConnection = { connected: true, address: env.peek()?.address ?? '', at: new Date().toISOString() };
      const lines = [`开始打关卡（每关 ${times} 次）：`];
      let okCount = 0;
      for (const stage of planned) {
        try {
          const result = await runner.fightStage({
            entry: stage.entry,
            entries: stage.entries,
            code: stage.code,
            times,
            difficulty,
            ...(typeof input?.file === 'string' && input.file !== '' ? { file: input.file } : {}),
            ...(typeof input?.video === 'string' && input.video !== '' ? { video: input.video } : {}),
            ...(Number.isFinite(input?.copilotId) ? { copilotId: input.copilotId } : {}),
            ...(Number.isFinite(input?.medicine) && input.medicine > 0 ? { medicine: input.medicine } : {}),
            ...(input?.useSanityPotion === true ? { useSanityPotion: true } : {}),
          });
          okCount += result.ok ? 1 : 0;
          lines.push(describeResult(stage, result));
        } catch (error) {
          lines.push(`- ${stage.code}：失败。${describeError(error)}`);
        }
      }
      lines.push(`完成：${okCount}/${planned.length} 关满星。`);
      return { text: lines.join('\n'), planned: false };
    });
  };

  /**
   * 推关。
   * @param {{ from?: string, chapter?: number, maxStages?: number, confirm?: boolean }} input - 参数。
   * @returns {Promise<{ text: string, planned: boolean }>} 结果。
   */
  const push = async (input) => {
    const plan = await pusher.plan(input);
    const lines = [];
    lines.push(`推关计划：${plan.queue.length} 关（跳过账本已满星 ${plan.skipped} 关）。`);
    for (const entry of plan.queue) {
      lines.push(`- ${entry.code} · ${estimateSanity(entry, 1) ?? '?'} 理智`);
    }
    lines.push(`预计理智合计：${plan.sanity}。`);
    lines.push('执行方式：先试代理指挥；没有代理指挥的关自动抄作业，满星后继续下一关；遇到未解锁的关就停下（到达进度边界）。');
    if (config.confirmRequired !== false && input?.confirm !== true) {
      lines.push('这一步**没有消耗任何理智**。确认后加 confirm=true（命令里加 --yes）才会真的开推。');
      return { text: lines.join('\n'), planned: true };
    }
    if (config.dryRun === true) return { text: `[dry-run] 不会真的开推。\n${lines.join('\n')}`, planned: true };

    return exclusive('push', async () => {
      await runner.ensureReady({ autoStart: true });
      lastConnection = { connected: true, address: env.peek()?.address ?? '', at: new Date().toISOString() };
      const result = await pusher.run({ ...input, maxStages: plan.queue.length, runner });
      const out = [...lines, '', '执行结果：'];
      for (const item of result.pushed) {
        if (item.ok) out.push(`- ${item.code}：满星（${item.method === 'copilot' ? '抄作业' : '代理指挥'}）`);
        else out.push(`- ${item.code}：未满星/失败（${item.reason ?? item.stars ?? '未知'}）${item.message ? ` · ${item.message}` : ''}`);
      }
      out.push(`停在：${result.stopped.code || '（队列结束）'}，原因：${reasonText(result.stopped.reason)}`);
      if (result.nextStage) out.push(`下次继续：ark_push from=${result.nextStage}`);
      return { text: out.join('\n'), planned: false };
    });
  };

  /**
   * 肉鸽。
   * @param {{ theme?: string, mode?: string, startsCount?: number, wait?: boolean, confirm?: boolean }} input - 参数。
   * @returns {Promise<{ text: string, planned: boolean }>} 结果。
   */
  const rogue = async (input) => {
    const theme = input?.theme ?? config.rogue.theme;
    const mode = input?.mode ?? config.rogue.mode;
    if (config.dryRun === true) {
      return { text: `[dry-run] 不会启动肉鸽。主题 ${theme}，模式 ${mode}。`, planned: true };
    }
    return exclusive('rogue', async () => {
      await runner.ensureReady({ autoStart: true });
      lastConnection = { connected: true, address: env.peek()?.address ?? '', at: new Date().toISOString() };
      const result = await runner.runRogue({ theme, mode, startsCount: input?.startsCount, wait: input?.wait === true });
      const lines = [`肉鸽已启动：主题 ${result.theme}，模式 ${result.mode}（任务 id ${result.taskId ?? '?'}）。`];
      if (input?.wait === true) {
        lines.push(result.timedOut ? '等待超时（任务可能仍在跑，用 ark_status 查看）。' : '任务已结束。');
        for (const chain of result.chains ?? []) lines.push(`- ${chain.name}：${chain.status}`);
      } else {
        lines.push('不会阻塞等待；用 ark_status 看进度，或用 ark_stop 停止。');
      }
      return { text: lines.join('\n'), planned: false };
    });
  };

  /**
   * 停止。
   * @returns {Promise<{ text: string }>} 结果。
   */
  const stop = async () => {
    try {
      await session.request('stop', {}, { timeoutMs: 20000 });
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'E_SIDECAR_EXIT' || normalized.code === 'E_NOT_INIT') {
        return { text: `侧车当前没在跑，没有任务需要停止（${normalized.code}）。` };
      }
      throw normalized;
    }
    ledger.setPush({ lastReason: 'stopped' });
    return { text: '已发送停止指令：当前任务链已中止（如有战斗，会停在当前画面）。' };
  };

  /**
   * 状态对象（只读内存 + 已有探测缓存，**绝不触发**拉侧车/启模拟器）。
   * @param {{ refreshEmulator?: boolean }} [options] - 是否在后台刷新模拟器状态。
   * @returns {Record<string, any>} 状态 JSON（见 docs/contracts.md §5）。
   */
  const statusObject = (options = {}) => {
    const detected = env.peek();
    if (options.refreshEmulator === true && Date.now() - lastEmulatorRefreshAt > 5000) {
      lastEmulatorRefreshAt = Date.now();
      // 后台刷新：不 await，失败也无所谓。
      void env.get({ fresh: true }).catch(() => {});
    }
    const snap = state.snapshot();
    const info = session.getInfo();
    return {
      ok: true,
      ts: new Date().toISOString(),
      sidecar: {
        alive: session.isRunning(),
        inited: info !== null,
        coreVersion: info?.coreVersion ?? '',
        resourceLoaded: info?.resourceLoaded === true,
      },
      paths: {
        maaPath: detected?.maaPath ?? '',
        pythonPath: detected?.pythonPath ?? '',
        adbPath: detected?.adbPath ?? '',
        userDir: deps.paths?.userDir ?? '',
        managerPath: detected?.managerPath ?? '',
        mumuInstallPath: detected?.mumuInstallPath ?? '',
      },
      emulator: detected?.emulator ?? { managerFound: false, running: false, androidStarted: false, adbOnline: false, vmIndex: 0, name: '' },
      connection: {
        connected: lastConnection?.connected === true,
        address: lastConnection?.address ?? detected?.address ?? '',
        config: config.connectionConfig,
        clientType: config.clientType,
      },
      tasks: snap.tasks,
      sanity: snap.sanity,
      drops: snap.drops,
      ledger: ledger.view(),
      push: ledger.pushView(),
      events: snap.events,
      config: {
        dryRun: config.dryRun === true,
        confirmRequired: config.confirmRequired !== false,
        clientType: config.clientType,
        defaultDifficulty: config.defaultDifficulty,
      },
    };
  };

  /**
   * 状态文本（给人看）。诊断用途，允许等一次探测（仍然不会启动模拟器/侧车）。
   * @returns {Promise<{ text: string, status: Record<string, any> }>} 结果。
   */
  const status = async () => {
    // 第一次调用时 env 还没探测过：这里等一次（只读文件系统 + MuMuManager info），
    // 好让 ark_status 一上来就给出真实路径。HTTP 路由走 statusObject()，不会等。
    try {
      await env.get({ fresh: false });
    } catch {
      // 探测失败也要出诊断文本。
    }
    const object = statusObject();
    const lines = [];
    lines.push(`MAA：${object.sidecar.coreVersion || '（未启动侧车）'}${object.sidecar.resourceLoaded ? ' · resource 已加载' : ''}`);
    lines.push(`Python：${object.paths.pythonPath || '未找到'} · adb：${object.paths.adbPath || '未找到'}`);
    lines.push(
      `模拟器：${object.emulator.managerFound ? (object.emulator.androidStarted ? '已开机' : '未开机') : '未找到 MuMu'}`
      + ` · adb ${object.emulator.adbOnline ? '在线' : '离线'}`
      + ` · 端口 ${object.connection.address || '未知'}`,
    );
    lines.push(`连接：${object.connection.connected ? '已连接' : '未连接'} · clientType=${object.config.clientType}`);
    lines.push(
      object.tasks.running
        ? `任务：进行中（${object.tasks.current ?? '未知链'}）`
        : '任务：空闲',
    );
    if (object.sanity.current !== null) lines.push(`理智：${object.sanity.current}/${object.sanity.max ?? '?'}`);
    lines.push(`账本：满星 ${object.ledger.fullStar} 关 · 未满星 ${object.ledger.missing} 关 · 已领源石 ${object.ledger.primeClaimed} 颗`);
    if (object.push.nextStage) lines.push(`推关进度：下一次从 ${object.push.nextStage} 继续（上次停在 ${object.push.lastStopped || '—'}，原因 ${reasonText(object.push.lastReason)}）`);
    if (object.events.length > 0) {
      lines.push('最近事件：');
      for (const event of object.events.slice(-5)) {
        lines.push(`- ${event.name}${event.task ? ` · ${event.task}` : ''}${event.what ? ` · ${event.what}` : ''}`);
      }
    }
    return { text: lines.join('\n'), status: object };
  };

  return { fight, push, rogue, stop, status, statusObject, resources };
}

/**
 * 把执行结果渲染成一行。
 * @param {Record<string, any>} stage - 计划里的关卡。
 * @param {Record<string, any>} result - 执行结果。
 * @returns {string} 文本。
 */
function describeResult(stage, result) {
  const method = result.method === 'copilot' ? '抄作业' : '代理指挥';
  const starText = Number.isFinite(result.stars) ? `${result.stars} 星` : '星级未知';
  const drops = Object.entries(result.drops ?? {})
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
  const solution = result.solutionId ? `（作业 ${result.solutionId}）` : '';
  return `- ${stage.code}：${result.ok ? '满星' : '未满星'} · ${method}${solution} · ${starText}`
    + `${drops === '' ? '' : ` · 掉落 ${drops}`}`;
}

/**
 * 难度标签（要考虑用户明确要求的难度，而不是只看选中的关卡条目）。
 * @param {string} difficulty - auto/easy/tough。
 * @param {Record<string, any>} entry - 关卡条目。
 * @returns {string} 文本。
 */
function difficultyLabelFor(difficulty, entry) {
  if (difficulty === 'tough') return '磨难/险地';
  if (difficulty === 'easy') return '标准/常规';
  return difficultyLabel(entry);
}

/**
 * 难度标签。
 * @param {Record<string, any>} entry - 关卡条目。
 * @returns {string} 文本。
 */
function difficultyLabel(entry) {
  const prefix = String(entry?.prefix ?? '');
  if (prefix === 'tough_') return '磨难';
  if (prefix === 'easy_') return '简单';
  if (prefix === 'main_') return '普通';
  return prefix.replace(/_$/, '') || '普通';
}

/**
 * 停止原因中文。
 * @param {string} reason - 代码。
 * @returns {string} 文本。
 */
function reasonText(reason) {
  switch (reason) {
    case 'queue-exhausted': return '本次队列打完';
    case 'stage-not-found': return '关卡未解锁（到达进度边界）';
    case 'no-solution': return '该关没有可用作业';
    case 'not-three-stars': return '连续未满星';
    case 'too-many-failures': return '连续失败过多';
    case 'nothing-to-push': return '没有需要推的关';
    case 'stopped': return '被手动停止';
    default: return reason || '—';
  }
}

/**
 * 状态快照：`ark_status`、`GET /arknights/status`、面板共用。
 *
 * 硬约束：只读内存与已有探测缓存（`env.peek()`），**绝不**拉起 sidecar、启动模拟器或执行 MAA。
 *
 * @module @local/arknights/status
 */

import { STATUS_SCHEMA } from './contracts.js';

/**
 * 造状态构造器。
 * @param {{ config: Record<string, any>, paths: Record<string, any>, env?: any, session?: any,
 *   state?: any, ledger?: any, box?: any, data?: any, runStore?: any, connection?: any,
 *   lastError?: () => Record<string, any> | null, now?: () => string }} deps - 依赖。
 * @returns {{ build: (options?: { refreshEmulator?: boolean }) => Promise<Record<string, any>> }} 状态。
 */
export function createStatus(deps) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  /** @type {number} */
  let lastEmulatorRefreshAt = 0;

  /**
   * 取精简 run。
   * @param {Record<string, any> | null} run - 原始 run。
   * @returns {Record<string, any> | null} 精简 run。
   */
  const slimRun = (run) => {
    if (run === null || run === undefined) return null;
    const out = {
      id: run.id,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt ?? null,
      updatedAt: run.updatedAt ?? null,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.phase ? { phase: run.phase } : {}),
      ...(run.error ? { error: run.error } : {}),
    };
    if (run.result !== null && typeof run.result === 'object') out.result = capResult(run.result);
    return out;
  };

  /**
   * 给 result 里的数组/字符串设上限，避免状态 JSON 过大。
   * @param {Record<string, any>} result - 结果。
   * @returns {Record<string, any>} 精简结果。
   */
  const capResult = (result) => {
    /**
     * 递归裁剪。
     * @param {any} value - 值。
     * @param {number} depth - 深度。
     * @returns {any} 裁剪后的值。
     */
    const capValue = (value, depth) => {
      if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
      if (Array.isArray(value)) return depth >= 4 ? [] : value.slice(0, 20).map((item) => capValue(item, depth + 1));
      if (value !== null && typeof value === 'object') {
        if (depth >= 4) return {};
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = capValue(child, depth + 1);
        return out;
      }
      return value;
    };
    return capValue(result, 0);
  };

  /**
   * 构造状态 JSON（契约 §5）。
   * @param {{ refreshEmulator?: boolean }} [options] - 是否后台刷新模拟器。
   * @returns {Promise<Record<string, any>>} 状态。
   */
  const build = async (options = {}) => {
    const detected = typeof deps.env?.peek === 'function' ? deps.env.peek() : null;
    if (options.refreshEmulator === true && Date.now() - lastEmulatorRefreshAt > 5000) {
      lastEmulatorRefreshAt = Date.now();
      void deps.env?.get?.({ fresh: true }).catch?.(() => {});
    }
    const info = typeof deps.session?.getInfo === 'function' ? deps.session.getInfo() : null;
    const snap = typeof deps.state?.snapshot === 'function' ? deps.state.snapshot() : {};
    const runSnap = typeof deps.runStore?.snapshot === 'function' ? deps.runStore.snapshot() : { run: null, lastRun: null };
    const ledgerView = typeof deps.ledger?.view === 'function' ? deps.ledger.view() : { fullStar: 0, missing: 0, primeClaimed: 0, entries: [] };
    const pushView = typeof deps.ledger?.pushView === 'function' ? deps.ledger.pushView() : { nextStage: '', lastStopped: '', lastReason: '' };
    const daily = typeof deps.ledger?.dailyView === 'function' ? deps.ledger.dailyView() : { date: '', tasks: {} };
    const box = typeof deps.box?.summary === 'function'
      ? deps.box.summary()
      : { operators: 0, depotItems: 0, updatedAt: null, partial: false };
    let data = typeof deps.data?.meta === 'function' ? deps.data.meta() : {};
    // meta 是进程内快照：重启后首次数据查询前 counts 为 null；这里退回只读 status()，让面板一开机就有计数。
    if ((data === null || data.ok !== true || data.stages === null || data.stages === undefined)
      && typeof deps.data?.status === 'function') {
      try {
        data = await deps.data.status();
      } catch {
        // 数据层不可用就保留 meta 的空结果。
      }
    }
    const connection = typeof deps.connection === 'function' ? deps.connection() : null;
    const lastError = typeof deps.lastError === 'function' ? deps.lastError() : null;
    const emulator = detected?.emulator ?? {
      managerFound: false, running: false, androidStarted: false, adbOnline: false, vmIndex: 0, name: '',
    };

    return {
      ok: true,
      schema: STATUS_SCHEMA,
      ts: now(),
      sidecar: {
        alive: typeof deps.session?.isRunning === 'function' ? deps.session.isRunning() : false,
        inited: info !== null,
        coreVersion: info?.coreVersion ?? '',
        resourceLoaded: info?.resourceLoaded === true,
        protocolVersion: info?.protocolVersion ?? '',
      },
      paths: {
        maaPath: detected?.maaPath ?? deps.config?.maaPath ?? '',
        pythonPath: detected?.pythonPath ?? deps.config?.pythonPath ?? '',
        adbPath: detected?.adbPath ?? deps.config?.adbPath ?? '',
        userDir: deps.paths?.userDir ?? '',
        ledgerFile: deps.paths?.ledgerFile ?? '',
        boxFile: deps.paths?.boxFile ?? '',
        historyFile: deps.paths?.historyFile ?? '',
      },
      emulator,
      connection: {
        connected: connection?.connected === true || info?.connected === true,
        address: connection?.address ?? detected?.address ?? '',
        config: deps.config?.connectionConfig ?? '',
        clientType: deps.config?.clientType ?? '',
      },
      tasks: snap.tasks ?? { running: false, current: null, chains: [] },
      sanity: { ...(snap.sanity ?? { current: null, max: null }), at: connection?.at ?? null },
      drops: snap.drops ?? {},
      ledger: ledgerView,
      push: pushView,
      run: slimRun(runSnap.run),
      lastRun: slimRun(runSnap.lastRun),
      daily,
      box,
      data,
      errors: lastError ?? { lastCode: null, lastMessage: null, at: null },
      safety: {
        confirmRequired: deps.config?.confirmRequired !== false,
        dryRun: deps.config?.dryRun === true,
        allowSanityPotion: deps.config?.safety?.allowSanityPotion === true,
        allowOriginitePrime: deps.config?.safety?.allowOriginitePrime === true,
        allowRecruitPermits: deps.config?.safety?.allowRecruitPermits === true,
        allowExpedite: deps.config?.safety?.allowExpedite === true,
      },
      events: snap.events ?? [],
      config: {
        dryRun: deps.config?.dryRun === true,
        confirmRequired: deps.config?.confirmRequired !== false,
        clientType: deps.config?.clientType ?? '',
        defaultDifficulty: deps.config?.defaultDifficulty ?? 'auto',
      },
    };
  };

  return { build };
}

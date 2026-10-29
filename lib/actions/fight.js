/**
 * `fight` 动作：按用户给的关卡与次数逐关打；能代理用 Fight，不能代理抄作业。
 *
 * 契约（docs/contracts.md §4/§9/§11）：
 * - 计划（confirm=false）**零副作用**：不 ensureReady、不 append/start，只读 env/resources/ledger；
 * - 执行时才 `runtime.ensureReady({autoStart:true})`，逐关试 `Fight`；
 * - `UnableToAgent*` / 链错误 → 自动转 Copilot（`lib/actions/copilot.js`）；
 * - `StageQueueStageNotFound` → `E_STAGE_UNKNOWN`（不换关，推关据此停在边界）；
 * - 失败一律 `classifyFailure` 出诊断（而不是一句「作业执行失败」），并写账本失败记录；
 * - 3 星写账本成功记录；返回 `{planned, executed, totals}`。
 *
 * @module @local/arknights/actions/fight
 */

import { DIFFICULTIES } from '../contracts.js';
import { arkError, describeError } from '../errors.js';
import { difficultyTier, estimateSanity } from '../stages.js';
import { classifyFailure, describeDiagnosis } from './classify.js';
import { createCopilotFallback } from './copilot.js';
import { planStages, sanityWarning, totalSanityText } from './preflight.js';
import { isConfirmed, needsConfirm, runAction } from './shared.js';

/** 单关兜底超时上限。 */
const MAX_STAGE_TIMEOUT_MS = 60 * 60 * 1000;

/** 一次最多计划多少关（与 preflight 保持一致）。 */
const MAX_STAGES = 20;

/**
 * 难度标签。
 * @param {string} tier - `tough` / `easy`。
 * @param {string} [requested] - 用户要求的难度。
 * @returns {string} 文本。
 */
function difficultyText(tier, requested) {
  if (tier === 'tough') return '磨难/险地';
  if (requested === 'tough') return '标准/常规（MAA 关卡表里没有该关的磨难/险地档）';
  return '标准/常规';
}

/**
 * 把 `state.getDrops()` 的名字→数量转成 §4 的 `[{itemId,itemName,quantity}]`。
 * @param {Record<string, number>} drops - 掉落。
 * @param {Record<string, string>} [nameToId] - 材料名 → itemId。
 * @returns {Array<{itemId: string|null, itemName: string, quantity: number}>} 数组。
 */
function dropsArray(drops, nameToId = {}) {
  return Object.entries(drops ?? {})
    .filter(([itemName, quantity]) => typeof itemName === 'string' && itemName !== '' && Number.isFinite(quantity))
    .map(([itemName, quantity]) => ({
      itemId: typeof nameToId[itemName] === 'string' ? nameToId[itemName] : null,
      itemName,
      quantity,
    }));
}

/**
 * 安全写账本：账本实现升级/磁盘错误都不该让打关失败。
 * @param {any} ledger - 账本。
 * @param {(ledger: any) => void} write - 写入回调。
 * @param {any} logger - 日志。
 * @returns {void}
 */
export function safeLedgerWrite(ledger, write, logger) {
  try {
    write(ledger);
  } catch (error) {
    logger?.warn?.(`[arknights] 账本写入失败（不影响打关）：${describeError(error)}`);
  }
}

/**
 * 记一次成功/星级结果（兼容账本 v1/v2：多传字段无副作用）。
 * @param {any} ledger - 账本。
 * @param {string} code - 关卡代码。
 * @param {{ stars: number, method: string, solutionId?: number|null, difficulty?: string }} input - 结果。
 * @param {any} [logger] - 日志。
 * @returns {void}
 */
export function recordRunSafe(ledger, code, input, logger) {
  safeLedgerWrite(ledger, (target) => {
    target?.recordRun?.(code, {
      stars: input.stars,
      method: input.method,
      ...(Number.isFinite(input.solutionId) ? { solutionId: Math.trunc(input.solutionId) } : {}),
      ...(typeof input.difficulty === 'string' ? { difficulty: input.difficulty } : {}),
    });
  }, logger);
}

/**
 * 记一次失败（同时给账本 v1 的 `reason` 与 v2 的 `code/message/screenshot` 字段）。
 * @param {any} ledger - 账本。
 * @param {string} code - 关卡代码。
 * @param {Record<string, any>} diagnosis - `classifyFailure` 的结果。
 * @param {any} [logger] - 日志。
 * @returns {void}
 */
export function recordFailureSafe(ledger, code, diagnosis, logger) {
  const message = typeof diagnosis?.message === 'string' ? diagnosis.message : '任务链失败。';
  const evidence = Array.isArray(diagnosis?.evidence) && diagnosis.evidence.length > 0
    ? `（证据：${diagnosis.evidence.slice(-3).join('；')}）`
    : '';
  safeLedgerWrite(ledger, (target) => {
    target?.recordFailure?.(code, {
      reason: typeof diagnosis?.code === 'string' && diagnosis.code !== '' ? diagnosis.code : 'unknown',
      code: typeof diagnosis?.code === 'string' && diagnosis.code !== '' ? diagnosis.code : 'unknown',
      message,
      detail: `${message}${evidence}`.slice(0, 500),
      ...(typeof diagnosis?.screenshot === 'string' && diagnosis.screenshot !== ''
        ? { screenshot: diagnosis.screenshot }
        : {}),
    });
  }, logger);
}

/**
 * 把 `drops` 参数解析成 MAA 的 `{itemId: 数量}`。
 *
 * 允许 key 是 `resource/item_index.json` 的 itemId，也允许中文材料名（用
 * `resources.itemNames` 反查）。数量必须是正整数。
 * @param {{ itemNames?: Record<string, string> }} resources - `loadResources()` 的产物。
 * @param {Record<string, any>} drops - 用户给的 drops。
 * @returns {{ ids: Record<string, number>, labels: string[] }} MAA 参数与可读标签。
 * @throws {import('../errors.js').ArkError} 数量/材料名不合法时 `E_BAD_ARGS`。
 */
export function resolveDrops(resources, drops) {
  const itemNames = resources?.itemNames ?? {};
  /** @type {Map<string, string>} */
  const byName = new Map();
  for (const [itemId, name] of Object.entries(itemNames)) {
    if (typeof name === 'string' && name !== '' && !byName.has(name)) byName.set(name, itemId);
  }
  /** @type {Record<string, number>} */
  const ids = {};
  /** @type {string[]} */
  const labels = [];
  for (const [rawKey, rawCount] of Object.entries(drops ?? {})) {
    const count = typeof rawCount === 'number' ? Math.trunc(rawCount) : Number.parseInt(String(rawCount), 10);
    if (!Number.isFinite(count) || count <= 0) {
      throw arkError('E_BAD_ARGS', `drops 里「${rawKey}」的数量不合法：${String(rawCount)}（必须是正整数）。`);
    }
    const key = String(rawKey).trim();
    const itemId = /^\d+$/.test(key) ? key : (byName.get(key) ?? null);
    if (itemId === null) {
      throw arkError('E_BAD_ARGS', `drops 里「${key}」既不是已知材料名，也不是 itemId。`, {
        hint: '材料名写中文全名（例如 固源岩），或直接给 resource/item_index.json 里的 itemId（例如 30011）。',
      });
    }
    ids[itemId] = (ids[itemId] ?? 0) + count;
    labels.push(`${itemNames[itemId] ?? key}×${count}`);
  }
  return { ids, labels };
}

/**
 * 归一/校验 fight 参数（纯函数，不读资源）。
 * @param {Record<string, any>} input - 工具参数。
 * @param {Record<string, any>} [config] - 生效配置。
 * @returns {Record<string, any>} 归一后的参数。
 * @throws {import('../errors.js').ArkError} `E_BAD_ARGS`。
 */
export function normalizeFightParams(input = {}, config = {}) {
  const rawStages = typeof input.stages === 'string' ? input.stages.trim() : '';
  if (rawStages === '') {
    throw arkError('E_BAD_ARGS', '缺少 stages：告诉我要打哪一关，例如 5-10。');
  }

  /** @type {Record<string, any>} */
  const out = { stages: rawStages };

  if (input.times !== undefined && input.times !== null && input.times !== '') {
    const times = typeof input.times === 'number'
      ? Math.trunc(input.times)
      : Number.parseInt(String(input.times), 10);
    if (!Number.isFinite(times) || times <= 0) {
      throw arkError('E_BAD_ARGS', `times 必须是正整数（收到 ${String(input.times)}）。`);
    }
    if (times > 1000) throw arkError('E_BAD_ARGS', `times 太大了（${times}），一次最多 1000 次。`);
    out.times = times;
  }

  const difficulty = input.difficulty === undefined || input.difficulty === null || input.difficulty === ''
    ? (config.defaultDifficulty ?? 'auto')
    : String(input.difficulty);
  if (!DIFFICULTIES.includes(difficulty)) {
    throw arkError('E_BAD_ARGS', `difficulty 只能是 ${DIFFICULTIES.join(' / ')}（收到 ${difficulty}）。`);
  }
  out.difficulty = difficulty;

  if (input.series !== undefined && input.series !== null && input.series !== '') {
    const series = typeof input.series === 'number'
      ? Math.trunc(input.series)
      : Number.parseInt(String(input.series), 10);
    if (!Number.isFinite(series) || series < -1 || series > 10) {
      throw arkError('E_BAD_ARGS', `series（代理倍率）必须是 -1~10 的整数（收到 ${String(input.series)}）。`);
    }
    out.series = series;
  }

  if (input.drops !== undefined && input.drops !== null) {
    if (typeof input.drops !== 'object' || Array.isArray(input.drops)) {
      throw arkError('E_BAD_ARGS', 'drops 必须是一个对象：材料名/itemId → 数量。');
    }
    if (out.times === undefined) {
      throw arkError('E_BAD_ARGS', '指定 drops 时必须显式给 times（MAA 需要明确的战斗次数）。', {
        hint: '例如：stages=1-7 times=20 drops={"固源岩":10}。',
      });
    }
    if (Object.keys(input.drops).length > 0) out.drops = { ...input.drops };
  }

  if (input.medicine !== undefined && input.medicine !== null) {
    const medicine = Number(input.medicine);
    if (!Number.isFinite(medicine) || medicine < 0) {
      throw arkError('E_BAD_ARGS', `medicine 必须是 >=0 的整数（收到 ${String(input.medicine)}）。`);
    }
    if (medicine > 0) out.medicine = Math.trunc(medicine);
  }

  if (input.stone !== undefined && input.stone !== null) {
    const stone = Number(input.stone);
    if (!Number.isFinite(stone) || stone < 0) {
      throw arkError('E_BAD_ARGS', `stone 必须是 >=0 的整数（收到 ${String(input.stone)}）。`);
    }
    if (stone > 0) out.stone = Math.trunc(stone);
  }

  if (input.useSanityPotion === true) out.useSanityPotion = true;
  if (input.copilotId !== undefined && input.copilotId !== null) {
    const copilotId = Number(input.copilotId);
    if (!Number.isFinite(copilotId) || copilotId <= 0) {
      throw arkError('E_BAD_ARGS', `copilotId 必须是正整数（收到 ${String(input.copilotId)}）。`);
    }
    out.copilotId = Math.trunc(copilotId);
  }
  if (typeof input.file === 'string' && input.file.trim() !== '') out.file = input.file.trim();
  if (typeof input.video === 'string' && input.video.trim() !== '') out.video = input.video.trim();
  if (input.confirm === true) out.confirm = true;
  if (input.wait === false) out.wait = false;
  return out;
}

/**
 * 单关执行器（fight 与 push 共用，不包 runAction，避免嵌套 run）。
 *
 * 返回值 `{ok, method, stars, reason, sanity, drops, solutionId?}`；
 * 失败时抛 `ArkError`（自动回退抄作业也失败时 `E_NO_SOLUTION`；关卡未解锁
 * `E_STAGE_UNKNOWN`；超时 `E_TIMEOUT`），错误对象上带 `.diagnosis` 与 `.dismissed`。
 *
 * @param {Record<string, any>} deps - 动作依赖（config/runtime/state/ledger/paths/copilot/arkrec/session/logger）。
 * @returns {(request: Record<string, any>) => Promise<Record<string, any>>} 执行器。
 */
export function createStageFighter(deps = {}) {
  const { config, runtime, state, ledger, logger, paths } = deps;
  const fallback = createCopilotFallback(deps);

  /**
   * 造一个带诊断的失败并抛出。
   * @param {Record<string, any>} request - 关卡请求。
   * @param {{ code: string, fallbackCode?: string, message: string, detail?: string, hint?: string,
   *   dismissed?: boolean, fallbackMessage?: string }} options - 失败信息。
   * @returns {Promise<never>} 不会返回。
   */
  const failWith = async (request, options) => {
    const diagnosis = classifyFailure({
      state,
      ...(paths ? { paths } : {}),
      fallback: {
        code: options.fallbackCode ?? 'unknown',
        message: options.fallbackMessage ?? options.message,
      },
    });
    if (options.dismissed !== true) await runtime.dismissOverlays?.(1);
    const error = arkError(options.code, options.message, {
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.hint ? { hint: options.hint } : {}),
    });
    error.diagnosis = diagnosis;
    error.dismissed = options.dismissed === true;
    throw error;
  };

  /** 等链结束时的中止判据（事件 → 结局）。 */
  const shouldAbortChain = () => {
    const branch = typeof state?.getBranch === 'function' ? state.getBranch() : null;
    if (typeof branch === 'string' && branch.includes('UnableToAgent')) return 'no-agent';
    if (typeof state?.hasWhat === 'function'
      && (state.hasWhat('StageQueueStageNotFound') || state.hasWhat('UnsupportedLevel'))) {
      return 'stage-not-found';
    }
    const chains = typeof state?.getChains === 'function' ? state.getChains() : [];
    return chains.some((chain) => chain.status === 'error') ? 'chain-error' : null;
  };

  /**
   * 没有可用作业时的错误（带三条出路 + 失败分类）。
   * @param {Record<string, any>} request - 请求。
   * @param {string} reason - 最后一轮原因。
   * @param {number} tried - 尝试的份数。
   * @param {{ timedOut?: boolean }} [lastAttempt] - 最后一次尝试。
   * @returns {Promise<never>} 不返回。
   */
  const throwNoSolution = async (request, reason, tried, lastAttempt = {}) => {
    const code = request.code;
    const fightFailure = request.fightFailure ?? null;
    const notes = [];
    if (typeof reason === 'string' && reason !== '') notes.push(reason);
    if (fightFailure === 'no-agent') notes.push('该关没有代理指挥（未满星或借过干员）。');
    if (fightFailure === 'chain-error') {
      notes.push(`Fight 也没能开打（关卡需要 ${request.entry?.apCost ?? '?'} 理智）：常见原因是理智不足（可用 medicine=N 或 useSanityPotion=true）或该关没有代理指挥。`);
    }
    const detail = notes.join(' ').slice(0, 800);
    const message = fightFailure === 'no-agent'
      ? `「${code}」没有代理指挥，且没有可用作业。`
      : `「${code}」试了 ${tried} 份作业都没能满星。`;

    const hints = [];
    if (config?.arkrec?.enabled !== false) {
      try {
        const info = await deps.arkrec?.describe?.(code);
        if (info?.url) {
          const record = Number.isFinite(info.minOperators) ? `少人纪录 ${info.minOperators} 人` : '少人打法';
          hints.push(`人工参考：${info.url}（${record}）`);
        }
      } catch {
        // ArkRec 只是可读性增强。
      }
    }
    hints.push(`指定作业：ark_fight stages=${code} copilotId=<作业id>`);
    hints.push(`本地作业：ark_fight stages=${code} file=<作业.json 路径>`);
    hints.push('自己手动打一局：不借干员拿到满星后，这一关就能用代理指挥刷。');

    const diagnosis = classifyFailure({
      state,
      ...(paths ? { paths } : {}),
      fallback: {
        code: lastAttempt?.timedOut === true ? 'timeout' : 'unknown',
        message: detail !== '' ? detail : message,
      },
    });
    const error = arkError('E_NO_SOLUTION', message, { detail, hint: hints.join('\n') });
    error.diagnosis = diagnosis;
    error.dismissed = true;
    throw error;
  };

  /**
   * 用代理指挥打一关。
   * @param {Record<string, any>} request - 请求。
   * @returns {Promise<{ next: 'done'|'copilot', result?: Record<string, any>, fightFailure?: string }>} 下一步。
   */
  const attemptFight = async (request) => {
    const { code, entry, tier } = request;
    const times = Number.isFinite(request.times) && request.times > 0 ? Math.trunc(request.times) : 1;
    const navStage = tier === 'tough' ? `${code}-HARD` : code;
    /** @type {Record<string, any>} */
    const params = { stage: navStage, times };
    if (request.series !== undefined) params.series = request.series;
    if (request.drops !== undefined && request.drops !== null) params.drops = request.drops;
    if (Number(request.medicine) > 0) params.medicine = Math.trunc(request.medicine);
    if (Number(request.stone) > 0) params.stone = Math.trunc(request.stone);

    const perStageTimeout = Math.min(MAX_STAGE_TIMEOUT_MS, Math.max(120_000, 180_000 * times));
    const outcome = await runtime.runTaskChain({
      type: 'Fight',
      params,
      timeoutMs: perStageTimeout,
      shouldAbort: shouldAbortChain,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const waited = outcome?.waited ?? {};
    if (waited.aborted === 'stopped') throw arkError('E_ABORTED', '操作被中止。');
    if (waited.aborted === 'no-agent') {
      await runtime.stopQuietly?.();
      await runtime.dismissOverlays?.(1);
      return { next: 'copilot', fightFailure: 'no-agent' };
    }
    if (waited.aborted === 'stage-not-found') {
      await runtime.stopQuietly?.();
      await failWith(request, {
        code: 'E_STAGE_UNKNOWN',
        fallbackCode: 'stage-not-found',
        message: `MAA 找不到「${code}」（可能尚未解锁）。`,
        detail: lastEventText(state),
        hint: '确认这一关是否已经解锁；推关遇到它说明已到进度边界。',
        dismissed: false,
      });
    }
    if (waited.timedOut === true) {
      await runtime.stopQuietly?.();
      await failWith(request, {
        code: 'E_TIMEOUT',
        fallbackCode: 'timeout',
        message: `打 ${code} 超时（${Math.round(perStageTimeout / 1000)}s）。`,
        detail: lastEventText(state),
        hint: '用 ark_diag(action=screen) 看当前画面；卡在弹窗/公告上时先关掉再重试。',
        dismissed: false,
      });
    }
    if (waited.aborted === 'chain-error') {
      await runtime.stopQuietly?.();
      await runtime.dismissOverlays?.(1);
      return { next: 'copilot', fightFailure: 'chain-error' };
    }

    const stars = outcome?.stars ?? null;
    const sanity = estimateSanity(entry, times);
    const drops = outcome?.drops ?? {};
    if (stars === 3) {
      return {
        next: 'done',
        result: { ok: true, method: 'fight', stars: 3, reason: 'full-star', sanity, drops, solutionId: null },
      };
    }
    if (Number.isFinite(stars)) {
      return {
        next: 'done',
        result: { ok: false, method: 'fight', stars, reason: 'not-three-stars', sanity, drops, solutionId: null },
      };
    }
    return {
      next: 'done',
      result: { ok: false, method: 'fight', stars: null, reason: 'unknown-stars', sanity: 0, drops: {}, solutionId: null },
    };
  };

  /**
   * 用抄作业打一关（逐份尝试，直到满星或用尽）。
   * @param {Record<string, any>} request - 请求。
   * @returns {Promise<{ next: 'done', result: Record<string, any> }>} 结果。
   */
  const attemptCopilot = async (request) => {
    const collected = await fallback.collect(request);
    if (collected.candidates.length === 0) {
      await throwNoSolution(request, collected.reason, 0);
    }
    let lastReason = '';
    /** @type {Record<string, any>} */
    let lastAttempt = {};
    for (const solution of collected.candidates) {
      if (request.signal?.aborted === true) throw arkError('E_ABORTED', '操作被中止。');
      const attempt = await fallback.run(request, solution);
      if (attempt.stopped === true) throw arkError('E_ABORTED', '操作被中止。');
      if (attempt.ok === true) {
        return {
          next: 'done',
          result: {
            ok: true,
            method: 'copilot',
            stars: 3,
            reason: 'full-star',
            sanity: estimateSanity(request.entry, 1),
            drops: attempt.drops ?? {},
            solutionId: attempt.solutionId ?? null,
            solutionTitle: attempt.solutionTitle ?? '',
            solutionUploader: attempt.solutionUploader ?? '',
          },
        };
      }
      lastReason = typeof attempt.reason === 'string' && attempt.reason !== '' ? attempt.reason : lastReason;
      lastAttempt = attempt;
    }
    await throwNoSolution(request, lastReason, collected.candidates.length, lastAttempt);
    // throwNoSolution 一定抛错；这一行只为类型收窄。
    throw arkError('E_NO_SOLUTION', '没有可用作业。');
  };

  /**
   * 打一关。
   * @param {Record<string, any>} request - `{code, entries, entry, tier, times, series?, drops?, medicine?, stone?, useSanityPotion?, copilotId?, file?, video?, signal?}`。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  return async (request) => {
    // 抄作业回退按 `difficulty` 判断磨难；Fight 按 `tier`。统一在这里补齐，调用方只需给 tier。
    const normalized = {
      ...request,
      difficulty: request.difficulty ?? (request.tier === 'tough' ? 'tough' : 'easy'),
    };
    const fight = await attemptFight(normalized);
    if (fight.next === 'done') return fight.result;
    return (await attemptCopilot({ ...normalized, fightFailure: fight.fightFailure })).result;
  };
}

/**
 * 最近事件文本（诊断 detail 用）。
 * @param {any} state - 状态容器。
 * @returns {string} 文本。
 */
function lastEventText(state) {
  if (typeof state?.recentEvents !== 'function') return '没有收到任何 MAA 事件。';
  const events = state.recentEvents(3);
  if (events.length === 0) return '没有收到任何 MAA 事件。';
  return events.map((event) => `${event.name}${event.what ? `/${event.what}` : ''}`).join(' → ');
}

/**
 * 取账本里这一关最近的失败记录（兼容 v1 `failures[]` 与 v2 `lastFailure`）。
 * @param {Record<string, any> | undefined} record - 账本记录。
 * @returns {{ code: string, message: string } | null} 失败摘要。
 */
function lastFailureOf(record) {
  if (record === null || record === undefined) return null;
  const raw = record.lastFailure
    ?? (Array.isArray(record.failures) && record.failures.length > 0 ? record.failures[record.failures.length - 1] : null);
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const code = typeof raw.code === 'string' && raw.code !== '' ? raw.code : (typeof raw.reason === 'string' ? raw.reason : '');
  const message = typeof raw.message === 'string' && raw.message !== '' ? raw.message : (typeof raw.detail === 'string' ? raw.detail : '');
  if (code === '' && message === '') return null;
  return { code: code === '' ? 'unknown' : code, message: message === '' ? '（无详情）' : message };
}

/**
 * 计划阶段里已经按最近失败给的诊断建议。
 * @param {string} code - 失败分类码。
 * @returns {string} 建议文本；未知码为空串。
 */
function failureHint(code) {
  switch (code) {
    case 'no-agent': return '没有代理指挥：插件会改走抄作业，仍失败就换 copilotId 或手动打一局。';
    case 'stage-not-found': return 'MAA 找不到这一关：确认已解锁/代码正确；推关遇到它就是进度边界。';
    case 'battle-start-timeout': return '没进关卡详情：先核对关卡与难度是否开放，再看截图确认画面。';
    case 'sanity-insufficient': return '可能理智不足：先等恢复，或明确同意后用药/碎石。';
    case 'oper-missing': return '作业要求干员不满足：换一份作业，或手动打一局。';
    case 'copilot-file': return '作业文件不可执行：用 copilotId 重新取完整作业，或换本地 file。';
    case 'connection': return '连接中断：检查模拟器/adb 后重试。';
    case 'timeout': return '上次超时：确认游戏画面没有卡在弹窗/公告上。';
    default: return '';
  }
}

/**
 * 造 `fight` 动作。
 * @param {Record<string, any>} deps - 依赖（见 lib/index.js：config/store/runtime/state/ledger/resources/
 *   arkrec/copilot/data/paths/session/logger）。
 * @returns {(params: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createFightAction(deps = {}) {
  const { config, store, runtime, state, ledger, logger } = deps;

  /** @type {Record<string, any> | null} */
  let snapshot = null;

  /**
   * 生成计划（零副作用）。
   * @param {Record<string, any>} params - 归一后的参数。
   * @returns {Promise<{ text: string, plannedItems: Array<Record<string, any>>, plannedTotalSanity: number|null }>} 计划。
   */
  const buildPlan = async (params) => {
    const resources = await deps.resources();
    const plan = planStages({
      resources,
      ...(deps.data ? { data: deps.data } : {}),
      requested: params.stages,
      difficulty: params.difficulty,
      ...(params.times !== undefined ? { times: params.times } : {}),
      defaultDifficulty: config.defaultDifficulty,
    });
    if (plan.stages.length > MAX_STAGES) {
      throw arkError('E_BAD_ARGS', `一次最多计划 ${MAX_STAGES} 关。`);
    }
    const times = Number.isFinite(params.times) ? params.times : 1;
    const drops = params.drops !== undefined ? resolveDrops(resources, params.drops) : null;
    // 主动用 stages.difficultyTier 再判一次档位（与 MAA `tough_` 前缀语义绑定），
    // 不依赖上游计划的字段命名；有落回普通档时过滤掉「没有磨难档」以外的误报。
    const tiers = plan.stages.map((stage) => difficultyTier(stage.entry?.prefix));
    const warnings = plan.warnings.filter((warning) => {
      const match = /「([^」]+)」在 MAA 关卡表里没有磨难\/险地档/.exec(warning);
      if (match === null) return true;
      const stage = plan.stages.find((item) => item.code === match[1] || item.raw === match[1]);
      return stage === undefined || difficultyTier(stage.entry?.prefix) !== 'tough';
    });
    /** @type {Record<string, string>} */
    const nameToId = {};
    for (const [itemId, name] of Object.entries(resources.itemNames ?? {})) {
      if (typeof name === 'string' && name !== '' && nameToId[name] === undefined) nameToId[name] = itemId;
    }
    const infos = config?.arkrec?.enabled === false
      ? plan.stages.map(() => null)
      : await Promise.all(plan.stages.map(async (stage) => {
        try {
          return (await deps.arkrec?.describe?.(stage.code)) ?? null;
        } catch {
          return null;
        }
      }));

    const lines = [];
    lines.push(`打关卡计划：${plan.stages.length} 关，每关 ${times} 次${params.series !== undefined ? `（代理倍率 series=${params.series}）` : ''}。`);
    /** @type {Array<Record<string, any>>} */
    const items = [];
    /** @type {Array<Record<string, any>>} */
    const requests = [];
    let anyNotFullStar = false;

    plan.stages.forEach((stage, index) => {
      const info = infos[index];
      const tier = tiers[index];
      const record = typeof ledger?.get === 'function' ? ledger.get(stage.code) : undefined;
      const lastFailure = lastFailureOf(record);
      const noteParts = [];
      if (stage.activity === true) noteParts.push('活动/特殊关卡');
      if (lastFailure !== null) {
        noteParts.push(`上次失败：${lastFailure.code}`);
        if (record?.fullStar !== true) anyNotFullStar = true;
      }
      if (record?.fullStar !== true) anyNotFullStar = true;
      const item = {
        stage: stage.display ?? stage.code,
        code: stage.code,
        difficulty: tier,
        times,
        sanity: stage.sanity,
        ...(info?.cn_name ? { cnName: info.cn_name } : {}),
        ...(stage.activity === true ? { activity: true } : {}),
        ...(record !== undefined ? { ledgerFullStar: record.fullStar === true, ledgerStars: record.stars ?? null } : {}),
        ...(noteParts.length > 0 ? { note: noteParts.join('；') } : {}),
      };
      items.push(item);
      requests.push({
        code: stage.code,
        entries: stage.entries,
        entry: stage.entry,
        tier,
        requested: params.difficulty,
        sanity: stage.sanity,
      });

      const ledgerText = record?.fullStar === true
        ? '账本：已满星（仍按指令再打）'
        : Number.isFinite(record?.stars)
          ? `账本：上次 ${record.stars} 星`
          : '账本：没打过';
      lines.push(`- ${item.stage}${item.cnName ? `（${item.cnName}）` : ''} · 难度 ${difficultyText(tier, params.difficulty)} · 每次 ${stage.sanity === null ? '理智未知' : `${stage.sanity} 理智`} · ${ledgerText}`);
      if (typeof info?.challenge === 'string' && info.challenge !== '') {
        lines.push(`  突袭条件：${info.challenge}`);
      }
      if (lastFailure !== null) {
        const hint = failureHint(lastFailure.code);
        lines.push(`  上次失败：${lastFailure.code} · ${lastFailure.message}${hint !== '' ? `；建议：${hint}` : ''}`);
      }
      if (stage.activity === true) {
        lines.push('  注意：活动/特殊关卡不在 MAA 关卡表里，只能按 MAA 支持的活动值导航。');
      }
    });

    lines.push(`预计理智合计：${totalSanityText(plan)}（不含理智药/碎石；未满星关改抄作业时只打 1 次，不叠加）。`);
    if (drops !== null) {
      lines.push(`目标掉落：${drops.labels.join('、')}（只对代理指挥生效；达到任一数量即停）。`);
    }

    // 作业可用性提示
    const maxSolutions = Number.isFinite(config?.copilot?.maxSolutionsPerStage)
      ? config.copilot.maxSolutionsPerStage
      : 3;
    if (params.file !== undefined) {
      lines.push(`执行方式：先试代理指挥（Fight）；失败时用本地作业文件 ${params.file}。`);
    } else if (params.copilotId !== undefined) {
      lines.push(`执行方式：先试代理指挥（Fight）；无法代理时用作业站 id=${params.copilotId} 的作业。`);
    } else if (config?.copilot?.enabled !== false) {
      lines.push(`执行方式：先试代理指挥（Fight）；没有代理指挥/开战失败时自动改抄作业（Copilot，每关最多 ${maxSolutions} 份）。`);
    } else {
      lines.push('执行方式：只试代理指挥（Fight）；配置里关掉了作业站（copilot.enabled=false），未满星关卡会失败。');
    }
    if (params.video !== undefined) {
      lines.push(`视频兜底：${params.video}（best-effort，不阻塞 file/copilotId）。`);
    }
    if (config?.copilot?.enabled === false && params.file === undefined && params.copilotId === undefined && anyNotFullStar) {
      lines.push('提示：有未满星关卡，且没有指定 file/copilotId；没代理指挥时这一关会失败。');
    }
    for (const warning of warnings) lines.push(`提示：${warning}`);
    const sanityNote = sanityWarning(state, plan.totalSanity);
    if (sanityNote !== '') lines.push(sanityNote);
    if (needsConfirm('fight', params) && !isConfirmed(config, params)) {
      lines.push('这一步**没有消耗任何理智**。确认无误后，用同一个工具再加 confirm=true（命令里加 --yes）才会真的开打。');
    }

    snapshot = {
      items,
      requests: requests.map((request) => ({
        ...request,
        times,
        ...(params.series !== undefined ? { series: params.series } : {}),
        ...(drops !== null ? { drops: drops.ids } : {}),
        ...(params.medicine !== undefined ? { medicine: params.medicine } : {}),
        ...(params.stone !== undefined ? { stone: params.stone } : {}),
        ...(params.useSanityPotion === true ? { useSanityPotion: true } : {}),
        ...(params.copilotId !== undefined ? { copilotId: params.copilotId } : {}),
        ...(params.file !== undefined ? { file: params.file } : {}),
        ...(params.video !== undefined ? { video: params.video } : {}),
      })),
      nameToId,
    };
    return {
      text: lines.join('\n'),
      plannedItems: items,
      plannedTotalSanity: plan.totalSanity,
    };
  };

  /**
   * 执行计划里的关卡。
   * @param {Record<string, any>} params - 参数。
   * @param {Record<string, any>} run - run 记录。
   * @returns {Promise<{ text: string, result: Record<string, any>, status: string }>} 结果。
   */
  const execute = async (params, run) => {
    const fighter = createStageFighter(deps);
    await runtime.ensureReady({ autoStart: true, startup: true, ...(run?.signal ? { signal: run.signal } : {}) });

    const lines = [`开始打关卡（每关 ${Number.isFinite(params.times) ? params.times : 1} 次）：`];
    /** @type {Array<Record<string, any>>} */
    const executed = [];
    /** @type {Record<string, any> | null} */
    let firstDiagnosis = null;
    let stopped = false;

    for (let index = 0; index < snapshot.requests.length; index += 1) {
      const request = snapshot.requests[index];
      const item = snapshot.items[index];
      if (run?.signal?.aborted === true) {
        stopped = true;
        lines.push('收到停止请求：后面的关卡没有执行。');
        break;
      }
      run?.update?.({ phase: 'battle', stage: item.code, progress: `${index + 1}/${snapshot.requests.length}` });
      try {
        const result = await fighter({ ...request, ...(run?.signal ? { signal: run.signal } : {}) });
        const sanity = Number.isFinite(result.sanity) ? result.sanity : null;
        const entry = {
          stage: item.code,
          code: item.code,
          stars: result.stars ?? null,
          sanity,
          drops: dropsArray(result.drops, snapshot.nameToId),
          method: result.method ?? 'fight',
          solutionId: result.solutionId ?? null,
          ok: result.ok === true,
          reason: result.reason ?? '',
        };
        executed.push(entry);
        lines.push(describeStageResult(entry));
        if (result.ok === true && Number.isFinite(result.stars)) {
          recordRunSafe(ledger, item.code, {
            stars: result.stars,
            method: result.method ?? 'fight',
            solutionId: result.solutionId,
            difficulty: item.difficulty,
          }, logger);
        } else if (Number.isFinite(result.stars)) {
          recordRunSafe(ledger, item.code, {
            stars: result.stars,
            method: result.method ?? 'fight',
            solutionId: result.solutionId,
            difficulty: item.difficulty,
          }, logger);
        } else {
          const diagnosis = classifyFailure({
            state,
            ...(deps.paths ? { paths: deps.paths } : {}),
            fallback: { code: 'unknown', message: '任务链结束了，但没有收到 StageDrops 星级事件。' },
          });
          firstDiagnosis ??= diagnosis;
          recordFailureSafe(ledger, item.code, diagnosis, logger);
          lines.push(indent(describeDiagnosis(diagnosis)));
        }
      } catch (error) {
        if (error?.code === 'E_ABORTED') {
          stopped = true;
          lines.push('收到停止请求：后面的关卡没有执行。');
          break;
        }
        const diagnosis = error?.diagnosis ?? classifyFailure({
          state,
          ...(deps.paths ? { paths: deps.paths } : {}),
          fallback: {
            code: fallbackDiagnosisCode(error),
            message: error instanceof Error ? error.message : String(error),
          },
          ...(error !== undefined ? { error } : {}),
        });
        if (error?.dismissed !== true) await runtime.dismissOverlays?.(1);
        firstDiagnosis ??= diagnosis;
        recordFailureSafe(ledger, item.code, diagnosis, logger);
        const errorCode = typeof error?.code === 'string' ? error.code : 'E_UNDEFINED';
        const errorMessage = error instanceof Error ? error.message : String(error);
        executed.push({
          stage: item.code,
          code: item.code,
          ok: false,
          stars: null,
          sanity: null,
          drops: [],
          method: null,
          solutionId: null,
          error: {
            code: errorCode,
            message: errorMessage,
            ...(typeof error?.hint === 'string' && error.hint !== '' ? { hint: error.hint } : {}),
          },
          diagnosis,
        });
        lines.push(`- ${item.code}：失败（${errorCode}）${errorMessage !== '' ? `：${firstLine(errorMessage)}` : ''}`);
        lines.push(indent(describeFailure(error, diagnosis)));
      }
    }

    const okCount = executed.filter((entry) => entry.ok === true).length;
    const totalSanity = executed.reduce((sum, entry) => sum + (Number.isFinite(entry.sanity) ? entry.sanity : 0), 0);
    lines.push(`完成：${okCount}/${snapshot.requests.length} 关满星${stopped ? '（已停止）' : ''}。`);
    lines.push(`本次执行 ${executed.length} 关，计消耗理智约 ${totalSanity}。`);
    const result = {
      planned: snapshot.items,
      executed,
      totals: { sanity: totalSanity, stages: executed.length },
      ...(firstDiagnosis !== null ? { diagnosis: firstDiagnosis } : {}),
    };
    const status = stopped
      ? 'stopped'
      : okCount === snapshot.requests.length && executed.length === snapshot.requests.length
        ? 'completed'
        : 'partial';
    return { text: lines.join('\n'), result, status };
  };

  return async (params = {}) => {
    const clean = normalizeFightParams(params, config);
    snapshot = null;
    return runAction({
      config,
      store,
      kind: 'fight',
      params: clean,
      plan: async () => {
        const plan = await buildPlan(clean);
        return {
          text: plan.text,
          plannedItems: plan.plannedItems,
          plannedTotalSanity: plan.plannedTotalSanity,
        };
      },
      execute: async (run) => {
        if (snapshot === null) {
          // 理论上 runAction 一定先调 plan；兜底再算一次（仍然零副作用）。
          await buildPlan(clean);
        }
        return execute(clean, run);
      },
    });
  };
}

/**
 * 异常 → 失败分类码（classifyFailure 的 fallback 用）。
 * @param {unknown} error - 原始错误。
 * @returns {string} 失败分类码。
 */
function fallbackDiagnosisCode(error) {
  const code = error?.code;
  switch (code) {
    case 'E_STAGE_UNKNOWN': return 'stage-not-found';
    case 'E_SOLUTION_INVALID': return 'copilot-file';
    case 'E_TIMEOUT': return 'timeout';
    case 'E_OPER_MISSING': return 'oper-missing';
    case 'E_CONNECT': return 'connection';
    default: return 'unknown';
  }
}

/**
 * 把失败渲染成多行文本：分类诊断 + 该错误自己的修复建议（例如三条出路）。
 * @param {unknown} error - 原始错误。
 * @param {Record<string, any>} diagnosis - 分类诊断。
 * @returns {string} 文本。
 */
function describeFailure(error, diagnosis) {
  const lines = [describeDiagnosis(diagnosis)];
  const errorHint = typeof error?.hint === 'string' && error.hint !== '' ? error.hint : '';
  if (errorHint !== '') {
    const alreadyInDiagnosis = typeof diagnosis?.hint === 'string' && diagnosis.hint === errorHint;
    if (!alreadyInDiagnosis) lines.push(`下一步：${errorHint}`);
  }
  return lines.join('\n');
}

/**
 * 取一段文本的第一行。
 * @param {string} text - 文本。
 * @returns {string} 第一行。
 */
function firstLine(text) {
  return String(text ?? '').split('\n')[0];
}

/**
 * 把单关结果渲染成一行。
 * @param {Record<string, any>} entry - 执行结果。
 * @returns {string} 文本。
 */
function describeStageResult(entry) {
  const method = entry.method === 'copilot' ? '抄作业' : '代理指挥';
  const starText = Number.isFinite(entry.stars) ? `${entry.stars} 星` : '星级未知';
  const drops = (entry.drops ?? []).map((drop) => `${drop.itemName}×${drop.quantity}`).join('、');
  const solution = Number.isFinite(entry.solutionId) ? `（作业 ${entry.solutionId}）` : '';
  if (entry.ok === true) {
    return `- ${entry.stage}：满星 · ${method}${solution} · ${starText}${drops === '' ? '' : ` · 掉落 ${drops}`}`;
  }
  return `- ${entry.stage}：未满星 · ${method}${solution} · ${starText}${drops === '' ? '' : ` · 掉落 ${drops}`}`;
}

/**
 * 缩进一段多行文本。
 * @param {string} text - 文本。
 * @returns {string} 缩进后的文本。
 */
function indent(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `  ${line}`)
    .join('\n');
}

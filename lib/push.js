/**
 * 推关：按主线顺序一关接一关地打，直到推到边界。
 *
 * 语义（与「打关卡」分得很清）：
 * - **严格按顺序**推进，不跳关、不猜关；
 * - 账本里已满星且 `skipLedgerFullStar` 的关**跳过**（零消耗）；
 * - 遇到 `E_STAGE_UNKNOWN`（关卡未解锁）→ **到达边界，正常结束**；
 * - 遇到没有作业 → 按 `stopOnNoSolution` 决定停下还是跳过；
 * - 连续失败达到 `maxConsecutiveFailures` → 停下。
 *
 * @module @local/arknights/push
 */

import { arkError } from './errors.js';
import {
  chapterStages,
  estimateSanity,
  mainlineStages,
  nextMainlineStage,
  normalizeCode,
  resolveStage,
} from './stages.js';

/**
 * 造一个推关器。
 * @param {{ config: any, ledger: any, resources: () => Promise<{ stages: Array<Record<string, any>> }>,
 *   runner: (services: any) => any, onProgress?: (line: string) => void }} deps - 依赖。
 *   `runner` 是一个**工厂**：只有真要开打时才会被调用（计划阶段零副作用）。
 * @returns {object} 推关器。
 */
export function createPush(deps) {
  const { config, ledger, resources, onProgress } = deps;

  /**
   * 计划：算出这次会推哪几关（不消耗任何资源，也不创建执行器）。
   * @param {{ from?: string, chapter?: number, maxStages?: number }} input - 计划参数。
   * @returns {Promise<Record<string, any>>} 计划。
   */
  const plan = async (input = {}) => {
    const loaded = await resources();
    const mainline = mainlineStages(loaded.stages);
    if (mainline.length === 0) throw arkError('E_MAA_LOAD', '关卡表里没有主线关卡，无法推关。');

    const chapter = Number.isFinite(input.chapter) ? Math.trunc(input.chapter) : null;
    /** @type {string} */
    let fromRaw = typeof input.from === 'string' && input.from.trim() !== '' ? input.from.trim() : '';
    // 只有在「没指定章节」时才回退到账本/配置里的推关进度；
    // 指定了章节却从别的章继续会让人误以为跳章。
    if (fromRaw === '' && chapter === null) fromRaw = ledger.nextPushStage() || config.push.from || '';

    /** @type {Array<Record<string, any>>} */
    let queue;
    if (chapter !== null) {
      queue = chapterStages(mainline, chapter);
      if (queue.length === 0) throw arkError('E_STAGE_UNKNOWN', `第 ${chapter} 章没有可推的关卡。`);
    } else {
      queue = mainline;
    }

    if (fromRaw !== '') {
      const normalized = normalizeCode(fromRaw);
      const startIndex = queue.findIndex((entry) => normalizeCode(entry.code) === normalized);
      if (startIndex < 0) {
        // 分清两件事：代码根本不存在（E_STAGE_UNKNOWN） vs 存在但不是主线/本章关（E_BAD_ARGS）
        let exists = false;
        try {
          resolveStage(loaded.stages, fromRaw);
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          throw arkError('E_STAGE_UNKNOWN', `关卡代码「${fromRaw}」不存在。`, {
            hint: '用 ark_fight 的预览或 ark_status 查一下准确的关卡代码。',
          });
        }
        throw arkError('E_BAD_ARGS', `起点「${fromRaw}」不在${chapter === null ? '主线关卡' : `第 ${chapter} 章`}里。`, {
          hint: chapter === null
            ? '起点要用主线普通关代码，例如 5-3 或 10-1。'
            : `第 ${chapter} 章的第一个关卡是 ${queue[0].code}。`,
        });
      }
      queue = queue.slice(startIndex);
    } else if (chapter === null) {
      throw arkError('E_BAD_ARGS', '推关需要一个起点：from=<关卡代码> 或 chapter=<章号>。', {
        hint: '也可以先跑一次 ark_status 看看账本里记录的推关进度。',
      });
    }

    const limit = Number.isFinite(input.maxStages) && input.maxStages > 0
      ? Math.min(Math.trunc(input.maxStages), 200)
      : config.push.maxStages;

    /** @type {Array<Record<string, any>>} */
    const picked = [];
    let skipped = 0;
    for (const entry of queue) {
      if (picked.length >= limit) break;
      const record = ledger.get(entry.code);
      if (record?.fullStar === true && config.push.skipLedgerFullStar !== false) {
        skipped += 1;
        continue;
      }
      picked.push(entry);
    }

    const lastQueued = picked.length > 0 ? picked[picked.length - 1] : null;
    const nextAfterQueue = lastQueued === null ? null : nextMainlineStage(mainline, lastQueued.code);
    const sanity = picked.reduce((sum, entry) => sum + (estimateSanity(entry, 1) ?? 0), 0);
    return {
      queue: picked,
      skipped,
      sanity,
      chapter,
      from: fromRaw,
      nextAfterQueue: nextAfterQueue?.code ?? '',
      nextAfterSkip: queue.length > 0 ? queue[queue.length - 1].code : fromRaw,
    };
  };

  /**
   * 执行推关。
   * @param {{ from?: string, chapter?: number, maxStages?: number, runner: any }} input - 参数（runner 必需）。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const run = async (input = {}) => {
    const runner = input.runner ?? deps.runner?.();
    if (runner === null || runner === undefined || typeof runner.fightStage !== 'function') {
      throw arkError('E_BAD_ARGS', '推关缺少执行器（内部错误）。');
    }
    const planned = await plan(input);
    if (planned.queue.length === 0) {
      return {
        planned,
        pushed: [],
        stopped: { code: planned.nextAfterSkip, reason: 'nothing-to-push' },
        nextStage: planned.nextAfterSkip,
      };
    }

    /** @type {Array<Record<string, any>>} */
    const pushed = [];
    let consecutiveFailures = 0;
    /** @type {{ code: string, reason: string } | null} */
    let stopped = null;

    for (const entry of planned.queue) {
      onProgress?.(`推关：${entry.code}`);
      let result;
      try {
        result = await runner.fightStage({
          entry,
          entries: [entry],
          code: entry.code,
          times: 1,
          difficulty: config.defaultDifficulty,
        });
      } catch (error) {
        const code = error?.code ?? 'E_UNDEFINED';
        pushed.push({ code: entry.code, ok: false, reason: code, message: error?.message ?? String(error) });
        consecutiveFailures += 1;

        if (code === 'E_STAGE_UNKNOWN') {
          stopped = { code: entry.code, reason: 'stage-not-found' };
          break;
        }
        if (code === 'E_NO_SOLUTION' && config.push.stopOnNoSolution !== false) {
          stopped = { code: entry.code, reason: 'no-solution' };
          break;
        }
        if (consecutiveFailures >= config.push.maxConsecutiveFailures) {
          stopped = { code: entry.code, reason: 'too-many-failures' };
          break;
        }
        continue;
      }

      pushed.push({
        code: entry.code,
        ok: result.ok === true,
        stars: result.stars ?? null,
        method: result.method ?? 'fight',
        sanity: result.sanity ?? null,
        drops: result.drops ?? {},
      });
      if (result.ok === true) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.push.maxConsecutiveFailures) {
        stopped = { code: entry.code, reason: 'not-three-stars' };
        break;
      }
    }

    const lastOk = [...pushed].reverse().find((item) => item.ok === true) ?? null;
    /** @type {string} */
    let nextStage;
    if (stopped === null) {
      stopped = { code: planned.nextAfterQueue, reason: 'queue-exhausted' };
      nextStage = planned.nextAfterQueue;
    } else if (lastOk !== null) {
      nextStage = planned.queue.find((entry) => entry.code === lastOk.code) === undefined
        ? stopped.code
        : (nextMainlineStage(planned.queue, lastOk.code)?.code ?? stopped.code);
    } else {
      nextStage = planned.queue[0]?.code ?? stopped.code;
    }

    ledger.setPush({ nextStage, lastStopped: stopped.code, lastReason: stopped.reason });
    return { planned, pushed, stopped, nextStage };
  };

  return { plan, run };
}

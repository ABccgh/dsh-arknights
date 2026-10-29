/**
 * `push` 动作：按主线顺序一关接一关推，直到进度边界。
 *
 * 计划复用 `lib/push.js` 的 `plan`（起点/章节/上限/跳过账本满星），执行逐关复用
 * `lib/actions/fight.js` 的**单关执行器**（不嵌套 runAction，避免子 run 抢单飞锁）。
 *
 * 停止语义（与 `lib/push.js` 保持一致）：
 * - `E_STAGE_UNKNOWN`（未解锁）→ 停在原地，记 `stage-not-found`（正常到达边界）；
 * - `E_NO_SOLUTION` → `config.push.stopOnNoSolution` 决定停或继续；
 * - 连续失败达到 `config.push.maxConsecutiveFailures` → 停。
 *
 * @module @local/arknights/actions/push
 */

import { describeError } from '../errors.js';
import { estimateSanity, nextMainlineStage } from '../stages.js';
import { createPush } from '../push.js';
import { classifyFailure, describeDiagnosis } from './classify.js';
import {
  createStageFighter,
  recordFailureSafe,
  recordRunSafe,
} from './fight.js';
import { isConfirmed, needsConfirm, runAction } from './shared.js';

/**
 * 停止原因中文。
 * @param {string} reason - 代码。
 * @returns {string} 文本。
 */
function reasonText(reason) {
  switch (reason) {
    case 'queue-exhausted': return '本次队列打完（可能已到主线尽头）';
    case 'stage-not-found': return '关卡未解锁（到达进度边界）';
    case 'no-solution': return '该关没有可用作业';
    case 'not-three-stars': return '连续未满星';
    case 'too-many-failures': return '连续失败过多';
    case 'nothing-to-push': return '没有需要推的关';
    case 'stopped': return '被手动停止';
    default: return reason || '—';
  }
}

/**
 * 造 `push` 动作。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/ledger/resources/copilot/arkrec/paths/session/logger）。
 * @returns {(params: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createPushAction(deps = {}) {
  const { config, store, runtime, state, ledger, logger } = deps;

  /** @type {Record<string, any> | null} */
  let snapshot = null;

  /**
   * 生成计划（零副作用；只读 resources + ledger）。
   * @param {Record<string, any>} params - 参数（from/chapter/maxStages）。
   * @returns {Promise<{ text: string, plannedItems: Array<Record<string, any>>, plannedTotalSanity: number }>} 计划。
   */
  const buildPlan = async (params) => {
    const resources = await deps.resources();
    const pusher = createPush({
      config,
      ledger,
      resources: async () => resources,
    });
    const planned = await pusher.plan(params ?? {});
    const limit = planned.queue.length;
    const items = planned.queue.map((entry) => ({
      stage: entry.code,
      code: entry.code,
      difficulty: 'easy',
      times: 1,
      sanity: estimateSanity(entry, 1),
    }));
    const lines = [];
    if (planned.queue.length === 0) {
      lines.push('推关计划：没有需要推的关（从起点起要么已满星，要么已到队列末尾）。');
      lines.push(`跳过账本已满星：${planned.skipped} 关；起点：${planned.from === '' ? '（自动）' : planned.from}。`);
    } else {
      lines.push(`推关计划：从 ${planned.from === '' ? planned.queue[0].code : planned.from} 起推 ${limit} 关（跳过账本已满星 ${planned.skipped} 关），每关 1 次。`);
      for (const item of items) {
        lines.push(`- ${item.stage} · ${item.sanity === null ? '理智未知' : `${item.sanity} 理智`}`);
      }
      lines.push(`预计理智合计：${planned.sanity}（不含理智药/碎石；未满星关改抄作业时按 1 次算）。`);
      lines.push(`执行方式：一关接一关；先试代理指挥，没有代理指挥/开战失败自动抄作业；遇未解锁的关停下（进度边界）；连续失败达到 ${config.push.maxConsecutiveFailures} 次停下。`);
      if (planned.nextAfterQueue !== '') lines.push(`本批打完后的下一关：${planned.nextAfterQueue}。`);
    }
    if (needsConfirm('push', params) && !isConfirmed(config, params)) {
      lines.push('这一步**没有消耗任何理智**。确认无误后，用同一个工具再加 confirm=true（命令里加 --yes）才会真的开推。');
    }

    /** @type {Record<string, string>} */
    const nameToId = {};
    for (const [itemId, name] of Object.entries(resources.itemNames ?? {})) {
      if (typeof name === 'string' && name !== '' && nameToId[name] === undefined) nameToId[name] = itemId;
    }
    snapshot = {
      planned,
      queue: planned.queue,
      items,
      nameToId,
      from: planned.from,
    };
    return {
      text: lines.join('\n'),
      plannedItems: items,
      plannedTotalSanity: planned.queue.length === 0 ? 0 : planned.sanity,
    };
  };

  /**
   * 执行推关。
   * @param {Record<string, any>} params - 参数。
   * @param {Record<string, any>} run - run 记录。
   * @returns {Promise<{ text: string, result: Record<string, any>, status: string }>} 结果。
   */
  const execute = async (params, run) => {
    const planned = snapshot.planned;
    const queue = snapshot.queue;
    if (queue.length === 0) {
      const text = [
        snapshot.items.length === 0 ? '没有需要推的关。' : '',
        `停在：${planned.nextAfterSkip || planned.from || '（没有起点）'}，原因：没有需要推的关。`,
      ].filter((line) => line !== '').join('\n');
      return {
        text: `${text}\n没有启动任何 MAA 任务（零消耗）。`,
        result: {
          planned: snapshot.items,
          executed: [],
          totals: { sanity: 0, stages: 0 },
          nextStage: planned.nextAfterSkip ?? '',
          stopped: null,
        },
        status: 'completed',
      };
    }

    const fighter = createStageFighter(deps);
    await runtime.ensureReady({ autoStart: true, startup: true, ...(run?.signal ? { signal: run.signal } : {}) });

    /** @type {Array<Record<string, any>>} */
    const executed = [];
    /** @type {Record<string, any> | null} */
    let firstDiagnosis = null;
    let consecutiveFailures = 0;
    /** @type {{ code: string, reason: string } | null} */
    let stopped = null;

    for (const entry of queue) {
      if (run?.signal?.aborted === true) {
        stopped = { code: entry.code, reason: 'stopped' };
        break;
      }
      run?.update?.({ phase: 'battle', stage: entry.code });
      try {
        const result = await fighter({
          code: entry.code,
          entries: [entry],
          entry,
          tier: 'easy',
          times: 1,
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        const record = {
          stage: entry.code,
          code: entry.code,
          stars: result.stars ?? null,
          sanity: Number.isFinite(result.sanity) ? result.sanity : null,
          drops: Object.entries(result.drops ?? {}).map(([itemName, quantity]) => ({
            itemId: snapshot.nameToId[itemName] ?? null,
            itemName,
            quantity,
          })),
          method: result.method ?? 'fight',
          solutionId: result.solutionId ?? null,
          ok: result.ok === true,
          reason: result.reason ?? '',
        };
        executed.push(record);
        if (Number.isFinite(result.stars)) {
          recordRunSafe(ledger, entry.code, {
            stars: result.stars,
            method: result.method ?? 'fight',
            solutionId: result.solutionId,
            difficulty: 'easy',
          }, logger);
        }
        if (result.ok === true) {
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= config.push.maxConsecutiveFailures) {
          stopped = { code: entry.code, reason: 'not-three-stars' };
          break;
        }
      } catch (error) {
        if (error?.code === 'E_ABORTED') {
          stopped = { code: entry.code, reason: 'stopped' };
          break;
        }
        const diagnosis = error?.diagnosis ?? classifyFailure({
          state,
          ...(deps.paths ? { paths: deps.paths } : {}),
          fallback: {
            code: error?.code === 'E_STAGE_UNKNOWN' ? 'stage-not-found' : 'unknown',
            message: error instanceof Error ? error.message : String(error),
          },
          ...(error !== undefined ? { error } : {}),
        });
        if (error?.dismissed !== true) await runtime.dismissOverlays?.(1);
        firstDiagnosis ??= diagnosis;
        recordFailureSafe(ledger, entry.code, diagnosis, logger);
        const errorCode = typeof error?.code === 'string' ? error.code : 'E_UNDEFINED';
        const errorMessage = error instanceof Error ? error.message : String(error);
        executed.push({
          stage: entry.code,
          code: entry.code,
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
        consecutiveFailures += 1;
        if (errorCode === 'E_STAGE_UNKNOWN') {
          stopped = { code: entry.code, reason: 'stage-not-found' };
          break;
        }
        if (errorCode === 'E_NO_SOLUTION' && config.push.stopOnNoSolution !== false) {
          stopped = { code: entry.code, reason: 'no-solution' };
          break;
        }
        if (consecutiveFailures >= config.push.maxConsecutiveFailures) {
          stopped = { code: entry.code, reason: 'too-many-failures' };
          break;
        }
      }
    }

    const lastOk = [...executed].reverse().find((record) => record.ok === true) ?? null;
    /** @type {string} */
    let nextStage;
    if (stopped === null) {
      stopped = { code: planned.nextAfterQueue ?? '', reason: 'queue-exhausted' };
      nextStage = planned.nextAfterQueue ?? '';
    } else if (lastOk !== null) {
      const next = nextMainlineStage(queue, lastOk.code);
      nextStage = next?.code ?? stopped.code;
    } else {
      nextStage = queue[0]?.code ?? stopped.code;
    }
    try {
      ledger?.setPush?.({
        nextStage,
        lastStopped: stopped.code,
        lastReason: stopped.reason,
      });
    } catch (error) {
      logger?.warn?.(`[arknights] 推关进度写入失败（不影响结果）：${describeError(error)}`);
    }

    const lines = [`开始推关（${queue.length} 关，从 ${planned.from === '' ? queue[0].code : planned.from} 起）：`];
    for (const record of executed) {
      if (record.ok === true) {
        lines.push(`- ${record.stage}：满星 · ${record.method === 'copilot' ? '抄作业' : '代理指挥'} · ${record.stars} 星`);
      } else if (record.diagnosis !== undefined) {
        lines.push(`- ${record.stage}：失败（${record.error?.code ?? 'E_UNDEFINED'}）${record.error?.message ? `：${String(record.error.message).split('\n')[0]}` : ''}`);
        lines.push(indent(describeFailure(record.error, record.diagnosis)));
      } else {
        lines.push(`- ${record.stage}：未满星 · ${record.stars ?? '星级未知'} 星`);
      }
    }
    const okCount = executed.filter((record) => record.ok === true).length;
    const totalSanity = executed.reduce((sum, record) => sum + (Number.isFinite(record.sanity) ? record.sanity : 0), 0);
    lines.push(`停在：${stopped.code || '（队列结束）'}，原因：${reasonText(stopped.reason)}。`);
    if (nextStage !== '') lines.push(`下次继续：ark_push from=${nextStage}`);
    lines.push(`本次推了 ${executed.length} 关，满星 ${okCount} 关，计消耗理智约 ${totalSanity}。`);

    const result = {
      planned: snapshot.items,
      executed,
      totals: { sanity: totalSanity, stages: executed.length },
      nextStage,
      stopped,
      ...(firstDiagnosis !== null ? { diagnosis: firstDiagnosis } : {}),
    };
    const allOk = executed.length > 0 && okCount === executed.length;
    const status = stopped.reason === 'stopped'
      ? 'stopped'
      : allOk && stopped.reason === 'queue-exhausted'
        ? 'completed'
        : 'partial';
    return { text: lines.join('\n'), result, status };
  };

  return async (params = {}) => {
    snapshot = null;
    return runAction({
      config,
      store,
      kind: 'push',
      params,
      plan: async () => {
        const plan = await buildPlan(params);
        return {
          text: plan.text,
          plannedItems: plan.plannedItems,
          plannedTotalSanity: plan.plannedTotalSanity,
        };
      },
      execute: async (run) => {
        if (snapshot === null) await buildPlan(params);
        return execute(params, run);
      },
    });
  };
}

/**
 * 把失败渲染成多行文本：分类诊断 + 错误自己的修复建议。
 * @param {unknown} error - 原始错误。
 * @param {Record<string, any>} diagnosis - 分类诊断。
 * @returns {string} 文本。
 */
function describeFailure(error, diagnosis) {
  const lines = [describeDiagnosis(diagnosis)];
  const errorHint = typeof error?.hint === 'string' && error.hint !== '' ? error.hint : '';
  if (errorHint !== '' && !(typeof diagnosis?.hint === 'string' && diagnosis.hint === errorHint)) {
    lines.push(`下一步：${errorHint}`);
  }
  return lines.join('\n');
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

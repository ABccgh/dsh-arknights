/**
 * `daily` 动作：把日常任务按固定顺序串起来跑（MAA `StartUp` → `Award` → `Mall` →
 * `Infrast` → `Recruit`（只识别）→ 可选 `Depot`/`OperBox`）。
 *
 * 行为约定（docs/contracts.md §4/§9/§10）：
 * - **需要 confirm**；计划阶段只读配置/账本，零副作用；
 * - 每项独立一条 MAA 任务链；某一项失败**不中断**后续，逐项结果进 `result.daily.tasks`；
 * - `skipDone=true`（默认）时按账本跳过当天已完成的 award/mall/infrast；recruit/box 只读
 *   不记完成，永远重复跑；
 * - 全部跳过时不启动 MAA；真正执行前先 `runtime.ensureReady({startup:true})`；
 * - 结束后把成功的 award/mall/infrast 写进账本（`ledger.markDaily({date,tasks})`）。
 *
 * @module @local/arknights/actions/daily
 */

import { DAILY_TASKS } from '../config.js';
import { arkError, describeError, normalizeError } from '../errors.js';
import { planResult, runAction } from './shared.js';
import { runAward } from './award.js';
import { runMall } from './mall.js';
import { runInfrast } from './infrast.js';
import { runRecruit } from './recruit.js';
import { runBox } from './box.js';

/** 固定执行顺序（用户给的 tasks 顺序不改变它）。 */
export const DAILY_CANONICAL_ORDER = ['award', 'mall', 'infrast', 'recruit', 'box'];

/** 会被记入账本「今天已完成」的项（recruit/box 只读，不记完成）。 */
const MARKED_TASKS = new Set(['award', 'mall', 'infrast']);

/** 每一项的展示信息与资源说明。 */
const TASK_INFO = {
  award: {
    label: '领取奖励',
    consumes: 'none',
    note: '每日/每周奖励、邮件等；不消耗理智/源石/招聘许可',
  },
  mall: {
    label: '信用商店',
    consumes: 'credit',
    note: '只消耗信用点（游戏内货币）；不消耗理智/源石/招聘许可',
  },
  infrast: {
    label: '基建换班',
    consumes: 'none',
    note: '不消耗理智；指定无人机时才会用掉基建无人机库存',
  },
  recruit: {
    label: '公招识别',
    consumes: 'none',
    note: '只识别 Tags 与组合；不消耗招聘许可、不确认招募、不刷新标签',
  },
  box: {
    label: '仓库/干员识别',
    consumes: 'none',
    note: '只识别并写入本地快照；不消耗资源',
  },
};

/**
 * 取对象。
 * @param {unknown} value - 原始值。
 * @returns {Record<string, any>} 对象。
 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 取布尔值，否则回退。
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 回退值。
 * @returns {boolean} 布尔值。
 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 本地日期 `YYYY-MM-DD`（账本的 daily 用本地日，跟游戏日常重置对齐）。
 * @param {Date} [now] - 时间。
 * @returns {string} 日期。
 */
export function todayLocal(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 归一「要跑哪些日常」：容错字符串/数组，丢掉非法项、按固定顺序输出。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {string[]} 规范化后的任务列表。
 * @throws {ArkError} 没有任务或包含未知任务时 `E_BAD_ARGS`。
 */
export function resolveDailyTasks(config, params = {}) {
  const raw = params?.tasks === undefined || params?.tasks === null || params?.tasks === ''
    ? config?.daily?.tasks
    : params.tasks;
  const tokens = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、;；\s]+/);
  /** @type {string[]} */
  const selected = [];
  /** @type {string[]} */
  const unknown = [];
  for (const token of tokens) {
    const name = typeof token === 'string' ? token.trim().toLowerCase() : '';
    if (name === '') continue;
    if (!DAILY_TASKS.includes(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    if (!selected.includes(name)) selected.push(name);
  }
  if (unknown.length > 0) {
    throw arkError('E_BAD_ARGS', `不认识的日常项：${unknown.join('、')}。`, {
      hint: `可用：${DAILY_TASKS.join(' / ')}。`,
    });
  }
  const ordered = DAILY_CANONICAL_ORDER.filter((task) => selected.includes(task));
  if (ordered.length === 0) {
    throw arkError('E_BAD_ARGS', '没有要执行的日常任务。', {
      hint: `用 tasks 指定，例如 "award,mall,infrast"；可选：${DAILY_TASKS.join(' / ')}。`,
    });
  }
  return ordered;
}

/**
 * 确保某个 daily 子任务在当前配置里有定义。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} params - 动作参数。
 * @param {string} task - 任务名。
 * @returns {Record<string, any>} 合并后的子任务参数。
 */
function mergeTaskParams(config, params, task) {
  return { ...asObject(config?.daily?.[task]), ...asObject(params?.[task]) };
}

/**
 * 读账本里的「今天已完成」视图，兼容 kernel 的 `viewDaily()` 与旧的 `dailyView()`。
 * @param {any} ledger - 账本。
 * @returns {{ date: string, tasks: Record<string, any> }} 视图。
 */
export function readDailyView(ledger) {
  try {
    const fn = typeof ledger?.viewDaily === 'function'
      ? ledger.viewDaily
      : typeof ledger?.dailyView === 'function'
        ? ledger.dailyView
        : null;
    if (fn === null) return { date: '', tasks: {} };
    const view = asObject(fn.call(ledger));
    return {
      date: typeof view.date === 'string' ? view.date : '',
      tasks: asObject(view.tasks),
    };
  } catch {
    return { date: '', tasks: {} };
  }
}

/**
 * 这一项今天是否已完成（只认 award/mall/infrast）。
 * @param {{ date: string, tasks: Record<string, any> }} view - 账本视图。
 * @param {string} today - 今天（本地日期）。
 * @param {string} task - 任务名。
 * @returns {boolean} 已完成 true。
 */
function isDoneToday(view, today, task) {
  if (!MARKED_TASKS.has(task)) return false;
  if (view.date !== today) return false;
  const entry = asObject(view.tasks[task]);
  return entry.ok === true;
}

/**
 * 把成功的 award/mall/infrast 写入账本（失败只告警，不影响动作结果）。
 * @param {any} ledger - 账本。
 * @param {string} date - 本地日期。
 * @param {Record<string, any>} tasks - 逐项结果。
 * @param {any} [logger] - 日志。
 * @returns {Promise<boolean>} 写成功 true。
 */
async function markDaily(ledger, date, tasks, logger) {
  if (typeof ledger?.markDaily !== 'function') return false;
  try {
    await ledger.markDaily({ date, tasks });
    return true;
  } catch (error) {
    logger?.warn?.(`[arknights] 日常完成记录写入失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 把多行文本压成一行（结果里逐项摘要用，避免无限长）。
 * @param {unknown} text - 文本。
 * @param {number} [max] - 字符上限。
 * @returns {string} 单行文本。
 */
function clipLine(text, max = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 造日常计划（零副作用：只读配置与账本）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} params - 动作参数。
 * @returns {Record<string, any>} planResult 形状。
 */
export function planDaily(deps, params = {}) {
  const { config, ledger } = deps;
  const tasks = resolveDailyTasks(config, params);
  const skipDone = boolOr(params?.skipDone, config?.daily?.skipDone !== false);
  const today = todayLocal();
  const view = readDailyView(ledger);
  const plannedItems = [];
  const skipped = [];
  const lines = [`日常计划（${tasks.length} 项，按固定顺序执行）：`];
  tasks.forEach((task, index) => {
    const info = TASK_INFO[task];
    const done = skipDone && isDoneToday(view, today, task);
    if (done) skipped.push(task);
    lines.push(`${index + 1}. ${task}（${info.label}）— ${info.note}${done ? '；今天已完成，执行时将跳过' : ''}`);
    plannedItems.push({
      task,
      label: info.label,
      consumes: info.consumes,
      note: info.note,
      ...(done ? { skip: true } : {}),
    });
  });
  lines.push('预计消耗：0 理智、0 源石、0 招聘许可（recruit 只识别、box 只识别）。');
  if (skipped.length > 0) lines.push(`skipDone=true：今天已完成 ${skipped.join('、')}，执行时会跳过。`);
  lines.push('执行需要 confirm=true。');
  return {
    ...planResult({
      kind: 'daily',
      text: lines.join('\n'),
      planned: plannedItems,
      plannedTotalSanity: 0,
      totals: { sanity: 0, tasks: tasks.length },
    }),
    plannedItems,
    plannedTotalSanity: 0,
  };
}

/**
 * 执行日常（不经过 runAction；工具/HTTP 只经 createDailyAction）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @param {Record<string, any>} [run] - run store 的当前 run（写 phase 用）。
 * @returns {Promise<{ text: string, result: Record<string, any>, status: 'completed'|'partial'|'failed' }>} 结果。
 */
export async function runDaily(deps, params = {}, run = null) {
  const { config, ledger, logger } = deps;
  const tasks = resolveDailyTasks(config, params);
  const skipDone = boolOr(params?.skipDone, config?.daily?.skipDone !== false);
  const today = todayLocal();
  const view = readDailyView(ledger);
  /** @type {Record<string, Record<string, any>>} */
  const taskEntries = {};
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const toRun = [];
  for (const task of tasks) {
    if (skipDone && isDoneToday(view, today, task)) skipped.push(task);
    else toRun.push(task);
  }
  const at = () => new Date().toISOString();
  for (const task of skipped) taskEntries[task] = { ok: true, skipped: true, at: at() };

  // 全部已完成：不启动 MAA（零副作用）。
  if (toRun.length === 0) {
    return {
      text: `今天的日常都已完成，全部跳过（没有启动 MAA）：${skipped.join('、')}。`,
      result: { daily: { date: today, tasks: taskEntries, skipped, ledgerMarked: false, results: {} } },
      status: 'completed',
    };
  }

  // StartUp：回主界面（零理智）。失败则所有待执行项记为失败，不继续。
  try {
    await deps.runtime.ensureReady({
      startup: true,
      ...(run?.signal ? { signal: run.signal } : {}),
    });
  } catch (error) {
    const normalized = normalizeError(error);
    for (const task of toRun) {
      taskEntries[task] = {
        ok: false,
        at: at(),
        code: normalized.code,
        text: clipLine(`环境未就绪，未执行：${describeError(error)}`),
      };
    }
    return {
      text: `环境未就绪，日常没有执行：\n${describeError(error)}`,
      result: { daily: { date: today, tasks: taskEntries, skipped, ledgerMarked: false, results: {} } },
      status: 'failed',
    };
  }

  /** @type {Record<string, () => Promise<{text:string,result?:Record<string,any>,status?:string}>>} */
  const runners = {
    award: () => runAward(deps, mergeTaskParams(config, params, 'award')),
    mall: () => runMall(deps, mergeTaskParams(config, params, 'mall')),
    infrast: () => runInfrast(deps, mergeTaskParams(config, params, 'infrast')),
    // 日常只做公招识别：强制 analyze，忽略子参数里的 mode。
    recruit: () => runRecruit(deps, { ...mergeTaskParams(config, params, 'recruit'), mode: 'analyze' }),
    box: () => runBox(deps, mergeTaskParams(config, params, 'box')),
  };
  /** @type {Record<string, any>} */
  const results = {};

  for (const task of toRun) {
    try {
      run?.update?.({ phase: task });
    } catch {
      // phase 只是面板展示，写不进去不影响执行。
    }
    try {
      const outcome = await runners[task]();
      const partial = outcome.status === 'partial';
      taskEntries[task] = {
        ok: true,
        at: at(),
        text: clipLine(outcome.text),
        ...(partial ? { partial: true } : {}),
      };
      const structured = asObject(outcome.result);
      if (structured[task] !== undefined) results[task] = structured[task];
    } catch (error) {
      const normalized = normalizeError(error);
      taskEntries[task] = {
        ok: false,
        at: at(),
        code: normalized.code,
        text: clipLine(describeError(error)),
      };
    }
  }

  // 只把成功的 award/mall/infrast 记为「今天已完成」；recruit/box 不记。
  /** @type {Record<string, any>} */
  const marked = {};
  for (const task of toRun) {
    if (!MARKED_TASKS.has(task)) continue;
    const entry = taskEntries[task];
    if (entry?.ok === true && entry?.partial !== true) marked[task] = entry;
  }
  const ledgerMarked = Object.keys(marked).length > 0
    ? await markDaily(ledger, today, marked, logger)
    : false;

  /** @type {Array<Record<string, any>>} */
  const failed = Object.values(taskEntries).filter((entry) => entry.ok === false);
  const partialCount = Object.values(taskEntries).filter((entry) => entry.partial === true).length;
  const doneCount = Object.values(taskEntries).filter((entry) => entry.ok === true && entry.skipped !== true).length;
  const status = failed.length > 0 ? 'failed' : partialCount > 0 ? 'partial' : 'completed';
  const lines = [
    `日常结束：${doneCount} 项执行${partialCount > 0 ? `（其中 ${partialCount} 项部分完成）` : ''}，${skipped.length} 项跳过，${failed.length} 项失败。`,
  ];
  for (const task of tasks) {
    const entry = asObject(taskEntries[task]);
    const label = TASK_INFO[task].label;
    if (entry.skipped === true) {
      lines.push(`- ${task}（${label}）：跳过（今天已完成）`);
    } else if (entry.ok === false) {
      lines.push(`- ${task}（${label}）：失败 ${entry.code ?? ''} — ${entry.text ?? ''}`);
    } else if (entry.partial === true) {
      lines.push(`- ${task}（${label}）：部分完成 — ${entry.text ?? ''}`);
    } else {
      lines.push(`- ${task}（${label}）：完成`);
    }
  }
  if (ledgerMarked) lines.push('已记录到账本（award/mall/infrast）。');
  return {
    text: lines.join('\n'),
    result: { daily: { date: today, tasks: taskEntries, skipped, ledgerMarked, results } },
    status,
  };
}

/**
 * 造 `daily` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/ledger/box/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createDailyAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function daily(params = {}) {
    return runAction({
      config,
      store,
      kind: 'daily',
      params,
      plan: () => planDaily(deps, params),
      execute: (run) => runDaily(deps, params, run),
    });
  };
}

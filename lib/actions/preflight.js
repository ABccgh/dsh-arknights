/**
 * 战斗预检：把用户给的一串关卡解析成可执行计划（零副作用）。
 *
 * 只读 `resources`（MAA 关卡表）与可选的 `data`（活动关卡等在线缓存），
 * 不启动 sidecar、不碰模拟器、不消耗任何资源。
 *
 * @module @local/arknights/actions/preflight
 */

import { arkError } from '../errors.js';
import { difficultyTier, estimateSanity, pickDifficulty, resolveStage } from '../stages.js';

/** 单次最多计划多少关。 */
const MAX_STAGES = 20;

/**
 * 按逗号/顿号/空白切关卡。
 * @param {string} input - 用户输入。
 * @returns {string[]} 关卡 token。
 */
export function splitStages(input) {
  return String(input ?? '')
    .split(/[,，、;；\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * 解析一关（允许活动关卡不在 MAA 关卡表里的情况）。
 * @param {{ resources: any, data?: any }} deps - 依赖。
 * @param {string} raw - 关卡代码。
 * @returns {{raw:string, code:string, entry:Record<string, any>, entries:Array<Record<string, any>>, activity:boolean}} 解析结果。
 */
function resolveOne(deps, raw) {
  try {
    const resolved = resolveStage(deps.resources.stages, raw);
    return { raw, code: resolved.code, entries: resolved.entries, entry: resolved.entries[0], activity: false };
  } catch (error) {
    if (error?.code !== 'E_STAGE_UNKNOWN') throw error;
    // 活动关卡：MAA 支持 SSReopen-XX / 当期 SS 后三关 / 剿灭值，MAA 关卡表里可能还没有。
    const activity = typeof deps.data?.stage === 'function' ? deps.data.stage(raw) : null;
    if (activity !== null && activity !== undefined) {
      return {
        raw,
        code: activity.code ?? raw,
        entries: [{ code: activity.code ?? raw, stageId: '', apCost: null, prefix: 'activity', activity: true }],
        entry: { code: activity.code ?? raw, stageId: '', apCost: null, prefix: 'activity', activity: true },
        activity: true,
      };
    }
    throw error;
  }
}

/**
 * 生成战斗计划。
 * @param {{ resources: any, data?: any, requested: string, difficulty?: string, times?: number,
 *   defaultDifficulty?: string }} input - 输入。
 * @returns {{ stages: Array<Record<string, any>>, totalSanity: number|null, warnings: string[] }} 计划。
 */
export function planStages(input) {
  const rawTokens = splitStages(input.requested);
  if (rawTokens.length === 0) throw arkError('E_BAD_ARGS', '没有给关卡。');
  if (rawTokens.length > MAX_STAGES) {
    throw arkError('E_BAD_ARGS', `一次最多计划 ${MAX_STAGES} 关。`);
  }
  const difficulty = input.difficulty ?? input.defaultDifficulty ?? 'auto';
  const times = Number.isFinite(input.times) && input.times > 0 ? Math.trunc(input.times) : 1;
  const plan = [];
  let totalSanity = null;
  const warnings = [];

  for (const raw of rawTokens) {
    const resolved = resolveOne({ resources: input.resources, ...(input.data ? { data: input.data } : {}) }, raw);
    let entry = pickDifficulty(resolved.entries, difficulty);
    let tier = difficultyTier(entry.prefix);
    if (resolved.activity) {
      warnings.push(`「${raw}」是活动/特殊关卡，MAA 关卡表里没有；只能按 MAA 支持的活动值导航。`);
    }
    if (difficulty === 'tough' && tier !== 'tough') {
      // MAA 关卡表不一定收录 15 章以后的险地档，但 MAA 仍接受 `<关卡>-HARD` 导航。
      // 计划按用户的 tough 意图走，并明确提示「游戏内未开放会失败」，不静默降级成常规。
      tier = 'tough';
      entry = { ...entry, prefix: 'tough_', toughFallback: true };
      warnings.push(`「${resolved.code}」的险地/磨难档不在 MAA 关卡表里；仍按 -HARD 导航，游戏内未开放时会失败。`);
    }
    const sanity = estimateSanity(entry, times);
    if (sanity !== null) totalSanity = (totalSanity ?? 0) + sanity;
    plan.push({
      raw,
      code: resolved.code,
      entry,
      entries: resolved.entries,
      tier,
      times,
      sanity,
      activity: resolved.activity,
      display: String(entry.code ?? resolved.code),
    });
  }

  return { stages: plan, totalSanity, warnings };
}

/**
 * 计划里预计消耗的理智（含次数）。
 * @param {ReturnType<typeof planStages>} plan - 计划。
 * @returns {string} 文本，如 `42` 或 `未知`。
 */
export function totalSanityText(plan) {
  return plan.totalSanity === null ? '未知（有关卡缺理智数据）' : String(plan.totalSanity);
}

/**
 * 理智警告：用最后已知理智比较。
 * @param {any} state - 状态容器。
 * @param {number|null} required - 计划消耗。
 * @returns {string} 警告文本；没有数据时为空串。
 */
export function sanityWarning(state, required) {
  if (required === null || required === undefined) return '';
  const snapshot = typeof state?.snapshot === 'function' ? state.snapshot() : null;
  const current = snapshot?.sanity?.current;
  if (!Number.isFinite(current)) return '';
  if (current >= required) return '';
  return `最后已知理智 ${current}，少于计划消耗 ${required}；开打前请确认，必要时先等恢复。`;
}

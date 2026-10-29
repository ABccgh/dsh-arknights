/**
 * `recruit` 动作：公开招募识别与执行（MAA `Recruit` 任务链）。
 *
 * 两种模式（docs/contracts.md §9/§10）：
 * - `mode=analyze`（默认）：**不需要 confirm**，只识别当前槽位的 Tags 与可选组合。
 *   MAA 参数固定为 `times=0, select=[], confirm=[], refresh=false, set_time=false`，
 *   不消耗招聘许可、不刷新标签、不确认招募；解析 `RecruitTagsDetected` / `RecruitResult`。
 * - `mode=execute`：**需要 confirm**，按 times/confirmLevels/selectLevels/refresh/expedite/
 *   permitReserve/firstTags/preserveTags 组装 MAA 参数；资源安全闸由 runAction 处理
 *   （`safety.allowRecruitPermits`，以及 `expedite=true` 时的 `safety.allowExpedite`）。
 *
 * @module @local/arknights/actions/recruit
 */

import { arkError } from '../errors.js';
import { planResult, runAction } from './shared.js';

/** 公招执行的动作超时（10 分钟；工具层同值）。 */
export const RECRUIT_TIMEOUT_MS = 10 * 60 * 1000;
/** 公招识别（times=0）的超时。 */
export const RECRUIT_ANALYZE_TIMEOUT_MS = 3 * 60 * 1000;

/** 单次最多招募多少次。 */
const MAX_TIMES = 100;
/** 允许的星级。 */
const LEVELS = [3, 4, 5, 6];

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
 * 取整数，非法回退。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 回退值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 取整数或 null。
 * @param {unknown} value - 原始值。
 * @returns {number|null} 整数或 null。
 */
function intOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * 取字符串，否则空串。
 * @param {unknown} value - 原始值。
 * @returns {string} 字符串。
 */
function textOr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 取去重后的字符串数组（每项非空，带长度上限）。
 * @param {unknown} value - 原始值。
 * @param {number} [limit] - 最多几项。
 * @returns {string[]} 字符串数组。
 */
function stringList(value, limit = 40) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = textOr(item);
    if (text === '' || out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 取星级数组（只允许 3–6，去重升序）。
 * @param {unknown} value - 原始值。
 * @param {number[]} fallback - 回退值。
 * @param {string} label - 参数名（错误消息用）。
 * @returns {number[]} 星级数组。
 * @throws {ArkError} 有非法星级时 `E_BAD_ARGS`。
 */
function levelList(value, fallback, label) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw arkError('E_BAD_ARGS', `${label} 必须是数组，例如 [3,4]。`);
  /** @type {number[]} */
  const out = [];
  for (const item of value) {
    const level = intOrNull(item);
    if (level === null || !LEVELS.includes(level)) {
      throw arkError('E_BAD_ARGS', `${label} 里的「${String(item)}」不是 3–6 星。`, {
        hint: `可用星级：${LEVELS.join(' / ')}；只公招计算请用 mode=analyze。`,
      });
    }
    if (!out.includes(level)) out.push(level);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 生效超时：`config.daily.recruit.timeoutMs` 可覆盖（识别/执行分别有默认）。
 * @param {Record<string, any>} config - 生效配置。
 * @param {'analyze'|'execute'} mode - 模式。
 * @returns {number} 毫秒。
 */
function recruitTimeout(config, mode) {
  const fallback = mode === 'execute' ? RECRUIT_TIMEOUT_MS : RECRUIT_ANALYZE_TIMEOUT_MS;
  return intIn(asObject(config?.daily?.recruit).timeoutMs, fallback, 10000, 4 * 60 * 60 * 1000);
}

/**
 * 把动作参数与 `config.daily.recruit` 合成 MAA 参数。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {{ mode: 'analyze'|'execute', times: number, confirmLevels: number[], selectLevels: number[],
 *   refresh: boolean, expedite: boolean, permitReserve: number, firstTags: string[], preserveTags: string[],
 *   maa: Record<string, any> }} 组装结果。
 * @throws {ArkError} 参数不合法时 `E_BAD_ARGS`。
 */
export function resolveRecruitParams(config, params = {}) {
  const rawMode = params?.mode;
  const mode = rawMode === undefined || rawMode === null || rawMode === '' ? 'analyze' : rawMode;
  if (mode !== 'analyze' && mode !== 'execute') {
    throw arkError('E_BAD_ARGS', `mode=${String(rawMode)} 不支持；只能是 analyze 或 execute。`, {
      hint: 'analyze 只识别、不消耗招聘许可；execute 才会真正招募（需要 confirm=true 与 safety.allowRecruitPermits）。',
    });
  }
  const configured = asObject(config?.daily?.recruit);
  const merged = { ...configured, ...params };

  if (mode === 'analyze') {
    return {
      mode: 'analyze',
      times: 0,
      confirmLevels: [],
      selectLevels: [],
      refresh: false,
      expedite: false,
      permitReserve: 0,
      firstTags: [],
      preserveTags: [],
      maa: {
        enable: true,
        times: 0,
        select: [],
        confirm: [],
        refresh: false,
        set_time: false,
        expedite: false,
        level3_recruitment_permit_reserve: 0,
        first_tags: [],
        preserve_tags: [],
      },
    };
  }

  // —— execute ——
  const timesRaw = merged?.times;
  const times = Number.parseInt(String(timesRaw ?? ''), 10);
  if (Number.isFinite(times) && times < 1) {
    throw arkError('E_BAD_ARGS', 'execute 模式下 times 必须 ≥ 1（times=0 是纯识别）。', {
      hint: '只想看标签与组合用 mode=analyze；要真招募请给 times。',
    });
  }
  const effectiveTimes = intIn(timesRaw, 1, 1, MAX_TIMES);
  const confirmLevels = levelList(merged?.confirmLevels, [3, 4], 'confirmLevels');
  const selectLevels = levelList(merged?.selectLevels, [4, 5], 'selectLevels');
  const refresh = boolOr(merged?.refresh, false);
  const expedite = boolOr(merged?.expedite, false);
  const permitReserveRaw = merged?.permitReserve;
  const permitReserve = permitReserveRaw === undefined || permitReserveRaw === null || permitReserveRaw === ''
    ? 0
    : intIn(permitReserveRaw, 0, 0, 99);
  const firstTags = stringList(merged?.firstTags);
  const preserveTags = stringList(merged?.preserveTags);
  const maa = {
    enable: true,
    times: effectiveTimes,
    select: selectLevels,
    confirm: confirmLevels,
    refresh,
    set_time: true,
    expedite,
    level3_recruitment_permit_reserve: permitReserve,
    first_tags: firstTags,
    preserve_tags: preserveTags,
  };
  return {
    mode: 'execute',
    times: effectiveTimes,
    confirmLevels,
    selectLevels,
    refresh,
    expedite,
    permitReserve,
    firstTags,
    preserveTags,
    maa,
  };
}

/**
 * 取最近事件序号；状态对象缺失时返回 0。
 * @param {any} state - 状态容器。
 * @returns {number} 序号。
 */
function lastSeq(state) {
  return typeof state?.getLastSeq === 'function' ? state.getLastSeq() : 0;
}

/**
 * 取 `seq` 之后的事件（带 MAA `details`）。
 * @param {any} state - 状态容器。
 * @param {number} seq - 起点序号。
 * @returns {Array<Record<string, any>>} 事件。
 */
function eventsSince(state, seq) {
  const recent = typeof state?.recentEvents === 'function' ? state.recentEvents(500, { withDetails: true }) : [];
  return recent.filter((event) => (Number.isFinite(event?.seq) ? event.seq > seq : true));
}

/**
 * 一条 `RecruitResult` 里的组合 → 契约形状。
 * @param {unknown} rawCombo - MAA 的组合对象。
 * @param {number|null} fallbackLevel - 组合缺 level 时用外层 level。
 * @returns {{ tags: string[], level: number|null, operators: Array<{id:string,name:string,rarity:number|null}> }} 组合。
 */
function toCombo(rawCombo, fallbackLevel) {
  const combo = asObject(rawCombo);
  const level = intOrNull(combo.level) ?? fallbackLevel;
  const operators = [];
  for (const rawOper of Array.isArray(combo.opers) ? combo.opers : []) {
    if (operators.length >= 40) break;
    const oper = asObject(rawOper);
    const id = textOr(oper.id);
    const name = textOr(oper.name);
    if (id === '' && name === '') continue;
    operators.push({ id, name, rarity: intOrNull(oper.level) ?? level });
  }
  return { tags: stringList(combo.tags), level, operators };
}

/**
 * 解析公招事件（`docs/contracts.md` §6 + MAA 回调协议）。
 * @param {Array<Record<string, any>>} events - 本次任务链之后的事件。
 * @returns {{ tags: string[], level: number|null, combos: Array<Record<string, any>>,
 *   slots?: Array<{tags: string[], level: number|null}>, refreshed: Record<string, any>|null,
 *   noPermit: Record<string, any>|null, permitReserved: Record<string, any>|null,
 *   selected: string[][], specialTags: string[], preservedTags: string[],
 *   error: Record<string, any>|null }} 解析结果。
 */
export function parseRecruitEvents(events = []) {
  /** @type {string[]} */
  let tags = [];
  /** @type {number|null} */
  let level = null;
  /** @type {Array<Record<string, any>>} */
  let combos = [];
  /** @type {Array<{tags: string[], level: number|null, combos: Array<Record<string, any>>}>} */
  const slots = [];
  /** @type {Record<string, any>|null} */
  let currentSlot = null;
  /** @type {Record<string, any>|null} */
  let refreshed = null;
  /** @type {Record<string, any>|null} */
  let noPermit = null;
  /** @type {Record<string, any>|null} */
  let permitReserved = null;
  /** @type {string[][]} */
  const selected = [];
  /** @type {string[]} */
  const specialTags = [];
  /** @type {string[]} */
  const preservedTags = [];
  /** @type {Record<string, any>|null} */
  let error = null;

  for (const event of events) {
    const what = typeof event?.what === 'string' ? event.what : '';
    const details = asObject(event?.details);
    if (what === 'RecruitTagsDetected') {
      tags = stringList(details.tags);
      currentSlot = { tags: [...tags], level: null, combos: [] };
      slots.push(currentSlot);
      continue;
    }
    if (what === 'RecruitResult') {
      const resultTags = stringList(details.tags);
      const resultLevel = intOrNull(details.level);
      const resultCombos = [];
      for (const rawCombo of Array.isArray(details.result) ? details.result : []) {
        if (resultCombos.length >= 20) break;
        resultCombos.push(toCombo(rawCombo, resultLevel));
      }
      if (resultTags.length > 0) tags = resultTags;
      level = resultLevel;
      combos = resultCombos;
      if (currentSlot === null || currentSlot.combos.length > 0) {
        currentSlot = { tags: [...tags], level: resultLevel, combos: resultCombos };
        slots.push(currentSlot);
      } else {
        currentSlot.tags = [...tags];
        currentSlot.level = resultLevel;
        currentSlot.combos = resultCombos;
      }
      continue;
    }
    if (what === 'RecruitTagsRefreshed') {
      refreshed = { count: intOrNull(details.count), limit: intOrNull(details.refresh_limit) };
      continue;
    }
    if (what === 'RecruitNoPermit') {
      noPermit = { continue: details.continue === true };
      continue;
    }
    if (what === 'RecruitPermitReserved') {
      permitReserved = { current: intOrNull(details.current) };
      continue;
    }
    if (what === 'RecruitTagsSelected') {
      selected.push(stringList(details.tags));
      continue;
    }
    if (what === 'RecruitSpecialTag') {
      const tag = textOr(details.tag);
      if (tag !== '' && !specialTags.includes(tag)) specialTags.push(tag);
      continue;
    }
    if (what === 'RecruitPreservedTag') {
      const tag = textOr(details.tag);
      if (tag !== '' && !preservedTags.includes(tag)) preservedTags.push(tag);
      continue;
    }
    if (what === 'RecruitError') {
      error = details.refresh_limit === undefined
        ? { reason: 'unknown' }
        : { reason: 'refresh-limit', refreshLimit: intOrNull(details.refresh_limit) };
    }
  }

  const parsed = {
    tags,
    level,
    combos,
    refreshed,
    noPermit,
    permitReserved,
    selected,
    specialTags,
    preservedTags,
    error,
  };
  if (slots.length > 1) {
    parsed.slots = slots.map((slot) => ({ tags: [...slot.tags], level: slot.level }));
  }
  return parsed;
}

/**
 * 收成便于排障的事件摘要。
 * @param {Array<Record<string, any>>} events - 事件。
 * @param {number} [limit] - 最多几条。
 * @returns {Array<Record<string, any>>} 摘要。
 */
function summarizeEvents(events, limit = 10) {
  return events.slice(-limit).map((event) => ({
    seq: event?.seq ?? null,
    name: typeof event?.name === 'string' ? event.name : '',
    ...(typeof event?.what === 'string' ? { what: event.what } : {}),
  }));
}

/**
 * 跑一条 MAA 任务链并把「超时/被停」翻译成动作错误。
 * @param {Record<string, any>} deps - 依赖。
 * @param {string} type - MAA 任务类型。
 * @param {Record<string, any>} params - MAA 参数。
 * @param {number} timeoutMs - 超时毫秒。
 * @returns {Promise<Record<string, any>>} 结果。
 */
async function runChain(deps, type, params, timeoutMs) {
  const outcome = await deps.runtime.runTaskChain({ type, params, timeoutMs });
  const waited = outcome?.waited ?? {};
  if (waited.aborted !== null && waited.aborted !== undefined) {
    throw arkError('E_ABORTED', `MAA ${type} 任务被停止。`, { hint: '停止是用户动作；需要时重新发起。' });
  }
  if (waited.timedOut === true) {
    throw arkError('E_TIMEOUT', `MAA ${type} 任务超过 ${Math.round(timeoutMs / 1000)}s 没有结束。`, {
      hint: '确认游戏画面没有卡在弹窗/公告上；必要时先 ark_stop 再重试。',
    });
  }
  return outcome;
}

/**
 * 渲染组合：`[tag1, tag2] → 5 星：能天使、银灰…等 12 名`。
 * @param {Record<string, any>} combo - 组合。
 * @returns {string} 文本。
 */
function formatCombo(combo) {
  const operators = Array.isArray(combo.operators) ? combo.operators : [];
  const names = operators.slice(0, 6).map((oper) => oper.name || oper.id).filter((name) => name !== '');
  const star = combo.level === null || combo.level === undefined ? '?' : combo.level;
  if (names.length === 0) return `[${combo.tags.join('、')}] → ${star} 星`;
  const more = operators.length > names.length ? `…等 ${operators.length} 名` : '';
  return `[${combo.tags.join('、')}] → ${star} 星：${names.join('、')}${more}`;
}

/**
 * 执行 `recruit` 任务链并解析结果（不经过 runAction；daily 直接复用）。
 * @param {Record<string, any>} deps - 依赖。
 * @param {Record<string, any>} [params] - 动作参数。
 * @returns {Promise<{ text: string, result: Record<string, any>, status?: 'completed'|'partial' }>} 结果。
 */
export async function runRecruit(deps, params = {}) {
  const { config, state } = deps;
  const resolved = resolveRecruitParams(config, params);
  const startSeq = lastSeq(state);
  const outcome = await runChain(deps, 'Recruit', resolved.maa, recruitTimeout(config, resolved.mode));
  const events = eventsSince(state, startSeq);
  const parsed = parseRecruitEvents(events);
  const chainError = events.some((event) => event?.name === 'TaskChainError' || event?.code === 10000);
  const failed = chainError || (Array.isArray(outcome?.chains) && outcome.chains.some((chain) => chain?.status === 'error'));
  const hasResult = parsed.level !== null && (parsed.tags.length > 0 || parsed.combos.length > 0);
  const partial = failed || !hasResult || parsed.noPermit !== null || parsed.error !== null;

  const detail = {
    mode: resolved.mode,
    ...(resolved.mode === 'execute'
      ? {
        times: resolved.times,
        confirmLevels: resolved.confirmLevels,
        selectLevels: resolved.selectLevels,
        refresh: resolved.refresh,
        expedite: resolved.expedite,
        permitReserve: resolved.permitReserve,
        firstTags: resolved.firstTags,
        preserveTags: resolved.preserveTags,
      }
      : {}),
    tags: parsed.tags,
    level: parsed.level,
    combos: parsed.combos,
    ...(parsed.slots === undefined ? {} : { slots: parsed.slots }),
    ...(parsed.refreshed === null ? {} : { refreshed: parsed.refreshed }),
    ...(parsed.noPermit === null ? {} : { noPermit: parsed.noPermit }),
    ...(parsed.permitReserved === null ? {} : { permitReserved: parsed.permitReserved }),
    ...(parsed.selected.length === 0 ? {} : { selected: parsed.selected }),
    ...(parsed.specialTags.length === 0 ? {} : { specialTags: parsed.specialTags }),
    ...(parsed.preservedTags.length === 0 ? {} : { preservedTags: parsed.preservedTags }),
    ...(parsed.error === null ? {} : { error: parsed.error }),
    events: summarizeEvents(events),
  };

  const lines = [];
  if (resolved.mode === 'analyze') {
    if (!hasResult) {
      lines.push('公招识别没有回传结果（可能没有招聘位、许可不足，或停在招募界面之外）。');
      lines.push('没有收到 RecruitResult：请确认游戏在公开招募界面、还有空余招聘位。');
    } else {
      lines.push('公招识别完成（只识别，不消耗招聘许可）：');
      if (parsed.tags.length > 0) lines.push(`识别标签（${parsed.tags.length} 个）：${parsed.tags.join('、')}`);
      lines.push(`最高星级：${parsed.level === null ? '未知' : parsed.level} 星；可行组合 ${parsed.combos.length} 组。`);
      parsed.combos.slice(0, 5).forEach((combo, index) => lines.push(`  ${index + 1}. ${formatCombo(combo)}`));
      if (parsed.combos.length > 5) lines.push(`  …还有 ${parsed.combos.length - 5} 组。`);
    }
  } else {
    lines.push('公招执行完成。');
    if (parsed.refreshed !== null) lines.push(`刷新：第 ${parsed.refreshed.count ?? '?'}/${parsed.refreshed.limit ?? '?'} 次。`);
    if (parsed.tags.length > 0) lines.push(`识别标签：${parsed.tags.join('、')}（最高 ${parsed.level ?? '?'} 星，${parsed.combos.length} 组）。`);
    if (parsed.selected.length > 0) lines.push(`MAA 选择过标签：${parsed.selected.map((tags) => `[${tags.join('、')}]`).join('；')}`);
    lines.push(`参数：times=${resolved.times}，confirm=[${resolved.confirmLevels.join(',')}]，select=[${resolved.selectLevels.join(',')}]，refresh=${resolved.refresh ? '是' : '否'}。`);
    if (parsed.noPermit !== null) lines.push('MAA 报告没有招聘许可，已跳过部分槽位。');
    if (parsed.permitReserved !== null) lines.push(`招聘许可数量 ≤ 保留值（当前 ${parsed.permitReserved.current ?? '?'}），已跳过 3 星招募。`);
    if (parsed.error !== null) lines.push('MAA 回传了公招识别错误，本次可能没有完成。');
    if (failed) lines.push('任务链报错（可能停在某个弹窗），以上是已回传的部分结果。');
  }
  if (parsed.preservedTags.length > 0) lines.push(`保留并跳过的标签：${parsed.preservedTags.join('、')}。`);
  if (parsed.specialTags.length > 0) lines.push(`特殊标签：${parsed.specialTags.join('、')}。`);

  return {
    text: lines.join('\n'),
    result: { recruit: detail },
    ...(partial ? { status: 'partial' } : {}),
  };
}

/**
 * 造 `recruit` 动作：`async (params) => response`（runAction 信封）。
 * @param {Record<string, any>} deps - 依赖（config/store/session/state/runtime/logger…）。
 * @returns {(params?: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createRecruitAction(deps) {
  const { config, store } = deps;
  /**
   * 执行入口。
   * @param {Record<string, any>} [params] - 动作参数。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  return async function recruit(params = {}) {
    return runAction({
      config,
      store,
      kind: 'recruit',
      params,
      plan: () => {
        const resolved = resolveRecruitParams(config, params);
        if (resolved.mode === 'analyze') {
          const plannedItems = [{ task: 'recruit', mode: 'analyze', consumes: 'none', note: '只识别标签/组合' }];
          return {
            ...planResult({
              kind: 'recruit',
              text: [
                '公招识别（不需要 confirm，不消耗招聘许可）：',
                '- MAA Recruit：times=0、select=[]、confirm=[]、refresh=false、set_time=false',
                '- 只识别当前槽位的 Tags 与可选组合，不确认招募、不刷新标签',
              ].join('\n'),
              planned: plannedItems,
            }),
            plannedItems,
          };
        }
        const lines = [
          '公招执行计划（需要 confirm=true）：',
          `- 招募次数：${resolved.times}`,
          `- 确认星级：${resolved.confirmLevels.join('/')} 星（confirmLevels）`,
          `- 选择标签星级：${resolved.selectLevels.join('/')} 星（selectLevels）`,
          `- 刷新三星标签：${resolved.refresh ? '是' : '否'}；加急许可：${resolved.expedite ? '是' : '否'}；3 星许可保留：${resolved.permitReserve}`,
          `- 首选 Tags：${resolved.firstTags.length > 0 ? resolved.firstTags.join('、') : '（无）'}`,
          `- 保留并跳过 Tags：${resolved.preserveTags.length > 0 ? resolved.preserveTags.join('、') : '（无）'}`,
          '消耗：招聘许可（≤ times 次）；刷新/加急按上面的开关。',
          '安全闸：需要 safety.allowRecruitPermits=true；expedite=true 还需要 safety.allowExpedite=true。',
        ];
        const plannedItems = [{ task: 'recruit', mode: 'execute', times: resolved.times, note: 'MAA Recruit 任务链', consumes: 'permit' }];
        return {
          ...planResult({ kind: 'recruit', text: lines.join('\n'), planned: plannedItems }),
          plannedItems,
        };
      },
      execute: async (run) => {
        await deps.runtime.ensureReady({
          startup: true,
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        return runRecruit(deps, params);
      },
    });
  };
}

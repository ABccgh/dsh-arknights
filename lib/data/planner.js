/**
 * 材料规划：把「我要 10 个固源岩、5 个聚酸酯组」变成「刷哪几关、大概多少理智」。
 *
 * 数据来源：
 * - 关卡理智/内部 id：MAA `stages.json`（经 `lib/data/resources.js`）；
 * - 掉率与期望理智：企鹅物流（经 `lib/data/penguin.js`）；
 * - 活动时间窗：StageActivityV2（经 `lib/data/activity.js`），用于排除过期活动关、
 *   `preferEvent` 时优先推荐正在开放的活动关。
 *
 * 期望理智的定义：拿 1 件材料平均要花的理智（`apCost * times / quantity`）。
 * 一个目标的期望花费 = 需求数量 × 期望理智；这是线性估算，不是严格保证。
 *
 * 本模块是纯计算 + 注入的数据提供者，不读文件、不联网、不碰 sidecar/模拟器。
 *
 * @module @local/arknights/data/planner
 */

import { arkError } from '../errors.js';
import { normalizeCode } from '../stages.js';

/** 每个材料最多给几个候选关卡。 */
export const MAX_CANDIDATES_PER_ITEM = 3;
/** 单个材料的需求数量上限（防止模型传离谱数字）。 */
export const MAX_TARGET_COUNT = 9999;

/**
 * 保留 2 位小数（消掉浮点尾差，如 3×4.8 = 14.399999…）。
 * @param {number} value - 数值。
 * @returns {number} 舍入后的数值。
 */
function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * 保留 1 位小数。
 * @param {number} value - 数值。
 * @returns {number} 舍入后的数值。
 */
function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

/**
 * 解析材料需求。
 *
 * 支持三种写法：
 * - `"固源岩:10, 聚酸酯组:5"`（中英文冒号/逗号/分号/换行分隔，数量可省略=1）；
 * - `"固源岩 x10"`（`x`/`X`/`×`/`*` 分隔）；
 * - `[{ item: '固源岩', count: 10 }, { name: '聚酸酯组', count: 5 }]`。
 * @param {unknown} input - 原始 targets。
 * @returns {Array<{ name: string, count: number, raw: string }>} 解析结果（保持输入顺序）。
 * @throws {import('../errors.js').ArkError} targets 为空或没有任何有效项时。
 */
export function parseTargets(input) {
  /** @type {Array<{ name: string, count: number, raw: string }>} */
  const out = [];
  const pushToken = (token) => {
    const raw = String(token ?? '').trim();
    if (raw === '') return;
    let name = raw;
    let count = 1;
    const colon = /^(.+?)\s*[:：]\s*(\d+)$/u.exec(raw);
    const times = /^(.+?)\s*[xX×*]\s*(\d+)$/u.exec(raw);
    if (colon !== null) {
      name = colon[1].trim();
      count = Number.parseInt(colon[2], 10);
    } else if (times !== null) {
      name = times[1].trim();
      count = Number.parseInt(times[2], 10);
    }
    if (name === '') return;
    const safeCount = Math.min(Math.max(Number.isFinite(count) ? Math.trunc(count) : 1, 1), MAX_TARGET_COUNT);
    out.push({ name, count: safeCount, raw });
  };

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === 'string') {
        pushToken(entry);
        continue;
      }
      if (entry === null || typeof entry !== 'object') continue;
      const name = typeof entry.item === 'string'
        ? entry.item
        : (typeof entry.name === 'string' ? entry.name : (typeof entry.itemId === 'string' ? entry.itemId : ''));
      const count = Number.isFinite(entry.count) ? Math.trunc(Number(entry.count)) : 1;
      const text = String(name ?? '').trim();
      if (text === '') continue;
      out.push({ name: text, count: Math.min(Math.max(count, 1), MAX_TARGET_COUNT), raw: text });
    }
  } else if (typeof input === 'string') {
    for (const token of input.split(/[,，;；\n]+/u)) pushToken(token);
  } else if (input !== null && input !== undefined) {
    throw arkError('E_BAD_ARGS', 'targets 必须是字符串或数组。', {
      hint: '示例：targets="固源岩:10, 聚酸酯组:5"',
    });
  }

  if (out.length === 0) {
    throw arkError('E_BAD_ARGS', 'targets 为空：至少给一个材料，如「固源岩:10」。', {
      hint: '示例：targets="固源岩:10, 聚酸酯组:5"',
    });
  }
  return out;
}

/**
 * 把 exclude 参数归一成关卡代码/内部 id 集合。
 * @param {unknown} input - 字符串（逗号/空白分隔）或数组。
 * @returns {{ codes: Set<string>, ids: Set<string> }} 归一集合。
 */
export function parseExclude(input) {
  /** @type {string[]} */
  const tokens = [];
  if (Array.isArray(input)) {
    for (const entry of input) tokens.push(String(entry ?? ''));
  } else if (typeof input === 'string') {
    for (const token of input.split(/[,，;；\s]+/u)) tokens.push(token);
  }
  const codes = new Set();
  const ids = new Set();
  for (const token of tokens) {
    const text = String(token ?? '').trim();
    if (text === '') continue;
    if (text.includes('_')) ids.add(text.toLowerCase());
    else codes.add(normalizeCode(text));
  }
  return { codes, ids };
}

/**
 * 判断一个候选关卡是否被 exclude 命中。
 * @param {{ code?: string | null, stageId?: string | null }} candidate - 候选。
 * @param {{ codes: Set<string>, ids: Set<string> }} exclude - 归一集合。
 * @returns {boolean} 命中为 true。
 */
export function isExcluded(candidate, exclude) {
  const code = normalizeCode(candidate?.code ?? '');
  if (code !== '' && exclude.codes.has(code)) return true;
  const stageId = String(candidate?.stageId ?? '').trim().toLowerCase();
  return stageId !== '' && exclude.ids.has(stageId);
}

/**
 * 在材料表里解析一个目标（id / 中文名 / 名字包含）。
 * @param {{ itemById: Function, itemByName: Function, items?: Array<Record<string, any>> }} resources - 资源 bundle。
 * @param {string} name - 用户输入。
 * @returns {{ item: Record<string, any> | null, suggestions: string[] }} 解析结果。
 */
export function resolveTargetItem(resources, name) {
  const text = String(name ?? '').trim();
  if (text === '') return { item: null, suggestions: [] };
  const direct = resources?.itemById?.(text) ?? null;
  if (direct !== null) return { item: direct, suggestions: [] };
  const byName = resources?.itemByName?.(text) ?? null;
  if (byName !== null) return { item: byName, suggestions: [] };
  const all = Array.isArray(resources?.items) ? resources.items : [];
  const lower = text.toLowerCase();
  const containing = all.filter((item) => item.name.toLowerCase().includes(lower) || lower.includes(item.name.toLowerCase()));
  if (containing.length === 1) return { item: containing[0], suggestions: [] };
  const suggestions = (containing.length > 0 ? containing : all)
    .slice(0, 6)
    .map((item) => item.name);
  return { item: null, suggestions };
}

/**
 * 造规划器。
 * @param {{ resources: Record<string, any>, getDrops: (itemId: string) => Promise<Record<string, any>>,
 *   getActivity?: () => Promise<Record<string, any>>, now?: () => number,
 *   maxCandidates?: number, lowSampleTimes?: number }} options - 依赖。
 *   - `resources`：`lib/data/resources.js` 的 bundle（同步、已加载）；
 *   - `getDrops(itemId)`：返回 `lib/data/penguin.js` 的 `matrix()` 结果；
 *   - `getActivity()`：返回 `lib/data/activity.js` 的 `load()` 结果（可省略）。
 * @returns {{ plan: (input: Record<string, any>) => Promise<Record<string, any>> }} 规划器。
 */
export function createPlanner(options = {}) {
  const resources = options.resources ?? {};
  const getDrops = typeof options.getDrops === 'function' ? options.getDrops : async () => ({ ok: false, candidates: [], reason: '没有掉率数据源。' });
  const getActivity = typeof options.getActivity === 'function' ? options.getActivity : null;
  const maxCandidates = Number.isFinite(options.maxCandidates) && options.maxCandidates > 0
    ? Math.trunc(Number(options.maxCandidates))
    : MAX_CANDIDATES_PER_ITEM;
  const lowSampleTimes = Number.isFinite(options.lowSampleTimes) ? Number(options.lowSampleTimes) : null;

  /**
   * 取活动数据（失败降级）。
   * @returns {Promise<Record<string, any> | null>} 活动结果。
   */
  const safeActivity = async () => {
    if (getActivity === null) return null;
    try {
      return await getActivity();
    } catch {
      return { ok: false, activities: [], stages: [], warnings: ['活动日历不可用。'] };
    }
  };

  /**
   * 取某材料的掉率（失败降级）。
   * @param {string} itemId - 材料 id。
   * @returns {Promise<Record<string, any>>} 企鹅物流结果。
   */
  const safeDrops = async (itemId) => {
    try {
      const result = await getDrops(itemId);
      return result !== null && typeof result === 'object'
        ? result
        : { ok: false, itemId, candidates: [], rows: [], reason: '掉率数据源没有返回内容。' };
    } catch (error) {
      return { ok: false, itemId, candidates: [], rows: [], reason: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 做一次材料规划。
   * @param {{ targets: unknown, preferEvent?: boolean, exclude?: unknown }} input - 输入。
   * @returns {Promise<Record<string, any>>} 规划结果。
   */
  const plan = async (input = {}) => {
    const parsed = parseTargets(input.targets);
    const exclude = parseExclude(input.exclude);
    const preferEvent = input.preferEvent === true;
    const warnings = [];

    const activity = await safeActivity();
    const activityOk = activity !== null && activity.ok === true && Array.isArray(activity.stages);
    if (activity === null) {
      if (preferEvent) warnings.push('没有活动日历数据，preferEvent 只在掉率数据里挑选。');
    } else if (!activityOk) {
      warnings.push('活动日历不可用：无法排除/优先活动关。');
    } else if (activity.stale === true) {
      warnings.push('活动日历是旧缓存，时间窗可能已变化。');
    }

    /** 已过期活动关：normalizeCode → { name } */
    const expiredActivityStages = new Map();
    /** 正在开放、按材料分组：itemId → 活动关[] */
    const activeEventStages = new Map();
    if (activityOk) {
      for (const stage of activity.stages) {
        const code = normalizeCode(stage.value);
        if (code === '') continue;
        if (stage.expired === true) {
          expiredActivityStages.set(code, { name: stage.activityName ?? '', code: stage.value });
          continue;
        }
        if (stage.active === true && typeof stage.itemId === 'string' && stage.itemId !== '') {
          const list = activeEventStages.get(stage.itemId) ?? [];
          list.push(stage);
          activeEventStages.set(stage.itemId, list);
        }
      }
    }

    /** @type {Array<Record<string, any>>} */
    const targets = [];
    /** @type {Map<string, Record<string, any>>} */
    const stageMap = new Map();
    const lowSampleParts = [];
    const noDataParts = [];
    const excludedParts = [];

    for (const target of parsed) {
      const resolved = resolveTargetItem(resources, target.name);
      if (resolved.item === null) {
        targets.push({
          name: target.name,
          count: target.count,
          ok: false,
          itemId: null,
          itemName: target.name,
          reason: `材料表里没有「${target.name}」。`,
          suggestions: resolved.suggestions,
          candidates: [],
          alternatives: [],
          best: null,
          expectedSanity: null,
          lowSample: false,
        });
        noDataParts.push(`${target.name}（材料未知）`);
        continue;
      }
      const item = resolved.item;
      const drops = await safeDrops(item.itemId);

      /** @type {Array<Record<string, any>>} */
      const excludedCandidates = [];
      /** @type {Array<Record<string, any>>} */
      const dropCandidates = [];
      for (const raw of Array.isArray(drops.candidates) ? drops.candidates : []) {
        if (isExcluded(raw, exclude)) {
          excludedCandidates.push({ ...raw, excludedReason: '用户排除' });
          excludedParts.push(`${raw.code ?? raw.stageId}（用户排除）`);
          continue;
        }
        const code = normalizeCode(raw.code ?? '');
        const expired = code !== '' ? expiredActivityStages.get(code) : null;
        if (expired !== undefined) {
          excludedCandidates.push({ ...raw, excludedReason: `活动「${expired.name}」已过期` });
          excludedParts.push(`${raw.code}（活动已过期）`);
          continue;
        }
        dropCandidates.push({ ...raw, source: 'penguin-stats' });
      }
      dropCandidates.sort((a, b) => {
        const left = Number.isFinite(a.expectedSanity) ? a.expectedSanity : Number.POSITIVE_INFINITY;
        const right = Number.isFinite(b.expectedSanity) ? b.expectedSanity : Number.POSITIVE_INFINITY;
        return left - right;
      });

      /** @type {Array<Record<string, any>>} */
      const eventCandidates = [];
      for (const stage of activeEventStages.get(item.itemId) ?? []) {
        if (isExcluded({ code: stage.value, stageId: null }, exclude)) continue;
        eventCandidates.push({
          code: stage.value,
          stageId: null,
          apCost: null,
          expectedSanity: null,
          times: 0,
          quantity: 0,
          dropRate: null,
          lowSample: false,
          source: 'activity',
          event: {
            name: stage.activityName ?? '',
            end: stage.end ?? null,
            endsInMs: Number.isFinite(stage.end) ? Math.max(0, stage.end - Number(options.now?.() ?? Date.now())) : null,
          },
        });
      }

      let ordered;
      if (preferEvent && eventCandidates.length > 0) {
        const seen = new Set(eventCandidates.map((candidate) => normalizeCode(candidate.code)));
        ordered = [...eventCandidates, ...dropCandidates.filter((candidate) => !seen.has(normalizeCode(candidate.code ?? '')))];
      } else if (dropCandidates.length > 0) {
        ordered = dropCandidates;
      } else {
        // 没有掉率数据时，活动关至少给用户一个方向。
        ordered = eventCandidates;
      }
      const candidates = ordered.slice(0, maxCandidates);
      const best = candidates[0] ?? null;
      const expectedSanity = best !== null && Number.isFinite(best.expectedSanity)
        ? round2(best.expectedSanity * target.count)
        : null;
      const lowSample = candidates.some((candidate) => candidate.lowSample === true);
      if (lowSample) {
        const worst = candidates.filter((candidate) => candidate.lowSample === true)[0];
        lowSampleParts.push(`${item.name}（${worst.code ?? worst.stageId} 样本 ${worst.times ?? 0} 次 < ${lowSampleTimes ?? '阈值'}）`);
      }
      let reason = '';
      if (!drops.ok) reason = drops.reason || '企鹅物流数据不可用。';
      else if (dropCandidates.length === 0) reason = drops.reason || '企鹅物流没有该材料的可用掉率样本。';
      if (reason === '' && expectedSanity === null && candidates.length > 0) {
        reason = '缺理智/掉率数据，无法估算期望理智。';
      }
      if (candidates.length === 0) {
        noDataParts.push(`${item.name}（${reason}）`);
      }
      targets.push({
        name: target.name,
        count: target.count,
        ok: candidates.length > 0,
        itemId: item.itemId,
        itemName: item.name,
        candidates,
        alternatives: candidates.filter((candidate) => candidate !== best),
        best,
        expectedSanity,
        lowSample,
        reason,
        excluded: excludedCandidates,
        dropSource: {
          source: drops.source ?? 'penguin-stats',
          fetchedAt: drops.fetchedAt ?? null,
          ageMs: drops.ageMs ?? null,
          stale: drops.stale === true,
        },
      });

      if (best !== null) {
        const key = best.stageId ?? `${best.code ?? ''}`;
        const existing = stageMap.get(key);
        const cover = {
          itemId: item.itemId,
          itemName: item.name,
          count: target.count,
          expectedSanity: Number.isFinite(best.expectedSanity) ? round2(best.expectedSanity * target.count) : null,
          perItemSanity: Number.isFinite(best.expectedSanity) ? round2(best.expectedSanity) : null,
          source: best.source,
        };
        if (existing === undefined) {
          stageMap.set(key, {
            code: best.code ?? '',
            stageId: best.stageId ?? null,
            apCost: best.apCost ?? null,
            expectedSanity: cover.expectedSanity,
            lowSample: best.lowSample === true,
            source: best.source,
            event: best.event ?? null,
            covers: [cover],
          });
        } else {
          existing.covers.push(cover);
          existing.lowSample = existing.lowSample || best.lowSample === true;
          existing.expectedSanity = Number.isFinite(existing.expectedSanity) && Number.isFinite(cover.expectedSanity)
            ? existing.expectedSanity + cover.expectedSanity
            : null;
        }
      }
    }

    /** @type {Array<Record<string, any>>} */
    const stages = [...stageMap.values()]
      .map((stage) => ({ ...stage, expectedSanity: Number.isFinite(stage.expectedSanity) ? round2(stage.expectedSanity) : null }))
      .sort((a, b) => {
        const left = Number.isFinite(a.expectedSanity) ? a.expectedSanity : Number.POSITIVE_INFINITY;
        const right = Number.isFinite(b.expectedSanity) ? b.expectedSanity : Number.POSITIVE_INFINITY;
        return left - right;
      });
    const totalExpected = stages.every((stage) => !Number.isFinite(stage.expectedSanity))
      ? null
      : stages.reduce((sum, stage) => sum + (Number.isFinite(stage.expectedSanity) ? stage.expectedSanity : 0), 0);

    if (noDataParts.length > 0) {
      warnings.push(`没有可用的掉率数据：${noDataParts.join('、')}。`);
    }
    if (excludedParts.length > 0) {
      warnings.push(`已排除：${excludedParts.join('、')}。`);
    }
    if (lowSampleParts.length > 0) {
      warnings.push(`低样本提示（掉率可能不准）：${lowSampleParts.join('、')}。`);
    }
    const estimated = targets.filter((target) => Number.isFinite(target.expectedSanity)).length;
    if (estimated > 0 && estimated < targets.length) {
      warnings.push(`只有 ${estimated}/${targets.length} 个目标能估算理智，其余缺掉率数据。`);
    }

    return {
      ok: stages.length > 0,
      targets,
      stages,
      totals: {
        expectedSanity: totalExpected === null ? null : round1(totalExpected),
        items: targets.length,
        covered: targets.filter((target) => target.ok === true).length,
        estimated,
        uncovered: targets.filter((target) => Number.isFinite(target.expectedSanity) === false).map((target) => target.itemName),
      },
      warnings,
      sources: {
        penguin: {
          ok: targets.some((target) => target.dropSource?.ageMs !== null),
          source: 'penguin-stats',
          ageMs: targets.reduce((newest, target) => {
            const age = target.dropSource?.ageMs;
            if (!Number.isFinite(age)) return newest;
            return newest === null || age < newest ? age : newest;
          }, null),
          stale: targets.some((target) => target.dropSource?.stale === true),
        },
        activity: {
          ok: activityOk,
          source: 'MAA StageActivityV2',
          ageMs: Number.isFinite(activity?.ageMs) ? activity.ageMs : null,
          stale: activity?.stale === true,
        },
      },
      preferEvent,
      maxCandidates,
      lowSampleTimes,
    };
  };

  return { plan };
}

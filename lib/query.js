/**
 * 面板查询门面：把 data / box / copilot 的返回收成 docs/contracts.md §10 的统一形状。
 *
 * 只读；默认只用缓存。绝不启动 sidecar/模拟器。
 *
 * @module @local/arknights/query
 */

import { arkError } from './errors.js';

/**
 * 造查询门面。
 * @param {{ data: Record<string, any>, box?: Record<string, any>, copilot?: Record<string, any>,
 *   config?: Record<string, any> }} deps - 依赖。
 * @returns {(input: Record<string, any>) => Promise<Record<string, any>>} query。
 */
export function createQuery(deps) {
  const { data, box, copilot } = deps;

  /**
   * 调 data 的方法；不可用时给 E_DATA_UNAVAILABLE。
   * @param {string} method - 方法。
   * @param {any[]} args - 参数。
   * @returns {Promise<any>} 结果。
   */
  const callData = async (method, args) => {
    if (typeof data?.[method] !== 'function') {
      throw arkError('E_DATA_UNAVAILABLE', `数据层没有实现 ${method}。`);
    }
    return data[method](...args);
  };

  /**
   * 关卡查询。
   * @param {string} q - 查询词。
   * @param {{ limit?: number, refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const stageQuery = async (q, options) => {
    const result = await callData('stage', [q, options]);
    const items = (result.matches ?? []).map((match) => ({
      code: match.code,
      name: match.displayName ?? match.code,
      stageId: match.internalIds?.[0]?.stageId ?? '',
      chapter: null,
      apCost: match.apCost ?? null,
      activity: match.activity !== null && match.activity !== undefined,
      activityInfo: match.activity ?? null,
      drops: (match.drops ?? []).map((drop) => ({
        itemId: drop.itemId,
        itemName: drop.name ?? '',
        rate: null,
        expectedSanity: null,
      })),
      arkrec: match.arkrec ?? null,
    }));
    return {
      items,
      total: items.length,
      source: 'MAA resource',
      note: result.note ?? '',
      cache: result.cache ?? null,
      warnings: [],
    };
  };

  /**
   * 材料查询（含永久关与活动关）。
   * @param {string} q - 查询词。
   * @param {{ limit?: number, refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const itemQuery = async (q, options) => {
    const result = await callData('item', [q, options]);
    const item = {
      id: result.item?.itemId ?? '',
      name: result.item?.name ?? '',
      usage: result.item?.usage ?? '',
      rarity: null,
      icon: result.item?.icon ?? '',
    };
    const stages = (result.drops?.candidates ?? []).map((candidate) => ({
      code: candidate.code ?? candidate.stageId ?? '',
      name: candidate.name ?? candidate.code ?? '',
      apCost: candidate.apCost ?? null,
      dropRate: candidate.dropRate ?? null,
      expectedSanity: candidate.expectedSanity ?? null,
      lowSample: candidate.lowSample === true,
    }));
    return {
      items: [item],
      item,
      stages,
      permanentStageCount: result.permanentStageCount ?? 0,
      activityStages: result.activityStages ?? [],
      drops: result.drops ?? null,
      warnings: result.drops?.reason ? [result.drops.reason] : [],
    };
  };

  /**
   * 材料掉率。
   * @param {string} q - 材料名/id。
   * @param {{ limit?: number, refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const dropQuery = async (q, options) => {
    const result = await callData('drops', [q, options]);
    const items = (result.candidates ?? []).map((candidate) => ({
      code: candidate.code ?? candidate.stageId ?? '',
      name: candidate.name ?? candidate.code ?? '',
      apCost: candidate.apCost ?? null,
      dropRate: candidate.dropRate ?? null,
      expectedSanity: candidate.expectedSanity ?? null,
      lowSample: candidate.lowSample === true,
    }));
    return {
      item: { id: result.item?.itemId ?? '', name: result.item?.name ?? '' },
      items,
      source: result.source ?? 'penguin-stats',
      ageMs: result.ageMs ?? null,
      stale: result.stale === true,
      warnings: result.reason ? [result.reason] : [],
    };
  };

  /**
   * 干员查询（公开招募索引；own 来自仓库快照）。
   * @param {string} q - 查询词。
   * @param {{ limit?: number }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const operatorQuery = async (q, options) => {
    const result = await callData('operator', [q, options]);
    const own = new Set();
    try {
      const snapshot = typeof box?.read === 'function' ? box.read() : null;
      for (const oper of snapshot?.operators?.own ?? []) own.add(String(oper.id ?? oper.name ?? ''));
    } catch {
      // 快照坏了不影响查询。
    }
    const items = (result.matches ?? []).map((oper) => ({
      id: oper.id,
      name: oper.name,
      rarity: oper.rarity,
      tags: oper.tags ?? [],
      own: own.has(String(oper.id ?? oper.name ?? '')),
    }));
    return { items, total: result.total ?? items.length, note: result.note ?? '', warnings: [] };
  };

  /**
   * 活动日历。
   * @param {{ refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const activityQuery = async (options) => {
    const result = await callData('activity', [options]);
    return {
      items: result.activities ?? [],
      stages: result.stages ?? [],
      resourceCollection: result.resourceCollection ?? null,
      ageMs: result.ageMs ?? null,
      stale: result.stale === true,
      warnings: result.warnings ?? [],
    };
  };

  /**
   * 跨类型搜索。
   * @param {string} q - 查询词。
   * @param {{ limit?: number, refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const searchQuery = async (q, options) => {
    const result = await callData('search', [q, options]);
    const items = [];
    for (const stage of result.stages ?? []) {
      items.push({ type: 'stage', code: stage.code, name: stage.displayName ?? stage.code, apCost: stage.apCost ?? null });
    }
    for (const item of result.items ?? []) {
      items.push({ type: 'item', id: item.itemId ?? item.id, name: item.name, usage: item.usage ?? '' });
    }
    for (const oper of result.operators ?? []) {
      items.push({ type: 'operator', id: oper.id, name: oper.name, rarity: oper.rarity });
    }
    for (const activity of result.activities ?? []) {
      items.push({ type: 'activity', name: activity.name, start: activity.start ?? null, end: activity.end ?? null });
    }
    return { items, warnings: [] };
  };

  /**
   * 材料规划。
   * @param {string} targets - `固源岩:10, 聚酸酯组:5`。
   * @param {{ refresh?: boolean }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const planQuery = async (targets, options) => {
    const result = await callData('plan', [{ targets, refresh: options.refresh === true }]);
    const mapped = (result.targets ?? []).map((target) => {
      const best = target.best ?? target.cover ?? null;
      return {
        itemId: target.itemId ?? '',
        itemName: target.itemName ?? '',
        count: target.count ?? 0,
        best: best === null ? null : {
          code: best.code ?? best.stageCode ?? '',
          name: best.name ?? '',
          apCost: best.apCost ?? null,
          dropRate: best.dropRate ?? null,
          expectedSanity: best.expectedSanity ?? null,
        },
        alternatives: (target.alternatives ?? target.candidates ?? []).slice(0, 3).map((candidate) => ({
          code: candidate.code ?? '',
          name: candidate.name ?? '',
          expectedSanity: candidate.expectedSanity ?? null,
        })),
      };
    });
    return {
      targets: mapped,
      stages: result.stages ?? [],
      totalExpectedSanity: result.totals?.expectedSanity ?? null,
      warnings: result.warnings ?? [],
    };
  };

  /**
   * 仓库/干员快照。
   * @param {{ target?: string, limit?: number }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const boxQuery = (options) => {
    const target = options.target === 'operators' || options.target === 'depot' ? options.target : 'both';
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.trunc(options.limit))) : 100;
    const snapshot = typeof box?.read === 'function' ? box.read() : null;
    if (snapshot === null) {
      return { updatedAt: null, partial: false, operators: { own: [] }, depot: { items: [] } };
    }
    if (typeof box?.detail === 'function') {
      const detail = box.detail({ target, limit });
      return {
        updatedAt: snapshot.updatedAt ?? null,
        partial: snapshot.partial === true,
        ...(target !== 'depot' ? { operators: { own: detail.operators ?? [] } } : {}),
        ...(target !== 'operators'
          ? { depot: { items: (detail.depot ?? []).map((item) => ({ id: item.itemId, name: item.name, count: item.count })) } }
          : {}),
      };
    }
    const operators = (snapshot.operators?.own ?? []).slice(0, limit).map((oper) => ({
      id: oper.id,
      name: oper.name,
      rarity: oper.rarity,
      elite: oper.elite ?? null,
      level: oper.level ?? null,
      potential: oper.potential ?? null,
    }));
    const depotItems = Object.entries(snapshot.depot?.items ?? {})
      .map(([id, value]) => ({ id, name: value?.name ?? '', count: value?.count ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    return {
      updatedAt: snapshot.updatedAt ?? null,
      partial: snapshot.partial === true,
      ...(target !== 'depot' ? { operators: { own: operators } } : {}),
      ...(target !== 'operators' ? { depot: { items: depotItems } } : {}),
    };
  };

  /**
   * 作业站浏览。
   * @param {string} q - 关卡代码。
   * @param {{ limit?: number }} options - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  const solutionsQuery = async (q, options) => {
    if (typeof copilot?.query !== 'function') throw arkError('E_DATA_UNAVAILABLE', '作业站客户端不可用。');
    const result = await copilot.query(q);
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.trunc(options.limit))) : 20;
    const items = (result.solutions ?? []).slice(0, limit).map((solution) => ({
      id: solution.id,
      stage: solution.stageName ?? q,
      title: solution.title ?? '',
      uploader: solution.uploader ?? '',
      rating: solution.rating ?? null,
      opers: solution.opers ?? [],
      isRaid: solution.isRaid === true,
      difficulty: solution.isRaid === true ? 'tough' : 'easy',
      available: solution.available !== false,
    }));
    return { items, total: result.total ?? items.length, warnings: result.reason ? [result.reason] : [] };
  };

  return async (input = {}) => {
    const kind = String(input.kind ?? '').trim();
    const q = String(input.q ?? '').trim();
    const options = {
      ...(Number.isFinite(input.limit) ? { limit: input.limit } : {}),
      refresh: input.refresh === true,
    };
    switch (kind) {
      case 'stage': return stageQuery(q, options);
      case 'item': return itemQuery(q, options);
      case 'drop':
      case 'drops': return dropQuery(q, options);
      case 'operator': return operatorQuery(q, options);
      case 'activity': return activityQuery(options);
      case 'search': return searchQuery(q, options);
      case 'plan': return planQuery(String(input.targets ?? q), options);
      case 'box': return boxQuery({ target: input.target, limit: input.limit });
      case 'solutions': return solutionsQuery(q, options);
      default:
        throw arkError('E_BAD_ARGS', `未知查询 kind「${kind}」。`);
    }
  };
}

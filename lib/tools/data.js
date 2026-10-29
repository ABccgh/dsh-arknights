/**
 * `ark_data`：只读数据查询（关卡/材料/干员/活动/搜索）。
 *
 * 与 HTTP 的 `GET /arknights/query` 共用 `lib/data/query.js` 的同一个门面；
 * 工具只负责把结构化结果渲染成**有界文本**（≤ 约 4000 字），带上数据来源与缓存年龄。
 * 失败一律走 `describeError`（code + message + hint），不抛裸异常。
 *
 * @module @local/arknights/tools/data
 */

import { describeError } from '../errors.js';
import { formatAge } from '../data/cache.js';
import { createData } from '../data/query.js';
import { defineArkTool } from './shared.js';

/** 工具文本上限（字符）。 */
export const TOOL_TEXT_LIMIT = 4000;
/** 默认返回条数。 */
export const TOOL_DEFAULT_LIMIT = 8;

/** `deps → data` 的弱引用缓存（同一 deps 只造一个门面）。 */
const dataInstances = new WeakMap();

/**
 * 把文本截到上限以内（超出时加「已截断」提示）。
 * @param {unknown} value - 原始文本。
 * @param {number} [limit] - 上限字符数。
 * @returns {string} 有界文本。
 */
export function clipText(value, limit = TOOL_TEXT_LIMIT) {
  const text = String(value ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : TOOL_TEXT_LIMIT;
  if (text.length <= max) return text;
  const marker = '\n…（内容过长，已截断）';
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/**
 * 解析工具依赖里的数据门面；没有注入时按 config/paths 惰性造一个。
 * @param {{ data?: Record<string, any>, config?: Record<string, any>, paths?: Record<string, any>,
 *   logger?: Record<string, any>, fetchImpl?: Function, now?: () => number,
 *   maaPath?: string | Function, resourceBundle?: any, offline?: boolean }} [deps] - 工具依赖。
 * @returns {Record<string, any>} 数据门面。
 */
export function getData(deps = {}) {
  const injected = deps?.data;
  if (injected !== null && typeof injected === 'object' && typeof injected.stage === 'function' && typeof injected.plan === 'function') {
    return injected;
  }
  const key = deps !== null && typeof deps === 'object' ? deps : {};
  const existing = dataInstances.get(key);
  if (existing !== undefined) return existing;
  const created = createData({
    config: key.config,
    paths: key.paths,
    logger: key.logger,
    fetchImpl: key.fetchImpl,
    now: key.now,
    maaPath: key.maaPath,
    resourceBundle: key.resourceBundle,
    offline: key.offline,
  });
  dataInstances.set(key, created);
  return created;
}

/**
 * 把 epoch 毫秒渲染成北京时间 `YYYY-MM-DD HH:mm`。
 * @param {unknown} epochMs - epoch 毫秒。
 * @returns {string} 时间文本；未知为空串。
 */
export function formatDateTime(epochMs) {
  if (!Number.isFinite(epochMs)) return '';
  const date = new Date(Number(epochMs) + 8 * 3600000);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

/** 来源标识 → 给人看的中文名。 */
const SOURCE_LABELS = {
  'penguin-stats': '企鹅物流',
  'MAA StageActivityV2': '活动日历',
  'MAA resource': 'MAA resource',
  'MAA recruitment.json': 'MAA resource',
  ArkRec: 'ArkRec',
};

/**
 * 渲染一条来源的缓存年龄。
 * @param {{ source?: string, ok?: boolean, ageMs?: number | null, stale?: boolean } | null | undefined} meta
 *   来源元信息。
 * @returns {string} 文本。
 */
export function renderSourceMeta(meta) {
  if (meta === null || meta === undefined) return '';
  const raw = typeof meta.source === 'string' && meta.source !== '' ? meta.source : '数据源';
  const source = SOURCE_LABELS[raw] ?? raw;
  if (meta.ok === false) return `${source}（不可用）`;
  if (Number.isFinite(meta.ageMs)) {
    return `${source}（缓存 ${formatAge(meta.ageMs)}${meta.stale === true ? '，旧缓存' : ''}）`;
  }
  return `${source}（本次读取）`;
}

/**
 * 渲染统一的「数据来源」行。
 * @param {Record<string, any> | null | undefined} sources - 来源表。
 * @returns {string} 一行文本；没有来源时为空串。
 */
export function renderSources(sources) {
  if (sources === null || typeof sources !== 'object') return '';
  const parts = [];
  for (const key of ['maa', 'arkrec', 'activity', 'penguin']) {
    const text = renderSourceMeta(sources[key]);
    if (text !== '') parts.push(text);
  }
  return parts.length === 0 ? '' : `数据来源：${parts.join('；')}`;
}

/**
 * 渲染一个条目列表（带序号，最多 n 条）。
 * @param {Array<string>} entries - 已渲染的行。
 * @returns {string} 文本。
 */
function bulletList(entries) {
  return entries.map((line, index) => ` ${index + 1}. ${line}`).join('\n');
}

/**
 * 渲染 `kind=stage` 结果。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderStageResult(result) {
  const lines = [];
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    for (const match of result.matches) {
      lines.push(match.displayName ?? match.code ?? '');
      const costs = [];
      if (Number.isFinite(match.apCost)) costs.push(`理智 ${match.apCost} / 次`);
      else costs.push('理智未知（活动关可能不在 stages.json）');
      const ids = Array.isArray(match.internalIds) && match.internalIds.length > 0
        ? match.internalIds.map((entry) => `${entry.stageId}${entry.difficulty === 'tough' ? '（磨难）' : '（普通）'}`).join('、')
        : '（无，活动关直接用代码导航）';
      lines.push(` · ${costs.join('，')}`);
      lines.push(` · 内部 id：${ids}`);
      if (Array.isArray(match.drops) && match.drops.length > 0) {
        lines.push(` · 掉落：${match.drops.map((drop) => drop.name || drop.itemId).join('、')}`);
      }
      if (match.activity !== null && match.activity !== undefined) {
        const window = [formatDateTime(match.activity.start), formatDateTime(match.activity.end)]
          .filter((part) => part !== '')
          .join(' ~ ');
        const status = match.activity.expired === true ? '已过期' : (match.activity.active === true ? '开放中' : '未开始');
        lines.push(` · 活动：${match.activity.name || match.activity.value}${window === '' ? '' : `（${window}，${status}）`}`);
      }
      if (match.arkrec !== null && match.arkrec !== undefined) {
        const bits = [];
        if (typeof match.arkrec.group === 'string' && match.arkrec.group !== '') bits.push(match.arkrec.group);
        if (typeof match.arkrec.story === 'string' && match.arkrec.story !== '') bits.push(match.arkrec.story);
        if (typeof match.arkrec.challenge === 'string' && match.arkrec.challenge !== '') bits.push(`突袭条件：${match.arkrec.challenge}`);
        if (Number.isFinite(match.arkrec.minOperators)) bits.push(`少人纪录 ${match.arkrec.minOperators} 人`);
        if (bits.length > 0) lines.push(` · ArkRec：${bits.join('；')}`);
      }
    }
  }
  if (typeof result.note === 'string' && result.note !== '') lines.push(`说明：${result.note}`);
  const sources = renderSources(result.sources);
  if (sources !== '') lines.push(sources);
  return ['ark_data · 关卡', ...lines].join('\n');
}

/**
 * 渲染 `kind=item` 结果。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderItemResult(result) {
  const item = result.item ?? {};
  const lines = [`${item.name ?? ''}（${item.itemId ?? ''}）${item.classifyType ? ` · ${item.classifyType}` : ''}`];
  if (typeof item.usage === 'string' && item.usage !== '') lines.push(`用途：${item.usage}`);
  const stages = Array.isArray(result.permanentStages) ? result.permanentStages : [];
  if (stages.length > 0) {
    lines.push(`常驻掉落关（${result.permanentStageCount ?? stages.length}，理智升序）：`);
    lines.push(bulletList(stages.map((stage) => `${stage.code}${Number.isFinite(stage.apCost) ? `（理智 ${stage.apCost}）` : ''}`)));
  } else {
    lines.push('常驻掉落关：MAA 关卡表里没有记录。');
  }
  const activityStages = Array.isArray(result.activityStages) ? result.activityStages : [];
  if (activityStages.length > 0) {
    lines.push(`活动掉落（${activityStages.length}）：`);
    lines.push(bulletList(activityStages.map((stage) => {
      const status = stage.expired === true ? '已过期' : (stage.active === true ? '开放中' : '未开始');
      return `${stage.code}（${stage.activityName || '活动'}，${status}）`;
    })));
  }
  const drops = result.drops ?? {};
  if (drops.ok === true && Array.isArray(drops.candidates) && drops.candidates.length > 0) {
    lines.push(`掉率（${renderSourceMeta({ source: '企鹅物流', ok: true, ageMs: drops.ageMs, stale: drops.stale })}，期望理智升序）：`);
    lines.push(bulletList(drops.candidates.map((candidate) => {
      const low = candidate.lowSample === true ? ' ⚠低样本' : '';
      return `${candidate.code ?? candidate.stageId}：期望 ${round1(candidate.expectedSanity)} 理智/件（掉率 ${round2(candidate.dropRate)}，样本 ${candidate.times} 次${low}）`;
    })));
  } else {
    lines.push(`掉率：${drops.reason || '暂无企鹅物流数据'}（可加 refresh=true 联网拉取）。`);
  }
  lines.push(renderSources(result.sources));
  return ['ark_data · 材料', ...lines].filter((line) => line !== '').join('\n');
}

/**
 * 渲染 `kind=operator` 结果。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderOperatorResult(result) {
  const lines = [`公开招募干员：共 ${result.total ?? 0} 名；查询「${result.query || '（全部）'}」`];
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (matches.length === 0) lines.push('没有匹配的干员。');
  else {
    lines.push(bulletList(matches.map((operator) => {
      const rarity = Number.isFinite(operator.rarity) ? `${operator.rarity}★` : '?★';
      const tags = Array.isArray(operator.tags) && operator.tags.length > 0 ? `；${operator.tags.join('、')}` : '';
      return `${operator.name}（${rarity}，${operator.id}）${tags}`;
    })));
  }
  if (typeof result.note === 'string' && result.note !== '') lines.push(`说明：${result.note}`);
  lines.push(renderSources(result.sources));
  return ['ark_data · 干员', ...lines].filter((line) => line !== '').join('\n');
}

/**
 * 渲染 `kind=activity` 结果。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderActivityResult(result) {
  const lines = [`客户端：${result.client ?? 'Official'}；${renderSourceMeta(result.sources?.activity)}`];
  const activities = Array.isArray(result.activities) ? result.activities : [];
  const active = activities.filter((entry) => entry.active === true);
  const expired = activities.filter((entry) => entry.expired === true);
  const upcoming = activities.filter((entry) => entry.expired !== true && entry.active !== true);
  const describe = (entry) => {
    const window = [formatDateTime(entry.start), formatDateTime(entry.end)].filter((part) => part !== '').join(' ~ ');
    const stages = Array.isArray(entry.stages) && entry.stages.length > 0
      ? `；关卡 ${entry.stages.map((stage) => stage.value).join('、')}`
      : '';
    return `${entry.name || entry.key}${window === '' ? '' : `（${window}）`}${stages}`;
  };
  if (active.length > 0) {
    lines.push(`开放中（${active.length}）：`);
    lines.push(bulletList(active.map(describe)));
  }
  if (upcoming.length > 0) {
    lines.push(`未开始（${upcoming.length}）：`);
    lines.push(bulletList(upcoming.map(describe)));
  }
  if (expired.length > 0) {
    lines.push(`已过期（${expired.length}）：`);
    lines.push(bulletList(expired.slice(0, 8).map(describe)));
  }
  if (result.warnings?.length > 0) lines.push(`提示：${result.warnings.join('；')}`);
  return ['ark_data · 活动', ...lines].join('\n');
}

/**
 * 渲染 `kind=search` 结果。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderSearchResult(result) {
  const lines = [`搜索「${result.query}」`];
  const stages = Array.isArray(result.stages) ? result.stages : [];
  const items = Array.isArray(result.items) ? result.items : [];
  const operators = Array.isArray(result.operators) ? result.operators : [];
  const activities = Array.isArray(result.activities) ? result.activities : [];
  lines.push(`关卡（${stages.length}）：${stages.length === 0 ? '无' : stages.map((stage) => stage.displayName ?? stage.code).join('、')}`);
  lines.push(`材料（${items.length}）：${items.length === 0 ? '无' : items.map((item) => `${item.name}（${item.itemId}）`).join('、')}`);
  lines.push(`干员（${operators.length}）：${operators.length === 0 ? '无' : operators.map((operator) => operator.name).join('、')}`);
  lines.push(`活动（${activities.length}）：${activities.length === 0 ? '无' : activities.map((activity) => activity.name).join('、')}`);
  lines.push(renderSources(result.sources));
  return ['ark_data · 搜索', ...lines].filter((line) => line !== '').join('\n');
}

/**
 * 渲染任意 `ark_data` 结果。
 * @param {string} kind - 查询种类。
 * @param {Record<string, any>} result - 结果。
 * @returns {string} 文本。
 */
export function renderDataResult(kind, result) {
  switch (kind) {
    case 'stage': return renderStageResult(result);
    case 'item': return renderItemResult(result);
    case 'operator': return renderOperatorResult(result);
    case 'activity': return renderActivityResult(result);
    case 'search': return renderSearchResult(result);
    default: return `ark_data · ${kind}\n${JSON.stringify(result)}`;
  }
}

/**
 * 保留 1 位小数。
 * @param {unknown} value - 数值。
 * @returns {string} 文本。
 */
export function round1(value) {
  return Number.isFinite(value) ? (Math.round(Number(value) * 10) / 10).toFixed(1) : '未知';
}

/**
 * 保留 2 位小数。
 * @param {unknown} value - 数值。
 * @returns {string} 文本。
 */
export function round2(value) {
  return Number.isFinite(value) ? (Math.round(Number(value) * 100) / 100).toFixed(2) : '未知';
}

/**
 * 造 `ark_data` 工具。
 * @param {{ data?: Record<string, any>, config?: Record<string, any>, paths?: Record<string, any> }} [deps]
 *   依赖（优先用 `deps.data`，否则用 config/paths 惰性造门面）。
 * @returns {object[]} 工具定义数组。
 */
export function createDataTools(deps = {}) {
  return [
    defineArkTool({
      name: 'ark_data',
      description:
        '查询明日方舟只读数据：关卡（代码/内部 id/理智/掉落/活动时间窗）、材料（常驻与活动掉落关、企鹅物流掉率与期望理智）、'
        + '干员（公开招募干员的名字/ID/星级/标签）、活动日历（开放中/未开始/已过期 + 活动关）、跨类搜索。'
        + '只读，绝不启动模拟器或侧车；默认用本地 MAA 资源 + 缓存，refresh=true 才联网刷新在线数据。',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['stage', 'item', 'operator', 'activity', 'search'],
          description: '查询种类：stage=关卡；item=材料；operator=干员；activity=活动日历；search=跨类搜索。',
        },
        q: {
          type: 'string',
          description: '查询词：关卡代码（5-10 / CE-6 / main_05-10）、材料名或 id（固源岩 / 30012）、干员名或标签（能天使 / 资深干员）、搜索词。kind=stage 时留空会列出正在开放的活动关。',
        },
        limit: { type: 'integer', description: '最多返回几条，默认 8，范围 1..20。' },
        refresh: { type: 'boolean', description: '是否强制联网刷新在线数据（ArkRec / 企鹅物流 / 活动日历）。默认 false，只用缓存。' },
      },
      concurrencySafe: true,
      timeoutMs: 45000,
      async execute(args) {
        const data = getData(deps);
        const kind = String(args.kind);
        const limit = Number.isFinite(args.limit) ? Math.trunc(args.limit) : TOOL_DEFAULT_LIMIT;
        const refresh = args.refresh === true;
        try {
          let result;
          switch (kind) {
            case 'stage':
              result = await data.stage(args.q ?? '', { limit });
              break;
            case 'item':
              result = await data.item(args.q ?? '', { limit, refresh });
              break;
            case 'operator':
              result = await data.operator(args.q ?? '', { limit });
              break;
            case 'activity':
              result = await data.activity({ refresh });
              break;
            case 'search':
              result = await data.search(args.q ?? '', { limit, refresh });
              break;
            default:
              result = await data.search(args.q ?? '', { limit });
              break;
          }
          return clipText(renderDataResult(kind, result));
        } catch (error) {
          return clipText(describeError(error));
        }
      },
    }),
  ];
}

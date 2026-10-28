/**
 * `ark_stages`：关卡目录查询（关卡代码 / 中文名 / 理智 / 掉落材料 / 账本状态）。
 *
 * 数据来自 MAA `resource/stages.json` + `item_index.json`（离线、权威），
 * 中文名与突袭条件来自 ArkRec（联网，失败只降级不报错）。
 *
 * @module @local/arknights/preset/tools/stages
 */

import { describeError } from '../../errors.js';
import {
  describeDrops,
  estimateSanity,
  loadResources,
  mainlineStages,
  normalizeCode,
  pickDifficulty,
  resolveStage,
} from '../../stages.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { intIn } from '../shared.js';

/**
 * 造 `ark_stages`。
 * @param {object} deps - 依赖（detect / arkrec / ledger / config）。
 * @returns {object[]} 工具定义。
 */
export function createStagesTools(deps) {
  return [
    defineTool({
      name: 'ark_stages',
      description:
        '查询明日方舟关卡目录（离线数据，来自本机 MAA 资源）：给关卡代码（5-10 / CE-6 / main_05-10）就返回它的中文名、理智消耗、可用难度、主要掉落材料（中文名）与账本状态（是否已满星）；给材料名（如「固源岩」「炽合金」）就反查哪些关卡会掉。也支持 scope=mainline 看主线序列、scope=missing 看账本里还没满星的关。只读，不消耗任何资源。',
      parameters: {
        query: {
          type: 'string',
          description: '关卡代码、代码前缀（如 "CE"）或材料中文名；留空表示按 scope 列出。',
        },
        scope: {
          type: 'string',
          enum: ['all', 'mainline', 'missing'],
          description: 'all（默认，配合 query）｜mainline（主线序列）｜missing（账本里未满星的关）。',
        },
        limit: {
          type: 'integer',
          description: '最多返回多少条，默认 30，上限 100。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const limit = intIn(args.limit, 30, 1, 100);
          const scope = typeof args.scope === 'string' ? args.scope : 'all';
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          const detected = await deps.detect();
          if (detected.maaPath === '') {
            return text(`没找到 MAA（MaaCore.dll），查不了关卡表。试过：${detected.maaTried.slice(0, 6).join('；')}`);
          }
          const resources = await loadResources(detected.maaPath);
          const lines = [];

          // —— 单关详情 ——
          if (query !== '' && scope === 'all') {
            let resolved = null;
            try {
              resolved = resolveStage(resources.stages, query);
            } catch {
              resolved = null;
            }
            if (resolved !== null) {
              const entry = pickDifficulty(resolved.entries, 'auto');
              const info = await deps.arkrec?.describe?.(resolved.code).catch(() => null) ?? null;
              const record = deps.ledger?.get?.(resolved.code);
              lines.push(`关卡：${resolved.code}${info?.cn_name ? ` ${info.cn_name}` : ''}`);
              if (info?.story || info?.group) lines.push(`归属：${[info.story, info.group].filter(Boolean).join(' · ')}`);
              lines.push(`理智：${Number.isFinite(entry.apCost) ? entry.apCost : '未知'} / 次（难度 ${entry.prefix === 'tough_' ? '磨难' : entry.prefix === 'easy_' ? '简单' : '普通'}）`);
              const difficulties = [...new Set(resolved.entries.map((item) => item.prefix === 'tough_' ? '磨难' : item.prefix === 'easy_' ? '简单' : '普通'))];
              lines.push(`可用难度：${difficulties.join(' / ')}（险地/磨难用 difficulty=tough）`);
              const drops = describeDrops(resources, entry.dropItems ?? [], 8);
              lines.push(`掉落：${drops === '' ? '（关卡表没有掉落信息）' : drops}`);
              if (info?.challenge) lines.push(`突袭/险地条件：${info.challenge}`);
              if (info?.minOperators) lines.push(`ArkRec 少人纪录：${info.minOperators} 人（${info.url}）`);
              lines.push(record
                ? record.fullStar === true
                  ? `账本：已满星${record.primeClaimed === true ? ' · 源石已领' : ''}`
                  : Number.isFinite(record.stars)
                    ? `账本：上次 ${record.stars} 星${record.primeClaimed === true ? ' · 源石已领' : ''}`
                    : '账本：有失败记录，还没有成功通关'
                : '账本：没有记录（打过一次后会记录）');
              return text(lines.join('\n'));
            }
            // 不是关卡代码 → 当材料名反查
            const hits = matchByMaterial(resources, query, limit);
            if (hits.length > 0) {
              lines.push(`掉落「${query}」的关卡（按理智升序）：`);
              for (const hit of hits) lines.push(renderRow(resources, hit, deps));
              return text(lines.join('\n'));
            }
            // 再退一步：按代码前缀列
            const byPrefix = resources.stages
              .filter((entry) => normalizeCode(entry.code).startsWith(normalizeCode(query)))
              .slice(0, limit);
            if (byPrefix.length > 0) {
              lines.push(`代码以「${query}」开头的关卡：`);
              for (const entry of byPrefix) lines.push(renderRow(resources, entry, deps));
              return text(lines.join('\n'));
            }
            return text(`没查到「${query}」：既不是关卡代码，也没有这个名字的材料/代码前缀。试试 CE-6、5-10、16-16，或材料名「固源岩」。`);
          }

          // —— 列表 ——
          if (scope === 'mainline') {
            const mainline = mainlineStages(resources.stages);
            lines.push(`主线关卡（共 ${mainline.length} 关，显示前 ${limit}）：`);
            for (const entry of mainline.slice(0, limit)) lines.push(renderRow(resources, entry, deps));
            return text(lines.join('\n'));
          }
          if (scope === 'missing') {
            const missing = [];
            for (const entry of resources.stages) {
              const record = deps.ledger?.get?.(entry.code);
              if (record?.fullStar === true) continue;
              if (record === undefined) continue; // 没记录的不算「未满星」，避免误导
              missing.push(entry);
            }
            if (missing.length === 0) return text('账本里没有「未满星」记录（有记录的关都已满星，或还没有任何记录）。');
            lines.push(`账本里未满星的关（${missing.length}）：`);
            for (const entry of missing.slice(0, limit)) lines.push(renderRow(resources, entry, deps));
            return text(lines.join('\n'));
          }
          const rows = resources.stages.slice(0, limit);
          lines.push(`关卡表前 ${rows.length} 条（共 ${resources.stages.length}）：`);
          for (const entry of rows) lines.push(renderRow(resources, entry, deps));
          return text(lines.join('\n'));
        } catch (error) {
          return text(`查询关卡失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 按材料中文名反查关卡。
 * @param {{ stages: Array<Record<string, any>>, itemNames: Record<string, string> }} resources - 资源。
 * @param {string} material - 材料名（子串匹配）。
 * @param {number} limit - 上限。
 * @returns {Array<Record<string, any>>} 关卡（按理智升序）。
 */
function matchByMaterial(resources, material, limit) {
  const wanted = material.trim();
  if (wanted === '') return [];
  const itemIds = new Set();
  for (const [itemId, name] of Object.entries(resources.itemNames)) {
    if (typeof name === 'string' && name.includes(wanted)) itemIds.add(itemId);
  }
  if (itemIds.size === 0) return [];
  const hits = resources.stages.filter((entry) => (entry.dropItems ?? []).some((itemId) => itemIds.has(itemId)));
  return hits
    .sort((a, b) => (a.apCost ?? 999) - (b.apCost ?? 999))
    .slice(0, limit);
}

/**
 * 渲染一行。
 * @param {{ itemNames: Record<string, string> }} resources - 资源（取材料名）。
 * @param {Record<string, any>} entry - 关卡条目。
 * @param {object} deps - 依赖（账本）。
 * @returns {string} 文本。
 */
function renderRow(resources, entry, deps) {
  const record = deps.ledger?.get?.(entry.code);
  const flag = record?.fullStar === true ? ' ★' : record ? ' ·' : '';
  const drops = describeDrops(resources, entry.dropItems ?? [], 5);
  const sanity = Number.isFinite(entry.apCost) ? `${entry.apCost} 理智` : '理智未知';
  return `- ${entry.code}${flag} · ${sanity}${drops === '' ? '' : ` · 掉落 ${drops}`}`;
}

/** 供测试用。 */
export { matchByMaterial, renderRow };

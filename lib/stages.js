/**
 * 关卡目录：把 MAA `resource/stages.json` 与 `item_index.json` 读成可用索引。
 *
 * 职责只有四件（契约见 docs/contracts.md）：
 * 1. 关卡代码/内部 id 解析与校验（`5-10` ↔ `main_05-10`；同一代码可能对应多个难度 id）；
 * 2. 难度选择（简单/普通优先，磨难其次）；
 * 3. 理智估算（`apCost × times`）；
 * 4. 掉落材料的中文名。
 *
 * 数据来自本地资源，**完全不联网**；读取失败一律 `E_MAA_LOAD`。
 *
 * @module @local/arknights/stages
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { arkError } from './errors.js';

/** 磨难（tough）难度前缀；其余前缀都算「普通/简单」一档。 */
const TOUGH_PREFIX = 'tough_';
/** 「普通/简单」档的优先顺序：简单 → 普通主线 → 其它。 */
const EASY_PREFIXES = ['easy_', 'main_'];

/** 缓存：`maaPath → { stages, itemNames }`。 */
const cache = new Map();

/**
 * 读 MAA 资源里的关卡与材料表。
 * @param {string} maaPath - MAA 安装根目录。
 * @param {{ fresh?: boolean }} [options] - 是否强制重读。
 * @returns {Promise<{ stages: Array<Record<string, any>>, itemNames: Record<string, string> }>} 数据。
 * @throws {ArkError} 资源缺失或格式不对时。
 */
export async function loadResources(maaPath, options = {}) {
  const key = path.resolve(String(maaPath ?? ''));
  if (options.fresh !== true && cache.has(key)) return cache.get(key);

  const stagesFile = path.join(key, 'resource', 'stages.json');
  const itemsFile = path.join(key, 'resource', 'item_index.json');

  let stagesRaw;
  try {
    stagesRaw = JSON.parse(await fs.readFile(stagesFile, 'utf8'));
  } catch (error) {
    throw arkError('E_MAA_LOAD', `读不到关卡表：${stagesFile}`, {
      detail: error instanceof Error ? error.message : String(error),
      hint: '先启动一次 MAA 主程序，确认它的 resource 目录完整。',
    });
  }
  if (!Array.isArray(stagesRaw)) {
    throw arkError('E_MAA_LOAD', `关卡表格式不对：${stagesFile} 不是数组。`);
  }

  const stages = stagesRaw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.stageId === 'string')
    .map((entry) => ({
      stageId: entry.stageId,
      code: typeof entry.code === 'string' ? entry.code : entry.stageId,
      apCost: Number.isFinite(entry.apCost) ? entry.apCost : null,
      prefix: entry.stageId.includes('_') ? entry.stageId.slice(0, entry.stageId.indexOf('_') + 1) : '',
      suffix: entry.stageId.includes('_') ? entry.stageId.slice(entry.stageId.indexOf('_') + 1) : entry.stageId,
      dropItems: Array.isArray(entry.dropInfos)
        ? entry.dropInfos
          .map((drop) => (typeof drop?.itemId === 'string' ? drop.itemId : ''))
          .filter((itemId) => itemId !== '')
        : [],
    }));

  /** @type {Record<string, string>} */
  const itemNames = {};
  try {
    const itemsRaw = JSON.parse(await fs.readFile(itemsFile, 'utf8'));
    if (itemsRaw !== null && typeof itemsRaw === 'object') {
      for (const [itemId, item] of Object.entries(itemsRaw)) {
        if (typeof item?.name === 'string' && item.name !== '') itemNames[itemId] = item.name;
      }
    }
  } catch {
    // 材料名只是显示增强，缺了不影响打关卡。
  }

  const loaded = { stages, itemNames };
  cache.set(key, loaded);
  return loaded;
}

/**
 * 清空缓存（测试与「更新 resource 后重读」用）。
 * @param {string} [maaPath] - 指定只清这个路径；缺省清全部。
 * @returns {void}
 */
export function clearResourceCache(maaPath) {
  if (typeof maaPath === 'string' && maaPath !== '') cache.delete(path.resolve(maaPath));
  else cache.clear();
}

/**
 * 难度档位。
 * @param {string} prefix - stageId 前缀（含下划线）。
 * @returns {'tough' | 'easy'} 档位。
 */
export function difficultyTier(prefix) {
  return prefix === TOUGH_PREFIX ? 'tough' : 'easy';
}

/**
 * 给同一 `code` 的多个难度挑一个。
 * @param {Array<Record<string, any>>} entries - 同一代码的候选。
 * @param {'auto' | 'easy' | 'tough'} [difficulty] - 期望档位。
 * @returns {Record<string, any>} 选中的那条。
 */
export function pickDifficulty(entries, difficulty = 'auto') {
  if (!Array.isArray(entries) || entries.length === 0) throw arkError('E_STAGE_UNKNOWN', '关卡候选为空。');
  if (difficulty === 'tough') {
    const tough = entries.find((entry) => difficultyTier(entry.prefix) === 'tough');
    if (tough) return tough;
  } else if (difficulty === 'easy') {
    for (const prefix of EASY_PREFIXES) {
      const hit = entries.find((entry) => entry.prefix === prefix);
      if (hit) return hit;
    }
  }
  // auto：先按简单/普通档依次尝试，再退到任何一条（含磨难）
  for (const prefix of EASY_PREFIXES) {
    const hit = entries.find((entry) => entry.prefix === prefix);
    if (hit) return hit;
  }
  const nonTough = entries.find((entry) => difficultyTier(entry.prefix) === 'easy');
  return nonTough ?? entries[0];
}

/**
 * 解析用户给的关卡（代码或内部 id）。
 * @param {Array<Record<string, any>>} stages - `loadResources().stages`。
 * @param {string} input - 例如 `5-10`、`CE-6`、`main_05-10`、`tough_10-09`。
 * @returns {{ code: string, entries: Array<Record<string, any>>, byId: Record<string, any> | null }} 解析结果。
 * @throws {ArkError} 无法识别时（带候选）。
 */
export function resolveStage(stages, input) {
  const raw = String(input ?? '').trim();
  if (raw === '') throw arkError('E_BAD_ARGS', '关卡代码为空。');

  const byId = stages.find((entry) => entry.stageId.toLowerCase() === raw.toLowerCase()) ?? null;
  if (byId) {
    const group = stages.filter((entry) => entry.code === byId.code);
    return { code: byId.code, entries: group.length > 0 ? group : [byId], byId };
  }

  const normalized = normalizeCode(raw);
  const group = stages.filter((entry) => normalizeCode(entry.code) === normalized);
  if (group.length > 0) return { code: group[0].code, entries: group, byId: null };

  throw arkError('E_STAGE_UNKNOWN', `关卡代码「${raw}」不在 MAA 的关卡表里。`, {
    detail: candidatesText(stages, raw),
    hint: '检查是否写错（例如 CE-7）；也可以直接传内部 id，如 main_05-10。',
  });
}

/**
 * 归一化关卡代码：去空白、全角转半角、大小写统一。
 * @param {string} code - 原始代码。
 * @returns {string} 归一后的代码。
 */
export function normalizeCode(code) {
  return String(code ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * 给出最相近的候选（给模型看）。
 * @param {Array<Record<string, any>>} stages - 全部关卡。
 * @param {string} raw - 用户输入。
 * @param {number} [limit] - 最多几条。
 * @returns {string} 逗号分隔的候选。
 */
export function candidatesText(stages, raw, limit = 12) {
  const normalized = normalizeCode(raw);
  const prefix = normalized.split(/[-_A-Z]/)[0] ?? '';
  const codes = [];
  for (const entry of stages) {
    const code = normalizeCode(entry.code);
    if (codes.includes(code)) continue;
    const samePrefix = prefix !== '' && code.startsWith(prefix);
    const nearLength = Math.abs(code.length - normalized.length) <= 2;
    if (samePrefix || (nearLength && commonPrefixLength(code, normalized) >= Math.min(3, normalized.length))) {
      codes.push(code);
    }
    if (codes.length >= limit * 3) break;
  }
  if (codes.length === 0) {
    for (const entry of stages) {
      if (!codes.includes(normalizeCode(entry.code))) codes.push(normalizeCode(entry.code));
      if (codes.length >= limit) break;
    }
  }
  return codes.slice(0, limit).join('、');
}

/**
 * 两串公共前缀长度。
 * @param {string} a - 串 a。
 * @param {string} b - 串 b。
 * @returns {number} 长度。
 */
function commonPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/**
 * 主线普通关序列（推关用）：代码形如 `章-序号`，按 (章, 序号) 升序，同代码只留最容易的一档。
 * @param {Array<Record<string, any>>} stages - 全部关卡。
 * @returns {Array<Record<string, any>>} 有序的主线关卡（每条含 `code`、`stageId`、`apCost`、`chapter`、`index`）。
 */
export function mainlineStages(stages) {
  /** @type {Map<string, { chapter: number, index: number, entry: Record<string, any> }>} */
  const byCode = new Map();
  for (const entry of stages) {
    const match = /^(\d+)-(\d+)$/.exec(normalizeCode(entry.code));
    if (match === null) continue;
    if (difficultyTier(entry.prefix) === 'tough') continue; // 推关只推普通/简单档
    const chapter = Number.parseInt(match[1], 10);
    const index = Number.parseInt(match[2], 10);
    const existing = byCode.get(entry.code);
    if (existing === undefined) {
      byCode.set(entry.code, { chapter, index, entry });
      continue;
    }
    // 同一代码若同时有 easy_ 与 main_，优先 easy_
    if (entry.prefix === 'easy_' && existing.entry.prefix !== 'easy_') {
      byCode.set(entry.code, { chapter, index, entry });
    }
  }
  return [...byCode.values()]
    .sort((a, b) => (a.chapter - b.chapter) || (a.index - b.index))
    .map(({ chapter, index, entry }) => ({ ...entry, chapter, index }));
}

/**
 * 找出主线序列里某关之后的一关。
 * @param {Array<Record<string, any>>} mainline - `mainlineStages` 的结果。
 * @param {string} code - 当前关卡代码。
 * @returns {Record<string, any> | null} 下一关；已经是最后一关时为 null。
 */
export function nextMainlineStage(mainline, code) {
  const normalized = normalizeCode(code);
  const index = mainline.findIndex((entry) => normalizeCode(entry.code) === normalized);
  if (index < 0) return null;
  return mainline[index + 1] ?? null;
}

/**
 * 只保留某一章的主线关。
 * @param {Array<Record<string, any>>} mainline - `mainlineStages` 的结果。
 * @param {number} chapter - 章号。
 * @returns {Array<Record<string, any>>} 该章关卡。
 */
export function chapterStages(mainline, chapter) {
  return mainline.filter((entry) => entry.chapter === chapter);
}

/**
 * 估算理智消耗。
 * @param {Record<string, any> | null} entry - 关卡条目。
 * @param {number} times - 次数。
 * @returns {number | null} 理智数；关卡没有 apCost 时为 null。
 */
export function estimateSanity(entry, times) {
  if (entry === null || entry === undefined) return null;
  if (!Number.isFinite(entry.apCost)) return null;
  const count = Number.isFinite(times) && times > 0 ? times : 1;
  return entry.apCost * count;
}

/**
 * 掉落的材料中文名（最多 n 个）。
 * @param {{ itemNames: Record<string, string> }} resources - 资源。
 * @param {Array<string>} itemIds - 材料 id 列表。
 * @param {number} [limit] - 最多几个。
 * @returns {string} 顿号分隔的中文名。
 */
export function describeDrops(resources, itemIds, limit = 6) {
  const names = [];
  for (const itemId of itemIds) {
    const name = resources.itemNames[itemId];
    if (typeof name === 'string' && name !== '' && name !== '家具' && !names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names.join('、');
}

/**
 * 把 ArkRec 给的中文关卡名并进条目（拿不到就是 undefined）。
 * @param {Record<string, any>} entry - 关卡条目。
 * @param {Record<string, any> | undefined} arkrecStage - ArkRec 的关卡信息。
 * @returns {string} 展示名，如 `5-10 长夜终尽`。
 */
export function displayName(entry, arkrecStage) {
  const cnName = typeof arkrecStage?.cn_name === 'string' ? arkrecStage.cn_name.trim() : '';
  return cnName === '' ? String(entry?.code ?? '') : `${entry.code} ${cnName}`;
}

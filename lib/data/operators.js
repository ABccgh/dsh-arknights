/**
 * 干员索引：把 MAA `resource/recruitment.json` 的公开招募干员表读成可搜索的索引。
 *
 * 只做三件事：归一字段（id/name/rarity/tags）、按 id/名字建索引、搜索。
 * 数据完全来自本地资源，**不联网**；坏条目直接跳过，不抛异常。
 *
 * @module @local/arknights/data/operators
 */

/** 搜索默认返回条数。 */
export const DEFAULT_OPERATOR_LIMIT = 10;
/** 搜索最大返回条数。 */
export const MAX_OPERATOR_LIMIT = 40;

/**
 * 归一一条干员记录。
 * @param {any} raw - recruitment.json 里的 `operators[]` 元素。
 * @returns {{ id: string, name: string, rarity: number, tags: string[] } | null} 归一结果；坏数据为 null。
 */
export function normalizeOperator(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (id === '' || name === '') return null;
  const rarity = Number.isFinite(raw.rarity) ? Math.trunc(raw.rarity) : null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter((tag) => tag !== '')
    : [];
  return { id, name, rarity, tags };
}

/**
 * 干员是否匹配查询词。
 * @param {{ id: string, name: string, rarity: number | null, tags: string[] }} operator - 干员。
 * @param {string} query - 归一后的小写查询词。
 * @returns {number} 匹配分（0 = 不匹配，越大越靠前）。
 */
function scoreOperator(operator, query) {
  if (query === '') return 1;
  const id = operator.id.toLowerCase();
  const name = operator.name.toLowerCase();
  if (name === query) return 100;
  if (id === query) return 98;
  if (name.startsWith(query)) return 90;
  if (id.startsWith(query)) return 86;
  if (name.includes(query)) return 70;
  if (id.includes(query)) return 66;
  for (const tag of operator.tags) {
    const lower = tag.toLowerCase();
    if (lower === query) return 60;
    if (lower.includes(query)) return 40;
  }
  if (query === String(operator.rarity)) return 30;
  return 0;
}

/**
 * 建干员索引。
 * @param {any} recruitmentRaw - `recruitment.json` 的解析结果。
 * @returns {object} 索引：`{ total, list, byId, byName, tagTable, search }`。
 */
export function buildOperatorIndex(recruitmentRaw) {
  const source = recruitmentRaw !== null && typeof recruitmentRaw === 'object' ? recruitmentRaw : {};
  const rawList = Array.isArray(source.operators) ? source.operators : [];
  /** @type {Array<{ id: string, name: string, rarity: number | null, tags: string[] }>} */
  const list = [];
  for (const raw of rawList) {
    const operator = normalizeOperator(raw);
    if (operator !== null) list.push(operator);
  }
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const operator of list) {
    if (operator.id !== '' && !byId.has(operator.id)) byId.set(operator.id, operator);
    if (operator.name !== '' && !byName.has(operator.name.toLowerCase())) byName.set(operator.name.toLowerCase(), operator);
  }
  const tagTable = source.tags !== null && typeof source.tags === 'object' && !Array.isArray(source.tags)
    ? source.tags
    : {};

  /**
   * 在索引里搜索。
   * @param {string} input - 查询词（名字/ID/标签/星级）。
   * @param {{ limit?: number }} [options] - 选项。
   * @returns {Array<Record<string, any>>} 匹配结果（含 `score`）。
   */
  const search = (input, options = {}) => {
    const limit = clampLimit(options.limit);
    const query = String(input ?? '').trim().toLowerCase();
    const scored = [];
    for (const operator of list) {
      const score = scoreOperator(operator, query);
      if (score <= 0) continue;
      scored.push({ ...operator, score });
    }
    scored.sort((a, b) => (b.score - a.score)
      || ((b.rarity ?? 0) - (a.rarity ?? 0))
      || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return scored.slice(0, limit);
  };

  return { total: list.length, list, byId, byName, tagTable, search };
}

/**
 * 把 limit 收进合法范围。
 * @param {unknown} value - 原始 limit。
 * @returns {number} 1..MAX_OPERATOR_LIMIT。
 */
export function clampLimit(value) {
  const parsed = Number.isFinite(value) ? Math.trunc(Number(value)) : DEFAULT_OPERATOR_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_OPERATOR_LIMIT);
}

/**
 * 在干员索引里搜索（`buildOperatorIndex` 结果的语法糖）。
 * @param {ReturnType<typeof buildOperatorIndex>} index - 索引。
 * @param {any} query - 查询词。
 * @param {{ limit?: number }} [options] - 选项。
 * @returns {Array<Record<string, any>>} 匹配结果。
 */
export function searchOperators(index, query, options = {}) {
  if (index === null || typeof index !== 'object' || typeof index.search !== 'function') return [];
  return index.search(query, options);
}

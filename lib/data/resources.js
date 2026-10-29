/**
 * MAA 本地资源索引：`stages.json` / `item_index.json` / `recruitment.json` /
 * `config.json` / `version.json`。
 *
 * 设计要点（契约见 docs/contracts.md §12）：
 * 1. **mtime 缓存**：每次加载先 stat 五个文件（mtimeMs + size），签名没变就直接复用
 *    上一次的 bundle，MAA 更新资源后无需重启插件；
 * 2. **错误收口**：关卡表缺失/不是数组 → `ArkError(E_DATA_UNAVAILABLE)`，绝不抛裸异常；
 *    其余文件缺失只降级（空索引 + warning），因为材料名/客户包名只是显示增强；
 * 3. **双索引**：按 `code` 与 `stageId` 建索引；同一 code 可能对应多个难度 id。
 *
 * 本模块只读本地文件，不联网、不启动 sidecar/模拟器。
 *
 * @module @local/arknights/data/resources
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from '../errors.js';
import { normalizeCode } from '../stages.js';
import { buildOperatorIndex } from './operators.js';

/** 需要读取的 MAA 资源文件。 */
export const RESOURCE_FILES = {
  stages: 'stages.json',
  items: 'item_index.json',
  recruitment: 'recruitment.json',
  config: 'config.json',
  version: 'version.json',
};

/** 缓存最多保留几个 MAA 目录（避免测试/多实例时无限增长）。 */
const MAX_CACHED_ROOTS = 4;

/** @type {Map<string, { signature: string, bundle: Record<string, any> }>} */
const bundleCache = new Map();

/**
 * 归一一条关卡记录（形状与 lib/stages.js 的 `loadResources` 保持一致）。
 * @param {any} raw - stages.json 的元素。
 * @returns {{ stageId: string, code: string, apCost: number | null, prefix: string, suffix: string,
 *   dropItems: string[], dropInfos: Array<{ itemId: string, dropType: string }> } | null} 归一结果；坏数据为 null。
 */
export function normalizeStage(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.stageId !== 'string' || raw.stageId.trim() === '') return null;
  const stageId = raw.stageId.trim();
  const code = typeof raw.code === 'string' && raw.code.trim() !== '' ? raw.code.trim() : stageId;
  const index = stageId.indexOf('_');
  const dropInfos = Array.isArray(raw.dropInfos)
    ? raw.dropInfos
      .map((drop) => ({
        itemId: typeof drop?.itemId === 'string' ? drop.itemId.trim() : '',
        dropType: typeof drop?.dropType === 'string' ? drop.dropType : '',
      }))
      .filter((drop) => drop.itemId !== '')
    : [];
  return {
    stageId,
    code,
    apCost: Number.isFinite(raw.apCost) ? Number(raw.apCost) : null,
    prefix: index >= 0 ? stageId.slice(0, index + 1) : '',
    suffix: index >= 0 ? stageId.slice(index + 1) : stageId,
    dropItems: dropInfos.map((drop) => drop.itemId),
    dropInfos,
  };
}

/**
 * 归一一条材料记录。
 * @param {string} itemId - 材料 id。
 * @param {any} raw - item_index.json 的值。
 * @returns {{ itemId: string, name: string, icon: string, usage: string, description: string,
 *   classifyType: string, sortId: number | null } | null} 归一结果；坏数据为 null。
 */
export function normalizeItem(itemId, raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof itemId === 'string' ? itemId.trim() : String(itemId ?? '').trim();
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (id === '' || name === '') return null;
  return {
    itemId: id,
    name,
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    usage: typeof raw.usage === 'string' ? raw.usage : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    classifyType: typeof raw.classifyType === 'string' ? raw.classifyType : '',
    sortId: Number.isFinite(raw.sortId) ? Number(raw.sortId) : null,
  };
}

/**
 * 把「对象 map」收成普通对象；非对象返回空对象。
 * @param {any} value - 原值。
 * @returns {Record<string, any>} 对象。
 */
function objectOr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * stat 五个资源文件，生成 mtime 签名（文件不存在记为 `-`）。
 * @param {string} root - MAA 安装根目录。
 * @returns {Promise<{ signature: string, files: Record<string, { mtimeMs: number | null, size: number | null }> }>} 签名。
 */
async function statSignature(root) {
  /** @type {Record<string, { mtimeMs: number | null, size: number | null }>} */
  const files = {};
  const parts = [];
  for (const [key, name] of Object.entries(RESOURCE_FILES)) {
    const file = path.join(root, 'resource', name);
    try {
      const stat = await fsp.stat(file);
      files[key] = { mtimeMs: stat.mtimeMs, size: stat.size };
      parts.push(`${key}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      files[key] = { mtimeMs: null, size: null };
      parts.push(`${key}:-`);
    }
  }
  return { signature: parts.join('|'), files };
}

/**
 * 读一个 JSON 文件。
 * @param {string} file - 文件路径。
 * @returns {Promise<{ ok: true, value: any } | { ok: false, missing: boolean, error: Error }>} 结果。
 */
async function readJsonFile(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
  try {
    return { ok: true, value: JSON.parse(raw.replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

/**
 * 从原始 JSON 组装 bundle（纯函数；测试可直接调用）。
 * @param {{ maaPath: string, files: Record<string, any>, stagesRaw: any, itemsRaw: any,
 *   recruitmentRaw: any, configRaw: any, versionRaw: any, warnings: string[], now?: () => number }} input
 *   原始数据。
 * @returns {Record<string, any>} bundle。
 */
export function buildResourceBundle(input) {
  const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
  const now = typeof input.now === 'function' ? input.now : () => Date.now();

  const stages = [];
  const stageById = new Map();
  const stageByCodeMap = new Map();
  if (Array.isArray(input.stagesRaw)) {
    for (const raw of input.stagesRaw) {
      const entry = normalizeStage(raw);
      if (entry === null) continue;
      stages.push(entry);
      const idKey = entry.stageId.toLowerCase();
      if (!stageById.has(idKey)) stageById.set(idKey, entry);
      const codeKey = normalizeCode(entry.code);
      if (codeKey === '') continue;
      const group = stageByCodeMap.get(codeKey);
      if (group === undefined) stageByCodeMap.set(codeKey, [entry]);
      else group.push(entry);
    }
  }

  /** @type {Map<string, any>} */
  const itemById = new Map();
  /** @type {Map<string, any>} */
  const itemByName = new Map();
  const items = [];
  for (const [itemId, raw] of Object.entries(objectOr(input.itemsRaw))) {
    const item = normalizeItem(itemId, raw);
    if (item === null) continue;
    items.push(item);
    if (!itemById.has(item.itemId)) itemById.set(item.itemId, item);
    const nameKey = item.name.toLowerCase();
    if (!itemByName.has(nameKey)) itemByName.set(nameKey, item);
  }
  /** @type {Record<string, string>} */
  const itemNames = {};
  for (const item of items) itemNames[item.itemId] = item.name;

  const operatorIndex = buildOperatorIndex(input.recruitmentRaw);
  const configRaw = objectOr(input.configRaw);
  const packageNames = objectOr(configRaw.packageName);
  const versionRaw = objectOr(input.versionRaw);
  const version = {
    configVersion: typeof configRaw.version === 'string' ? configRaw.version : null,
    lastUpdated: typeof versionRaw.last_updated === 'string' ? versionRaw.last_updated : null,
    activity: objectOr(versionRaw.activity),
    gacha: objectOr(versionRaw.gacha),
  };

  const bundle = {
    maaPath: input.maaPath,
    loadedAt: now(),
    files: objectOr(input.files),
    stages,
    items,
    itemNames,
    operators: operatorIndex.list,
    operatorIndex,
    packageNames,
    version,
    warnings,
    /** 按代码（归一化后）取同一关卡的所有难度条目。未找到给空数组。 */
    stageByCode(code) {
      const key = normalizeCode(code);
      if (key === '') return [];
      const group = stageByCodeMap.get(key);
      if (group !== undefined) return group;
      const byId = stageById.get(String(code ?? '').trim().toLowerCase());
      return byId === undefined ? [] : [byId];
    },
    /** 按内部 stageId 取条目（大小写不敏感）。 */
    stageById(stageId) {
      const byId = stageById.get(String(stageId ?? '').trim().toLowerCase());
      return byId ?? null;
    },
    /** 按材料 id 取材料。 */
    itemById(itemId) {
      return itemById.get(String(itemId ?? '').trim()) ?? null;
    },
    /** 按中文名取材料（大小写/空白不敏感；也接受 id）。 */
    itemByName(name) {
      const key = String(name ?? '').trim().toLowerCase();
      if (key === '') return null;
      return itemByName.get(key) ?? itemById.get(String(name ?? '').trim()) ?? null;
    },
    /** 按 id 取干员。 */
    operatorById(id) {
      return operatorIndex.byId.get(String(id ?? '').trim()) ?? null;
    },
    /** 按名字取干员（大小写不敏感）。 */
    operatorByName(name) {
      return operatorIndex.byName.get(String(name ?? '').trim().toLowerCase()) ?? null;
    },
    /** 公开招募标签表（原始对象）。 */
    tagTable: operatorIndex.tagTable,
  };
  return bundle;
}

/**
 * 读 MAA 资源并组装 bundle（按 mtime 缓存）。
 * @param {string} maaPath - MAA 安装根目录。
 * @param {{ fresh?: boolean, logger?: { warn?: Function, info?: Function } }} [options] - 选项。
 * @returns {Promise<Record<string, any>>} bundle（含 `stageByCode` 等方法）。
 * @throws {import('../errors.js').ArkError} 关卡表缺失/损坏且没有旧缓存时。
 */
export async function loadResourceBundle(maaPath, options = {}) {
  const root = typeof maaPath === 'string' ? maaPath.trim() : '';
  if (root === '') {
    throw arkError('E_DATA_UNAVAILABLE', '没有找到 MAA 安装目录，无法读取本地关卡数据。', {
      hint: '确认 MAA 已安装，或在配置里显式指定 maaPath。',
    });
  }
  const key = path.resolve(root);
  const logger = options.logger;
  const { signature, files } = await statSignature(key);
  const cached = bundleCache.get(key);
  if (options.fresh !== true && cached !== undefined && cached.signature === signature) {
    return cached.bundle;
  }

  const warnings = [];
  const readAll = async () => {
    const stages = await readJsonFile(path.join(key, 'resource', RESOURCE_FILES.stages));
    const items = await readJsonFile(path.join(key, 'resource', RESOURCE_FILES.items));
    const recruitment = await readJsonFile(path.join(key, 'resource', RESOURCE_FILES.recruitment));
    const config = await readJsonFile(path.join(key, 'resource', RESOURCE_FILES.config));
    const version = await readJsonFile(path.join(key, 'resource', RESOURCE_FILES.version));
    return { stages, items, recruitment, config, version };
  };
  const raw = await readAll();

  if (!raw.stages.ok || !Array.isArray(raw.stages.value)) {
    const detail = raw.stages.ok
      ? 'stages.json 的顶层不是数组'
      : (raw.stages.missing ? 'resource/stages.json 不存在' : 'resource/stages.json 不是合法 JSON');
    if (cached !== undefined) {
      logger?.warn?.(`[arknights] ${detail}，沿用上一次读到的关卡表（${cached.bundle.stages.length} 关）。`);
      return { ...cached.bundle, warnings: [...cached.bundle.warnings, detail], degraded: true };
    }
    throw arkError('E_DATA_UNAVAILABLE', `读不到 MAA 关卡表：${path.join(key, 'resource', RESOURCE_FILES.stages)}`, {
      detail,
      hint: '先启动一次 MAA 主程序确认 resource 目录完整，或在配置里指定正确的 maaPath。',
    });
  }

  if (!raw.items.ok) {
    warnings.push(raw.items.missing ? 'item_index.json 缺失：材料名/材料查询不可用。' : 'item_index.json 损坏：材料名/材料查询不可用。');
  }
  if (!raw.recruitment.ok) {
    warnings.push(raw.recruitment.missing ? 'recruitment.json 缺失：干员索引不可用。' : 'recruitment.json 损坏：干员索引不可用。');
  }
  if (!raw.config.ok) warnings.push('config.json 缺失：客户包名不可用。');
  if (!raw.version.ok) warnings.push('version.json 缺失：资源版本时间不可用。');

  const bundle = buildResourceBundle({
    maaPath: key,
    files,
    stagesRaw: raw.stages.value,
    itemsRaw: raw.items.ok ? raw.items.value : {},
    recruitmentRaw: raw.recruitment.ok ? raw.recruitment.value : {},
    configRaw: raw.config.ok ? raw.config.value : {},
    versionRaw: raw.version.ok ? raw.version.value : {},
    warnings,
  });

  if (bundle.stages.length === 0) {
    throw arkError('E_DATA_UNAVAILABLE', 'MAA 关卡表里没有可用条目（stages.json 为空或字段不对）。', {
      detail: `文件：${path.join(key, 'resource', RESOURCE_FILES.stages)}`,
    });
  }

  if (bundleCache.size >= MAX_CACHED_ROOTS && !bundleCache.has(key)) {
    const oldest = [...bundleCache.keys()][0];
    bundleCache.delete(oldest);
  }
  bundleCache.set(key, { signature, bundle });
  logger?.info?.(`[arknights] MAA 资源已索引：${bundle.stages.length} 关、${bundle.items.length} 材料、${bundle.operators.length} 干员。`);
  return bundle;
}

/**
 * 清空资源 bundle 缓存（测试与「更新 resource 后强制重读」用）。
 * @param {string} [maaPath] - 指定只清这个目录；缺省清全部。
 * @returns {void}
 */
export function clearResourceBundleCache(maaPath) {
  if (typeof maaPath === 'string' && maaPath.trim() !== '') bundleCache.delete(path.resolve(maaPath.trim()));
  else bundleCache.clear();
}

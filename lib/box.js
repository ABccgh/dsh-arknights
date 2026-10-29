/**
 * 仓库 / 干员快照：`box.json` v1（契约 §7.2）。
 *
 * 数据来自 MAA 的 `DepotInfo` / `OperBoxInfo` 回调事件：
 * - `DepotInfo.details = {done, data}`，`data` 是 JSON 字符串 `{"itemId": 数量, ...}`（无物品名，
 *   名称需要调用方用 MAA resource 的 `item_index.json` 补齐，见下方 `itemNames`）；
 * - `OperBoxInfo.details = {done, all_opers:[…], own_opers:[…]}`。
 *
 * **部分识别保护**：`done:false`（或 `partial:true`）的写入不覆盖已有的完整快照；
 * 只有当前还没有完整快照时才落一份 `partial:true` 的中间态。
 *
 * 与账本一样：构造时同步读盘，损坏文件先备份 `<file>.corrupt-<ts>` 再从空开始，
 * 写入用「临时文件 + rename」保证原子性，失败只告警。
 *
 * @module @local/arknights/box
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BOX_VERSION } from './contracts.js';
import { arkError } from './errors.js';

/** 快照规模上限（防脏数据把文件撑爆；正常账号远小于这个数）。 */
const MAX_OPERATORS = 5000;
const MAX_ITEMS = 5000;
/** 面板查询默认/上限条数。 */
const DETAIL_LIMIT = 100;
const DETAIL_LIMIT_MAX = 500;

/** 文件名安全的时间戳。 */
function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 是否普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 截断字符串。 */
function text(value, limit = 200) {
  return typeof value === 'string' ? (value.length > limit ? `${value.slice(0, limit)}…` : value) : '';
}

/** 空快照。 */
function emptyBox() {
  return {
    version: BOX_VERSION,
    updatedAt: '',
    partial: false,
    operators: { all: [], own: [] },
    depot: { items: {} },
  };
}

/** 归一化全干员条目。 */
function normalizeAllOper(raw) {
  if (!isPlainObject(raw)) return null;
  const id = text(raw.id, 100);
  if (id === '') return null;
  return {
    id,
    name: text(raw.name, 100),
    rarity: Number.isFinite(raw.rarity) ? Math.trunc(raw.rarity) : 0,
    own: raw.own === true,
  };
}

/** 归一化已拥有干员条目。 */
function normalizeOwnOper(raw) {
  if (!isPlainObject(raw)) return null;
  const id = text(raw.id, 100);
  if (id === '') return null;
  return {
    id,
    name: text(raw.name, 100),
    rarity: Number.isFinite(raw.rarity) ? Math.trunc(raw.rarity) : 0,
    elite: Number.isFinite(raw.elite) ? Math.trunc(raw.elite) : null,
    level: Number.isFinite(raw.level) ? Math.trunc(raw.level) : null,
    potential: Number.isFinite(raw.potential) ? Math.trunc(raw.potential) : null,
    own: raw.own !== false,
  };
}

/** 归一化整份快照。 */
function normalizeBox(raw) {
  const box = emptyBox();
  if (!isPlainObject(raw)) return box;
  box.version = BOX_VERSION;
  box.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  box.partial = raw.partial === true;
  const operators = isPlainObject(raw.operators) ? raw.operators : {};
  if (Array.isArray(operators.all)) {
    box.operators.all = operators.all.map(normalizeAllOper).filter(Boolean).slice(0, MAX_OPERATORS);
  }
  if (Array.isArray(operators.own)) {
    box.operators.own = operators.own.map(normalizeOwnOper).filter(Boolean).slice(0, MAX_OPERATORS);
  }
  const depot = isPlainObject(raw.depot) ? raw.depot : {};
  if (isPlainObject(depot.items)) {
    for (const [itemId, item] of Object.entries(depot.items).slice(0, MAX_ITEMS)) {
      if (typeof itemId !== 'string' || itemId === '') continue;
      const count = isPlainObject(item) ? item.count : item;
      if (!Number.isFinite(count)) continue;
      box.depot.items[itemId] = {
        name: isPlainObject(item) ? text(item.name, 100) : '',
        count: Math.trunc(count),
      };
    }
  }
  return box;
}

/** 从 `itemNames` 参数里取物品名（支持 `{id:{name}}`、`{id:name}` 与 Map）。 */
function itemNameOf(itemNames, itemId) {
  if (itemNames === null || itemNames === undefined) return '';
  if (itemNames instanceof Map) {
    const value = itemNames.get(itemId);
    return isPlainObject(value) ? text(value.name, 100) : text(value, 100);
  }
  if (!isPlainObject(itemNames)) return '';
  const value = itemNames[itemId];
  return isPlainObject(value) ? text(value.name, 100) : text(value, 100);
}

/**
 * 造一个仓库/干员快照对象。
 * @param {{ file: string, logger?: { warn?: Function, info?: Function } }} options - 选项。
 * @returns {object} box API。
 */
export function createBox(options) {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : '';
  if (file === '') throw arkError('E_BAD_ARGS', 'createBox 需要 file。');
  const logger = options.logger;

  /** @type {ReturnType<typeof emptyBox>} */
  let data = emptyBox();

  // —— 读盘：损坏先备份，再从空快照开始 ——
  let rawText = null;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[arknights] 仓库快照读取失败，按空快照继续：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rawText !== null) {
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      parseError = error;
    }
    if (parseError === null && isPlainObject(parsed)) {
      data = normalizeBox(parsed);
    } else {
      const backup = `${file}.corrupt-${fileStamp()}`;
      try {
        fs.copyFileSync(file, backup);
      } catch {
        // 备份失败不影响空快照继续。
      }
      logger?.warn?.(
        `[arknights] 仓库快照读取失败（已备份到 ${backup}），按空快照继续：`
        + (parseError instanceof Error ? parseError.message : '不是 JSON 对象'),
      );
      data = emptyBox();
    }
  }

  /** 串行化写操作。 @type {Promise<void>} */
  let writeChain = Promise.resolve();
  let writeCounter = 0;

  /** 原子落盘（失败只告警）。 */
  const flush = () => {
    const write = async () => {
      const temp = `${file}.${process.pid}.${writeCounter}.tmp`;
      writeCounter += 1;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await fsp.rename(temp, file);
      } catch (error) {
        try {
          await fsp.rm(temp, { force: true });
        } catch {
          // 忽略清理失败。
        }
        logger?.warn?.(`[arknights] 仓库快照写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    writeChain = writeChain.then(write, write);
    return writeChain;
  };

  const now = () => new Date().toISOString();

  /** 当前是否有可用的完整快照。 */
  const hasComplete = () => data.partial === false
    && (data.operators.all.length > 0 || data.operators.own.length > 0 || Object.keys(data.depot.items).length > 0);

  /**
   * 完整数据副本。
   * @returns {{version:number,updatedAt:string,partial:boolean,
   *   operators:{all:Array<Record<string,any>>,own:Array<Record<string,any>>},
   *   depot:{items:Record<string,{name:string,count:number}>}}} 快照。
   */
  const read = () => JSON.parse(JSON.stringify(data));

  /**
   * 状态 JSON 用的摘要（契约 §5：`box`）。
   * @returns {{operators:number,depotItems:number,updatedAt:string|null,partial:boolean}} 摘要。
   */
  const summary = () => ({
    operators: data.operators.own.length > 0 ? data.operators.own.length : data.operators.all.length,
    depotItems: Object.keys(data.depot.items).length,
    updatedAt: data.updatedAt === '' ? null : data.updatedAt,
    partial: data.partial === true,
  });

  /**
   * 保存干员识别结果。
   *
   * payload 接受两种形状：MAA `OperBoxInfo.details`（`{done, all_opers, own_opers}`）
   * 或归一化后的 `{all, own}`。
   * @param {Record<string, any>} payload - 识别结果。
   * @param {{ partial?: boolean, done?: boolean }} [opts] - 覆盖 done/partial。
   * @returns {{operators:number,depotItems:number,updatedAt:string|null,partial:boolean}} 摘要。
   */
  const saveOperBox = (payload, opts = {}) => {
    const raw = isPlainObject(payload) ? payload : {};
    const done = opts.partial !== undefined ? opts.partial === false : (opts.done !== undefined ? opts.done !== false : raw.done !== false);
    const partial = opts.partial !== undefined ? opts.partial !== false : done !== true;
    if (partial === true && hasComplete()) {
      logger?.info?.('[arknights] 干员识别是部分结果，保留现有完整快照。');
      return summary();
    }
    const allSource = Array.isArray(raw.all) ? raw.all : (Array.isArray(raw.all_opers) ? raw.all_opers : []);
    const ownSource = Array.isArray(raw.own) ? raw.own : (Array.isArray(raw.own_opers) ? raw.own_opers : []);
    data.operators = {
      all: allSource.map(normalizeAllOper).filter(Boolean).slice(0, MAX_OPERATORS),
      own: ownSource.map((item) => {
        const normalized = normalizeOwnOper(item);
        if (normalized === null) return null;
        if (!Number.isFinite(normalized.rarity)) return normalized;
        return normalized;
      }).filter(Boolean).slice(0, MAX_OPERATORS),
    };
    data.partial = partial;
    data.updatedAt = now();
    void flush();
    return summary();
  };

  /**
   * 保存仓库识别结果。
   *
   * payload 接受两种形状：MAA `DepotInfo.details`（`{done, data}`，`data` 是 JSON 字符串）
   * 或归一化后的 `{items}`。
   * 物品名来自 `opts.itemNames`（`itemId → name` 或 `itemId → {name}`）。
   * @param {Record<string, any>} payload - 识别结果。
   * @param {{ partial?: boolean, done?: boolean, itemNames?: Record<string, any> | Map<string, any> }} [opts] - 选项。
   * @returns {{operators:number,depotItems:number,updatedAt:string|null,partial:boolean}} 摘要。
   */
  const saveDepot = (payload, opts = {}) => {
    const raw = isPlainObject(payload) ? payload : {};
    const done = opts.partial !== undefined ? opts.partial === false : (opts.done !== undefined ? opts.done !== false : raw.done !== false);
    const partial = opts.partial !== undefined ? opts.partial !== false : done !== true;
    if (partial === true && hasComplete()) {
      logger?.info?.('[arknights] 仓库识别是部分结果，保留现有完整快照。');
      return summary();
    }

    /** @type {Record<string, any>} */
    let source = {};
    if (isPlainObject(raw.items)) {
      source = raw.items;
    } else if (typeof raw.data === 'string' && raw.data.trim() !== '') {
      try {
        const parsed = JSON.parse(raw.data);
        if (isPlainObject(parsed)) source = parsed;
      } catch {
        logger?.warn?.('[arknights] 仓库识别 data 不是合法 JSON，忽略这次写入。');
        return summary();
      }
    } else if (isPlainObject(raw.data)) {
      source = raw.data;
    }

    const items = {};
    let accepted = 0;
    for (const [itemId, item] of Object.entries(source)) {
      if (typeof itemId !== 'string' || itemId === '' || accepted >= MAX_ITEMS) continue;
      const countValue = isPlainObject(item) ? item.count : item;
      if (!Number.isFinite(countValue)) continue;
      const providedName = isPlainObject(item) ? text(item.name, 100) : '';
      items[itemId] = {
        name: providedName !== '' ? providedName : itemNameOf(opts.itemNames, itemId),
        count: Math.trunc(countValue),
      };
      accepted += 1;
    }
    data.depot = { items };
    data.partial = partial;
    data.updatedAt = now();
    void flush();
    return summary();
  };

  /**
   * 面板查询用的数组形状。
   * @param {{ target?: 'operators'|'depot'|'both', limit?: number }} [input] - 选项。
   * @returns {{operators?: Array<Record<string, any>>, depot?: Array<Record<string, any>>}} 结果。
   */
  const detail = (input = {}) => {
    const target = input.target === 'operators' || input.target === 'depot' ? input.target : 'both';
    const limit = Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, DETAIL_LIMIT_MAX)
      : DETAIL_LIMIT;

    /** @type {Array<Record<string, any>>} */
    let operators = [];
    if (target !== 'depot') {
      const source = data.operators.own.length > 0 ? data.operators.own : data.operators.all;
      operators = source.slice(0, limit).map((oper) => ({
        id: oper.id,
        name: oper.name,
        rarity: oper.rarity,
        ...(oper.elite === undefined ? {} : { elite: oper.elite }),
        ...(oper.level === undefined ? {} : { level: oper.level }),
        ...(oper.potential === undefined ? {} : { potential: oper.potential }),
        own: oper.own !== false,
      }));
    }

    /** @type {Array<Record<string, any>>} */
    let depot = [];
    if (target !== 'operators') {
      depot = Object.entries(data.depot.items)
        .map(([itemId, item]) => ({ itemId, name: item.name, count: item.count }))
        .sort((a, b) => (b.count - a.count) || a.itemId.localeCompare(b.itemId))
        .slice(0, limit);
    }

    const result = {};
    if (target !== 'depot') result.operators = operators;
    if (target !== 'operators') result.depot = depot;
    return result;
  };

  return {
    read,
    summary,
    saveOperBox,
    saveDepot,
    detail,
    flush,
    file,
    /** 把快照清空（测试/重新识别前用）。 */
    clear: () => {
      data = emptyBox();
      data.updatedAt = now();
      void flush();
      return summary();
    },
  };
}

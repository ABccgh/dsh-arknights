/**
 * 数据层通用件：TTL JSON 缓存 + 带超时的 JSON GET。
 *
 * 设计目标（契约见 docs/contracts.md §12）：
 * 1. **原子写**：先写同目录临时文件再 rename，进程被杀也不会留下半个 JSON；
 * 2. **key 清洗**：`../../evil` 这类 key 不能逃出缓存目录，也不能互相覆盖；
 * 3. **损坏回退**：缓存文件不是合法 JSON / 不是本模块的封装时，当作未命中，
 *    并把坏文件改名成 `.corrupt-<ts>` 留在原地（便于排查），绝不抛裸异常；
 * 4. **可注入**：`now()`、`fetchImpl`、`timeoutMs` 都从参数来，测试里完全离线可控；
 * 5. **降级**：刷新失败时如果有旧缓存，就带着 `stale` 标记返回旧值，由上层决定怎么提示。
 *
 * @module @local/arknights/data/cache
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from '../errors.js';

/** 缓存封装格式版本（改字段时递增）。 */
export const CACHE_FORMAT_VERSION = 1;
/** 默认网络超时。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 递增计数，保证同一进程内的临时文件名唯一。 */
let tempCounter = 0;

/**
 * 一个进程内稳定的短哈希（FNV-1a 32 位），只用于文件名消歧。
 * @param {string} text - 原始文本。
 * @returns {string} base36 短哈希。
 */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text ?? '')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * 把任意 key 洗成安全的文件名片段。
 * 安全且不超过 64 字符时原样返回；否则截断并追加哈希，防止 `../`、`:`、换行等。
 * @param {string} key - 原始 key。
 * @returns {string} 文件名片段（不含扩展名）。
 */
export function sanitizeCacheKey(key) {
  const raw = String(key ?? '').trim();
  if (raw === '') return '_';
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  const base = safe === '' ? '_' : safe;
  if (base === raw && raw.length <= 64) return base;
  return `${base.slice(0, 56)}-h${shortHash(raw)}`;
}

/**
 * 把毫秒渲染成「刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前」。
 * @param {number | null | undefined} ageMs - 毫秒；未知传 null。
 * @returns {string} 中文短文本。
 */
export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '未知';
  if (ageMs < 5000) return '刚刚';
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)} 秒前`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)} 分钟前`;
  if (ageMs < 86400000) return `${Math.round(ageMs / 3600000)} 小时前`;
  return `${Math.round(ageMs / 86400000)} 天前`;
}

/**
 * 把 TTL 收成正数毫秒；非法值回退。
 * @param {unknown} value - 原始 TTL（毫秒）。
 * @param {number} [fallback] - 回退值。
 * @returns {number} 非负毫秒。
 */
export function normalizeTtlMs(value, fallback = 0) {
  if (Number.isFinite(value) && value >= 0) return Number(value);
  return Number.isFinite(fallback) && fallback >= 0 ? Number(fallback) : 0;
}

/**
 * 把 `{cacheTtlHours}` 收成毫秒；非法值回退默认小时数。
 * @param {unknown} hours - 小时数。
 * @param {number} [defaultHours] - 默认小时数。
 * @returns {number} 非负毫秒。
 */
export function ttlMsFromHours(hours, defaultHours = 168) {
  const parsed = Number(hours);
  const effective = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHours;
  return Math.round(effective * 3600000);
}

/**
 * 造一个 JSON 缓存。
 *
 * 存储模式三选一（优先级从高到低）：
 * - `file`：固定单个文件（活动日历这种「一份全局数据」）；
 * - `dir`：目录 + 每个 key 一个文件（企鹅物流按材料、ArkRec 按数据源）；
 * - 都没有：纯内存缓存（测试 / 没有可写目录时兜底）。
 *
 * @param {{ file?: string, dir?: string, ttlMs?: number, now?: () => number,
 *   logger?: { warn?: Function }, label?: string }} [options] - 选项。
 * @returns {object} 缓存对象。
 */
export function createJsonCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger;
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'cache';
  const defaultTtlMs = normalizeTtlMs(options.ttlMs, 0);
  const fixedFile = typeof options.file === 'string' && options.file.trim() !== '' ? path.resolve(options.file.trim()) : '';
  const dir = fixedFile === '' && typeof options.dir === 'string' && options.dir.trim() !== ''
    ? path.resolve(options.dir.trim())
    : '';
  /** @type {Map<string, Record<string, any>>} */
  const memory = new Map();

  /** 相对/绝对 key 对应的落盘文件；纯内存模式返回空串。 */
  const fileForKey = (key) => {
    if (fixedFile !== '') return fixedFile;
    if (dir !== '') return path.join(dir, `${sanitizeCacheKey(key)}.json`);
    return '';
  };

  /** 把坏文件挪走（尽力而为，失败只告警）。 */
  const quarantine = async (file, reason) => {
    logger?.warn?.(`[arknights] ${label}缓存损坏（${reason}），已忽略：${file}`);
    try {
      await fsp.rename(file, `${file}.corrupt-${Date.now().toString(36)}`);
    } catch {
      // 挪不走也无所谓：下次读还会当未命中。
    }
  };

  /**
   * 读缓存。
   * @param {string} key - key。
   * @returns {Promise<{ data: any, fetchedAt: number, ageMs: number } | null>} 未命中/损坏为 null。
   */
  const read = async (key) => {
    const file = fileForKey(key);
    if (file === '') {
      const entry = memory.get(String(key));
      if (entry === undefined) return null;
      return { data: entry.data, fetchedAt: entry.fetchedAt, ageMs: Math.max(0, now() - entry.fetchedAt) };
    }
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        logger?.warn?.(`[arknights] 读 ${label}缓存失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
    let entry;
    try {
      entry = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      await quarantine(file, '不是合法 JSON');
      return null;
    }
    if (entry === null || typeof entry !== 'object' || !Number.isFinite(entry.fetchedAt) || !('data' in entry)) {
      await quarantine(file, '结构不合法');
      return null;
    }
    return { data: entry.data, fetchedAt: Number(entry.fetchedAt), ageMs: Math.max(0, now() - Number(entry.fetchedAt)) };
  };

  /**
   * 原子落盘。写入失败只告警并返回 false（缓存不是关键路径）。
   * @param {string} file - 目标文件。
   * @param {Record<string, any>} entry - 缓存封装。
   * @returns {Promise<boolean>} 是否写入成功。
   */
  const replaceFile = async (file, entry) => {
    const tmp = `${file}.${process.pid}.${(tempCounter += 1)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(entry)}\n`, 'utf8');
      try {
        await fsp.rename(tmp, file);
      } catch (error) {
        // Windows 上目标被占用时会 EPERM/EEXIST，删掉再试一次。
        if (error?.code !== 'EPERM' && error?.code !== 'EEXIST' && error?.code !== 'EACCES') throw error;
        await fsp.rm(file, { force: true });
        await fsp.rename(tmp, file);
      }
      return true;
    } catch (error) {
      logger?.warn?.(`[arknights] 写 ${label}缓存失败：${error instanceof Error ? error.message : String(error)}`);
      try {
        await fsp.rm(tmp, { force: true });
      } catch {
        // 清理失败无所谓。
      }
      return false;
    }
  };

  /**
   * 写缓存。
   * @param {string} key - key。
   * @param {any} data - 要缓存的数据（undefined 会被拒绝）。
   * @param {{ fetchedAt?: number, ttlMs?: number }} [meta] - 元信息。
   * @returns {Promise<{ fetchedAt: number, ttlMs: number } | null>} 写成功返回元信息；失败 null。
   */
  const write = async (key, data, meta = {}) => {
    if (data === undefined) return null;
    const fetchedAt = Number.isFinite(meta.fetchedAt) ? Number(meta.fetchedAt) : now();
    const ttlMs = normalizeTtlMs(meta.ttlMs ?? defaultTtlMs, defaultTtlMs);
    /** @type {Record<string, any>} */
    const entry = { version: CACHE_FORMAT_VERSION, fetchedAt, data };
    if (ttlMs > 0) entry.expiresAt = fetchedAt + ttlMs;
    const file = fileForKey(key);
    if (file === '') {
      memory.set(String(key), entry);
      return { fetchedAt, ttlMs };
    }
    const ok = await replaceFile(file, entry);
    return ok ? { fetchedAt, ttlMs } : null;
  };

  /**
   * 记住一个生产结果：命中新鲜缓存就不跑 producer，过期/未命中才跑。
   *
   * producer 抛错或返回 `null/undefined` 都算「本次没拿到数据」：有旧缓存且
   * `allowStale !== false` 时返回旧值 + `stale:true`，否则返回 `{data:null}`，不抛。
   * @param {string} key - key。
   * @param {(context: { cached: any, ageMs: number | null }) => Promise<any> | any} producer - 数据生产函数。
   * @param {{ fresh?: boolean, ttlMs?: number, allowStale?: boolean }} [options] - 选项。
   * @returns {Promise<{ data: any, fetchedAt: number | null, ageMs: number | null,
   *   stale: boolean, fromCache: boolean, error: unknown, file: string }>} 结果。
   */
  const remember = async (key, producer, options = {}) => {
    const ttlMs = normalizeTtlMs(options.ttlMs ?? defaultTtlMs, defaultTtlMs);
    const cached = await read(key);
    const fresh = options.fresh === true;
    if (!fresh && cached !== null && (ttlMs === 0 || cached.ageMs < ttlMs)) {
      return {
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        ageMs: cached.ageMs,
        stale: false,
        fromCache: true,
        error: null,
        file: fileForKey(key),
      };
    }

    let produced;
    let failure = null;
    try {
      produced = await producer({ cached: cached?.data ?? null, ageMs: cached?.ageMs ?? null });
    } catch (error) {
      failure = error;
    }
    if (failure === null && produced === null) failure = arkError('E_DATA_UNAVAILABLE', `${label}没有返回数据。`);

    if (failure !== null) {
      if (cached !== null && options.allowStale !== false) {
        logger?.warn?.(`[arknights] ${label}刷新失败（${failure instanceof Error ? failure.message : String(failure)}），沿用 ${formatAge(cached.ageMs)} 的旧缓存。`);
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          ageMs: cached.ageMs,
          stale: true,
          fromCache: true,
          error: failure,
          file: fileForKey(key),
        };
      }
      return {
        data: null,
        fetchedAt: null,
        ageMs: cached?.ageMs ?? null,
        stale: false,
        fromCache: false,
        error: failure,
        file: fileForKey(key),
      };
    }

    const written = await write(key, produced, { ttlMs });
    return {
      data: produced,
      fetchedAt: written?.fetchedAt ?? now(),
      ageMs: 0,
      stale: false,
      fromCache: false,
      error: null,
      file: fileForKey(key),
    };
  };

  return {
    read,
    write,
    remember,
    /** 只读元信息（不触发网络）。 */
    peek: read,
    /** 删掉一个 key。 */
    remove: async (key) => {
      const file = fileForKey(key);
      memory.delete(String(key));
      if (file === '') return;
      try {
        await fsp.rm(file, { force: true });
      } catch {
        // 删不掉不影响结论。
      }
    },
    /** 该 key 的落盘路径（测试/排查用）。 */
    fileForKey,
    /** 目录模式下的缓存目录。 */
    dir,
    /** 固定文件模式下缓存文件。 */
    file: fixedFile,
    label,
    ttlMs: defaultTtlMs,
  };
}

/**
 * 带超时地 GET 一个 JSON。
 *
 * 失败一律抛 `ArkError(E_DATA_UNAVAILABLE)`，由调用方决定降级成 null 还是提示；
 * 这样上层不需要区分 `fetch failed` / 非 2xx / 非 JSON 三种裸异常。
 * @param {string} url - 完整 URL。
 * @param {{ fetchImpl?: Function, timeoutMs?: number, headers?: Record<string, string>,
 *   init?: Record<string, any> }} [options] - 选项。
 * @returns {Promise<any>} 解析后的 JSON。
 * @throws {import('../errors.js').ArkError} 请求失败/超时/非 JSON 时。
 */
export async function fetchJson(url, options = {}) {
  const target = String(url ?? '').trim();
  if (target === '') throw arkError('E_DATA_UNAVAILABLE', '请求地址为空。');
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw arkError('E_DATA_UNAVAILABLE', '当前运行环境没有可用的 fetch。', {
      hint: '在 Node 20+ 或浏览器里运行；也可以在 createData 里注入 fetchImpl。',
    });
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(target, {
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
      ...(options.init ?? {}),
      signal: controller.signal,
    });
    if (response === null || typeof response !== 'object') {
      throw arkError('E_DATA_UNAVAILABLE', '数据源没有返回响应。', { detail: target });
    }
    if (response.ok !== true) {
      throw arkError('E_DATA_UNAVAILABLE', `数据源返回 HTTP ${response.status ?? '未知'}。`, { detail: target });
    }
    try {
      return await response.json();
    } catch (error) {
      throw arkError('E_DATA_UNAVAILABLE', '数据源返回的不是合法 JSON。', {
        detail: target,
        cause: error,
      });
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw arkError('E_DATA_UNAVAILABLE', `请求超时（${timeoutMs}ms）。`, { detail: target, cause: error });
    }
    if (error?.code === 'E_DATA_UNAVAILABLE') throw error;
    throw arkError('E_DATA_UNAVAILABLE', `请求失败：${error instanceof Error ? error.message : String(error)}`, {
      detail: target,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

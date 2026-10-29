/**
 * 关卡账本 v2：记录「这一关打没打过、几星、源石有没有拿、哪个难度、失败过几次」。
 *
 * 只做记录与提示，**绝不覆盖用户的指令**（账本说已满星，用户要求再打就再打）。
 * 推关用它跳过已满星的关卡，面板与 `ark_status` 用它显示统计与每日进度。
 *
 * 文件格式见 docs/contracts.md §7.1；写入用「临时文件 + rename」保证原子性。
 * v1 → v2 迁移：先写 `<file>.v1.bak`；解析失败：复制 `<file>.corrupt-<ts>` 后从空账本开始。
 *
 * @module @local/arknights/ledger
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { LEDGER_VERSION } from './contracts.js';
import { arkError } from './errors.js';
import { normalizeCode } from './stages.js';

/** 每关失败记录上限（契约 §7.1：最多 20 条）。 */
const MAX_FAILURES_PER_STAGE = 20;
/** 每日任务项上限（防脏数据把文件撑大）。 */
const MAX_DAILY_TASKS = 20;
/** 状态 JSON 里的账本条目上限。 */
const VIEW_ENTRIES = 30;
/** 难度键（契约 §7.1）。 */
const DIFFICULTY_KEYS = ['easy', 'tough'];

/** 今天（本地时区）的 `YYYY-MM-DD`。 */
function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 文件名安全的时间戳。 */
function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 是否普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 空难度记录。 */
function emptyDifficulty() {
  return {
    easy: { stars: null, at: null },
    tough: { stars: null, at: null },
  };
}

/** 归一化难度记录（容忍 null / 旧格式）。 */
function normalizeDifficulty(raw) {
  const out = emptyDifficulty();
  if (!isPlainObject(raw)) return out;
  for (const key of DIFFICULTY_KEYS) {
    const value = isPlainObject(raw[key]) ? raw[key] : {};
    out[key] = {
      stars: normalizeStars(value.stars),
      at: typeof value.at === 'string' ? value.at : null,
    };
  }
  return out;
}

/** 星级收敛到 0..3 的整数；非法返回 null。 */
function normalizeStars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

/** 难度名归一化：只认 easy/tough；auto 等返回 null（不记录）。 */
function normalizeDifficultyKey(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text === 'easy' || text === 'tough' ? text : null;
}

/** 截断字符串。 */
function truncate(value, limit) {
  return typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 归一化一条失败记录（契约 §7.1：`{at,code,message,detail?,screenshot?}`）。 */
function normalizeFailure(raw) {
  if (!isPlainObject(raw)) return null;
  const at = typeof raw.at === 'string' ? raw.at : new Date().toISOString();
  const reason = typeof raw.reason === 'string' && raw.reason !== '' ? truncate(raw.reason, 200) : undefined;
  const code = typeof raw.code === 'string' && raw.code !== '' ? truncate(raw.code, 200) : (reason ?? 'unknown');
  const message = typeof raw.message === 'string' && raw.message !== ''
    ? truncate(raw.message, 500)
    : (typeof raw.detail === 'string' && raw.detail !== '' ? truncate(raw.detail, 500) : code);
  return {
    at,
    code,
    message,
    ...(reason === undefined ? {} : { reason }),
    ...(typeof raw.detail === 'string' ? { detail: truncate(raw.detail, 300) } : {}),
    ...(typeof raw.screenshot === 'string' ? { screenshot: truncate(raw.screenshot, 500) } : {}),
  };
}

/** 空账本。 */
function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    updatedAt: '',
    stages: {},
    daily: { date: '', tasks: {} },
    push: {},
  };
}

/** 归一化单关记录；`code` 为关卡键。 */
function normalizeEntry(code, raw) {
  const entry = isPlainObject(raw) ? raw : {};
  const failures = Array.isArray(entry.failures)
    ? entry.failures.map(normalizeFailure).filter(Boolean).slice(-MAX_FAILURES_PER_STAGE)
    : [];
  const lastFailure = normalizeFailure(entry.lastFailure) ?? (failures.length > 0 ? failures[failures.length - 1] : null);
  return {
    code,
    stars: normalizeStars(entry.stars),
    fullStar: entry.fullStar === true || normalizeStars(entry.stars) === 3,
    primeClaimed: entry.primeClaimed === true || entry.fullStar === true || normalizeStars(entry.stars) === 3,
    difficulty: normalizeDifficulty(entry.difficulty),
    method: typeof entry.method === 'string' ? entry.method : null,
    solutionId: Number.isFinite(entry.solutionId) ? Math.trunc(entry.solutionId) : null,
    attempts: Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : failures.length,
    lastRunAt: typeof entry.lastRunAt === 'string' ? entry.lastRunAt : null,
    lastFailure,
    failures,
  };
}

/** 单关记录的默认形状。 */
function emptyEntry(code) {
  return {
    code,
    stars: null,
    fullStar: false,
    primeClaimed: false,
    difficulty: emptyDifficulty(),
    method: null,
    solutionId: null,
    attempts: 0,
    lastRunAt: null,
    lastFailure: null,
    failures: [],
  };
}

/** 归一化每日记录。 */
function normalizeDaily(raw) {
  if (!isPlainObject(raw)) return { date: '', tasks: {} };
  const date = typeof raw.date === 'string' ? raw.date : '';
  const tasks = {};
  if (isPlainObject(raw.tasks)) {
    for (const [key, value] of Object.entries(raw.tasks).slice(0, MAX_DAILY_TASKS)) {
      if (typeof key !== 'string' || key === '') continue;
      tasks[key] = isPlainObject(value) ? sanitizeDailyTask(value) : {};
    }
  }
  return { date, tasks };
}

/** 清洗单个每日任务记录。 */
function sanitizeDailyTask(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = truncate(value, 500);
    } else if (Array.isArray(value)) {
      out[key] = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 50);
    } else if (isPlainObject(value)) {
      out[key] = sanitizeDailyTask(value);
    }
  }
  return out;
}

/** 归一化整本账本（v2 或更高版本）。 */
function normalizeLedger(raw) {
  const data = emptyLedger();
  if (!isPlainObject(raw)) return data;
  data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  if (isPlainObject(raw.stages)) {
    for (const [code, entry] of Object.entries(raw.stages)) {
      if (typeof code !== 'string' || code === '') continue;
      data.stages[code] = normalizeEntry(code, entry);
    }
  }
  data.daily = normalizeDaily(raw.daily);
  data.push = isPlainObject(raw.push) ? raw.push : {};
  return data;
}

/**
 * 把 v1 账本迁移成 v2（difficulty/attempts/lastFailure/daily）。
 * @param {Record<string, any>} raw - v1 解析结果。
 * @returns {Record<string, any>} v2 账本。
 */
function migrateV1(raw) {
  const data = normalizeLedger(raw);
  data.version = LEDGER_VERSION;
  for (const entry of Object.values(data.stages)) {
    entry.attempts = Math.max(
      entry.attempts,
      entry.failures.length + (entry.lastRunAt !== null ? 1 : 0),
    );
  }
  return data;
}

/**
 * 造一个账本对象（构造时同步读盘/迁移，读不到就当空账本）。
 * @param {{ file: string, logger?: { warn?: Function, info?: Function }, now?: () => Date }} options - 选项。
 * @returns {object} 账本 API。
 */
export function createLedger(options) {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : '';
  if (file === '') throw arkError('E_BAD_ARGS', 'createLedger 需要 file。');
  const logger = options.logger;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  const now = () => clock().toISOString();

  /** @type {ReturnType<typeof emptyLedger>} */
  let data = emptyLedger();

  // —— 原子落盘：串行化写入，避免并发 rename 互相踩（必须定义在读盘/迁移之前：
  //    迁移分支会立刻 flush 一次，而 const 在声明前不可用）——
  let writeCounter = 0;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  /** 实际写盘（临时文件 + rename；失败只告警）。 */
  const writeFile = async () => {
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
        // 临时文件清理失败无所谓。
      }
      logger?.warn?.(`[arknights] 账本写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 落盘（原子替换；失败只告警；并发调用按顺序执行）。 */
  const flush = () => {
    writeChain = writeChain.then(writeFile, writeFile);
    return writeChain;
  };

  // —— 读盘 / 迁移 / 损坏降级 ——
  let rawText = null;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[arknights] 账本读取失败，按空账本继续：${error instanceof Error ? error.message : String(error)}`);
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
    if (parseError !== null) {
      const backup = `${file}.corrupt-${fileStamp(clock())}`;
      try {
        fs.copyFileSync(file, backup);
      } catch {
        // 备份失败也不能影响空账本继续。
      }
      logger?.warn?.(`[arknights] 账本读取失败（已备份到 ${backup}），按空账本继续：${parseError instanceof Error ? parseError.message : String(parseError)}`);
      data = emptyLedger();
    } else if (!isPlainObject(parsed)) {
      const backup = `${file}.corrupt-${fileStamp(clock())}`;
      try {
        fs.copyFileSync(file, backup);
      } catch {
        // 同上。
      }
      logger?.warn?.(`[arknights] 账本读取失败（不是 JSON 对象，已备份到 ${backup}），按空账本继续。`);
      data = emptyLedger();
    } else {
      const version = Number.isInteger(parsed.version) ? parsed.version : (isPlainObject(parsed.stages) ? 1 : LEDGER_VERSION);
      if (version < LEDGER_VERSION) {
        const backup = `${file}.v1.bak`;
        try {
          fs.writeFileSync(backup, rawText, 'utf8');
          logger?.info?.(`[arknights] 账本 v${version} → v${LEDGER_VERSION} 迁移，已备份到 ${backup}`);
        } catch (error) {
          logger?.warn?.(`[arknights] 账本迁移备份失败（继续迁移）：${error instanceof Error ? error.message : String(error)}`);
        }
        data = migrateV1(parsed);
        void flush();
      } else {
        data = normalizeLedger(parsed);
        data.version = LEDGER_VERSION;
      }
    }
  }

  /**
   * 取某关记录。
   * @param {string} code - 关卡代码。
   * @returns {Record<string, any> | undefined} 记录。
   */
  const get = (code) => data.stages[normalizeCode(code)];

  /**
   * 写一条记录（读-改-写内存态），必要时落盘。
   * @param {string} code - 关卡代码。
   * @param {(entry: Record<string, any>) => Record<string, any>} mutate - 变更函数。
   * @returns {Record<string, any>} 新记录。
   */
  const upsert = (code, mutate) => {
    const key = normalizeCode(code);
    const current = data.stages[key] ?? emptyEntry(key);
    const next = mutate({
      ...current,
      difficulty: normalizeDifficulty(current.difficulty),
      failures: Array.isArray(current.failures) ? [...current.failures] : [],
    });
    next.code = key;
    data.stages[key] = next;
    data.updatedAt = next.lastRunAt ?? now();
    return next;
  };

  /**
   * 记一次成功战斗的星级。
   * @param {string} code - 关卡代码。
   * @param {{ stars?: number, method?: string, solutionId?: number|null, difficulty?: string, at?: string }} input - 结果。
   * @returns {Record<string, any>} 记录。
   */
  const recordRun = (code, input = {}) => {
    const stars = normalizeStars(input?.stars);
    const at = typeof input?.at === 'string' ? input.at : now();
    const difficultyKey = normalizeDifficultyKey(input?.difficulty);
    const entry = upsert(code, (current) => {
      current.attempts += 1;
      if (stars !== null) current.stars = stars;
      current.fullStar = stars === 3 || current.fullStar === true;
      current.primeClaimed = current.fullStar === true;
      current.method = typeof input?.method === 'string' ? input.method : current.method;
      current.solutionId = Number.isFinite(input?.solutionId) ? Math.trunc(input.solutionId) : current.solutionId;
      current.lastRunAt = at;
      if (stars === 3) {
        current.failures = [];
        current.lastFailure = null;
      }
      if (difficultyKey !== null && stars !== null) {
        current.difficulty[difficultyKey] = { stars, at };
      }
      return current;
    });
    void flush();
    return entry;
  };

  /**
   * 记某个难度的通关星级（`easy`/`tough`；`auto` 等忽略）。
   * @param {string} code - 关卡代码。
   * @param {string} difficulty - 难度名。
   * @param {number} stars - 星级。
   * @returns {Record<string, any>} 记录。
   */
  const recordDifficulty = (code, difficulty, stars) => {
    const key = normalizeDifficultyKey(difficulty);
    if (key === null) {
      const existing = get(code);
      return existing ?? emptyEntry(normalizeCode(code));
    }
    const normalized = normalizeStars(stars) ?? 0;
    const at = now();
    const entry = upsert(code, (current) => {
      current.difficulty[key] = { stars: normalized, at };
      return current;
    });
    void flush();
    return entry;
  };

  /**
   * 记一次失败/未满星。
   * @param {string} code - 关卡代码。
   * @param {{ reason?: string, code?: string, message?: string, method?: string, solutionId?: number|null,
   *   detail?: string, screenshot?: string, at?: string }} input - 原因。
   * @returns {Record<string, any>} 记录。
   */
  const recordFailure = (code, input) => {
    const at = typeof input?.at === 'string' ? input.at : now();
    const reason = typeof input?.reason === 'string' && input.reason !== '' ? input.reason : 'unknown';
    const failureCode = typeof input?.code === 'string' && input.code !== '' ? input.code : reason;
    const failure = normalizeFailure({
      at,
      reason,
      code: failureCode,
      message: typeof input?.message === 'string' && input.message !== '' ? input.message : reason,
      ...(typeof input?.detail === 'string' ? { detail: input.detail } : {}),
      ...(typeof input?.screenshot === 'string' ? { screenshot: input.screenshot } : {}),
    });
    const entry = upsert(code, (current) => {
      current.attempts += 1;
      current.failures = [...current.failures.slice(-(MAX_FAILURES_PER_STAGE - 1)), failure];
      current.lastFailure = failure;
      current.lastRunAt = at;
      if (typeof input?.method === 'string') current.method = input.method;
      if (Number.isFinite(input?.solutionId)) current.solutionId = Math.trunc(input.solutionId);
      return current;
    });
    void flush();
    return entry;
  };

  /**
   * 记推关进度。
   * @param {{ nextStage?: string, lastStopped?: string, lastReason?: string }} input - 进度。
   * @returns {void}
   */
  const setPush = (input = {}) => {
    data.push = {
      ...data.push,
      ...(typeof input.nextStage === 'string' ? { nextStage: normalizeCode(input.nextStage) } : {}),
      ...(typeof input.lastStopped === 'string' ? { lastStopped: normalizeCode(input.lastStopped) } : {}),
      ...(typeof input.lastReason === 'string' ? { lastReason: input.lastReason } : {}),
    };
    data.updatedAt = now();
    void flush();
  };

  /**
   * 统计。
   * @returns {{ fullStar: number, missing: number, primeClaimed: number, total: number }} 统计。
   */
  const stats = () => {
    let fullStar = 0;
    let missing = 0;
    let primeClaimed = 0;
    for (const entry of Object.values(data.stages)) {
      if (entry?.fullStar === true) {
        fullStar += 1;
        if (entry.primeClaimed === true) primeClaimed += 1;
      } else {
        missing += 1;
      }
    }
    return { fullStar, missing, primeClaimed, total: Object.keys(data.stages).length };
  };

  /**
   * 状态 JSON 里的精简视图（最多 30 条，最近的在前）。
   * @returns {{ fullStar: number, missing: number, primeClaimed: number, entries: Array<Record<string, any>> }} 视图。
   */
  const view = () => {
    const entries = Object.values(data.stages)
      .filter((entry) => entry !== null && typeof entry === 'object')
      .sort((a, b) => String(b.lastRunAt ?? '').localeCompare(String(a.lastRunAt ?? '')))
      .slice(0, VIEW_ENTRIES)
      .map((entry) => ({
        code: entry.code,
        stars: entry.stars ?? null,
        fullStar: entry.fullStar === true,
        primeClaimed: entry.primeClaimed === true,
        lastRunAt: entry.lastRunAt ?? null,
        method: entry.method ?? null,
        attempts: entry.attempts ?? 0,
        difficulty: normalizeDifficulty(entry.difficulty),
        lastFailure: entry.lastFailure === null || entry.lastFailure === undefined ? null : normalizeFailure(entry.lastFailure),
      }));
    return { ...stats(), entries };
  };

  /**
   * 推关的下一个起点。
   * @returns {string} 关卡代码；没有记录时为空串。
   */
  const nextPushStage = () => (typeof data.push?.nextStage === 'string' ? data.push.nextStage : '');

  /**
   * 推关进度视图。
   * @returns {{ nextStage: string, lastStopped: string, lastReason: string }} 进度。
   */
  const pushView = () => ({
    nextStage: typeof data.push?.nextStage === 'string' ? data.push.nextStage : '',
    lastStopped: typeof data.push?.lastStopped === 'string' ? data.push.lastStopped : '',
    lastReason: typeof data.push?.lastReason === 'string' ? data.push.lastReason : '',
  });

  /**
   * 标记一个每日任务完成（单任务形态）。
   * @param {string} name - 任务名（award/mall/infrast/recruit/box…）。
   * @param {Record<string, any>} [input] - 记录（`{ok, at, text, date?}`）。
   * @returns {{ date: string, tasks: Record<string, any> }} 每日视图。
   */
  const ensureDaily = (dateKey) => {
    if (!isPlainObject(data.daily)) data.daily = { date: '', tasks: {} };
    if (data.daily.date !== dateKey) data.daily = { date: dateKey, tasks: {} };
    return data.daily;
  };

  const markDaily = (nameOrBatch, input) => {
    /** @type {Record<string, any>} */
    let tasks = {};
    let date = todayKey(clock());
    if (typeof nameOrBatch === 'string') {
      const payload = isPlainObject(input)
        ? input
        : (typeof input === 'boolean' ? { ok: input } : { ok: true });
      if (typeof payload.date === 'string' && payload.date !== '') date = payload.date;
      tasks = { [nameOrBatch]: payload };
    } else if (isPlainObject(nameOrBatch)) {
      if (typeof nameOrBatch.date === 'string' && nameOrBatch.date !== '') date = nameOrBatch.date;
      if (isPlainObject(nameOrBatch.tasks)) tasks = nameOrBatch.tasks;
    }
    const daily = ensureDaily(date);
    for (const [key, value] of Object.entries(tasks).slice(0, MAX_DAILY_TASKS)) {
      if (typeof key !== 'string' || key === '') continue;
      const previous = isPlainObject(daily.tasks[key]) ? daily.tasks[key] : {};
      const next = sanitizeDailyTask({ ...previous, ...(isPlainObject(value) ? value : { ok: value === true }) });
      if (typeof next.at !== 'string') next.at = now();
      daily.tasks[key] = next;
    }
    data.updatedAt = now();
    void flush();
    return viewDaily();
  };

  /**
   * 今天的每日任务视图；存储日期不是今天时返回空任务。
   * @returns {{ date: string, tasks: Record<string, any> }} 每日视图。
   */
  const viewDaily = () => {
    const today = todayKey(clock());
    if (!isPlainObject(data.daily) || data.daily.date !== today) return { date: today, tasks: {} };
    return { date: data.daily.date, tasks: JSON.parse(JSON.stringify(data.daily.tasks)) };
  };

  // —— 原子落盘已在上方定义（迁移分支会立刻用到）——

  return {
    get,
    recordRun,
    recordDifficulty,
    recordFailure,
    setPush,
    stats,
    view,
    nextPushStage,
    pushView,
    markDaily,
    viewDaily,
    /** `viewDaily` 的别名（Lead 接线用名）。 */
    dailyView: viewDaily,
    flush,
    /** 当前账本版本（迁移后恒为 LEDGER_VERSION）。 */
    getVersion: () => data.version,
    /** 完整数据副本（排障/测试用；不要在业务里改它）。 */
    dump: () => JSON.parse(JSON.stringify(data)),
    file,
  };
}

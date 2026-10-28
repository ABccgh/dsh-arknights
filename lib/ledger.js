/**
 * 关卡账本：记录「这一关打没打过、几星、源石有没有拿」。
 *
 * 只做记录与提示，**绝不覆盖用户的指令**（账本说已满星，用户要求再打就再打）。
 * 推关用它跳过已满星的关卡，面板与 `ark_status` 用它显示统计。
 *
 * 文件格式见 docs/contracts.md §10；写入用「临时文件 + rename」保证原子性。
 *
 * @module @local/arknights/ledger
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from './errors.js';
import { normalizeCode } from './stages.js';

/** 账本格式版本。 */
const LEDGER_VERSION = 1;

/**
 * 造一个账本对象（构造时同步读盘，读不到就当空账本）。
 * @param {{ file: string, logger?: { warn?: Function, info?: Function } }} options - 选项。
 * @returns {object} 账本 API。
 */
export function createLedger(options) {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : '';
  if (file === '') throw arkError('E_BAD_ARGS', 'createLedger 需要 file。');
  const logger = options.logger;

  /** @type {{ version: number, updatedAt: string, stages: Record<string, any>, push: Record<string, any> }} */
  let data = { version: LEDGER_VERSION, updatedAt: '', stages: {}, push: {} };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw !== null && typeof raw === 'object' && raw.stages !== null && typeof raw.stages === 'object') {
      data = {
        version: Number.isInteger(raw.version) ? raw.version : LEDGER_VERSION,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        stages: raw.stages,
        push: raw.push !== null && typeof raw.push === 'object' ? raw.push : {},
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[arknights] 账本读取失败，按空账本继续：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const now = () => new Date().toISOString();

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
    const current = data.stages[key] ?? {
      code: key,
      stars: null,
      fullStar: false,
      primeClaimed: false,
      method: null,
      solutionId: null,
      lastRunAt: null,
      failures: [],
    };
    const next = mutate({ ...current, failures: Array.isArray(current.failures) ? [...current.failures] : [] });
    next.code = key;
    next.lastRunAt = now();
    data.stages[key] = next;
    data.updatedAt = next.lastRunAt;
    return next;
  };

  /**
   * 记一次成功战斗的星级。
   * @param {string} code - 关卡代码。
   * @param {{ stars: number, method?: string, solutionId?: number|null }} input - 结果。
   * @returns {Record<string, any>} 记录。
   */
  const recordRun = (code, input = {}) => {
    const stars = Number.isFinite(input.stars) ? Math.max(0, Math.min(3, Math.trunc(input.stars))) : null;
    const entry = upsert(code, (current) => {
      current.stars = stars === null ? current.stars : stars;
      current.fullStar = stars === 3 || current.fullStar === true;
      current.primeClaimed = current.fullStar === true;
      current.method = typeof input.method === 'string' ? input.method : current.method;
      current.solutionId = Number.isFinite(input.solutionId) ? Math.trunc(input.solutionId) : current.solutionId;
      if (stars === 3) current.failures = [];
      return current;
    });
    void flush();
    return entry;
  };

  /**
   * 记一次失败/未满星。
   * @param {string} code - 关卡代码。
   * @param {{ reason: string, method?: string, solutionId?: number|null, detail?: string }} input - 原因。
   * @returns {Record<string, any>} 记录。
   */
  const recordFailure = (code, input) => {
    const reason = typeof input?.reason === 'string' && input.reason !== '' ? input.reason : 'unknown';
    const entry = upsert(code, (current) => {
      current.failures = [
        ...current.failures.slice(-9),
        {
          at: now(),
          reason,
          ...(typeof input?.detail === 'string' ? { detail: input.detail.slice(0, 300) } : {}),
        },
      ];
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
      .slice(0, 30)
      .map((entry) => ({
        code: entry.code,
        stars: entry.stars ?? null,
        fullStar: entry.fullStar === true,
        primeClaimed: entry.primeClaimed === true,
        lastRunAt: entry.lastRunAt ?? null,
        method: entry.method ?? null,
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

  /** 落盘（原子替换；失败只告警）。 */
  const flush = async () => {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await fsp.rename(temp, file);
    } catch (error) {
      logger?.warn?.(`[arknights] 账本写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { get, recordRun, recordFailure, setPush, stats, view, nextPushStage, pushView, flush, file };
}

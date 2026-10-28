/**
 * 作业站客户端：为某个关卡找可执行的 MAA 作业（Copilot JSON）。
 *
 * 关键事实（实测）：`GET {api}/copilot/query?document=<关卡代码>` 会**混返多个难度**的作业，
 * 必须按作业里的 `content.stage_name` 过滤出目标难度；同一关卡代码在 stages.json 里可能对应
 * 多个内部 id（`main_` / `easy_` / `tough_`）。
 *
 * 网络失败一律降级（返回空列表 + 原因），绝不阻塞打关卡主流程。
 *
 * @module @local/arknights/copilot
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from './errors.js';

/** 难度档：`tough_` 单独一档，其余（`main_`/`easy_`/`sub_`/`wk_`…）算普通档。 */
function tierOf(stageName) {
  return String(stageName ?? '').startsWith('tough_') ? 'tough' : 'easy';
}

/** 内部 id 的后半段（`main_10-09` → `10-09`）。 */
function suffixOf(stageName) {
  const text = String(stageName ?? '');
  const index = text.indexOf('_');
  return index >= 0 ? text.slice(index + 1) : text;
}

/**
 * 造一个作业站客户端。
 * @param {{ api: string, timeoutMs: number, maxCandidates: number, maxSolutionsPerStage: number,
 *   allowBorrowedOper: boolean, cacheDir: string, logger?: { warn?: Function, info?: Function },
 *   fetchImpl?: Function }} options - 选项。
 * @returns {object} 客户端。
 */
export function createCopilot(options) {
  const api = String(options?.api ?? 'https://prts.maa.plus').replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 15000;
  const maxCandidates = Number.isFinite(options?.maxCandidates) ? options.maxCandidates : 20;
  const maxSolutions = Number.isFinite(options?.maxSolutionsPerStage) ? options.maxSolutionsPerStage : 3;
  const allowBorrowedOper = options?.allowBorrowedOper === true;
  const cacheDir = typeof options?.cacheDir === 'string' ? options.cacheDir : '';
  const logger = options?.logger;
  const fetchImpl = typeof options?.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  /**
   * 查询某个关卡代码的作业列表。
   * @param {string} code - 关卡代码（如 `5-10`）。
   * @returns {Promise<{ solutions: Array<Record<string, any>>, reason: string, total: number }>} 原始候选。
   */
  const query = async (code) => {
    const url = `${api}/copilot/query?document=${encodeURIComponent(code)}&page=1&limit=${maxCandidates}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response?.ok) {
        return { solutions: [], reason: `作业站返回 HTTP ${response?.status ?? '未知'}`, total: 0 };
      }
      const body = await response.json();
      if (body?.status_code !== 200 || body?.data === undefined) {
        return { solutions: [], reason: `作业站返回 status_code=${body?.status_code ?? '未知'}`, total: 0 };
      }
      const items = Array.isArray(body.data.data) ? body.data.data : [];
      const total = Number.isFinite(body.data.total) ? body.data.total : items.length;
      const solutions = [];
      for (const item of items) {
        const parsed = parseSolution(item);
        if (parsed !== null) solutions.push(parsed);
      }
      return { solutions, reason: '', total };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        solutions: [],
        reason: aborted ? `查询作业站超时（${timeoutMs}ms）` : `查询作业站失败：${error instanceof Error ? error.message : String(error)}`,
        total: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 从作业站的一行里解析出可执行作业。
   * @param {Record<string, any>} item - 站上的一行。
   * @returns {Record<string, any> | null} 作业；坏数据为 null。
   */
  const parseSolution = (item) => {
    if (item === null || typeof item !== 'object') return null;
    const id = Number.isFinite(item.id) ? item.id : null;
    const contentRaw = typeof item.content === 'string' ? item.content : null;
    if (contentRaw === null) return null;
    let content;
    try {
      content = JSON.parse(contentRaw);
    } catch {
      return null;
    }
    if (content === null || typeof content !== 'object') return null;
    const stageName = typeof content.stage_name === 'string' ? content.stage_name : '';
    if (stageName === '') return null;
    const opers = Array.isArray(content.opers)
      ? content.opers.map((oper) => (typeof oper?.name === 'string' ? oper.name : '')).filter((name) => name !== '')
      : [];
    const details = typeof content.doc?.details === 'string' ? content.doc.details : '';
    const title = typeof content.doc?.title === 'string' ? content.doc.title : '';
    return {
      id,
      stageName,
      opers,
      title,
      details,
      contentRaw,
      uploader: typeof item.uploader === 'string' ? item.uploader : '',
      ratingLevel: Number.isFinite(item.rating_level) ? Number(item.rating_level) : 0,
      hotScore: Number.isFinite(item.hot_score) ? Number(item.hot_score) : 0,
      views: Number.isFinite(item.views) ? Number(item.views) : 0,
      available: item.available !== false,
      mentionsSupport: /助战|支援单位|好友/.test(`${title}${details}`),
      mentionsRaid: /险地|磨难|突袭/.test(`${title}${details}`),
    };
  };

  /**
   * 为目标关卡挑出可用作业（难度过滤 + 排序）。
   *
   * 难度关系（MAA 集成文档）：磨难/险地/突袭靠导航关卡名的 `-HARD` 后缀 + Copilot 的
   * `is_raid` 切换，因此**作业里的 `stage_name` 不一定带难度前缀**；这里只按「基础关卡」
   * 匹配（显示代码 / 内部 id / 后缀三者之一），难度交给调用方强制。
   * @param {Array<Record<string, any>>} solutions - `query` 的候选。
   * @param {{ entries: Array<Record<string, any>>, code?: string, difficulty?: 'auto' | 'easy' | 'tough' }} input
   *   目标关卡（`code` 是给用户看的关卡代码，如 `16-16`）。
   * @returns {Array<Record<string, any>>} 排好序的作业。
   */
  const pick = (solutions, input) => {
    const entries = Array.isArray(input?.entries) ? input.entries : [];
    const code = String(input?.code ?? '').toLowerCase();
    const stageIds = new Set(entries.map((entry) => String(entry.stageId ?? '').toLowerCase()));
    const suffixes = new Set(entries.map((entry) => String(entry.suffix ?? '').toLowerCase()));
    const difficulty = input?.difficulty ?? 'auto';

    const matched = solutions.filter((solution) => {
      if (solution.available !== true) return false;
      const stageName = solution.stageName.toLowerCase();
      const isBase = stageName === code
        || stageIds.has(stageName)
        || suffixes.has(suffixOf(stageName).toLowerCase());
      if (isBase) {
        // 只有明确要磨难/险地时才用 tough_ 作业；其它情况一律排除（否则会跑错难度）
        return difficulty === 'tough' || tierOf(solution.stageName) !== 'tough';
      }
      return false;
    });

    const exactId = (solution) => (stageIds.has(solution.stageName.toLowerCase()) ? 0 : 1);
    const tierRank = (solution) => (tierOf(solution.stageName) === 'tough' ? 1 : 0);
    const raidRank = (solution) => (solution.mentionsRaid === true ? 0 : 1);

    matched.sort((a, b) => {
      if (difficulty === 'tough' && raidRank(a) !== raidRank(b)) return raidRank(a) - raidRank(b);
      if (difficulty !== 'tough' && tierRank(a) !== tierRank(b)) return tierRank(a) - tierRank(b);
      // 标准难度下，内部 id 精确匹配的作业最不容易跑错关
      if (difficulty !== 'tough' && exactId(a) !== exactId(b)) return exactId(a) - exactId(b);
      if (b.ratingLevel !== a.ratingLevel) return b.ratingLevel - a.ratingLevel;
      if (!allowBorrowedOper && a.mentionsSupport !== b.mentionsSupport) return a.mentionsSupport ? 1 : -1;
      if (b.hotScore !== a.hotScore) return b.hotScore - a.hotScore;
      if (a.opers.length !== b.opers.length) return a.opers.length - b.opers.length;
      return b.views - a.views;
    });

    return matched.slice(0, Math.max(1, maxSolutions));
  };

  /**
   * 取单个作业的完整内容。
   *
   * **必须调这个**：列表接口 `query` 返回的 `content` 是**截断版**（没有 `actions`），
   * 直接丢给 MAA 会 `AsstAppendTask ret=0`（实测）。完整作业在 `/copilot/get/<id>`。
   * @param {number} id - 作业 id。
   * @returns {Promise<Record<string, any> | null>} `{contentRaw, stageName, opers, title, hasActions}`；失败为 null。
   */
  const detail = async (id) => {
    if (!Number.isFinite(id)) return null;
    const url = `${api}/copilot/get/${id}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response?.ok) {
        logger?.warn?.(`[arknights] 取作业 ${id} 失败：HTTP ${response?.status ?? '未知'}`);
        return null;
      }
      const body = await response.json();
      const raw = body?.data?.content;
      if (typeof raw !== 'string' || raw === '') {
        logger?.warn?.(`[arknights] 取作业 ${id} 失败：响应里没有 content`);
        return null;
      }
      const parsed = JSON.parse(raw);
      const opers = Array.isArray(parsed?.opers)
        ? parsed.opers.map((oper) => (typeof oper?.name === 'string' ? oper.name : '')).filter((name) => name !== '')
        : [];
      return {
        id,
        contentRaw: raw,
        stageName: typeof parsed?.stage_name === 'string' ? parsed.stage_name : '',
        title: typeof parsed?.doc?.title === 'string' ? parsed.doc.title : '',
        opers,
        hasActions: Array.isArray(parsed?.actions) && parsed.actions.length > 0,
      };
    } catch (error) {
      logger?.warn?.(`[arknights] 取作业 ${id} 失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 把作业落盘（UTF-8 无 BOM，MAA 才能解析）。
   * @param {Record<string, any>} solution - 作业。
   * @param {string} [code] - 关卡代码（用于文件名）。
   * @returns {Promise<string>} 文件路径。
   */
  const materialize = async (solution, code = '') => {
    const dir = cacheDir !== '' ? cacheDir : path.join(process.env.TEMP ?? '.', 'dsh-arknights-copilot');
    await fsp.mkdir(dir, { recursive: true });
    const safeCode = String(code).replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(dir, `${safeCode}-${solution.id ?? 'local'}.json`);
    await fsp.writeFile(file, solution.contentRaw, { encoding: 'utf8' });
    logger?.info?.(`[arknights] 作业已落盘：${path.basename(file)}（id=${solution.id}，${solution.stageName}）`);
    return file;
  };

  /**
   * 判断一份作业的 JSON 里有没有可执行动作（列表接口的截断内容没有）。
   * @param {string} contentRaw - 作业 JSON 文本。
   * @returns {boolean} 有动作才为 true。
   */
  const hasExecutableActions = (contentRaw) => {
    try {
      const parsed = JSON.parse(String(contentRaw ?? ''));
      if (Array.isArray(parsed?.actions) && parsed.actions.length > 0) return true;
      return Array.isArray(parsed?.groups) && parsed.groups.some((group) => Array.isArray(group?.actions) && group.actions.length > 0);
    } catch {
      return false;
    }
  };

  return { query, detail, pick, materialize, parseSolution, hasExecutableActions, api, maxSolutions };
}

/**
 * 读本地作业文件（`file=` 参数用）。
 * @param {string} file - 作业 JSON 路径。
 * @returns {Promise<Record<string, any>>} 解析后的作业元信息。
 * @throws {ArkError} 文件读不到或不是作业格式时。
 */
export async function loadLocalSolution(file) {
  const target = String(file ?? '').trim();
  if (target === '') throw arkError('E_BAD_ARGS', 'file 参数为空。');
  let raw;
  try {
    raw = await fsp.readFile(target, 'utf8');
  } catch (error) {
    throw arkError('E_SOLUTION_INVALID', `读不到作业文件：${target}`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  let content;
  try {
    content = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw arkError('E_SOLUTION_INVALID', `作业文件不是合法 JSON：${target}`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (content === null || typeof content !== 'object' || typeof content.stage_name !== 'string') {
    throw arkError('E_SOLUTION_INVALID', `作业文件缺少 stage_name：${target}`);
  }
  const opers = Array.isArray(content.opers)
    ? content.opers.map((oper) => (typeof oper?.name === 'string' ? oper.name : '')).filter((name) => name !== '')
    : [];
  return {
    id: null,
    stageName: content.stage_name,
    title: typeof content.doc?.title === 'string' ? content.doc.title : path.basename(target),
    details: typeof content.doc?.details === 'string' ? content.doc.details : '',
    opers,
    file: target,
    uploader: 'local',
  };
}

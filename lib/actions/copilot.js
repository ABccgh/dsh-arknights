/**
 * 抄作业回退（薄封装）：候选收集 + 单份执行 + 只读作业查询。
 *
 * fight/push 的「没有代理指挥 / 无法开战」回退只走这里，避免两套作业逻辑。
 * 本模块只负责把 `lib/copilot.js` 的客户端原语（query/detail/pick/materialize/
 * hasExecutableActions）与 `runtime.runTaskChain` 串起来；失败分类、账本与文本
 * 由动作层负责（见 `lib/actions/fight.js`）。
 *
 * 所有网络失败都降级成「没有候选 + 原因」，绝不抛裸异常阻塞打关主流程。
 *
 * @module @local/arknights/actions/copilot
 */

import fsp from 'node:fs/promises';

import { arkError, describeError } from '../errors.js';
import { loadLocalSolution } from '../copilot.js';
import { pickDifficulty, resolveStage } from '../stages.js';
import { recognizeVideo } from '../video.js';

/** 单份作业单次执行超时（MAA Copilot 链）。 */
const COPILOT_ATTEMPT_TIMEOUT_MS = 300_000;

/**
 * 取最近几条事件拼成排障文本。
 * @param {any} state - 状态容器。
 * @param {number} [limit] - 条数。
 * @returns {string} 文本。
 */
function lastEventText(state, limit = 3) {
  if (typeof state?.recentEvents !== 'function') return '没有收到任何 MAA 事件。';
  const events = state.recentEvents(limit);
  if (events.length === 0) return '没有收到任何 MAA 事件。';
  return events.map((event) => `${event.name}${event.what ? `/${event.what}` : ''}`).join(' → ');
}

/**
 * 目标关卡内部 id（错误消息用）。
 * @param {Array<Record<string, any>>} entries - 候选条目。
 * @returns {string} 文本。
 */
function targetStageNames(entries) {
  const names = (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry?.stageId ?? ''))
    .filter((name) => name !== '');
  return names.length === 0 ? '目标关卡' : names.join(' 或 ');
}

/**
 * 造一个抄作业回退器。
 *
 * 依赖（都是动作层的 deps 子集，测试可整体替换）：
 * - `config` / `paths` / `session` / `state` / `copilot` / `logger`；
 * - `runtime.runTaskChain / stopQuietly / dismissOverlays`；
 * - 可选覆盖：`recognizeVideo`（视频识别）、`loadLocalSolution`（本地作业读取）。
 *
 * @param {Record<string, any>} deps - 依赖。
 * @returns {{
 *   collect: (request: Record<string, any>) => Promise<{ candidates: Array<Record<string, any>>, reason: string }>,
 *   run: (request: Record<string, any>, solution: Record<string, any>) => Promise<Record<string, any>>,
 * }} 回退器。
 */
export function createCopilotFallback(deps = {}) {
  const config = deps.config ?? {};
  const copilot = deps.copilot;
  const logger = deps.logger;
  const state = deps.state;
  const runtime = deps.runtime;
  const loadLocal = typeof deps.loadLocalSolution === 'function' ? deps.loadLocalSolution : loadLocalSolution;
  const recognize = typeof deps.recognizeVideo === 'function' ? deps.recognizeVideo : recognizeVideo;
  const copilotConfig = config.copilot ?? {};
  const enabled = copilotConfig.enabled !== false;
  const maxSolutions = Number.isFinite(copilotConfig.maxSolutionsPerStage)
    ? Math.max(1, Math.trunc(copilotConfig.maxSolutionsPerStage))
    : 3;

  /**
   * 查询作业站（失败降级成空列表 + 原因）。
   * @param {string} code - 关卡代码。
   * @returns {Promise<{ solutions: Array<Record<string, any>>, reason: string, total: number }>} 结果。
   */
  const querySafe = async (code) => {
    if (!copilot || typeof copilot.query !== 'function') {
      return { solutions: [], reason: '作业站客户端不可用。', total: 0 };
    }
    try {
      const queried = await copilot.query(code);
      return {
        solutions: Array.isArray(queried?.solutions) ? queried.solutions : [],
        reason: typeof queried?.reason === 'string' ? queried.reason : '',
        total: Number.isFinite(queried?.total) ? queried.total : 0,
      };
    } catch (error) {
      logger?.warn?.(`[arknights] 查询作业站失败：${describeError(error)}`);
      return { solutions: [], reason: `查询作业站失败：${describeError(error)}`, total: 0 };
    }
  };

  /**
   * 收集这一关可尝试的作业候选（零 MAA 副作用；video 兜底会跑一次 MAA 任务）。
   *
   * 优先级：`file=` → `copilotId=`/作业站 → `video=` 兜底。`video=` 永远不阻塞
   * file/copilotId；失败只作为原因记录，然后继续走作业站。
   * @param {{ code: string, entries?: Array<Record<string, any>>, difficulty?: string, file?: string,
   *   copilotId?: number, video?: string }} request - 请求。
   * @returns {Promise<{ candidates: Array<Record<string, any>>, reason: string }>} 候选。
   */
  const collect = async (request = {}) => {
    const code = String(request.code ?? '');
    const entries = Array.isArray(request.entries) ? request.entries : [];
    const difficulty = request.difficulty === 'tough' ? 'tough' : 'easy';
    /** @type {Array<string>} */
    const notes = [];

    if (typeof request.file === 'string' && request.file.trim() !== '') {
      const local = await loadLocal(request.file);
      return { candidates: [local], reason: '' };
    }

    /** @type {Array<Record<string, any>>} */
    let candidates = [];
    let reason = '';
    const wantsSpecific = Number.isFinite(request.copilotId) && request.copilotId > 0;

    if (wantsSpecific) {
      const queried = await querySafe(code);
      candidates = queried.solutions.filter((solution) => solution?.id === Math.trunc(request.copilotId));
      if (candidates.length === 0) {
        reason = queried.reason !== '' ? queried.reason : `作业站上没有 id=${request.copilotId} 的作业。`;
      }
    } else if (enabled) {
      const queried = await querySafe(code);
      if (queried.solutions.length === 0) {
        reason = queried.reason !== '' ? queried.reason : `作业站上没有 ${code} 的作业。`;
      } else {
        const picked = typeof copilot.pick === 'function'
          ? copilot.pick(queried.solutions, { entries, code, difficulty })
          : queried.solutions;
        candidates = Array.isArray(picked) ? picked : [];
        if (candidates.length === 0) {
          reason = `作业站有 ${queried.total} 份 ${code} 的作业，但没有匹配 ${targetStageNames(entries)} 这一难度的。`;
        }
      }
    } else {
      reason = '配置里关掉了作业站（copilot.enabled=false），且没有指定 file。';
    }

    // 视频兜底：只在「没有 file/copilotId、也没有别的候选」时尝试；失败不阻塞后续。
    if (candidates.length === 0 && typeof request.video === 'string' && request.video.trim() !== '') {
      if (typeof runtime?.waitForIdle !== 'function') {
        notes.push('视频识别需要可用的运行时，本次跳过 video=。');
      } else {
        try {
          const recognized = await recognize({
            videoPath: request.video,
            paths: deps.paths,
            session: deps.session,
            state,
            waitForIdle: runtime.waitForIdle,
          });
          candidates = [{
            id: null,
            stageName: recognized.stageName,
            title: recognized.title,
            uploader: 'video',
            opers: Array.isArray(recognized.opers) ? recognized.opers : [],
            available: true,
            contentRaw: recognized.contentRaw,
            file: recognized.file,
            source: recognized.source,
            video: true,
          }];
          reason = '';
        } catch (error) {
          notes.push(`视频识别失败：${describeError(error)}`);
        }
      }
    }

    const combined = [reason, ...notes].filter((part) => typeof part === 'string' && part !== '').join(' ');
    return { candidates: candidates.slice(0, maxSolutions), reason: combined };
  };

  /**
   * 用一份作业打一关。
   *
   * 会依次：取完整作业（列表接口的 content 是截断版）→ 判断有没有可执行动作 →
   * 落盘 → `append Copilot` → 等链结束 → 判星。失败返回结构化原因，不抛异常。
   * @param {{ code: string, difficulty?: string, useSanityPotion?: boolean, signal?: AbortSignal,
   *   timeoutMs?: number }} request - 请求。
   * @param {Record<string, any>} solution - 候选作业。
   * @returns {Promise<Record<string, any>>} 结果：`{ok, stars, method?, drops?, reason?}`。
   */
  const run = async (request = {}, solution = {}) => {
    const code = String(request.code ?? '');
    const difficulty = request.difficulty === 'tough' ? 'tough' : 'easy';
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : COPILOT_ATTEMPT_TIMEOUT_MS;

    /** @type {Record<string, any>} */
    let full = solution;
    if (solution.file === undefined && Number.isFinite(solution.id) && copilot
      && typeof copilot.detail === 'function') {
      try {
        const detail = await copilot.detail(solution.id);
        if (detail !== null && detail !== undefined) full = { ...solution, ...detail };
      } catch (error) {
        logger?.warn?.(`[arknights] 取作业 ${solution.id} 详情失败：${describeError(error)}`);
      }
    }

    const executable = await checkExecutable(copilot, full, solution);
    if (!executable.ok) return executable;

    /** @type {string} */
    let file = '';
    try {
      if (typeof full.file === 'string' && full.file !== '') {
        file = full.file;
      } else if (copilot && typeof copilot.materialize === 'function') {
        file = await copilot.materialize(full, code);
      }
    } catch (error) {
      return { ok: false, skipped: true, reason: describeError(error) };
    }
    if (typeof file !== 'string' || file === '') {
      return { ok: false, skipped: true, reason: `作业 ${solution.id ?? 'local'} 没有可用的本地文件路径。` };
    }

    const params = {
      filename: file,
      formation: false,
      ignore_requirements: copilotConfig.ignoreRequirements !== false,
      use_sanity_potion: request.useSanityPotion === true,
      loop_times: 1,
      // 磨难/险地/突袭：显式覆盖导航关卡名并标记突袭模式
      ...(difficulty === 'tough' ? { nav_name_override: `${code}-HARD`, is_raid: true } : {}),
    };

    if (!runtime || typeof runtime.runTaskChain !== 'function') {
      return { ok: false, skipped: true, reason: '运行时不可用，无法执行抄作业。' };
    }

    /** @type {Record<string, any>} */
    let outcome;
    try {
      outcome = await runtime.runTaskChain({
        type: 'Copilot',
        params,
        timeoutMs,
        shouldAbort: () => {
          const chains = typeof state?.getChains === 'function' ? state.getChains() : [];
          return chains.some((chain) => chain.status === 'error') ? 'chain-error' : null;
        },
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      return { ok: false, error, reason: describeError(error) };
    }

    const waited = outcome?.waited ?? {};
    if (waited.timedOut === true) {
      await runtime.stopQuietly?.();
      await runtime.dismissOverlays?.(1);
      return { ok: false, timedOut: true, reason: `抄作业超时（${Math.round(timeoutMs / 1000)}s）。` };
    }
    if (waited.aborted === 'stopped') {
      return { ok: false, stopped: true, reason: '操作被中止。' };
    }

    const stars = outcome?.stars ?? null;
    if (stars === 3) {
      return {
        ok: true,
        method: 'copilot',
        stars: 3,
        reason: 'full-star',
        drops: outcome?.drops ?? {},
        solutionId: solution.id ?? null,
        solutionTitle: solution.title ?? '',
        solutionUploader: solution.uploader ?? '',
      };
    }

    let reason = waited.aborted === 'chain-error'
      ? `作业 ${solution.id ?? 'local'} 执行失败（${lastEventText(state)}）。`
      : `作业 ${solution.id ?? 'local'} 打出来是 ${stars ?? '未知'} 星。`;
    const missing = typeof state?.missingOperText === 'function' ? state.missingOperText() : '';
    if (missing !== '') reason += ` ${missing}`;
    await runtime.dismissOverlays?.(1);
    return {
      ok: false,
      stars: Number.isFinite(stars) ? stars : null,
      reason,
      ...(waited.aborted ? { aborted: waited.aborted } : {}),
    };
  };

  return { collect, run };
}

/**
 * 判断一份作业有没有可执行动作。
 *
 * 作业站列表接口的 `content` 是截断版（没有 `actions`），必须先用 `detail()` 取完整内容；
 * 本地 `file=` 作业则在读取时只拿到元信息，这里按文件内容再校验一次。
 * @param {Record<string, any>} copilot - 作业站客户端。
 * @param {Record<string, any>} full - 取完整内容后的作业。
 * @param {Record<string, any>} solution - 原始候选。
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string }>} 检查结果。
 */
async function checkExecutable(copilot, full, solution) {
  let raw = typeof full.contentRaw === 'string' ? full.contentRaw : '';
  if (raw === '' && typeof full.file === 'string' && full.file !== '') {
    try {
      raw = await fsp.readFile(full.file, 'utf8');
    } catch (error) {
      return {
        ok: false,
        skipped: true,
        reason: `读不到本地作业文件：${describeError(error)}`,
      };
    }
  }
  if (raw === '') {
    return {
      ok: false,
      skipped: true,
      reason: `作业 ${solution.id ?? 'local'} 没有可执行内容（列表截断或文件为空）。`,
    };
  }
  if (copilot && typeof copilot.hasExecutableActions === 'function' && copilot.hasExecutableActions(raw) !== true) {
    return {
      ok: false,
      skipped: true,
      reason: `作业 ${solution.id ?? 'local'} 没有可执行动作（可能是列表截断或作业本身为空）。`,
    };
  }
  return { ok: true };
}

/**
 * 把作业列表渲染成有界文本。
 * @param {{ code: string, difficulty: string, total: number, reason?: string,
 *   solutions: Array<Record<string, any>> }} input - 输入。
 * @returns {string} 文本。
 */
export function formatSolutionsText(input) {
  const lines = [];
  const difficultyText = input.difficulty === 'tough' ? '磨难/险地' : '标准/常规';
  lines.push(`「${input.code}」的作业（${difficultyText}，共 ${input.total} 份，列出 ${input.solutions.length} 份）：`);
  if (input.solutions.length === 0) {
    lines.push(input.reason ? `没有可用作业：${input.reason}` : '没有可用作业。');
    lines.push('出路：用 ark_fight copilotId=<作业id> 指定、用 file=<本地作业.json>，或手动打一局拿到满星。');
    return lines.join('\n');
  }
  for (const solution of input.solutions) {
    const rating = Number.isFinite(solution.ratingLevel) && solution.ratingLevel > 0
      ? ` · 评分 ${solution.ratingLevel}`
      : '';
    const opers = Array.isArray(solution.opers) && solution.opers.length > 0
      ? ` · ${solution.opers.length} 名干员`
      : '';
    const title = typeof solution.title === 'string' && solution.title !== '' ? ` · ${solution.title}` : '';
    const uploader = typeof solution.uploader === 'string' && solution.uploader !== '' ? ` · by ${solution.uploader}` : '';
    lines.push(`- id=${solution.id ?? '?'} · ${solution.stageName ?? '?'}${rating}${opers}${title}${uploader}`);
  }
  lines.push('用 ark_fight stages=<关卡> copilotId=<作业id> confirm=true 执行其中一份。');
  return lines.join('\n');
}

/**
 * 只读动作：查某个关卡的作业列表（`ark_solutions` / 预设工具用；零 MAA 副作用）。
 * @param {Record<string, any>} deps - 依赖（config / copilot / resources / logger）。
 * @returns {(params: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createSolutionsAction(deps = {}) {
  const config = deps.config ?? {};
  const copilot = deps.copilot;

  return async (params = {}) => {
    const stageRaw = String(params.stage ?? params.stages ?? params.code ?? '').trim();
    if (stageRaw === '') {
      throw arkError('E_BAD_ARGS', '缺少 stage：要查哪一关的作业？例如 5-10。');
    }
    if (config?.copilot?.enabled === false) {
      throw arkError('E_NO_SOLUTION', '配置里关掉了作业站（copilot.enabled=false），查不到作业。', {
        hint: '在 cordis.patch.yml 里打开 copilot.enabled，或用 file= 传本地作业。',
      });
    }
    if (!copilot || typeof copilot.query !== 'function') {
      throw arkError('E_DATA_UNAVAILABLE', '作业站客户端不可用（数据层未就绪）。');
    }

    const resources = await deps.resources();
    const resolved = resolveStage(resources.stages, stageRaw);
    const requested = params.difficulty ?? config.defaultDifficulty ?? 'auto';
    const difficulty = requested === 'tough' ? 'tough' : 'easy';
    const entry = pickDifficulty(resolved.entries, requested);
    const queried = await copilot.query(resolved.code);
    const pool = typeof copilot.pick === 'function'
      ? copilot.pick(queried.solutions, { entries: resolved.entries, code: resolved.code, difficulty })
      : queried.solutions;
    const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.trunc(params.limit) : 10;
    const solutions = (Array.isArray(pool) ? pool : []).slice(0, limit).map((solution) => ({
      id: solution.id ?? null,
      stage: resolved.code,
      stageName: solution.stageName ?? '',
      title: solution.title ?? '',
      uploader: solution.uploader ?? '',
      ratingLevel: solution.ratingLevel ?? 0,
      opers: Array.isArray(solution.opers) ? solution.opers : [],
      isRaid: solution.mentionsRaid === true,
      available: solution.available !== false,
    }));
    const reason = solutions.length === 0
      ? (queried.reason !== '' ? queried.reason : `作业站上没有匹配「${entry.code ?? resolved.code}」的作业。`)
      : '';
    const text = formatSolutionsText({
      code: resolved.code,
      difficulty,
      total: Number.isFinite(queried.total) ? queried.total : solutions.length,
      reason,
      solutions,
    });
    return {
      ok: true,
      kind: 'solutions',
      stage: resolved.code,
      difficulty,
      total: Number.isFinite(queried.total) ? queried.total : solutions.length,
      solutions,
      text,
    };
  };
}

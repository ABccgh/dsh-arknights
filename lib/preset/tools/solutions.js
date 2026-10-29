/**
 * `ark_solutions`：作业站浏览（prts.maa.plus）——为某关列出可执行作业。
 *
 * 只查询，不执行、不消耗理智；输出里直接给出可复制的 `ark_fight … copilotId=…` 调用串。
 *
 * 注意：作业站的**列表**接口返回的 `content` 是截断版（没有 actions），
 * 真正执行时由全局 `ark_fight` 按 id 取 `/copilot/get/<id>`（已内置）。
 *
 * @module @local/arknights/preset/tools/solutions
 */

import { arkError, describeError } from '../../errors.js';
import { loadResources, pickDifficulty, resolveStage } from '../../stages.js';
import { TEXT_OUTPUT, defineTool, text } from '../../tool-kit.js';
import { intIn } from '../shared.js';

/**
 * 造 `ark_solutions`。
 * @param {object} deps - 依赖（detect / copilot / config）。
 * @returns {object[]} 工具定义。
 */
export function createSolutionsTools(deps) {
  return [
    defineTool({
      name: 'ark_solutions',
      description:
        '浏览作业站（prts.maa.plus）上某个关卡的 MAA 作业：返回作业 id、评分、干员需求、是否标注险地/磨难（is_raid）、'
        + '难度、热度，并直接给出「用它打这一关」可复制的 ark_fight 调用串。只查询不执行、不消耗理智；'
        + 'difficulty=tough 会优先挑磨难/险地向的作业，auto/easy 不会用 tough_ 作业（防止跑错难度）。',
      parameters: {
        stage: {
          type: 'string',
          required: true,
          description: '关卡代码，例如 16-16、5-10、CE-6；也可以传内部 id（如 main_05-10）。',
        },
        difficulty: {
          type: 'string',
          enum: ['auto', 'easy', 'tough'],
          description: '看哪种难度的作业：auto（默认）/easy（标准/常规）/tough（磨难/险地）。',
        },
        limit: {
          type: 'integer',
          description: '最多返回几条，默认 10，上限 30。',
        },
        minRating: {
          type: 'integer',
          description: '只显示评分不低于该值的作业（0-10），默认 0。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const stage = String(args.stage ?? '').trim();
          if (stage === '') throw arkError('E_BAD_ARGS', 'stage 不能为空。', { hint: '例子：ark_solutions stage=16-16 difficulty=tough' });
          const limit = intIn(args.limit, 10, 1, 30);
          const minRating = intIn(args.minRating, 0, 0, 10);
          const difficulty = args.difficulty === 'tough' || args.difficulty === 'easy' ? args.difficulty : 'auto';

          const detected = await deps.detect();
          if (detected.maaPath === '') {
            return text(
              `没找到 MAA（MaaCore.dll），没法解析关卡代码。试过：${attemptsText(detected.maaTried)}\n`
              + '建议：先 ark_diag action=probe 看探测结果，或在预设 config 里写 maaPath。',
            );
          }
          const resources = await loadResources(detected.maaPath);

          let resolved;
          try {
            resolved = resolveStage(resources.stages, stage);
          } catch (error) {
            if (error?.code === 'E_STAGE_UNKNOWN') {
              return text(
                `查不到关卡「${stage}」：${error instanceof Error ? error.message : String(error)}\n`
                + '建议：先用全局 ark_data(kind=stage, q=…) 核对准确代码，或直接传内部 id（如 main_05-10）；'
                + '也可以换一个关卡代码再查作业。',
              );
            }
            throw error;
          }
          const entry = pickDifficulty(resolved.entries, difficulty);

          const queried = await deps.copilot.query(resolved.code);
          if (queried.solutions.length === 0) {
            return text(
              `作业站上没查到「${resolved.code}」的作业（${queried.reason === '' ? '站点返回空列表' : queried.reason}）。\n`
              + '可以：① 换关卡代码或内部 id 重试；② 用 file= 传本地作业 JSON；'
              + '③ 自己在游戏里手动打一次（不借干员拿满星后就能代理刷）；'
              + '④ 去 prts.maa.plus 网页找到作业 id 后用 copilotId= 直接指定。',
            );
          }
          const matched = deps.copilot.pick(queried.solutions, {
            entries: resolved.entries,
            code: resolved.code,
            difficulty,
          });
          const picked = matched
            .filter((solution) => solution.ratingLevel >= minRating)
            .slice(0, limit);

          const lines = [
            `${resolved.code} 的作业（站上共 ${queried.total} 份，`
            + `${difficultyLabel(difficulty)}档匹配 ${matched.length} 份，显示 ${picked.length} 条）：`,
          ];
          if (picked.length === 0) {
            lines.push(`匹配到的作业评分都低于 minRating=${minRating}；放低 minRating 或换 difficulty 再试。`);
          }
          for (const solution of picked) {
            const raid = isRaidSolution(solution);
            const ratingNote = solution.ratingLevel >= 8 ? '（好评）' : '';
            lines.push(
              `- id=${solution.id} · 评分 ${solution.ratingLevel}/10${ratingNote} · 干员需求 ${solution.opers.length}`
              + ` · is_raid=${raid ? '是' : '否'} · 难度=${raid ? '磨难/险地' : '标准/常规'}`
              + ` · 热度 ${solution.hotScore.toFixed(1)}`,
            );
            const title = solution.title === '' ? '（无标题）' : solution.title;
            lines.push(`  ${title}${solution.uploader === '' ? '' : ` — ${solution.uploader}`}`);
            if (solution.opers.length > 0) {
              lines.push(`  需要：${solution.opers.slice(0, 10).join('、')}${solution.opers.length > 10 ? '…' : ''}`);
            }
          }
          const best = picked[0];
          if (best !== undefined) {
            lines.push('');
            lines.push(
              `用它打：ark_fight stages=${resolved.code}`
              + `${difficulty === 'auto' ? '' : ` difficulty=${difficulty}`} copilotId=${best.id} confirm=true`,
            );
          } else {
            lines.push('');
            lines.push(`备用：ark_fight stages=${resolved.code} file=<本地作业 JSON> confirm=true`);
          }
          lines.push('（作业站列表接口的内容是截断版，真正执行时全局 ark_fight 会按 id 取完整作业）');
          return text(lines.join('\n'));
        } catch (error) {
          return text(`查询作业失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * 请求难度的中文标签。
 * @param {'auto'|'easy'|'tough'} difficulty - 难度。
 * @returns {string} 标签。
 */
function difficultyLabel(difficulty) {
  if (difficulty === 'tough') return '磨难/险地';
  if (difficulty === 'easy') return '标准/常规';
  return '当前难度';
}

/**
 * 这份作业是不是磨难/险地向。
 * @param {Record<string, any>} solution - 作业。
 * @returns {boolean} 是则为 true。
 */
function isRaidSolution(solution) {
  return solution.mentionsRaid === true || String(solution.stageName ?? '').startsWith('tough_');
}

/**
 * 把「试过的路径」渲染成一行。
 * @param {unknown} tried - 路径数组。
 * @returns {string} 文本。
 */
function attemptsText(tried) {
  if (!Array.isArray(tried) || tried.length === 0) return '（没有候选路径）';
  return tried.slice(0, 6).join('；');
}

/** 供测试用。 */
export { difficultyLabel, isRaidSolution };

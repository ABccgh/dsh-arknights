/**
 * `ark_solutions`：作业站浏览（prts.maa.plus）——为某关列出可执行作业。
 *
 * 只查询，不执行；输出里直接给出可复制的 `ark_fight … copilotId=…` 调用串。
 * 注意：作业站的**列表**接口返回的 `content` 是截断版（没有 actions），
 * 真正执行时由 `ark_fight` 按 id 取 `/copilot/get/<id>`（已内置）。
 *
 * @module @local/arknights/preset/tools/solutions
 */

import { describeError } from '../../errors.js';
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
        '浏览作业站（prts.maa.plus）上某个关卡的 MAA 作业：返回作业 id、标题、作者、评分、热度、所需干员数量、是否标注险地/磨难，并直接给出「用它打这一关」可复制的 ark_fight 调用串。只查询不执行、不消耗理智；`difficulty=tough` 会优先挑险地/磨难向的作业。',
      parameters: {
        stage: {
          type: 'string',
          required: true,
          description: '关卡代码，例如 16-16、5-10、CE-6。',
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
          const limit = intIn(args.limit, 10, 1, 30);
          const minRating = intIn(args.minRating, 0, 0, 10);
          const difficulty = typeof args.difficulty === 'string' ? args.difficulty : 'auto';
          const detected = await deps.detect();
          if (detected.maaPath === '') {
            return text(`没找到 MAA（MaaCore.dll），没法解析关卡代码。试过：${detected.maaTried.slice(0, 6).join('；')}`);
          }
          const resources = await loadResources(detected.maaPath);
          const resolved = resolveStage(resources.stages, String(args.stage ?? ''));
          const entry = pickDifficulty(resolved.entries, difficulty);

          const queried = await deps.copilot.query(resolved.code);
          if (queried.solutions.length === 0) {
            return text(
              `作业站上没查到「${resolved.code}」的作业${queried.reason === '' ? '' : `（${queried.reason}）`}。\n`
              + '可以：换关卡代码重试、用 file= 传本地作业，或自己在游戏里打一次（不借干员拿满星后就能代理刷）。',
            );
          }
          const picked = deps.copilot
            .pick(queried.solutions, { entries: resolved.entries, code: resolved.code, difficulty })
            .filter((solution) => solution.ratingLevel >= minRating)
            .slice(0, limit);

          const lines = [
            `${resolved.code} 的作业（站上共 ${queried.total} 份，匹配 ${difficulty === 'tough' ? '磨难/险地' : difficulty === 'easy' ? '标准/常规' : '当前难度'} ${picked.length} 份显示 ${Math.min(picked.length, limit)} 条）：`,
          ];
          if (picked.length === 0) {
            lines.push(`没有评分 ≥ ${minRating} 的匹配作业，可以放低 minRating 或换 difficulty。`);
          }
          for (const solution of picked) {
            const raid = solution.mentionsRaid === true ? ' [险地/磨难]' : '';
            const stars = solution.ratingLevel >= 8 ? '好评' : '';
            lines.push(
              `- id=${solution.id} · 评分 ${solution.ratingLevel}/10${stars === '' ? '' : `（${stars}）`} · 热度 ${solution.hotScore.toFixed(1)}`
              + ` · 干员 ${solution.opers.length}${raid}\n    ${solution.title || '（无标题）'}${solution.uploader ? ` — ${solution.uploader}` : ''}`
              + `${solution.opers.length > 0 ? `\n    需要：${solution.opers.slice(0, 10).join('、')}${solution.opers.length > 10 ? '…' : ''}` : ''}`,
            );
          }
          const best = picked[0];
          if (best !== undefined) {
            lines.push('');
            lines.push(`用它打：ark_fight stages=${resolved.code}${difficulty === 'auto' ? '' : ` difficulty=${difficulty}`} copilotId=${best.id} confirm=true`);
          }
          lines.push('（作业站列表接口的内容是截断版，真正执行时插件会按 id 取完整作业）');
          return text(lines.join('\n'));
        } catch (error) {
          return text(`查询作业失败。\n${describeError(error)}`);
        }
      },
    }),
  ];
}

/**
 * `ark_plan`：材料规划（刷哪几关 / 期望理智）。
 *
 * 复用 `lib/data/query.js` 的 `plan` 方法（本地关卡表 + 企鹅物流掉率 + 活动日历），
 * 把结构化结果渲染成有界中文文本：目标候选（期望理智升序，最多 3 个）、
 * 合并后的关卡方案、总期望理智、低样本与「没有掉率数据」的明确说明。
 *
 * @module @local/arknights/tools/plan
 */

import { describeError } from '../errors.js';
import { defineArkTool } from './shared.js';
import { clipText, formatDateTime, getData, renderSourceMeta, renderSources, round1, round2 } from './data.js';

/**
 * 解析 targets 参数：工具 schema 里是字符串，但也兼容模型传 JSON 数组字符串。
 * @param {unknown} value - 原始参数。
 * @returns {string | Array<Record<string, any>>} 传给数据层的形式。
 */
export function normalizeTargetsArg(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 不是 JSON 就按「名字:数量」字符串处理。
    }
  }
  return text;
}

/**
 * 渲染一个候选关卡。
 * @param {Record<string, any>} candidate - 候选。
 * @returns {string} 文本。
 */
function renderCandidate(candidate) {
  const code = candidate.code ?? candidate.stageId ?? '?';
  if (candidate.source === 'activity' && !Number.isFinite(candidate.expectedSanity)) {
    const deadline = Number.isFinite(candidate.event?.end) ? `，${formatDateTime(candidate.event.end)} 结束` : '';
    const name = candidate.event?.name ? `（${candidate.event.name}）` : '';
    return `${code}${name}：活动关${deadline}；缺理智/掉率数据，无法估算`;
  }
  const ap = Number.isFinite(candidate.apCost) ? `理智 ${candidate.apCost}` : '理智未知';
  const low = candidate.lowSample === true ? '（低样本）' : '';
  return `${code}（${ap}）：期望 ${round1(candidate.expectedSanity)} 理智/件（掉率 ${round2(candidate.dropRate)}，样本 ${candidate.times ?? 0} 次）${low}`;
}

/**
 * 渲染 `ark_plan` 结果。
 * @param {Record<string, any>} result - `data.plan()` 的返回值。
 * @returns {string} 文本。
 */
export function renderPlanResult(result) {
  const totals = result.totals ?? {};
  const lines = [];
  const totalText = Number.isFinite(totals.expectedSanity)
    ? `总期望理智约 ${round1(totals.expectedSanity)}（按企鹅物流掉率线性估算）`
    : '总期望理智：缺掉率数据，无法估算';
  lines.push(`${totals.items ?? 0} 个目标；${totalText}`);

  const targets = Array.isArray(result.targets) ? result.targets : [];
  for (const target of targets) {
    const name = target.itemName ?? target.name ?? '?';
    if (target.ok !== true) {
      const reason = target.reason || '没有可用的掉率数据。';
      lines.push(`· ${name} ×${target.count}：${reason}${Array.isArray(target.suggestions) && target.suggestions.length > 0 ? `（可能想找：${target.suggestions.join('、')}）` : ''}`);
      continue;
    }
    const estimate = Number.isFinite(target.expectedSanity) ? `，合计期望 ${round1(target.expectedSanity)} 理智` : '，无法估算理智';
    lines.push(`· ${name} ×${target.count}（共 ${target.candidates.length} 个候选${estimate}）：`);
    for (const candidate of target.candidates) lines.push(`   - ${renderCandidate(candidate)}`);
  }

  const stages = Array.isArray(result.stages) ? result.stages : [];
  if (stages.length > 0) {
    lines.push('推荐方案：');
    for (const stage of stages) {
      const covers = (stage.covers ?? []).map((cover) => `${cover.itemName}×${cover.count}`).join('、');
      const cost = Number.isFinite(stage.expectedSanity) ? `约 ${round1(stage.expectedSanity)} 理智` : '理智未知';
      const event = stage.event?.name ? `（${stage.event.name}）` : '';
      lines.push(` ${stage.code || stage.stageId}${event}：${covers} → ${cost}`);
    }
  }
  if (Number.isFinite(totals.expectedSanity)) {
    lines.push(`合计期望理智：约 ${round1(totals.expectedSanity)}（线性估算，不含刷取波动与活动加成）。`);
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    for (const warning of result.warnings) lines.push(`提示：${warning}`);
  }
  const sources = renderSources(result.sources);
  if (sources !== '') lines.push(sources);
  if (result.sources?.penguin?.ok === false) {
    lines.push(`掉率数据：${renderSourceMeta({ source: '企鹅物流', ok: false })}，可用 ark_data(kind=item, q=材料, refresh=true) 尝试刷新。`);
  }
  return ['ark_plan · 材料规划', ...lines].join('\n');
}

/**
 * 造 `ark_plan` 工具。
 * @param {{ data?: Record<string, any>, config?: Record<string, any>, paths?: Record<string, any> }} [deps]
 *   依赖（优先用 `deps.data`）。
 * @returns {object[]} 工具定义数组。
 */
export function createPlanTools(deps = {}) {
  return [
    defineArkTool({
      name: 'ark_plan',
      description:
        '材料规划：给「要刷哪些材料、各多少」，按企鹅物流掉率算出期望理智最低的关卡（每材料最多 3 个候选），'
        + '合并同一关可同时刷多种材料的情况，给出总期望理智、低样本提示、以及「没有掉率数据」的明确说明；'
        + '自动排除已过期活动关。纯只读计算，不消耗理智、不启动模拟器或侧车。',
      parameters: {
        targets: {
          type: 'string',
          required: true,
          description: '材料需求，如 "固源岩:10, 聚酸酯组:5"；也接受 JSON 数组 [{"item":"固源岩","count":10}]。',
        },
        preferEvent: {
          type: 'boolean',
          description: '是否优先推荐正在开放的活动关（活动关缺少理智/掉率数据时会标注无法估算）。默认 false。',
        },
        exclude: {
          type: 'string',
          description: '要排除的关卡代码，逗号/空格分隔，如 "CE-6, 5-10" 或内部 id "main_05-10"。',
        },
      },
      concurrencySafe: true,
      timeoutMs: 60000,
      async execute(args) {
        const data = getData(deps);
        try {
          const result = await data.plan({
            targets: normalizeTargetsArg(args.targets),
            preferEvent: args.preferEvent === true,
            exclude: args.exclude ?? '',
          });
          return clipText(renderPlanResult(result));
        } catch (error) {
          return clipText(describeError(error));
        }
      },
    }),
  ];
}

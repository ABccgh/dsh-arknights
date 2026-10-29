/**
 * `/ark` 命令解析与执行：与工具共用同一套 actions/status/query。
 *
 * 语法见 docs/contracts.md §10。命令返回 `{kind:'success'|'error', text}`。
 *
 * @module @local/arknights/commands
 */

import { describeError } from './errors.js';
import { renderStatus } from './tools/status.js';

/**
 * 解析 `/ark` 一行输入。
 * @param {string} rawInput - 原始输入（可带 `/ark`）。
 * @returns {{sub:string,args:string[],flags:Set<string>}} 解析结果。
 */
export function parseCommand(rawInput) {
  const text = String(rawInput ?? '').trim();
  const withoutSlash = text.startsWith('/') ? text.slice(1) : text;
  const parts = withoutSlash.split(/\s+/).filter((part) => part !== '');
  if (parts.length > 0 && parts[0] === 'ark') parts.shift();
  const sub = parts.shift() ?? 'status';
  const flags = new Set(parts.filter((part) => part.startsWith('--')).map((part) => part.slice(2)));
  const args = parts.filter((part) => !part.startsWith('--'));
  return { sub, args, flags };
}

/**
 * 把 flags 收成对象（`--chapter=5` / `--yes`）。
 * @param {Set<string>} flags - flags。
 * @returns {Record<string,string|true>} 映射。
 */
export function flagValues(flags) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (const flag of flags) {
    const [key, value] = flag.split('=');
    if (key === undefined || key === '') continue;
    out[key] = value === undefined ? true : value;
  }
  return out;
}

/**
 * 执行一条 `/ark` 命令。
 * @param {string} rawInput - 原始输入。
 * @param {{ actions: Record<string, Function>, status: { build: Function },
 *   query?: (input: Record<string, any>) => Promise<Record<string, any>>, config?: Record<string, any> }} deps - 依赖。
 * @returns {Promise<{kind:'success'|'error',text:string}>} 结果。
 */
export async function runCommand(rawInput, deps) {
  try {
    const parsed = parseCommand(rawInput);
    const flags = flagValues(parsed.flags);
    const confirmed = flags.yes === true || flags.confirm === true;
    const args = parsed.args;
    switch (parsed.sub) {
      case 'status': {
        const object = await deps.status.build();
        return { kind: 'success', text: renderStatus(object) };
      }
      case 'fight': {
        const last = args[args.length - 1];
        const hasTimes = args.length > 1 && /^\d+$/.test(String(last ?? ''));
        const times = hasTimes ? Number.parseInt(String(last), 10) : 1;
        const stages = (hasTimes ? args.slice(0, -1) : args).join(',');
        const difficulty = typeof flags.difficulty === 'string' ? flags.difficulty : undefined;
        const response = await deps.actions.fight({
          stages,
          times: Number.isFinite(times) ? times : 1,
          ...(difficulty ? { difficulty } : {}),
          confirm: confirmed,
        });
        return { kind: 'success', text: response.text };
      }
      case 'push': {
        const from = args[0] ?? '';
        const chapterRaw = flags.chapter;
        const chapter = typeof chapterRaw === 'string' ? Number.parseInt(chapterRaw, 10) : undefined;
        const maxStagesRaw = flags.max ?? flags['max-stages'];
        const maxStages = typeof maxStagesRaw === 'string' ? Number.parseInt(maxStagesRaw, 10) : undefined;
        const response = await deps.actions.push({
          ...(from === '' ? {} : { from }),
          ...(Number.isFinite(chapter) ? { chapter } : {}),
          ...(Number.isFinite(maxStages) ? { maxStages } : {}),
          confirm: confirmed,
        });
        return { kind: 'success', text: response.text };
      }
      case 'rogue': {
        const theme = args[0];
        const mode = args[1];
        const response = await deps.actions.rogue({
          ...(theme === undefined ? {} : { theme }),
          ...(mode === undefined ? {} : { mode }),
          confirm: confirmed,
        });
        return { kind: 'success', text: response.text };
      }
      case 'daily': {
        const tasks = typeof flags.tasks === 'string' ? flags.tasks.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
        const response = await deps.actions.daily({ ...(tasks ? { tasks } : {}), confirm: confirmed });
        return { kind: 'success', text: response.text };
      }
      case 'recruit': {
        const mode = args[0] === 'execute' ? 'execute' : 'analyze';
        const response = await deps.actions.recruit({ mode, confirm: confirmed });
        return { kind: 'success', text: response.text };
      }
      case 'infrast': {
        const response = await deps.actions.infrast({ confirm: confirmed });
        return { kind: 'success', text: response.text };
      }
      case 'mall': {
        const response = await deps.actions.mall({ confirm: confirmed });
        return { kind: 'success', text: response.text };
      }
      case 'award': {
        const response = await deps.actions.award({});
        return { kind: 'success', text: response.text };
      }
      case 'box': {
        const target = args[0];
        const response = await deps.actions.box(target === 'operbox' || target === 'depot' ? { target } : {});
        return { kind: 'success', text: response.text };
      }
      case 'data': {
        if (typeof deps.query !== 'function') return { kind: 'error', text: '数据查询未接好。' };
        const kind = args[0] ?? 'search';
        const q = args.slice(1).join(' ');
        const result = await deps.query({ kind, q, limit: 10, refresh: false, target: '', targets: '' });
        return { kind: 'success', text: formatQuery(kind, result) };
      }
      case 'plan': {
        if (typeof deps.query !== 'function') return { kind: 'error', text: '数据查询未接好。' };
        const targets = args.join(' ');
        const result = await deps.query({ kind: 'plan', q: targets, targets, limit: 10, refresh: false, target: '' });
        return { kind: 'success', text: formatPlan(result) };
      }
      case 'stop': {
        const response = await deps.actions.stop({});
        return { kind: 'success', text: response.text };
      }
      default:
        return {
          kind: 'error',
          text: `未知子命令「${parsed.sub}」。可用：status / fight / push / rogue / daily / recruit / infrast / mall / award / box / data / plan / stop。`,
        };
    }
  } catch (error) {
    return { kind: 'error', text: describeError(error) };
  }
}

/**
 * 查询结果转文本。
 * @param {string} kind - 类型。
 * @param {Record<string, any>} result - 查询结果。
 * @returns {string} 文本。
 */
function formatQuery(kind, result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (items.length === 0) return `没有找到（kind=${kind}）。`;
  const lines = [`${kind}：${items.length} 条`];
  for (const item of items.slice(0, 10)) {
    lines.push(`- ${item.code ?? item.id ?? item.name ?? '?'} ${item.name ?? item.stageName ?? ''}`.trim());
  }
  return lines.join('\n');
}

/**
 * 规划结果转文本。
 * @param {Record<string, any>} result - 规划结果。
 * @returns {string} 文本。
 */
function formatPlan(result) {
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  if (targets.length === 0) return '没有可规划的目标。';
  const lines = ['材料规划：'];
  for (const target of targets) {
    const best = target.best;
    lines.push(`- ${target.itemName ?? target.itemId} ×${target.count}：${best?.code ?? '?'}（期望 ${best?.expectedSanity ?? '?'} 理智/个）`);
  }
  if (Number.isFinite(result?.totalExpectedSanity)) lines.push(`合计期望理智：${result.totalExpectedSanity}`);
  for (const warning of result?.warnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

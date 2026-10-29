/**
 * `rogue` 动作：启动 MAA 的 Roguelike（集成战略）任务。
 *
 * 契约（docs/contracts.md §9）：`rogue` 需要 confirm；默认**后台运行**（append + start 后
 * 立即返回 taskId），`wait=true` 才等任务链结束（最长 6 小时）。
 *
 * MAA 6.21 的 `mode` 是数字：友好模式名用 `contracts.rogueModeNumber` 映射。
 *
 * @module @local/arknights/actions/rogue
 */

import { ROGUE_MODES, ROGUE_MODE_NUMBERS, ROGUE_THEMES, rogueModeNumber } from '../contracts.js';
import { arkError } from '../errors.js';
import { isConfirmed, needsConfirm, runAction } from './shared.js';

/** `wait=true` 时最长等待（6 小时）。 */
export const ROGUE_WAIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * 取非空字符串。
 * @param {unknown} value - 值。
 * @returns {string} 文本；非字符串/空串为空串。
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 取整数（非法回落）。
 * @param {unknown} value - 值。
 * @param {number} fallback - 回落值。
 * @returns {number} 整数。
 */
function integerOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 核心干员：数组或逗号分隔字符串都接受。
 * @param {unknown} value - 值。
 * @returns {string[]} 名字列表。
 */
function coreCharsOf(value) {
  if (Array.isArray(value)) {
    return value.map((item) => trimmed(item)).filter((item) => item !== '');
  }
  const text = trimmed(value);
  if (text === '') return [];
  return text.split(/[,，、;；\s]+/).map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 归一/校验肉鸽参数（纯函数）。
 *
 * 返回的 `{theme, modeName, maaMode, maaParams}` 用于执行；任何非法值都抛 `E_BAD_ARGS`
 * 而不是把坏参数丢给 MAA（`AsstAppendTask` 返回 0 的报错更难懂）。
 * @param {Record<string, any>} params - 工具参数。
 * @param {Record<string, any>} [config] - 生效配置。
 * @returns {{ theme: string, modeName: string, maaMode: number, maaParams: Record<string, any> }} 归一结果。
 */
export function normalizeRogueParams(params = {}, config = {}) {
  const rogueConfig = config.rogue ?? {};

  const theme = trimmed(params.theme) || trimmed(rogueConfig.theme) || 'Sarkaz';
  if (!ROGUE_THEMES.includes(theme)) {
    throw arkError('E_BAD_ARGS', `未知肉鸽主题「${theme}」。`, {
      hint: `可选：${ROGUE_THEMES.join(' / ')}。`,
    });
  }

  const rawMode = params.mode === undefined || params.mode === null || params.mode === ''
    ? (rogueConfig.mode ?? 'Exp')
    : params.mode;
  /** @type {string} */
  let modeName;
  /** @type {number} */
  let maaMode;
  if (typeof rawMode === 'number' && Number.isInteger(rawMode)) {
    maaMode = rawMode;
    modeName = Object.entries(ROGUE_MODE_NUMBERS)
      .find(([, value]) => value === rawMode)?.[0] ?? String(rawMode);
  } else {
    const text = trimmed(rawMode);
    const friendly = ROGUE_MODES.find((name) => name.toLowerCase() === text.toLowerCase());
    if (friendly !== undefined && ROGUE_MODE_NUMBERS[friendly] !== undefined) {
      modeName = friendly;
      maaMode = ROGUE_MODE_NUMBERS[friendly];
    } else if (/^-?\d+$/.test(text)) {
      maaMode = Number.parseInt(text, 10);
      modeName = String(maaMode);
    } else if (friendly === 'Custom') {
      throw arkError('E_BAD_ARGS', 'Custom 模式没有固定映射：请直接在 mode 里传 MAA 的数字模式。', {
        hint: '例如 mode=0（Exp）/ mode=1（Invest）/ mode=7（DeepExploration），或用 params 覆盖。',
      });
    } else {
      throw arkError('E_BAD_ARGS', `未知肉鸽模式「${text}」。`, {
        hint: `可选：${Object.keys(ROGUE_MODE_NUMBERS).join(' / ')}，或直接传 MAA 数字模式（见 contracts.rogueModeNumber）。`,
      });
    }
  }

  const startsCount = integerOr(params.startsCount, integerOr(rogueConfig.startsCount, 9999));
  if (startsCount < 1 || startsCount > 100000) {
    throw arkError('E_BAD_ARGS', `startsCount 必须在 1~100000 之间（收到 ${startsCount}）。`);
  }
  const squad = trimmed(params.squad) || trimmed(rogueConfig.squad);
  const roles = trimmed(params.roles) || trimmed(rogueConfig.roles);
  const coreChars = coreCharsOf(params.coreChars !== undefined ? params.coreChars : rogueConfig.coreChars);
  const difficulty = integerOr(params.difficulty, integerOr(rogueConfig.difficulty, -1));
  if (difficulty < -1 || difficulty > 30) {
    throw arkError('E_BAD_ARGS', `difficulty 必须在 -1~30 之间（收到 ${difficulty}）。`);
  }
  const extra = params.params !== undefined ? params.params : rogueConfig.params;
  if (extra !== undefined && (extra === null || typeof extra !== 'object' || Array.isArray(extra))) {
    throw arkError('E_BAD_ARGS', 'params 必须是一个对象（原样并入 MAA Roguelike 任务参数）。');
  }

  /** @type {Record<string, any>} */
  const maaParams = {
    theme,
    mode: maaMode,
    starts_count: startsCount,
    ...(squad !== '' ? { squad } : {}),
    ...(roles !== '' ? { roles } : {}),
    ...(coreChars.length > 0 ? { core_char: coreChars.join(',') } : {}),
    ...(difficulty >= 0 ? { difficulty } : {}),
    ...(extra ?? {}),
  };
  return { theme, modeName, maaMode, maaParams };
}

/**
 * 造 `rogue` 动作。
 * @param {Record<string, any>} deps - 依赖（config/store/runtime/state/logger）。
 * @returns {(params: Record<string, any>) => Promise<Record<string, any>>} 动作。
 */
export function createRogueAction(deps = {}) {
  const { config, store, runtime, state } = deps;

  /** @type {ReturnType<typeof normalizeRogueParams> | null} */
  let snapshot = null;

  return async (params = {}) => {
    snapshot = null;
    const normalized = normalizeRogueParams(params, config);
    // 这里的 wait 是「是否等任务链结束」，与 runAction 的「是否等 execute 返回」不是一个东西：
    // 后台模式 execute 本身会立即返回，所以不能把 wait=false 透给 runAction（否则只回计划文本）。
    const runParams = { ...params };
    delete runParams.wait;
    return runAction({
      config,
      store,
      kind: 'rogue',
      params: runParams,
      plan: async () => {
        snapshot = normalized;
        const lines = [];
        lines.push(`肉鸽计划：主题 ${normalized.theme}，模式 ${normalized.modeName}（MAA mode ${normalized.maaMode}），开始次数上限 ${normalized.maaParams.starts_count}。`);
        if (normalized.maaParams.squad !== undefined) lines.push(`- 分队：${normalized.maaParams.squad}`);
        if (normalized.maaParams.roles !== undefined) lines.push(`- 职业组：${normalized.maaParams.roles}`);
        if (normalized.maaParams.core_char !== undefined) lines.push(`- 核心干员：${normalized.maaParams.core_char}`);
        if (normalized.maaParams.difficulty !== undefined) lines.push(`- 难度：${normalized.maaParams.difficulty}`);
        lines.push(params.wait === true
          ? '执行方式：启动 Roguelike 任务链并等待结束（最长 6 小时）；期间可用 ark_status 看进度、ark_stop 停止。'
          : '执行方式：启动 Roguelike 任务链后立即返回（后台运行）；用 ark_status 看进度、ark_stop 停止。');
        if (needsConfirm('rogue', params) && !isConfirmed(config, params)) {
          lines.push('这一步没有消耗理智/源石/招聘许可。确认无误后，用同一个工具再加 confirm=true（命令里加 --yes）才会启动。');
        }
        return { text: lines.join('\n'), plannedItems: [], plannedTotalSanity: null };
      },
      execute: async (run) => {
        if (snapshot === null) snapshot = normalizeRogueParams(params, config);
        await runtime.ensureReady({ autoStart: true, startup: true, ...(run?.signal ? { signal: run.signal } : {}) });
        state?.resetChain?.();
        const { taskId } = await runtime.appendAndStart('Roguelike', snapshot.maaParams);
        const base = {
          theme: snapshot.theme,
          mode: snapshot.modeName,
          maaMode: snapshot.maaMode,
          taskId,
          startsCount: snapshot.maaParams.starts_count,
          params: snapshot.maaParams,
        };

        if (params.wait !== true) {
          const text = [
            `肉鸽已启动：主题 ${base.theme}，模式 ${base.mode}（MAA mode ${base.maaMode}），任务 id ${taskId}。`,
            '不会阻塞等待；用 ark_status 看进度，用 ark_stop 停止。',
          ].join('\n');
          return {
            text,
            result: { ...base, started: true, finished: false, background: true, chains: [] },
            status: 'completed',
          };
        }

        const waited = await runtime.waitForIdle({
          timeoutMs: ROGUE_WAIT_TIMEOUT_MS,
          shouldAbort: () => {
            const chains = typeof state?.getChains === 'function' ? state.getChains() : [];
            return chains.some((chain) => chain.status === 'error') ? 'chain-error' : null;
          },
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        const chains = typeof state?.getChains === 'function' ? state.getChains() : [];
        const finished = waited.timedOut !== true;
        const lines = [`肉鸽任务结束：主题 ${base.theme}，模式 ${base.mode}（MAA mode ${base.maaMode}），任务 id ${taskId}。`];
        for (const chain of chains) lines.push(`- ${chain.name}：${chain.status}`);
        if (waited.timedOut === true) {
          lines.push('等待超时（6 小时）：任务可能仍在跑，用 ark_status 查看或 ark_stop 停止。');
        } else if (waited.aborted === 'stopped') {
          lines.push('收到停止请求：任务链已中止。');
        } else if (waited.aborted === 'chain-error') {
          lines.push('任务链失败：用 ark_status 看最近事件，必要时 ark_diag(action=logs)。');
        }
        const status = waited.aborted === 'stopped'
          ? 'stopped'
          : waited.timedOut === true || waited.aborted === 'chain-error'
            ? 'partial'
            : 'completed';
        return {
          text: lines.join('\n'),
          result: {
            ...base,
            started: true,
            finished,
            timedOut: waited.timedOut === true,
            ...(waited.aborted ? { aborted: waited.aborted } : {}),
            chains,
          },
          status,
        };
      },
    });
  };
}

/**
 * 只读：把归一后的肉鸽参数渲染成给人看的一行（面板/诊断用）。
 * @param {Record<string, any>} params - 工具参数。
 * @param {Record<string, any>} [config] - 配置。
 * @returns {string} 文本。
 */
export function describeRoguePlan(params = {}, config = {}) {
  const normalized = normalizeRogueParams(params, config);
  return `主题 ${normalized.theme} · 模式 ${normalized.modeName}（MAA mode ${normalized.maaMode}） · 开始次数 ${normalized.maaParams.starts_count}`;
}

/** 兼容导出：把友好模式名映射成 MAA 数字（转发 contracts 的实现）。 */
export { rogueModeNumber };

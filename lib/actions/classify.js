/**
 * 失败分类器：把「链失败」翻译成可行动的诊断，而不是一句“作业执行失败”。
 *
 * 判据只来自 MAA 事件与账本（docs/contracts.md §3/§11）；截图取 MAA debug 目录里最新的一张。
 *
 * @module @local/arknights/actions/classify
 */

import fs from 'node:fs';
import path from 'node:path';

import { FAILURE_CODES } from '../contracts.js';

/** 连接类 what。 */
const CONNECTION_WHATS = new Set([
  'ConnectFailed',
  'Disconnected',
  'Disconnect',
  'ScreencapFailed',
  'ResolutionChanged',
  'ResolutionError',
  'UnsupportedResolution',
  'Reconnecting',
]);

/** 战斗开始相关的任务名（出现后失败，多半是没进关卡详情/弹窗挡住）。 */
const BATTLE_START_TASKS = new Set(['BattleStartAll', 'BattleStartPre', 'StartButton1', 'StartButton2', 'StartWithSanity']);

/**
 * 从事件里挑出最近出现的 task/what。
 * @param {Array<Record<string, any>>} events - 事件。
 * @returns {string[]} 证据。
 */
function evidenceOf(events) {
  const evidence = [];
  for (const event of events.slice(-10)) {
    const parts = [event.name];
    if (event.what) parts.push(event.what);
    if (event.task) parts.push(event.task);
    const text = parts.filter(Boolean).join(' / ');
    if (text !== '') evidence.push(text);
  }
  return evidence;
}

/**
 * 找 MAA debug/interface 下最新截图。
 * @param {string} userDir - MAA user 目录。
 * @returns {string|null} 路径。
 */
function newestScreenshot(userDir) {
  const dir = path.join(String(userDir ?? ''), 'debug', 'interface');
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return files.length > 0 ? files[0].file : null;
  } catch {
    return null;
  }
}

/**
 * 分类一次失败。
 * @param {{ state: any, paths?: Record<string, any>, kind?: string, fallback?: { code?: string, message?: string },
 *   error?: unknown }} input - 输入。
 * @returns {{code:string,message:string,hint:string,evidence:string[],screenshot:string|null,known:boolean}} 诊断。
 */
export function classifyFailure(input = {}) {
  const state = input.state;
  const events = typeof state?.recentEvents === 'function'
    ? state.recentEvents(80, { withDetails: true })
    : [];
  const whats = events.map((event) => (typeof event?.what === 'string' ? event.what : '')).filter(Boolean);
  const tasks = events
    .map((event) => event?.details?.task)
    .filter((task) => typeof task === 'string' && task !== '');
  const evidence = evidenceOf(events);
  const screenshot = newestScreenshot(input.paths?.userDir);
  const missingOper = typeof state?.missingOperText === 'function' ? state.missingOperText() : '';
  const base = {
    evidence,
    screenshot,
    known: true,
    hint: '用 ark_diag(action=screen) 看当前画面；把这份诊断连同截图一起保留。',
  };

  if (whats.some((what) => what.includes('UnableToAgent'))) {
    return {
      ...base,
      code: 'no-agent',
      message: '该关没有代理指挥（未满星或借过干员）。',
      hint: '插件会改走抄作业；若抄作业也失败，换 copilotId 或手动打一局。',
    };
  }
  if (whats.includes('StageQueueStageNotFound') || whats.includes('UnsupportedLevel')) {
    return {
      ...base,
      code: 'stage-not-found',
      message: 'MAA 找不到这一关（可能未解锁、代码不对，或活动关卡不在当前资源里）。',
      hint: '用 ark_data(kind=stage) 核对代码；推关遇到它说明已到进度边界。',
    };
  }
  if (whats.includes('CopilotPrecheckFile')) {
    return {
      ...base,
      code: 'copilot-file',
      message: '作业文件预检失败（缺 actions、格式不对或不是 UTF-8）。',
      hint: '换一份作业 / 用 copilotId 重新取完整作业。',
    };
  }
  if (missingOper !== '' || whats.includes('BattleFormationOperbox1Unmatched') || whats.includes('may_borrow_oper')) {
    return {
      ...base,
      code: 'oper-missing',
      message: missingOper !== '' ? missingOper : '作业要求的干员不满足。',
      hint: '换一份不需要这些干员的作业，或手动打通。',
    };
  }
  if (whats.some((what) => CONNECTION_WHATS.has(what))) {
    return {
      ...base,
      code: 'connection',
      message: '模拟器/adb 连接中断或截图失败。',
      hint: '用 ark_diag(action=device/emulator) 检查；必要时重启模拟器。',
    };
  }
  if (whats.includes('NotEnoughStaff')) {
    return {
      ...base,
      code: 'unknown',
      message: '基建可用干员不足，换班没有完成。',
      hint: '减少设施或换一组心情足够的干员再试。',
    };
  }
  // 理智不足：失败前摸过 UseMedicine/StoneConfirm，或停在 StartWithSanity/StageSanityCost
  if (whats.includes('MedicineConfirm') || whats.includes('StoneConfirm') || tasks.includes('UseMedicine')) {
    return {
      ...base,
      code: 'sanity-insufficient',
      message: '可能理智不足：MAA 在开始行动前停下了。',
      hint: '确认关卡理智与当前理智；要用药/碎石必须由用户明确同意并打开 safety 开关。',
    };
  }
  // 停在 BattleStartAll 一段时间 → 多半没进关卡详情（难度未开放/未解锁/导航失败）
  if (tasks.some((task) => BATTLE_START_TASKS.has(task))) {
    return {
      ...base,
      code: 'battle-start-timeout',
      message: '没有进入关卡详情，卡在「开始行动」之前（可能难度未开放、关卡未解锁、或导航失败）。',
      hint: '先用 ark_data 核对该关与难度是否开放；再打开截图确认画面。',
    };
  }
  if (whats.includes('RoutingRestart')) {
    return {
      ...base,
      code: 'unknown',
      message: '肉鸽路径规划判定无法避开过多战斗，MAA 主动重开了本局。',
      hint: '这是 MAA 的正常策略，不是插件错误。',
    };
  }

  const fallback = input.fallback ?? {};
  const code = FAILURE_CODES.includes(fallback.code) ? fallback.code : 'unknown';
  return {
    ...base,
    known: false,
    code,
    message: typeof fallback.message === 'string' && fallback.message !== '' ? fallback.message : '任务链失败，原因未识别。',
    hint: '看 ark_status 的最近事件与 ark_diag(action=logs) 的 MAA 日志；保留截图。',
  };
}

/**
 * 把诊断渲染成一段文本。
 * @param {ReturnType<typeof classifyFailure>} diagnosis - 诊断。
 * @returns {string} 文本。
 */
export function describeDiagnosis(diagnosis) {
  const lines = [`诊断：${diagnosis.code} — ${diagnosis.message}`];
  if (diagnosis.screenshot) lines.push(`截图：${diagnosis.screenshot}`);
  if (Array.isArray(diagnosis.evidence) && diagnosis.evidence.length > 0) {
    lines.push(`证据：${diagnosis.evidence.slice(-5).join('；')}`);
  }
  if (diagnosis.hint) lines.push(`建议：${diagnosis.hint}`);
  return lines.join('\n');
}

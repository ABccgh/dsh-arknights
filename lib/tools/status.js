/**
 * `ark_status`：链路体检 + 账本/日常/仓库/数据摘要（只读，不拉侧车/模拟器）。
 *
 * @module @local/arknights/tools/status
 */

import { defineArkTool } from './shared.js';

/**
 * 造 `ark_status`。
 * @param {{ status: { build: Function } }} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createStatusTools(deps) {
  return [
    defineArkTool({
      name: 'ark_status',
      description:
        '明日方舟链路体检：MAA 版本/资源、Python、adb、模拟器、连接、当前任务链、理智（最后识别）、账本、推关进度、今日日常、仓库/干员快照摘要、数据缓存与最近错误。只读，不会拉起侧车或模拟器；排查任何问题先调它。',
      parameters: {},
      concurrencySafe: true,
      async execute() {
        const object = await deps.status.build();
        return renderStatus(object);
      },
    }),
  ];
}

/**
 * 把状态 JSON 渲染成有界文本。
 * @param {Record<string, any>} object - 状态。
 * @returns {string} 文本。
 */
export function renderStatus(object) {
  const lines = [];
  const sidecar = object.sidecar ?? {};
  const paths = object.paths ?? {};
  const emulator = object.emulator ?? {};
  const connection = object.connection ?? {};
  const sanity = object.sanity ?? {};
  const ledger = object.ledger ?? {};
  const push = object.push ?? {};
  const daily = object.daily ?? {};
  const box = object.box ?? {};
  const data = object.data ?? {};
  const run = object.run ?? null;
  const lastRun = object.lastRun ?? null;

  lines.push(`明日方舟助手（schema ${object.schema ?? 2}）`);
  lines.push(`MAA：${sidecar.coreVersion || '（未启动侧车）'}${sidecar.resourceLoaded ? ' · resource 已加载' : ''}${sidecar.protocolVersion ? ` · 协议 ${sidecar.protocolVersion}` : ''}`);
  lines.push(`Python：${paths.pythonPath || '未找到'} · adb：${paths.adbPath || '未找到'}`);
  lines.push(
    `模拟器：${emulator.managerFound ? (emulator.androidStarted ? '已开机' : '未开机') : '未找到 MuMu'}`
    + ` · adb ${emulator.adbOnline ? '在线' : '离线'}`
    + ` · 端口 ${connection.address || '未知'}`,
  );
  lines.push(`连接：${connection.connected ? '已连接' : '未连接'} · clientType=${connection.clientType || '?'}`);
  if (run !== null) {
    lines.push(`任务：进行中（${run.kind} · ${run.status}${run.phase ? ` · ${run.phase}` : ''}）`);
  } else if (lastRun !== null) {
    lines.push(`任务：空闲 · 最近 ${lastRun.kind} ${lastRun.status}${lastRun.endedAt ? `（${lastRun.endedAt}）` : ''}`);
  } else {
    lines.push('任务：空闲');
  }
  if (Number.isFinite(sanity.current)) {
    lines.push(`理智：${sanity.current}/${sanity.max ?? '?'}${sanity.at ? `（${sanity.at} 识别）` : ''}`);
  } else {
    lines.push('理智：未知（还没识别到；打一关后会更新）');
  }
  lines.push(`账本：满星 ${ledger.fullStar ?? 0} 关 · 未满星 ${ledger.missing ?? 0} 关 · 已领源石 ${ledger.primeClaimed ?? 0} 颗`);
  if (push.nextStage) {
    lines.push(`推关进度：下一次从 ${push.nextStage} 继续（上次停在 ${push.lastStopped || '—'}，原因 ${push.lastReason || '—'}）`);
  }
  if (daily.date) {
    const tasksText = Object.entries(daily.tasks ?? {})
      .map(([name, value]) => `${dailyLabel(name)}${value?.ok === true ? '✓' : '·'}`)
      .join(' ');
    lines.push(`日常：${daily.date} ${tasksText}`);
  }
  if (box.updatedAt) {
    lines.push(`仓库/干员：干员 ${box.operators ?? 0} · 物品 ${box.depotItems ?? 0} · 快照 ${box.updatedAt}${box.partial ? '（部分识别）' : ''}`);
  }
  const dataParts = [];
  if (Number.isFinite(data.stages)) dataParts.push(`关卡 ${data.stages}`);
  if (Number.isFinite(data.items)) dataParts.push(`材料 ${data.items}`);
  if (data.arkrec) dataParts.push(`ArkRec ${data.arkrec.ok ? '正常' : '降级'}`);
  if (data.penguin?.ageMs !== undefined) dataParts.push(`掉率缓存 ${ageText(data.penguin.ageMs)}`);
  if (data.activity?.ageMs !== undefined) dataParts.push(`活动缓存 ${ageText(data.activity.ageMs)}`);
  if (dataParts.length > 0) lines.push(`数据：${dataParts.join(' · ')}`);
  if (object.errors?.lastCode) {
    lines.push(`最近错误：${object.errors.lastCode} — ${object.errors.lastMessage ?? ''}${object.errors.at ? `（${object.errors.at}）` : ''}`);
  }
  if (Array.isArray(object.events) && object.events.length > 0) {
    lines.push('最近事件：');
    for (const event of object.events.slice(-5)) {
      lines.push(`- ${event.name}${event.task ? ` · ${event.task}` : ''}${event.what ? ` · ${event.what}` : ''}`);
    }
  }
  if (object.safety?.confirmRequired) {
    lines.push('确认：需要 confirm=true 的动作不会自动执行；理智药/源石/招聘许可默认被安全闸拒绝。');
  }
  return lines.join('\n');
}

/**
 * 日常任务中文名。
 * @param {string} name - 任务名。
 * @returns {string} 中文。
 */
function dailyLabel(name) {
  switch (name) {
    case 'award': return '签到';
    case 'mall': return '信用';
    case 'infrast': return '基建';
    case 'recruit': return '公招';
    case 'box': return '仓库';
    default: return name;
  }
}

/**
 * 缓存年龄文本。
 * @param {number} ms - 毫秒。
 * @returns {string} 文本。
 */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.round(minutes / 60);
  return `${hours}h 前`;
}

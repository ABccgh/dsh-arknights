/**
 * 视频兜底：把一段作战录屏交给 MAA 的 `VideoRecognition`，再设法拿回它生成的作业 JSON。
 *
 * ⚠️ **best-effort**：MAA 文档只写了 `{"filename": "<视频路径>"}`，没有写作业 JSON 的交付方式，
 * 所以这里按两条路尝试拾取：
 * 1. 回调事件里出现形如 `{stage_name, actions[]}` 的内容；
 * 2. `<userDir>/copilot/`、`<userDir>/debug/`、视频同目录下 `mtime` 晚于开始的 `*.json`。
 * 都拿不到就明确报错，让用户走「MAA GUI 视频识别 → 另存 JSON → file=」这条路。
 *
 * @module @local/arknights/video
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { arkError } from './errors.js';

/** 视频识别最长等待。 */
const VIDEO_TIMEOUT_MS = 20 * 60 * 1000;
/** 扫描候选目录的深度（只扫一层）。 */
const MAX_CANDIDATES = 20;

/**
 * 从任意 JSON 值里挖出一份作业（含 `stage_name` 与 `actions`）。
 * @param {unknown} value - 待检查的值。
 * @param {number} [depth] - 递归深度。
 * @returns {Record<string, any> | null} 作业对象。
 */
export function extractCopilot(value, depth = 0) {
  if (value === null || value === undefined || depth > 3) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
      return extractCopilot(JSON.parse(text), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_CANDIDATES)) {
      const hit = extractCopilot(item, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (value);
  if (typeof record.stage_name === 'string' && (Array.isArray(record.actions) || Array.isArray(record.groups))) {
    return record;
  }
  for (const item of Object.values(record)) {
    const hit = extractCopilot(item, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 从事件缓冲里找作业。
 * @param {any} state - 状态容器（`recentEvents(limit, {withDetails:true})`）。
 * @returns {{ content: Record<string, any>, source: string } | null} 结果。
 */
export function findCopilotInEvents(state) {
  const events = typeof state?.recentEvents === 'function' ? state.recentEvents(300, { withDetails: true }) : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const hit = extractCopilot(event?.details);
    if (hit !== null) return { content: hit, source: `事件 ${event?.name ?? '?'}${event?.what ? `/${event.what}` : ''}` };
  }
  return null;
}

/**
 * 在候选目录里找「开始之后新写入」的作业 JSON。
 * @param {string[]} dirs - 候选目录。
 * @param {number} sinceMs - 只接受 mtime 晚于这个时间戳的文件。
 * @returns {Promise<{ content: Record<string, any>, source: string } | null>} 结果。
 */
export async function findNewCopilotFile(dirs, sinceMs) {
  for (const dir of dirs) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (!fileName.toLowerCase().endsWith('.json')) continue;
      const file = path.join(dir, fileName);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < sinceMs) continue;
        const raw = await fsp.readFile(file, 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        const hit = extractCopilot(parsed);
        if (hit !== null) return { content: hit, source: `文件 ${file}` };
      } catch {
        // 坏文件/读不到就跳过
      }
    }
  }
  return null;
}

/**
 * 跑一次视频识别并拿回作业。
 * @param {{ videoPath: string, paths: { userDir: string }, session: any, state: any, waitForIdle: Function }} input
 *   运行期依赖。
 * @returns {Promise<Record<string, any>>} `{file, contentRaw, stageName, opers, source}`。
 * @throws {ArkError} 视频不存在 / MAA 拒绝 / 拿不到作业时。
 */
export async function recognizeVideo(input) {
  const { videoPath, paths, session, state, waitForIdle } = input;
  const absolute = path.resolve(String(videoPath ?? ''));
  try {
    await fsp.access(absolute);
  } catch {
    throw arkError('E_BAD_ARGS', `视频文件不存在：${absolute}`, {
      hint: '传本地作战录屏的绝对路径；MAA 的视频识别只支持「作战」视频。',
    });
  }
  const since = Date.now() - 1000;
  const dirs = [
    path.join(paths.userDir, 'copilot'),
    path.join(paths.userDir, 'debug'),
    path.dirname(absolute),
  ];

  state.resetChain();
  session.hold();
  try {
    const appended = await session.request('append', {
      type: 'VideoRecognition',
      params: { filename: absolute },
    });
    if (!Number.isFinite(appended.taskId) || appended.taskId <= 0) {
      throw arkError('E_TASK_TYPE', 'MAA 不接受 VideoRecognition 任务（视频路径或格式不对）。', {
        hint: '确认是本地 mp4 作战录屏；MAA 目前只支持作业视频。',
      });
    }
    await session.request('start', {}, { timeoutMs: 15000 });
    const waited = await waitForIdle({
      timeoutMs: VIDEO_TIMEOUT_MS,
      shouldAbort: () => (state.getChains().some((chain) => chain.status === 'error') ? 'chain-error' : null),
    });
    if (waited.timedOut) {
      await session.request('stop', {}, { timeoutMs: 15000 }).catch(() => {});
      throw arkError('E_TIMEOUT', `视频识别超过 ${Math.round(VIDEO_TIMEOUT_MS / 60000)} 分钟还没结束。`);
    }
    const fromEvents = findCopilotInEvents(state);
    const found = fromEvents ?? await findNewCopilotFile(dirs, since);
    if (found === null) {
      throw arkError('E_NO_SOLUTION', '视频识别跑完了，但没能拿回它生成的作业 JSON。', {
        hint: 'MAA 没有把作业交给这个接口。请在 MAA 主程序里做「视频识别」并另存为 JSON，然后用 file=<路径> 传给 ark_fight。',
      });
    }
    const contentRaw = JSON.stringify(found.content);
    const opers = Array.isArray(found.content.opers)
      ? found.content.opers.map((oper) => (typeof oper?.name === 'string' ? oper.name : '')).filter((name) => name !== '')
      : [];
    // 落到自己的作业缓存里，交给 Copilot 执行路径
    const dir = path.join(paths.userDir, 'copilot');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `video-${Date.now()}.json`);
    await fsp.writeFile(file, contentRaw, 'utf8');
    return {
      file,
      contentRaw,
      stageName: typeof found.content.stage_name === 'string' ? found.content.stage_name : '',
      opers,
      source: found.source,
      title: '视频识别结果',
    };
  } finally {
    session.release();
  }
}

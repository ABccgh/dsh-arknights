/**
 * 与 Python 侧车的 NDJSON 线路协议（契约见 docs/contracts.md §2）。
 *
 * 只有两种行：**响应**（带 `id`）与**事件**（带 `event`）。
 * 解析失败必须是硬错误：调用方会杀掉侧车并透明重启，绝不猜测半截 JSON。
 *
 * @module @local/arknights/protocol
 */

import { arkError } from './errors.js';

/** 单行上限：作业 JSON 不经过这里的 stdout，正常响应都远小于 1 MiB。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 造一条请求。
 * @param {number} id - 请求 id（正整数，单调递增）。
 * @param {string} op - 操作名。
 * @param {Record<string, unknown>} [args] - 参数。
 * @returns {{ id: number, op: string, args: Record<string, unknown> }} 请求对象。
 */
export function makeRequest(id, op, args = {}) {
  if (!Number.isInteger(id) || id <= 0) throw arkError('E_BAD_OP', `请求 id 必须是正整数，收到 ${String(id)}。`);
  if (typeof op !== 'string' || op === '') throw arkError('E_BAD_OP', '请求缺少 op。');
  const safeArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return { id, op, args: safeArgs };
}

/**
 * 序列化成一行（不带换行；调用方负责补 `\n`）。
 * @param {unknown} message - 任意可 JSON 化的对象。
 * @returns {string} 单行 JSON。
 */
export function encodeLine(message) {
  let text;
  try {
    text = JSON.stringify(message);
  } catch (error) {
    throw arkError('E_PROTOCOL', '请求无法编码成 JSON。', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof text !== 'string') throw arkError('E_PROTOCOL', '请求无法编码成 JSON。');
  return text;
}

/**
 * 解析一行。
 * @param {string} line - 去掉换行的一行文本。
 * @returns {{ kind: 'response', id: number, ok: boolean, result?: unknown, error?: object }
 *   | { kind: 'event', event: string, payload: Record<string, unknown> }} 归类后的消息。
 * @throws {ArkError} 不是合法 JSON 对象、或既无 id 又无 event 时。
 */
export function decodeLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (text === '') throw arkError('E_PROTOCOL', '侧车输出了空行。');
  if (text.length > MAX_LINE_BYTES) throw arkError('E_PROTOCOL', '侧车单行输出异常过长。');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw arkError('E_PROTOCOL', '侧车输出不是合法 JSON。', {
      detail: `${error instanceof Error ? error.message : String(error)}；原始行前 200 字：${text.slice(0, 200)}`,
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw arkError('E_PROTOCOL', '侧车输出不是 JSON 对象。');
  }
  if (Number.isInteger(value.id)) {
    return {
      kind: 'response',
      id: value.id,
      ok: value.ok === true,
      result: value.result,
      error: value.error === undefined ? undefined : value.error,
    };
  }
  if (typeof value.event === 'string' && value.event !== '') {
    const { event, ...payload } = value;
    return { kind: 'event', event, payload };
  }
  throw arkError('E_PROTOCOL', '侧车输出既没有 id 也没有 event。', { detail: text.slice(0, 200) });
}

/**
 * 取出响应里的 `result` 对象；不是对象就报协议错。
 * @param {{ ok: boolean, result?: unknown, error?: object }} response - 解析后的响应。
 * @param {string} op - 用于错误消息。
 * @returns {Record<string, any>} result。
 */
export function readResult(response, op) {
  if (response.ok !== true) return {};
  const result = response.result;
  if (result === undefined || result === null) return {};
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw arkError('E_PROTOCOL', `侧车对 ${op} 的 result 不是对象。`);
  }
  return result;
}

/**
 * 校验 `ready` 事件（进程起来了但还没 init）。
 * @param {Record<string, unknown>} payload - 事件负载。
 * @returns {{ sidecarVersion: string, python: string }} 精简结果。
 * @throws {ArkError} 版本不匹配时。
 */
export function validateReady(payload) {
  const sidecarVersion = typeof payload.sidecarVersion === 'string' ? payload.sidecarVersion : '';
  if (sidecarVersion === '') throw arkError('E_PROTOCOL', 'ready 事件缺少 sidecarVersion。');
  return {
    sidecarVersion,
    python: typeof payload.python === 'string' ? payload.python : '',
  };
}

/**
 * 校验 `init` 的结果。
 * @param {Record<string, any>} result - 侧车返回。
 * @returns {{ coreVersion: string, resourceLoaded: boolean }} 精简结果。
 * @throws {ArkError} 资源没加载成功时。
 */
export function validateInitResult(result) {
  const coreVersion = typeof result.coreVersion === 'string' ? result.coreVersion : '';
  if (coreVersion === '') throw arkError('E_MAA_LOAD', 'init 没有返回 MaaCore 版本。');
  if (result.resourceLoaded !== true) {
    throw arkError('E_MAA_LOAD', 'MaaCore 资源加载失败（AsstLoadResource 返回 false）。');
  }
  return { coreVersion, resourceLoaded: true };
}

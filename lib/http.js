/**
 * 面板用的两个 HTTP 端点：`/arknights/status`、`/arknights/query`、`/arknights/action`。
 *
 * 只绑定本机（由 DSH webServer 决定）；不返回任何凭据。
 * 状态/查询路由只读，绝不启动 sidecar/模拟器。
 *
 * @module @local/arknights/http
 */

import { arkError, describeError, normalizeError } from './errors.js';

/** 请求体上限。 */
const MAX_BODY = 64 * 1024;

/**
 * 把错误收成可 JSON 化的负载。
 * @param {unknown} error - 错误。
 * @returns {{code:string,message:string,hint?:string,detail?:string}} 负载。
 */
function errorPayload(error) {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(normalized.detail ? { detail: normalized.detail } : {}),
  };
}

/**
 * 读请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} [limit] - 上限。
 * @returns {Promise<string>} 文本。
 */
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(arkError('E_BAD_ARGS', '请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(normalizeError(error)));
  });
}

/**
 * 挂上路由。
 * @param {{ config: Record<string, any>, status: { build: Function }, actions: { start: Function, status?: Function },
 *   query: (input: Record<string, any>) => Promise<Record<string, any>>,
 *   logger?: any }} deps - 依赖。
 * @returns {(webServer: any) => Array<() => void>} 注册函数。
 */
export function createHttp(deps) {
  const { config, status, actions, query, logger } = deps;

  /**
   * 发 JSON。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} code - 状态码。
   * @param {Record<string, any>} payload - 负载。
   * @returns {void}
   */
  const json = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };

  /**
   * 注册全部路由。
   * @param {any} webServer - DSH webServer 服务。
   * @returns {Array<() => void>} disposers。
   */
  const register = (webServer) => {
    if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return [];
    const disposers = [];

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/arknights/status',
      handler: async (req, res) => {
        try {
          const object = await status.build({ refreshEmulator: true });
          json(res, 200, object);
        } catch (error) {
          json(res, 500, { ok: false, error: errorPayload(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/arknights/query',
      handler: async (req, res) => {
        try {
          const url = new URL(String(req.url ?? ''), 'http://127.0.0.1');
          const kind = (url.searchParams.get('kind') ?? '').trim();
          if (kind === '') throw arkError('E_BAD_ARGS', '缺少 kind。');
          const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
          const result = await query({
            kind,
            q: url.searchParams.get('q') ?? '',
            limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
            refresh: url.searchParams.get('refresh') === '1',
            target: url.searchParams.get('target') ?? '',
            targets: url.searchParams.get('targets') ?? '',
          });
          json(res, 200, { ok: true, kind, ...result });
        } catch (error) {
          const normalized = normalizeError(error);
          json(res, normalized.code === 'E_BAD_ARGS' ? 400 : 500, { ok: false, error: normalized });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/arknights/action',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: { code: 'E_BAD_ARGS', message: '只接受 POST。' } });
            return;
          }
          const raw = await readBody(req);
          let payload;
          try {
            payload = raw === '' ? {} : JSON.parse(raw);
          } catch {
            json(res, 400, { ok: false, error: { code: 'E_BAD_ARGS', message: '请求体不是合法 JSON。' } });
            return;
          }
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            json(res, 400, { ok: false, error: { code: 'E_BAD_ARGS', message: '请求体必须是对象。' } });
            return;
          }
          const result = await actions.start(payload);
          json(res, 200, result);
        } catch (error) {
          const normalized = normalizeError(error);
          const code = normalized.code === 'E_BUSY'
            ? 409
            : ['E_BAD_ARGS', 'E_ACTION_UNKNOWN', 'E_CONFIRM_REQUIRED'].includes(normalized.code)
              ? 400
              : normalized.code === 'E_UNSAFE_RESOURCE'
                ? 403
                : 500;
          json(res, code, { ok: false, error: normalized });
          logger?.warn?.(`[arknights] action 失败：${describeError(normalized)}`);
        }
      },
    }));

    return disposers;
  };

  return { register };
}

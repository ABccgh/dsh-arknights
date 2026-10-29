/**
 * lib/http.js 单元测试：路由注册、查询参数、动作校验与错误映射。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createHttp, readBody } from '../lib/http.js';
import { arkError } from '../lib/errors.js';
import { normalizeConfig } from '../lib/config.js';

/**
 * 假 webServer。
 * @returns {{routes:Array<any>, register: Function}} server。
 */
function makeServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/**
 * 假请求。
 * @param {{url?:string,method?:string,body?:string}} [input] - 输入。
 * @returns {any} 请求。
 */
function makeReq(input = {}) {
  const req = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)]);
  req.url = input.url ?? '/';
  req.method = input.method ?? 'GET';
  return req;
}

/**
 * 假响应。
 * @returns {any} 响应。
 */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk = '') {
      res.body += String(chunk);
      return res;
    },
  };
  return res;
}

/**
 * 调路由。
 * @param {any} route - 路由。
 * @param {{url?:string,method?:string,body?:string}} [input] - 输入。
 * @returns {Promise<any>} 响应。
 */
async function call(route, input = {}) {
  const res = makeRes();
  await route.handler(makeReq(input), res);
  return res;
}

/**
 * 造 HTTP 依赖。
 * @param {{ actions?: any, query?: any, status?: any }} [overrides] - 覆盖。
 * @returns {any} 依赖。
 */
function makeDeps(overrides = {}) {
  return {
    config: normalizeConfig(),
    status: overrides.status ?? {
      build: async () => ({ ok: true, schema: 2, ts: 'x', box: { operators: 0 } }),
    },
    actions: overrides.actions ?? {
      start: async (payload) => ({ ok: true, runId: 'run-1', started: true, text: `action:${payload.action}` }),
    },
    query: overrides.query ?? (async (input) => ({ items: [{ input }] })),
  };
}

/**
 * 找到某个路径的路由。
 * @param {any} server - server。
 * @param {string} path - 路径。
 * @returns {any} 路由。
 */
function routeOf(server, path) {
  return server.routes.find((route) => route.path === path);
}

test('http: 注册三个端点；dispose 移除', () => {
  const server = makeServer();
  const disposers = createHttp(makeDeps()).register(server);
  assert.equal(server.routes.length, 3);
  assert.deepEqual(server.routes.map((route) => route.path).sort(), ['/arknights/action', '/arknights/query', '/arknights/status']);
  for (const dispose of disposers) dispose();
  assert.equal(server.routes.length, 0);
});

test('http: status 路由返回 JSON', async () => {
  const server = makeServer();
  createHttp(makeDeps()).register(server);
  const res = await call(routeOf(server, '/arknights/status'), { url: '/arknights/status' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.schema, 2);
});

test('http: status 路由错误转 500 JSON', async () => {
  const server = makeServer();
  createHttp(makeDeps({ status: { build: async () => { throw arkError('E_MAA_LOAD', '加载失败', { hint: '先开 MAA' }); } } })).register(server);
  const res = await call(routeOf(server, '/arknights/status'), { url: '/arknights/status' });
  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_MAA_LOAD');
  assert.equal(body.error.hint, '先开 MAA');
});

test('http: query 透传参数并包装 {ok,kind}', async () => {
  const calls = [];
  const server = makeServer();
  createHttp(makeDeps({ query: async (input) => { calls.push(input); return { items: [1, 2], total: 2 }; } })).register(server);
  const res = await call(routeOf(server, '/arknights/query'), {
    url: '/arknights/query?kind=stage&q=1-7&limit=5&refresh=1&target=both&targets=a',
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.kind, 'stage');
  assert.deepEqual(body.items, [1, 2]);
  assert.equal(body.total, 2);
  assert.deepEqual(calls[0], {
    kind: 'stage',
    q: '1-7',
    limit: 5,
    refresh: true,
    target: 'both',
    targets: 'a',
  });
});

test('http: query 缺 kind / 异常的错误码', async () => {
  const server = makeServer();
  createHttp(makeDeps({ query: async ({ kind }) => { if (kind === 'boom') throw new Error('炸了'); return {}; } })).register(server);
  const missing = await call(routeOf(server, '/arknights/query'), { url: '/arknights/query' });
  assert.equal(missing.statusCode, 400);
  assert.equal(JSON.parse(missing.body).error.code, 'E_BAD_ARGS');
  const boom = await call(routeOf(server, '/arknights/query'), { url: '/arknights/query?kind=boom' });
  assert.equal(boom.statusCode, 500);
  assert.equal(JSON.parse(boom.body).error.code, 'E_UNDEFINED');
});

test('http: action 只接受 POST / 合法 JSON / 对象', async () => {
  const server = makeServer();
  createHttp(makeDeps()).register(server);
  const route = routeOf(server, '/arknights/action');
  const get = await call(route, { url: '/arknights/action', method: 'GET' });
  assert.equal(get.statusCode, 405);
  const bad = await call(route, { url: '/arknights/action', method: 'POST', body: '{' });
  assert.equal(bad.statusCode, 400);
  const array = await call(route, { url: '/arknights/action', method: 'POST', body: '[]' });
  assert.equal(array.statusCode, 400);
});

test('http: action 透传 payload 并返回 actions.start 结果', async () => {
  const calls = [];
  const server = makeServer();
  createHttp(makeDeps({ actions: { start: async (payload) => { calls.push(payload); return { ok: true, runId: 'run-9', text: 'ok' }; } } })).register(server);
  const res = await call(routeOf(server, '/arknights/action'), {
    url: '/arknights/action',
    method: 'POST',
    body: JSON.stringify({ action: 'fight', stages: '1-7', confirm: true }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).runId, 'run-9');
  assert.deepEqual(calls[0], { action: 'fight', stages: '1-7', confirm: true });
});

test('http: action 错误映射（E_BUSY 409 / E_UNSAFE_RESOURCE 403 / E_ACTION_UNKNOWN 400 / 其它 500）', async () => {
  for (const [code, expected] of [
    ['E_BUSY', 409],
    ['E_UNSAFE_RESOURCE', 403],
    ['E_ACTION_UNKNOWN', 400],
    ['E_BAD_ARGS', 400],
    ['E_MAA_LOAD', 500],
  ]) {
    const server = makeServer();
    createHttp(makeDeps({ actions: { start: async () => { throw arkError(code, 'x'); } } })).register(server);
    const res = await call(routeOf(server, '/arknights/action'), {
      url: '/arknights/action',
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    });
    assert.equal(res.statusCode, expected, code);
    assert.equal(JSON.parse(res.body).error.code, code);
  }
});

test('http: readBody 超限拒绝', async () => {
  const req = makeReq({ body: 'x'.repeat(100) });
  await assert.rejects(readBody(req, 10), (error) => error.code === 'E_BAD_ARGS');
});

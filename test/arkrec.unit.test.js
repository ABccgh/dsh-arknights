/**
 * lib/arkrec.js 单元测试：关卡树展平、请求降级（注入假 fetch，不联网）、内存/磁盘缓存。
 * 契约：lib/arkrec.js JSDoc（任何失败都必须降级成 null，绝不影响打关卡）。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArkrec } from '../lib/arkrec.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读 fixture。 */
async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(here, 'fixtures', name), 'utf8'));
}

/** 造一个按 URL 路由的假 fetch；`calls` 记录请求过的 URL。 */
function makeRouterFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    for (const [fragment, handler] of routes) {
      if (text.includes(fragment)) return handler(text);
    }
    throw new Error(`假 fetch 没有为 ${text} 准备响应`);
  };
  return { fetchImpl, calls };
}

/** 成功的 JSON 响应。 */
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** 少人纪录 fixture（真实接口是分组数组）。 */
const HARD_OPERATIONS = [
  {
    name: '少人',
    value: [
      { operation: '5-10', num: '4' },
      { operation: '5-11', num: '2' },
      { operation: '5-10', num: '3' },
    ],
  },
];

test('arkrec: flattenMenu 把 fixture 关卡树展平成 code → 信息', async () => {
  const menu = await readFixture('arkrec-menu.sample.json');
  const client = createArkrec({ api: 'https://api.test' });
  const table = client.flattenMenu(menu);

  assert.deepEqual(table['5-10'], {
    code: '5-10',
    cn_name: '长夜终尽',
    en_name: '5-10',
    challenge: '',
    story: '主线关卡',
    group: '第5章 长夜终尽',
  });
  assert.equal(table['5-11'].challenge, '不能使用重装');
  assert.equal(table['10-09'].group, '第10章 破碎日冕');
  assert.equal(table['CW-1'].story, '活动关卡');
  assert.equal(table['CW-1'].group, 'CW');
  // 重复出现的 operation 只保留第一次
  assert.equal(table['5-10'].cn_name, '长夜终尽');
  assert.equal(Object.keys(table).length, 4);
});

test('arkrec: flattenMenu 对坏输入返回空对象', () => {
  const client = createArkrec({ api: 'https://api.test' });
  assert.deepEqual(client.flattenMenu(null), {});
  assert.deepEqual(client.flattenMenu(undefined), {});
  assert.deepEqual(client.flattenMenu({}), {});
  assert.deepEqual(client.flattenMenu({ childNodes: 'nope' }), {});
  assert.deepEqual(client.flattenMenu([]), {});
});

test('arkrec: flattenMenu 跳过非字符串字段', () => {
  const client = createArkrec({ api: 'https://api.test' });
  const table = client.flattenMenu({
    childNodes: [{ story: '主线关卡', childNodes: [{ operation: 'X-1', cn_name: 42, en_name: null }] }],
  });
  assert.deepEqual(table['X-1'], { code: 'X-1', cn_name: '', en_name: '', challenge: '', story: '主线关卡', group: '' });
});

test('arkrec: loadStages 用 /api/menu 填充并缓存在内存', async () => {
  const menu = await readFixture('arkrec-menu.sample.json');
  const { fetchImpl, calls } = makeRouterFetch([['/api/menu', () => jsonResponse(menu)]]);
  const client = createArkrec({ api: 'https://api.test/v1', fetchImpl, cacheTtlHours: 168 });

  const first = await client.loadStages();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://api.test/v1/api/menu');
  assert.equal(first['5-10'].cn_name, '长夜终尽');

  const second = await client.loadStages();
  assert.equal(second, first, '第二次必须直接复用内存缓存');
  assert.equal(calls.length, 1);
});

test('arkrec: loadHardOperations 解析少人纪录并取最小值', async () => {
  const { fetchImpl, calls } = makeRouterFetch([['/api/hard-operations', () => jsonResponse(HARD_OPERATIONS)]]);
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  const hard = await client.loadHardOperations();
  assert.equal(calls.length, 1);
  assert.deepEqual(hard['5-10'], { minOperators: 3, categories: ['少人'] });
  assert.deepEqual(hard['5-11'], { minOperators: 2, categories: ['少人'] });
  assert.equal(await client.loadHardOperations(), hard);
  assert.equal(calls.length, 1);
});

test('arkrec: loadHardOperations 对非数组响应返回 null', async () => {
  const { fetchImpl } = makeRouterFetch([['/api/hard-operations', () => jsonResponse({ nope: true })]]);
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  assert.equal(await client.loadHardOperations(), null);
});

test('arkrec: describe 合并关卡树与少人纪录', async () => {
  const menu = await readFixture('arkrec-menu.sample.json');
  const { fetchImpl, calls } = makeRouterFetch([
    ['/api/menu', () => jsonResponse(menu)],
    ['/api/hard-operations', () => jsonResponse(HARD_OPERATIONS)],
  ]);
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  const info = await client.describe('5-10');
  assert.equal(info.cn_name, '长夜终尽');
  assert.equal(info.en_name, '5-10');
  assert.equal(info.challenge, '');
  assert.equal(info.story, '主线关卡');
  assert.equal(info.group, '第5章 长夜终尽');
  assert.equal(info.minOperators, 3);
  assert.equal(info.url, 'https://wiki.arkrec.com/operation/5-10');
  assert.equal(calls.length, 2);

  // 表已缓存：未知关卡不再发请求，返回 null。
  assert.equal(await client.describe('NOPE-99'), null);
  assert.equal(calls.length, 2);
});

test('arkrec: describe 空/未知代码返回 null', async () => {
  const menu = await readFixture('arkrec-menu.sample.json');
  const { fetchImpl, calls } = makeRouterFetch([
    ['/api/menu', () => jsonResponse(menu)],
    ['/api/hard-operations', () => jsonResponse(HARD_OPERATIONS)],
  ]);
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  assert.equal(await client.describe(''), null);
  assert.equal(await client.describe('   '), null);
  assert.equal(calls.length, 0, '空代码不应发任何请求');

  const unknown = await client.describe('CW-999');
  assert.equal(unknown, null);
  assert.equal(calls.length, 2);
});

test('arkrec: 请求失败时 describe 降级为 null，绝不抛出', async () => {
  const warnings = [];
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const client = createArkrec({ api: 'https://api.test', fetchImpl, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(await client.describe('5-10'), null);
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join('\n'), /network down/);
});

test('arkrec: HTTP 非 2xx 也降级为 null', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  assert.equal(await client.loadStages(), null);
  assert.equal(await client.describe('5-10'), null);
});

test('arkrec: 磁盘缓存可用时不发网络请求', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-arkrec-'));
  try {
    const menu = await readFixture('arkrec-menu.sample.json');
    const first = makeRouterFetch([['/api/menu', () => jsonResponse(menu)]]);
    const writer = createArkrec({ api: 'https://api.test', cacheDir: directory, fetchImpl: first.fetchImpl });
    const stages = await writer.loadStages();
    assert.equal(first.calls.length, 1);
    // 缓存文件确实写出来了
    const cachedRaw = JSON.parse(await fs.readFile(path.join(directory, 'menu.json'), 'utf8'));
    assert.equal(typeof cachedRaw.fetchedAt, 'number');
    assert.equal(cachedRaw.stages['5-10'].cn_name, '长夜终尽');

    const second = makeRouterFetch([]);
    const reader = createArkrec({ api: 'https://api.test', cacheDir: directory, fetchImpl: second.fetchImpl });
    const cached = await reader.loadStages();
    assert.equal(second.calls.length, 0, '磁盘缓存命中时不应再请求网络');
    assert.deepEqual(cached, stages);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('arkrec: 磁盘缓存过期后重新请求', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-arkrec-'));
  try {
    const menu = await readFixture('arkrec-menu.sample.json');
    await fs.writeFile(path.join(directory, 'menu.json'), JSON.stringify({ fetchedAt: 0, stages: { OLD: { code: 'OLD' } } }), 'utf8');
    const { fetchImpl, calls } = makeRouterFetch([['/api/menu', () => jsonResponse(menu)]]);
    const client = createArkrec({ api: 'https://api.test', cacheDir: directory, cacheTtlHours: 1, fetchImpl });
    const stages = await client.loadStages();
    assert.equal(calls.length, 1);
    assert.equal('OLD' in stages, false);
    assert.equal(stages['5-10'].cn_name, '长夜终尽');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('arkrec: warmup 不抛错也不阻塞', async () => {
  const fetchImpl = async () => {
    throw new Error('down');
  };
  const client = createArkrec({ api: 'https://api.test', fetchImpl });
  assert.doesNotThrow(() => client.warmup());
  await new Promise((resolve) => setTimeout(resolve, 50));
});

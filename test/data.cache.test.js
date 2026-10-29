/**
 * lib/data/cache.js 单元测试：TTL、原子写、key 清洗、损坏回退、旧缓存降级、
 * 注入时钟/网络/超时。全部离线，不碰真实网络与文件系统之外的任何东西。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createJsonCache,
  fetchJson,
  formatAge,
  normalizeTtlMs,
  sanitizeCacheKey,
  shortHash,
  ttlMsFromHours,
} from '../lib/data/cache.js';
import { ArkError } from '../lib/errors.js';

/** @type {string[]} */
const dirs = [];

/** 建一个测试临时目录。 */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-cache-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: sanitizeCacheKey 不允许路径逃逸/非法字符，且不同 key 不互相覆盖', () => {
  assert.equal(sanitizeCacheKey('matrix-CN-30012'), 'matrix-CN-30012');
  const traversal = sanitizeCacheKey('../../evil');
  assert.equal(traversal.includes('/'), false);
  assert.equal(traversal.includes('..'), false);
  assert.equal(traversal.includes('\\'), false);
  const a = sanitizeCacheKey('a/b');
  const b = sanitizeCacheKey('a_b');
  assert.notEqual(a, b, '清洗后仍要能区分不同 key');
  assert.ok(a.length <= 64 + 10);
  assert.equal(sanitizeCacheKey(''), '_');
  assert.equal(sanitizeCacheKey('中文 key').includes('/'), false);
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
});

test('cache: 纯内存模式 + 注入时钟实现 TTL', async () => {
  let clock = 1000;
  const cache = createJsonCache({ ttlMs: 500, now: () => clock });
  let calls = 0;
  const producer = async () => {
    calls += 1;
    return { value: calls };
  };
  const first = await cache.remember('k', producer);
  assert.equal(first.data.value, 1);
  assert.equal(first.fromCache, false);
  const second = await cache.remember('k', producer);
  assert.equal(second.data.value, 1);
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1);
  clock += 600;
  const third = await cache.remember('k', producer);
  assert.equal(third.data.value, 2);
  assert.equal(calls, 2);
  // fresh=true 跳过缓存
  const fourth = await cache.remember('k', producer, { fresh: true });
  assert.equal(fourth.data.value, 3);
  assert.equal(calls, 3);
});

test('cache: 落盘是原子写（没有残留 .tmp，封装可解析）', async () => {
  const dir = tempDir();
  const cache = createJsonCache({ dir, ttlMs: 60000 });
  const written = await cache.write('matrix-CN-30012', { hello: '世界' });
  assert.ok(written !== null);
  const files = await fsp.readdir(dir);
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
  assert.deepEqual(files, ['matrix-CN-30012.json']);
  const raw = JSON.parse(await fsp.readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.data, { hello: '世界' });
  assert.equal(Number.isFinite(raw.fetchedAt), true);
  const read = await cache.read('matrix-CN-30012');
  assert.deepEqual(read.data, { hello: '世界' });
  assert.equal(Number.isFinite(read.ageMs), true);
});

test('cache: 损坏文件当未命中，改名为 .corrupt-*，并重新拉取', async () => {
  const dir = tempDir();
  const warnings = [];
  const cache = createJsonCache({ dir, ttlMs: 60000, logger: { warn: (message) => warnings.push(String(message)) } });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'menu.json'), '{not json', 'utf8');
  assert.equal(await cache.read('menu'), null);
  const files = await fsp.readdir(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].startsWith('menu.json.corrupt-'), true);
  assert.equal(warnings.length >= 1, true);
  const result = await cache.remember('menu', async () => ({ ok: true }));
  assert.deepEqual(result.data, { ok: true });
});

test('cache: mtime 之外还有「结构不合法」的损坏分支', async () => {
  const dir = tempDir();
  const cache = createJsonCache({ dir });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'x.json'), JSON.stringify({ noFetchedAt: true }), 'utf8');
  assert.equal(await cache.read('x'), null);
});

test('cache: 刷新失败时用旧缓存降级（stale:true），没有旧缓存则 data:null 不抛', async () => {
  const dir = tempDir();
  let clock = 1000;
  const cache = createJsonCache({ dir, ttlMs: 100, now: () => clock });
  await cache.write('matrix', { old: true });
  clock = 5000;
  const stale = await cache.remember('matrix', async () => {
    throw new Error('网络断了');
  });
  assert.deepEqual(stale.data, { old: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.fromCache, true);
  assert.match(String(stale.error?.message), /网络断了/);

  const empty = await cache.remember('missing', async () => {
    throw new Error('还是断的');
  });
  assert.equal(empty.data, null);
  assert.equal(empty.stale, false);
  assert.equal(empty.error instanceof Error, true);

  const nullProducer = await cache.remember('missing-2', async () => null);
  assert.equal(nullProducer.data, null);
  assert.equal(nullProducer.error?.code, 'E_DATA_UNAVAILABLE');
});

test('cache: 固定单文件模式（活动日历用）', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'activity.json');
  const cache = createJsonCache({ file, ttlMs: 60000 });
  await cache.write('ignored-key', { activities: [] });
  const read = await cache.read('another-key');
  assert.deepEqual(read.data, { activities: [] });
  assert.equal(cache.fileForKey('anything'), file);
});

test('cache: ttlMsFromHours / normalizeTtlMs / formatAge', () => {
  assert.equal(ttlMsFromHours(6), 6 * 3600000);
  assert.equal(ttlMsFromHours(undefined, 168), 168 * 3600000);
  assert.equal(ttlMsFromHours(-1, 6), 6 * 3600000);
  assert.equal(normalizeTtlMs(undefined), 0);
  assert.equal(normalizeTtlMs(500), 500);
  assert.equal(formatAge(0), '刚刚');
  assert.match(formatAge(5000), /秒前/);
  assert.match(formatAge(120000), /分钟前/);
  assert.match(formatAge(7200000), /小时前/);
  assert.match(formatAge(172800000), /天前/);
  assert.equal(formatAge(null), '未知');
});

test('cache: fetchJson 成功/HTTP 错误/非 JSON/超时都收成 ArkError(E_DATA_UNAVAILABLE)', async () => {
  const ok = await fetchJson('https://example.test/data', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }),
  });
  assert.deepEqual(ok, { hello: 1 });

  await assert.rejects(
    fetchJson('https://example.test/data', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_DATA_UNAVAILABLE');
      assert.match(error.message, /HTTP 503/);
      return true;
    },
  );

  await assert.rejects(
    fetchJson('https://example.test/data', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }),
    }),
    (error) => error.code === 'E_DATA_UNAVAILABLE' && /合法 JSON/.test(error.message),
  );

  await assert.rejects(
    fetchJson('https://example.test/data', {
      fetchImpl: async (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
      timeoutMs: 20,
    }),
    (error) => error.code === 'E_DATA_UNAVAILABLE' && /超时/.test(error.message),
  );

  await assert.rejects(fetchJson('', {}), (error) => error.code === 'E_DATA_UNAVAILABLE');
});

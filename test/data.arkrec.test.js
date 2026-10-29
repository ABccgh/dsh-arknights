/**
 * lib/data/arkrec.js 单元测试：menu 展平、少人纪录聚合、TTL 缓存、失败降级（null/旧缓存）。
 * 全部离线：fetchImpl 由夹具驱动，缓存写在临时目录。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArkrecData, flattenHardOperations, flattenMenu } from '../lib/data/arkrec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');

/** @type {string[]} */
const dirs = [];

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-arkrec-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个按 URL 返回夹具的假 fetch，并记录调用次数。 */
function makeFetch(options = {}) {
  const menu = readFixture('arkrec-menu.sample.json');
  const hard = readFixture('arkrec-hard-operations.sample.json');
  const calls = [];
  let fail = options.fail === true;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('网络不可用');
    const body = String(url).includes('/api/hard-operations') ? hard : menu;
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    fetchImpl,
    calls,
    setFail(value) {
      fail = value;
    },
  };
}

test('arkrec: flattenMenu 展平 code → 中文名/分组，重复 code 只留第一次', () => {
  const menu = flattenMenu(readFixture('arkrec-menu.sample.json'));
  assert.deepEqual(Object.keys(menu).sort(), ['5-10', '5-9', 'CE-1', 'CW-1'].sort());
  assert.equal(menu['5-10'].cn_name, '长夜终尽', '重复的 5-10 应保留第一次（主线）');
  assert.equal(menu['5-10'].story, '主线关卡');
  assert.equal(menu['5-10'].group, '第5章 长夜终尽');
  assert.equal(menu['5-9'].challenge, '不能使用重装');
  assert.equal(menu['CW-1'].group, 'CW');
  assert.deepEqual(flattenMenu(null), {});
  assert.deepEqual(flattenMenu({ childNodes: [null, { story: 'x' }] }), {});
});

test('arkrec: flattenHardOperations 聚合最少人数与分类', () => {
  const table = flattenHardOperations(readFixture('arkrec-hard-operations.sample.json'));
  assert.equal(table['5-10'].minOperators, 2);
  assert.deepEqual(table['5-10'].categories, ['常规队', '精一1级']);
  assert.equal(table['CW-1'].minOperators, 4);
  assert.equal(table['CE-1'].minOperators, 2);
  assert.deepEqual(flattenHardOperations(null), {});
});

test('arkrec: load/get 走缓存，TTL 内不再联网；get 给出中文名/少人/链接', async () => {
  const fake = makeFetch();
  let clock = 1000;
  const client = createArkrecData({ cacheDir: tempDir(), now: () => clock, fetchImpl: fake.fetchImpl });
  const first = await client.get('5-10');
  assert.equal(first.cn_name, '长夜终尽');
  assert.equal(first.challenge, '');
  assert.equal(first.group, '第5章 长夜终尽');
  assert.equal(first.minOperators, 2);
  assert.deepEqual(first.categories, ['常规队', '精一1级']);
  assert.match(first.url, /wiki\.arkrec\.com\/operation\/5-10/);
  assert.equal(fake.calls.length, 2, 'menu + hard-operations 各一次');

  const second = await client.get('5-10');
  assert.equal(second.cn_name, '长夜终尽');
  assert.equal(fake.calls.length, 2, 'TTL 内应命中缓存');

  const loaded = await client.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.menu['CW-1'].cn_name, '孤星');
  assert.equal(loaded.stale, false);

  clock += 168 * 3600000 + 1;
  const refreshed = await client.load({ fresh: false });
  assert.equal(fake.calls.length, 4, 'TTL 过期应重新拉取');
  assert.equal(refreshed.ok, true);

  const forced = await client.load({ fresh: true });
  assert.equal(fake.calls.length, 6, 'fresh=true 强制刷新');
  assert.equal(forced.ok, true);
});

test('arkrec: 网络失败时降级——有旧缓存给 stale，没有就 null，不抛异常', async () => {
  const fake = makeFetch();
  let clock = 1000;
  const cacheDir = tempDir();
  const client = createArkrecData({ cacheDir, now: () => clock, fetchImpl: fake.fetchImpl, cacheTtlHours: 1 });
  await client.load();
  assert.equal(fake.calls.length, 2);

  fake.setFail(true);
  clock += 2 * 3600000;
  const stale = await client.load();
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.menu['5-10'].cn_name, '长夜终尽');

  const cold = createArkrecData({ cacheDir: tempDir(), now: () => clock, fetchImpl: fake.fetchImpl });
  const empty = await cold.load();
  assert.equal(empty.ok, false);
  assert.equal(empty.menu, null);
  assert.equal(empty.hardOperations, null);
  assert.equal(empty.warnings.length, 2);
  assert.equal(empty.error instanceof Error, true);
  assert.equal(await cold.get('5-10'), null);
  const coldStatus = await cold.status();
  assert.equal(coldStatus.ok, false);
  assert.equal(coldStatus.ageMs, null);
});

test('arkrec: 空关卡树视为失败（接口结构变了也要降级而不是缓存空表）', async () => {
  const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ childNodes: [] }) });
  const client = createArkrecData({ cacheDir: tempDir(), fetchImpl: emptyFetch });
  const result = await client.load();
  assert.equal(result.ok, false);
  assert.equal(result.menu, null);
});

test('arkrec: status 只读缓存（不联网）', async () => {
  const fake = makeFetch();
  const client = createArkrecData({ cacheDir: tempDir(), fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.status(), { ok: false, ageMs: null, entries: null });
  await client.load();
  const status = await client.status();
  assert.equal(status.ok, true);
  assert.equal(status.entries, 4);
  assert.equal(Number.isFinite(status.ageMs), true);
});

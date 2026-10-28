/**
 * lib/copilot.js 单元测试：作业站查询（注入假 fetch，不联网）、作业解析与排序、
 * 作业落盘（UTF-8 无 BOM）、本地作业读取。契约：lib/copilot.js JSDoc + docs/contracts.md §7。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCopilot, loadLocalSolution } from '../lib/copilot.js';
import { ArkError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读 fixture。 */
async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(here, 'fixtures', name), 'utf8'));
}

/** 断言抛出的是带指定 code 的 ArkError。 */
function assertArkCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArkError, `${label} 应抛 ArkError，实际：${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

/** 造一个成功响应。 */
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** 造一个可注入的 fetch（记录调用）。 */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { fetchImpl, calls };
}

/** 造一条「已解析」的作业（用于 pick 排序测试，不经过 parseSolution）。 */
function solution(id, options = {}) {
  return {
    id,
    stageName: options.stageName ?? 'main_05-10',
    ratingLevel: options.rating ?? 0,
    hotScore: options.hot ?? 0,
    views: options.views ?? 0,
    mentionsSupport: options.support === true,
    opers: Array.from({ length: options.opers ?? 1 }, (_value, index) => `oper-${index}`),
    available: options.available !== false,
    contentRaw: '{}',
  };
}

const MAIN_ENTRY = { stageId: 'main_05-10', code: '5-10', prefix: 'main_', suffix: '05-10', apCost: 18 };
const TOUGH_ENTRY = { stageId: 'tough_05-10', code: '5-10', prefix: 'tough_', suffix: '05-10', apCost: 18 };

test('copilot: createCopilot 归一 api（去尾斜杠）并给出默认 maxSolutions', () => {
  const client = createCopilot({ api: 'https://prts.maa.plus///' });
  assert.equal(client.api, 'https://prts.maa.plus');
  assert.equal(client.maxSolutions, 3);
  assert.equal(typeof client.query, 'function');
  assert.equal(typeof client.pick, 'function');
  assert.equal(typeof client.materialize, 'function');
  assert.equal(typeof client.parseSolution, 'function');
});

test('copilot: parseSolution 解析 fixture 作业字段', async () => {
  const fixture = await readFixture('copilot-query.sample.json');
  const client = createCopilot({ api: 'https://example.test' });
  const parsed = client.parseSolution(fixture.data.data[0]);
  assert.equal(parsed.id, 104178);
  assert.equal(parsed.stageName, 'main_05-10');
  assert.deepEqual(parsed.opers, ['德克萨斯', '能天使']);
  assert.equal(parsed.title, '5-10 两人');
  assert.equal(parsed.details, '两人打法');
  assert.equal(parsed.uploader, '博士');
  assert.equal(parsed.ratingLevel, 4);
  assert.equal(parsed.hotScore, 920);
  assert.equal(parsed.views, 12345);
  assert.equal(parsed.available, true);
  assert.equal(parsed.mentionsSupport, false);
  assert.equal(typeof parsed.contentRaw, 'string');
});

test('copilot: parseSolution 识别「需要助战」', async () => {
  const fixture = await readFixture('copilot-query.sample.json');
  const client = createCopilot({ api: 'https://example.test' });
  assert.equal(client.parseSolution(fixture.data.data[1]).mentionsSupport, true);
});

test('copilot: parseSolution 对坏数据返回 null', () => {
  const client = createCopilot({ api: 'https://example.test' });
  const bad = [
    null,
    42,
    {},
    { id: 1 },
    { id: 1, content: 'not-json' },
    { id: 1, content: '[]' },
    { id: 1, content: '{"opers":[]}' },
    { id: 1, content: '{"stage_name":""}' },
  ];
  for (const item of bad) assert.equal(client.parseSolution(item), null, JSON.stringify(item));
});

test('copilot: parseSolution 对缺失字段用安全默认值', () => {
  const client = createCopilot({ api: 'https://example.test' });
  const parsed = client.parseSolution({ id: 9, content: '{"stage_name":"main_05-10"}' });
  assert.equal(parsed.title, '');
  assert.equal(parsed.details, '');
  assert.equal(parsed.uploader, '');
  assert.equal(parsed.ratingLevel, 0);
  assert.equal(parsed.hotScore, 0);
  assert.equal(parsed.views, 0);
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.opers, []);
});

test('copilot: query 构造 URL 并过滤坏作业（注入假 fetch，不联网）', async () => {
  const fixture = await readFixture('copilot-query.sample.json');
  const { fetchImpl, calls } = makeFetch(() => jsonResponse(fixture));
  const client = createCopilot({ api: 'https://api.test', fetchImpl, maxCandidates: 20 });
  const result = await client.query('5-10');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/copilot/query?document=5-10&page=1&limit=20');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.equal(result.total, 5);
  assert.equal(result.reason, '');
  // 5 条里 1 条 content 坏 → 4 条可执行
  assert.deepEqual(result.solutions.map((item) => item.id), [104178, 104179, 104180, 104182]);
});

test('copilot: query HTTP 非 2xx 时降级（返回空列表 + 原因）', async () => {
  const { fetchImpl } = makeFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  const client = createCopilot({ api: 'https://api.test', fetchImpl });
  const result = await client.query('5-10');
  assert.deepEqual(result.solutions, []);
  assert.match(result.reason, /HTTP 503/);
  assert.equal(result.total, 0);
});

test('copilot: query status_code 异常时降级', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ status_code: 500, data: { data: [] } }));
  const client = createCopilot({ api: 'https://api.test', fetchImpl });
  const result = await client.query('5-10');
  assert.deepEqual(result.solutions, []);
  assert.match(result.reason, /status_code=500/);
});

test('copilot: query 网络异常时降级且不抛出', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const client = createCopilot({ api: 'https://api.test', fetchImpl });
  const result = await client.query('5-10');
  assert.deepEqual(result.solutions, []);
  assert.match(result.reason, /查询作业站失败/);
  assert.match(result.reason, /ECONNREFUSED/);
});

test('copilot: query 超时（AbortError）时提示超时', async () => {
  const fetchImpl = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const client = createCopilot({ api: 'https://api.test', fetchImpl, timeoutMs: 2000 });
  const result = await client.query('5-10');
  assert.deepEqual(result.solutions, []);
  assert.match(result.reason, /超时/);
  assert.match(result.reason, /2000ms/);
});

test('copilot: pick 按 difficulty 过滤同一关卡的 main_/tough_', async () => {
  const fixture = await readFixture('copilot-query.sample.json');
  const { fetchImpl } = makeFetch(() => jsonResponse(fixture));
  const client = createCopilot({ api: 'https://api.test', fetchImpl });
  const queried = await client.query('5-10');
  const entries = [MAIN_ENTRY, TOUGH_ENTRY];

  const easy = client.pick(queried.solutions, { entries, difficulty: 'easy' });
  assert.deepEqual(easy.map((item) => item.id), [104178, 104182]);
  assert.equal(easy.every((item) => item.stageName === 'main_05-10'), true);

  const tough = client.pick(queried.solutions, { entries, difficulty: 'tough' });
  // 磨难/险地由 Copilot 的 is_raid + nav_name_override 强制，作业只需匹配「同一关」，
  // 因此这里允许 main_ 与 tough_ 两种命名的作业一起作为候选（auto/easy 仍会排除 tough 作业）。
  assert.deepEqual(tough.map((item) => item.id).sort(), [104178, 104179, 104182]);
  assert.equal(tough.some((item) => item.stageName === 'tough_05-10'), true);

  const auto = client.pick(queried.solutions, { entries, difficulty: 'auto' });
  // auto 会选普通档，因此 tough_ 作业必须被排除（否则会跑错难度）
  assert.equal(auto.length, 2);
  assert.equal(auto.some((item) => item.stageName === 'tough_05-10'), false);
  // 排序：rating 高优先
  assert.equal(auto[0].id, 104178);
  assert.equal(auto.includes(104180), false, 'available:false 必须被排除');
});

test('copilot: pick 在 auto 下排除与仅 main_ 目标不同难度的 tough 作业', async () => {
  const fixture = await readFixture('copilot-query.sample.json');
  const { fetchImpl } = makeFetch(() => jsonResponse(fixture));
  const client = createCopilot({ api: 'https://api.test', fetchImpl });
  const queried = await client.query('5-10');
  const picked = client.pick(queried.solutions, { entries: [MAIN_ENTRY], difficulty: 'auto' });
  assert.equal(picked.some((item) => item.stageName === 'tough_05-10'), false);
  assert.equal(picked.some((item) => item.stageName === 'main_05-10'), true);
});

test('copilot: pick 排除 available:false 的作业', () => {
  const client = createCopilot({ api: 'https://api.test' });
  const picked = client.pick([
    solution(1, { available: true }),
    solution(2, { available: false }),
  ], { entries: [MAIN_ENTRY], difficulty: 'auto' });
  assert.deepEqual(picked.map((item) => item.id), [1]);
  // 没有 available 字段的脏数据也要排除
  const dirty = solution(3);
  delete dirty.available;
  assert.deepEqual(client.pick([dirty], { entries: [MAIN_ENTRY], difficulty: 'auto' }), []);
});

test('copilot: pick 遵守 maxSolutionsPerStage', () => {
  const client = createCopilot({ api: 'https://api.test', maxSolutionsPerStage: 2 });
  const solutions = [solution(1, { rating: 5 }), solution(2, { rating: 4 }), solution(3, { rating: 3 })];
  assert.equal(client.pick(solutions, { entries: [MAIN_ENTRY], difficulty: 'auto' }).length, 2);
});

test('copilot: pick 排序为 rating → 助战 → 热度 → 干员数 → 观看数', () => {
  const client = createCopilot({ api: 'https://api.test', maxSolutionsPerStage: 10 });
  const solutions = [
    solution(1, { rating: 3 }),
    solution(2, { rating: 5, hot: 1 }),
    solution(3, { rating: 5, hot: 9, support: true, opers: 2, views: 100 }),
    solution(4, { rating: 5, hot: 9, opers: 3, views: 10 }),
    solution(5, { rating: 5, hot: 9, opers: 2, views: 20 }),
    solution(6, { rating: 5, hot: 9, opers: 2, views: 30 }),
  ];
  assert.deepEqual(client.pick(solutions, { entries: [MAIN_ENTRY], difficulty: 'auto' }).map((item) => item.id), [6, 5, 4, 2, 3, 1]);

  const allowBorrowed = createCopilot({ api: 'https://api.test', maxSolutionsPerStage: 10, allowBorrowedOper: true });
  assert.deepEqual(allowBorrowed.pick(solutions, { entries: [MAIN_ENTRY], difficulty: 'auto' }).map((item) => item.id), [3, 6, 5, 4, 2, 1]);
});

test('copilot: pick 无候选时返回空数组', () => {
  const client = createCopilot({ api: 'https://api.test' });
  assert.deepEqual(client.pick([], { entries: [MAIN_ENTRY] }), []);
  assert.deepEqual(client.pick([], {}), []);
});

test('copilot: materialize 写出 UTF-8 无 BOM 的作业文件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-copilot-'));
  try {
    const client = createCopilot({ api: 'https://api.test', cacheDir: directory });
    const contentRaw = '{"stage_name":"main_05-10","opers":[]}';
    const file = await client.materialize({ id: 104178, stageName: 'main_05-10', contentRaw }, '5-10');
    assert.equal(path.dirname(file), directory);
    assert.match(path.basename(file), /5-10-104178\.json$/);
    const buffer = await fs.readFile(file);
    assert.notDeepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'MAA 不接受带 BOM 的作业 JSON');
    assert.equal(buffer.toString('utf8'), contentRaw);
    assert.deepEqual(JSON.parse(buffer.toString('utf8')).stage_name, 'main_05-10');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('copilot: materialize 清理文件名里的非法字符', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-copilot-'));
  try {
    const client = createCopilot({ api: 'https://api.test', cacheDir: directory });
    const file = await client.materialize({ id: 7, stageName: 'x', contentRaw: '{}' }, '5/10 关');
    assert.equal(path.dirname(file), directory);
    assert.equal(path.basename(file).includes('/'), false);
    assert.equal(/[\\:*?"<>|]/.test(path.basename(file)), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('copilot: loadLocalSolution 读本地作业', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-local-'));
  try {
    const file = path.join(directory, 'solution.json');
    await fs.writeFile(file, JSON.stringify({
      stage_name: 'main_05-10',
      opers: [{ name: '德克萨斯' }, { name: '' }, {}],
      doc: { title: '本地作业', details: '手动导出' },
    }), 'utf8');
    const parsed = await loadLocalSolution(file);
    assert.equal(parsed.stageName, 'main_05-10');
    assert.equal(parsed.title, '本地作业');
    assert.equal(parsed.details, '手动导出');
    assert.deepEqual(parsed.opers, ['德克萨斯']);
    assert.equal(parsed.uploader, 'local');
    assert.equal(parsed.file, file);
    assert.equal(parsed.id, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('copilot: loadLocalSolution 容忍 BOM 前缀', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-local-'));
  try {
    const file = path.join(directory, 'bom.json');
    await fs.writeFile(file, `\uFEFF${JSON.stringify({ stage_name: 'main_05-10' })}`, 'utf8');
    const parsed = await loadLocalSolution(file);
    assert.equal(parsed.stageName, 'main_05-10');
    assert.equal(parsed.title, 'bom.json');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('copilot: loadLocalSolution 对缺失/坏文件抛 E_SOLUTION_INVALID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-local-'));
  try {
    const missing = path.join(directory, 'missing.json');
    await assert.rejects(loadLocalSolution(missing), (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_SOLUTION_INVALID');
      return true;
    });
    const broken = path.join(directory, 'broken.json');
    await fs.writeFile(broken, 'not-json', 'utf8');
    await assert.rejects(loadLocalSolution(broken), (error) => {
      assert.equal(error.code, 'E_SOLUTION_INVALID');
      return true;
    });
    const noStage = path.join(directory, 'no-stage.json');
    await fs.writeFile(noStage, '{"opers":[]}', 'utf8');
    await assert.rejects(loadLocalSolution(noStage), (error) => {
      assert.equal(error.code, 'E_SOLUTION_INVALID');
      return true;
    });
    const array = path.join(directory, 'array.json');
    await fs.writeFile(array, '[]', 'utf8');
    await assert.rejects(loadLocalSolution(array), (error) => {
      assert.equal(error.code, 'E_SOLUTION_INVALID');
      return true;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('copilot: loadLocalSolution 空 file 抛 E_BAD_ARGS', async () => {
  for (const file of ['', '   ', null, undefined]) {
    await assert.rejects(loadLocalSolution(file), (error) => {
      assert.ok(error instanceof ArkError);
      assert.equal(error.code, 'E_BAD_ARGS');
      return true;
    });
  }
});

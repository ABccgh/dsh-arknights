/**
 * lib/tools/data.js 与 lib/tools/plan.js 单元测试：工具 schema、文本渲染与截断（≤4000 字）、
 * 来源/缓存年龄、错误收口（describeError）、依赖注入，以及「不碰 sidecar/模拟器」的静态检查。
 * 全部离线。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createData } from '../lib/data/query.js';
import { ArkError } from '../lib/errors.js';
import { createDataTools, clipText, formatDateTime, getData, TOOL_TEXT_LIMIT } from '../lib/tools/data.js';
import { createPlanTools, normalizeTargetsArg, renderPlanResult } from '../lib/tools/plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'data');
const repoRoot = path.resolve(here, '..');

/** 固定「现在」：2026-10-29 12:00 UTC。 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** @type {string[]} */
const dirs = [];

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function tempDir(prefix = 'dsh-ark-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function makeMaaDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ark-tools-maa-'));
  dirs.push(root);
  await fsp.mkdir(path.join(root, 'resource'), { recursive: true });
  const files = {
    'stages.json': 'stages.sample.json',
    'item_index.json': 'items.sample.json',
    'recruitment.json': 'recruitment.sample.json',
    'config.json': 'config.sample.json',
    'version.json': 'version.sample.json',
  };
  for (const [target, source] of Object.entries(files)) {
    await fsp.writeFile(path.join(root, 'resource', target), JSON.stringify(readFixture(source)), 'utf8');
  }
  return root;
}

function makeFetch() {
  const menu = readFixture('arkrec-menu.sample.json');
  const hard = readFixture('arkrec-hard-operations.sample.json');
  const activity = readFixture('activity.sample.json');
  const penguin = readFixture('penguin-matrix.sample.json');
  return async (url) => {
    const target = String(url);
    if (target.includes('/api/menu')) return { ok: true, status: 200, json: async () => menu };
    if (target.includes('/api/hard-operations')) return { ok: true, status: 200, json: async () => hard };
    if (target.includes('StageActivityV2')) return { ok: true, status: 200, json: async () => activity };
    if (target.includes('/result/matrix')) {
      const match = /itemFilter=(\d+)/.exec(target);
      return { ok: true, status: 200, json: async () => ({ matrix: penguin[match?.[1] ?? '']?.matrix ?? [] }) };
    }
    return { ok: false, status: 404 };
  };
}

/** 调工具 definition（等价于注册表调用）。 */
async function callTool(tools, name, args) {
  const definition = tools.find((tool) => tool.name === name);
  assert.ok(definition !== undefined, `没有工具 ${name}`);
  return definition.execute(args, {});
}

/** @type {ReturnType<typeof createData>} */
let data;
/** @type {object[]} */
let dataTools;
/** @type {object[]} */
let planTools;

before(async () => {
  const cacheDir = tempDir();
  data = createData({
    config: {},
    paths: {
      dataCacheDir: cacheDir,
      arkrecCacheDir: path.join(cacheDir, 'arkrec'),
      penguinCacheDir: path.join(cacheDir, 'penguin'),
      activityCacheFile: path.join(cacheDir, 'activity.json'),
    },
    maaPath: await makeMaaDir(),
    fetchImpl: makeFetch(),
    now: () => NOW,
  });
  dataTools = createDataTools({ data });
  planTools = createPlanTools({ data });
});

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('tools: ark_data 的 schema（kind 枚举、q/limit/refresh、只读并发安全）', () => {
  assert.equal(dataTools.length, 1);
  const tool = dataTools[0];
  assert.equal(tool.name, 'ark_data');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['kind']);
  assert.deepEqual(tool.parameters.properties.kind.enum, ['stage', 'item', 'operator', 'activity', 'search']);
  assert.equal(tool.parameters.properties.q.type, 'string');
  assert.equal(tool.parameters.properties.limit.type, 'integer');
  assert.equal(tool.parameters.properties.refresh.type, 'boolean');
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(typeof tool.output.schema, 'object');
  // 渲染器能处理空值
  const rendered = tool.output.render({}, { text: 'abc' });
  assert.deepEqual(rendered, [{ type: 'text', text: 'abc' }]);
});

test('tools: ark_plan 的 schema（targets 必填、preferEvent/exclude）', () => {
  assert.equal(planTools.length, 1);
  const tool = planTools[0];
  assert.equal(tool.name, 'ark_plan');
  assert.deepEqual(tool.parameters.required, ['targets']);
  assert.equal(tool.parameters.properties.targets.type, 'string');
  assert.equal(tool.parameters.properties.preferEvent.type, 'boolean');
  assert.equal(tool.parameters.properties.exclude.type, 'string');
  assert.equal(tool.isConcurrencySafe(), true);
});

test('tools: ark_data 各 kind 的文本有来源与关键信息且不超过 4000 字', async () => {
  const cases = [
    ['stage', { kind: 'stage', q: '5-10' }, ['ark_data · 关卡', '5-10 长夜终尽', '理智 18', '内部 id', '数据来源：MAA resource']],
    ['item', { kind: 'item', q: '固源岩' }, ['ark_data · 材料', '固源岩（30012）', '常驻掉落关', '企鹅物流', '期望 4.8 理智/件']],
    ['operator', { kind: 'operator', q: '能天使' }, ['ark_data · 干员', '能天使（6★', '公开招募干员：共 8 名']],
    ['activity', { kind: 'activity' }, ['ark_data · 活动', '开放中', '已过期', '当前活动']],
    ['search', { kind: 'search', q: '5-10' }, ['ark_data · 搜索', '关卡（', '材料（']],
  ];
  for (const [label, args, needles] of cases) {
    const result = await callTool(dataTools, 'ark_data', args);
    assert.equal(typeof result.text, 'string', label);
    assert.ok(result.text.length > 0, label);
    assert.ok(result.text.length <= TOOL_TEXT_LIMIT, `${label} 文本超过 ${TOOL_TEXT_LIMIT} 字`);
    for (const needle of needles) assert.ok(result.text.includes(needle), `${label} 缺少「${needle}」：\n${result.text}`);
  }
  // 活动关也能查，并标注时间窗
  const activityStage = await callTool(dataTools, 'ark_data', { kind: 'stage', q: 'ZZ-8' });
  assert.ok(activityStage.text.includes('当前活动'));
  assert.ok(activityStage.text.includes('2026-10-20 16:00'));
  assert.ok(activityStage.text.includes('理智未知'));
});

test('tools: ark_plan 渲染目标/候选/方案/总期望理智/来源', async () => {
  const result = await callTool(planTools, 'ark_plan', { targets: '固源岩:10, 聚酸酯组:5' });
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length <= TOOL_TEXT_LIMIT);
  for (const needle of ['ark_plan · 材料规划', '固源岩 ×10', '个候选', '期望', '推荐方案', '合计期望理智', '数据来源：MAA resource']) {
    assert.ok(result.text.includes(needle), `缺少「${needle}」：\n${result.text}`);
  }
  assert.ok(result.text.includes('1-7'));
  assert.ok(result.text.includes('5-9'));
  // 没有任何掉率数据时明确说清楚
  const noData = await callTool(planTools, 'ark_plan', { targets: 'RMA70-12:2' });
  assert.ok(noData.text.includes('掉率'));
  assert.ok(noData.text.includes('无法估算'));
  // preferEvent
  const event = await callTool(planTools, 'ark_plan', { targets: '固源岩:1', preferEvent: true });
  assert.ok(event.text.includes('ZZ-8'));
  assert.ok(event.text.includes('活动关'));
});

test('tools: 参数错误走 describeError（code + 建议），不抛裸异常', async () => {
  const result = await callTool(dataTools, 'ark_data', { kind: 'stage', q: 'CE-7' });
  assert.ok(result.text.includes('E_STAGE_UNKNOWN'));
  assert.ok(result.text.includes('建议：'));
  assert.ok(result.text.length <= TOOL_TEXT_LIMIT);

  const badTargets = await callTool(planTools, 'ark_plan', { targets: '' });
  assert.ok(badTargets.text.includes('E_BAD_ARGS'));

  // 缺失必填参数属于 schema 层错误，由 defineTool 的 coerceArguments 拒绝（注册表/模型会看到）。
  await assert.rejects(callTool(dataTools, 'ark_data', {}), /缺少必填参数/);
});

test('tools: 超长结果被截断到上限以内', async () => {
  const bigText = '很长的关卡名'.repeat(200);
  const fakeData = {
    stage: async () => ({
      ok: true,
      kind: 'stage',
      query: 'x',
      matches: Array.from({ length: 200 }, (_, index) => ({
        code: `ST-${index}`,
        displayName: `${bigText}ST-${index}`,
        apCost: 6,
        internalIds: [{ stageId: `main_${index}`, difficulty: 'easy' }],
        drops: [],
        arkrec: null,
        activity: null,
      })),
      note: '',
      sources: {},
    }),
    plan: async () => ({
      ok: true,
      kind: 'plan',
      targets: Array.from({ length: 200 }, (_, index) => ({
        name: `材料${index}`,
        itemName: `材料${index}`,
        count: 100,
        ok: true,
        candidates: Array.from({ length: 3 }, () => ({
          code: `ST-${index}`,
          apCost: 18,
          expectedSanity: 1.5,
          dropRate: 1,
          times: 1000,
          lowSample: false,
        })),
        expectedSanity: 150,
      })),
      stages: [],
      totals: { expectedSanity: 150, items: 200, covered: 200, estimated: 200, uncovered: [] },
      warnings: [],
      sources: {},
    }),
  };
  const bigTools = createDataTools({ data: fakeData });
  const stageResult = await callTool(bigTools, 'ark_data', { kind: 'stage', q: 'x' });
  assert.equal(stageResult.text.length <= TOOL_TEXT_LIMIT, true);
  assert.ok(stageResult.text.includes('已截断'));

  const bigPlanTools = createPlanTools({ data: fakeData });
  const planResult = await callTool(bigPlanTools, 'ark_plan', { targets: '材料0:1' });
  assert.equal(planResult.text.length <= TOOL_TEXT_LIMIT, true);
  assert.ok(planResult.text.includes('已截断'));
});

test('tools: 错误结果同样受 4000 字上限保护', async () => {
  const fakeData = {
    stage: async () => {
      throw new ArkError('E_STAGE_UNKNOWN', '关卡代码「X」不可用。', {
        detail: '候选：'.repeat(2000),
        hint: '用 ark_data(kind=stage, q=…) 查准确的关卡代码。',
      });
    },
    plan: async () => ({ ok: false }),
  };
  const tools = createDataTools({ data: fakeData });
  const result = await callTool(tools, 'ark_data', { kind: 'stage', q: 'X' });
  assert.ok(result.text.length <= TOOL_TEXT_LIMIT);
  assert.ok(result.text.includes('E_STAGE_UNKNOWN'));
  assert.ok(result.text.includes('已截断'));
});

test('tools: getData 优先用注入门面，否则按 deps 惰性创建且同一 deps 复用', () => {
  const injected = { stage: async () => ({}), plan: async () => ({}) };
  assert.equal(getData({ data: injected }), injected);
  const deps = { config: {}, paths: {} };
  const first = getData(deps);
  assert.equal(typeof first.stage, 'function');
  assert.equal(typeof first.plan, 'function');
  assert.equal(getData(deps), first, '同一 deps 应复用同一个门面');
  const other = getData({ config: {}, paths: {} });
  assert.notEqual(other, first, '不同 deps 各自一个门面');
});

test('tools: clipText / formatDateTime / normalizeTargetsArg / renderPlanResult 辅助函数', () => {
  assert.equal(clipText('abc'), 'abc');
  const clipped = clipText('x'.repeat(5000), 100);
  assert.equal(clipped.length <= 100, true);
  assert.ok(clipped.includes('已截断'));
  assert.equal(formatDateTime(Date.UTC(2026, 9, 29, 12, 0, 0)), '2026-10-29 20:00');
  assert.equal(formatDateTime(null), '');
  assert.equal(normalizeTargetsArg('固源岩:1'), '固源岩:1');
  assert.deepEqual(normalizeTargetsArg('[{"item":"固源岩","count":2}]'), [{ item: '固源岩', count: 2 }]);
  assert.equal(normalizeTargetsArg('[不是 json'), '[不是 json');
  const rendered = renderPlanResult({
    targets: [],
    stages: [],
    totals: { expectedSanity: null, items: 0, covered: 0, estimated: 0, uncovered: [] },
    warnings: ['没有可用的掉率数据：固源岩。'],
    sources: { penguin: { ok: false, source: 'penguin-stats' } },
  });
  assert.ok(rendered.includes('无法估算'));
  assert.ok(rendered.includes('掉率数据'));
});

test('tools/data 层只 import node:* 与本仓库模块，绝不 import sidecar/模拟器/DSH 包', () => {
  const files = [
    'lib/data/cache.js',
    'lib/data/resources.js',
    'lib/data/operators.js',
    'lib/data/arkrec.js',
    'lib/data/penguin.js',
    'lib/data/activity.js',
    'lib/data/planner.js',
    'lib/data/query.js',
    'lib/tools/data.js',
    'lib/tools/plan.js',
  ];
  const forbiddenImport = /^import[^;]*from\s+['"](?:node:child_process|child_process|.*maa-session.*|.*sidecar.*|.*environment\.js|.*detect\.js|.*actions.*|.*runner\.js|.*emulator.*|@deepseek-ai\/.*)['"]/m;
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    assert.equal(forbiddenImport.test(source), false, `${file} 有不该出现的 import`);
    assert.equal(/\bexecFile\s*\(/.test(source), false, `${file} 不应 exec`);
    assert.equal(/\bspawn\s*\(/.test(source), false, `${file} 不应 spawn`);
  }
});

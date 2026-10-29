/**
 * 工具定义单元测试：13 个全局工具、参数 schema、执行转发与错误收口。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createToolDefinitions } from '../lib/index.js';
import { arkError } from '../lib/errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 造 fake actions：任何方法都返回固定文本。
 * @param {Record<string, any>} [overrides] - 覆盖。
 * @returns {Record<string, any>} actions。
 */
function makeActions(overrides = {}) {
  const names = ['fight', 'push', 'rogue', 'daily', 'recruit', 'infrast', 'mall', 'award', 'box', 'stop'];
  const actions = {};
  for (const name of names) actions[name] = async (args) => ({ text: `${name}:${JSON.stringify(args)}` });
  return { ...actions, ...overrides };
}

/**
 * 造 fake deps。
 * @param {Record<string, any>} [overrides] - 覆盖。
 * @returns {Record<string, any>} deps。
 */
function makeDeps(overrides = {}) {
  return {
    actions: makeActions(),
    status: {
      build: async () => ({
        ok: true,
        schema: 2,
        sidecar: {},
        paths: {},
        emulator: {},
        connection: {},
        tasks: {},
        sanity: {},
        ledger: {},
        push: {},
        daily: {},
        box: {},
        data: {},
        events: [],
        safety: {},
      }),
    },
    data: {
      stage: async () => ({ matches: [] }),
      item: async () => ({ item: null }),
      operator: async () => ({ matches: [] }),
      activity: async () => ({ activities: [] }),
      search: async () => ({ stages: [], items: [], operators: [], activities: [] }),
      drops: async () => ({ candidates: [] }),
      plan: async () => ({ targets: [], totals: {} }),
    },
    ...overrides,
  };
}

test('tools: createToolDefinitions 返回 13 个全局工具，顺序固定', () => {
  const tools = createToolDefinitions(makeDeps());
  assert.deepEqual(tools.map((tool) => tool.name), [
    'ark_status',
    'ark_fight',
    'ark_push',
    'ark_rogue',
    'ark_daily',
    'ark_recruit',
    'ark_infrast',
    'ark_mall',
    'ark_award',
    'ark_box',
    'ark_data',
    'ark_plan',
    'ark_stop',
  ]);
});

test('tools: name 唯一、description 非空、parameters 是 object schema、output 有 render', () => {
  const tools = createToolDefinitions(makeDeps());
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('tools: 必填参数（fight.stages / data.kind / plan.targets）', async () => {
  const tools = createToolDefinitions(makeDeps());
  const fight = tools.find((tool) => tool.name === 'ark_fight');
  await assert.rejects(fight.execute({}, {}), /stages/);
  const data = tools.find((tool) => tool.name === 'ark_data');
  await assert.rejects(data.execute({}, {}), /kind/);
  const plan = tools.find((tool) => tool.name === 'ark_plan');
  await assert.rejects(plan.execute({}, {}), /targets/);
});

test('tools: 参数 coercion（"2" → 2、"true" → true）', async () => {
  const calls = [];
  const deps = makeDeps({
    actions: makeActions({ fight: async (args) => { calls.push(args); return { text: 'ok' }; } }),
  });
  const fight = createToolDefinitions(deps).find((tool) => tool.name === 'ark_fight');
  await fight.execute({ stages: '1-7', times: '2', confirm: 'true' }, {});
  assert.equal(calls[0].times, 2);
  assert.equal(calls[0].confirm, true);
});

test('tools: 执行转发到 actions，把文本返回', async () => {
  const deps = makeDeps();
  const fight = createToolDefinitions(deps).find((tool) => tool.name === 'ark_fight');
  const result = await fight.execute({ stages: '5-10', times: 2 }, {});
  assert.match(result.text, /^fight:/);
  const status = createToolDefinitions(deps).find((tool) => tool.name === 'ark_status');
  const statusResult = await status.execute({}, {});
  assert.match(statusResult.text, /明日方舟助手/);
});

test('tools: action 抛错时 execute 只回错误文本，不向外抛', async () => {
  const deps = makeDeps({
    actions: makeActions({ fight: async () => { throw arkError('E_NO_SOLUTION', '没有作业', { hint: '换作业' }); } }),
  });
  const fight = createToolDefinitions(deps).find((tool) => tool.name === 'ark_fight');
  const result = await fight.execute({ stages: '16-16' }, {});
  assert.match(result.text, /E_NO_SOLUTION/);
  assert.match(result.text, /没有作业/);
  assert.match(result.text, /建议：换作业/);
});

test('tools: 并发安全标记（只读工具 true，动作工具 false）', () => {
  const tools = createToolDefinitions(makeDeps());
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ['ark_status', 'ark_data', 'ark_plan']) {
    assert.equal(byName.get(name).isConcurrencySafe(), true, name);
  }
  for (const name of ['ark_fight', 'ark_daily', 'ark_box', 'ark_stop']) {
    assert.equal(byName.get(name).isConcurrencySafe(), false, name);
  }
});

test('tools: 代码里不 import @deepseek-ai/*（防止 link 安装解析失败）', async () => {
  const libRoot = path.join(root, 'lib');
  const entries = await fs.readdir(libRoot, { recursive: true });
  for (const entry of entries) {
    if (!String(entry).endsWith('.js')) continue;
    const text = await fs.readFile(path.join(libRoot, String(entry)), 'utf8');
    assert.ok(!/from\s+['"]@deepseek-ai\//.test(text), `${entry} 不应 import @deepseek-ai/*`);
  }
});

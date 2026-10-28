/**
 * lib/index.js#createToolDefinitions 与 lib/tool-kit.js 的单元测试：
 * 5 个 ark_* 工具的顺序/描述/JSON Schema/输出渲染/错误收敛。
 * 契约：docs/contracts.md §8、lib/tool-kit.js JSDoc。全部离线（actions 用假实现）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config.js';
import { createDeps, createToolDefinitions } from '../lib/index.js';

/** 假动作层：记录调用并返回固定文本；overrides 可让某个动作抛错。 */
function makeActions(overrides = {}) {
  const calls = [];
  const actions = {
    status: async () => ({ text: '状态 OK', status: {} }),
    fight: async (args) => {
      calls.push(['fight', args]);
      return { text: '打关卡计划', planned: true };
    },
    push: async (args) => {
      calls.push(['push', args]);
      return { text: '推关计划', planned: true };
    },
    rogue: async (args) => {
      calls.push(['rogue', args]);
      return { text: '肉鸽已启动' };
    },
    stop: async () => {
      calls.push(['stop', {}]);
      return { text: '已停止' };
    },
    statusObject: () => ({}),
    ...overrides,
  };
  return { actions, calls };
}

/** 按名字取工具。 */
function byName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

/** 合法参数组合（每个工具的最小调用）。 */
const MIN_ARGS = {
  ark_status: {},
  ark_fight: { stages: '5-10' },
  ark_push: {},
  ark_rogue: {},
  ark_stop: {},
};

test('tools: createToolDefinitions 按固定顺序返回 5 个工具', () => {
  const { actions } = makeActions();
  const tools = createToolDefinitions({ actions });
  assert.deepEqual(tools.map((tool) => tool.name), ['ark_status', 'ark_fight', 'ark_push', 'ark_rogue', 'ark_stop']);
});

test('tools: 真实 deps（createDeps）也能装配出 5 个工具且可 dispose', async () => {
  const config = normalizeConfig();
  const deps = createDeps(config, { logger: { info: () => {}, warn: () => {} } });
  try {
    const tools = createToolDefinitions(deps);
    assert.deepEqual(tools.map((tool) => tool.name), ['ark_status', 'ark_fight', 'ark_push', 'ark_rogue', 'ark_stop']);
  } finally {
    deps.session.dispose();
  }
});

test('tools: name 唯一、description 非空', () => {
  const { actions } = makeActions();
  const tools = createToolDefinitions({ actions });
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10, `${tool.name} 描述太短`);
  }
});

test('tools: parameters 是合法 JSON Schema object（required ⊆ properties）', () => {
  const { actions } = makeActions();
  for (const tool of createToolDefinitions({ actions })) {
    const schema = tool.parameters;
    assert.equal(schema.type, 'object', tool.name);
    assert.equal(typeof schema.properties, 'object', tool.name);
    assert.equal(Array.isArray(schema.properties), false, tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
    for (const [key, node] of Object.entries(schema.properties)) {
      assert.equal(typeof node.type, 'string', `${tool.name}.${key} 缺 type`);
      assert.ok(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(node.type), `${tool.name}.${key} type 非法`);
    }
    for (const key of schema.required ?? []) {
      assert.ok(key in schema.properties, `${tool.name} required ${key} 不在 properties 里`);
    }
  }
});

test('tools: ark_fight 的 schema 覆盖 stages/times/difficulty/confirm/file/copilotId', () => {
  const { actions } = makeActions();
  const fight = byName(createToolDefinitions({ actions })).ark_fight;
  assert.deepEqual(fight.parameters.required, ['stages']);
  for (const key of ['stages', 'times', 'difficulty', 'confirm', 'file', 'copilotId']) {
    assert.ok(key in fight.parameters.properties, `ark_fight 缺参数 ${key}`);
  }
  assert.equal(fight.parameters.properties.stages.type, 'string');
  assert.equal(fight.parameters.properties.times.type, 'integer');
  assert.deepEqual(fight.parameters.properties.difficulty.enum, ['auto', 'easy', 'tough']);
  assert.equal(fight.parameters.properties.confirm.type, 'boolean');
});

test('tools: ark_push / ark_rogue 的参数与枚举', () => {
  const { actions } = makeActions();
  const tools = byName(createToolDefinitions({ actions }));
  for (const key of ['from', 'chapter', 'maxStages', 'confirm']) {
    assert.ok(key in tools.ark_push.parameters.properties, `ark_push 缺参数 ${key}`);
  }
  assert.deepEqual(tools.ark_rogue.parameters.properties.theme.enum, ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden']);
  assert.deepEqual(tools.ark_rogue.parameters.properties.mode.enum, ['Exp', 'Invest', 'Start', 'DeepExploration']);
  assert.equal(tools.ark_rogue.parameters.properties.startsCount.type, 'integer');
  assert.deepEqual(Object.keys(tools.ark_status.parameters.properties), []);
});

test('tools: TEXT_OUTPUT 渲染成 [{type:"text",text}]', () => {
  const { actions } = makeActions();
  for (const tool of createToolDefinitions({ actions })) {
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual(tool.output.render({}, { text: '你好' }), [{ type: 'text', text: '你好' }]);
    assert.deepEqual(tool.output.render(undefined, undefined), [{ type: 'text', text: '' }]);
  }
});

test('tools: execute 返回 {text} 且把参数交给 actions', async () => {
  const { actions, calls } = makeActions();
  const tools = byName(createToolDefinitions({ actions }));
  for (const tool of Object.values(tools)) {
    const result = await tool.execute(MIN_ARGS[tool.name] ?? {});
    assert.equal(typeof result.text, 'string');
    assert.ok(result.text.length > 0, `${tool.name} 返回空文本`);
  }
  assert.deepEqual(calls.map(([name]) => name), ['fight', 'push', 'rogue', 'stop']);
  assert.deepEqual(calls.find(([name]) => name === 'fight')[1], { stages: '5-10' });
});

test('tools: actions 抛错时 execute 只回错误文本，不向外抛', async () => {
  const { actions } = makeActions({
    status: async () => { throw new Error('boom'); },
    fight: async () => { throw new Error('boom'); },
    push: async () => { throw new Error('boom'); },
    rogue: async () => { throw new Error('boom'); },
    stop: async () => { throw new Error('boom'); },
  });
  const tools = byName(createToolDefinitions({ actions }));
  for (const tool of Object.values(tools)) {
    const result = await tool.execute(MIN_ARGS[tool.name] ?? {});
    assert.match(result.text, /失败/, tool.name);
    assert.match(result.text, /boom/, tool.name);
  }
});

test('tools: 参数 coercion 把 "2"/"true" 转成 integer/boolean', async () => {
  const { actions, calls } = makeActions();
  const tools = byName(createToolDefinitions({ actions }));
  await tools.ark_fight.execute({ stages: '5-10', times: '2', confirm: 'true' });
  const args = calls.find(([name]) => name === 'fight')[1];
  assert.equal(args.times, 2);
  assert.equal(args.confirm, true);
});

test('tools: ark_fight 缺 stages 时 execute 拒绝（必填校验）', async () => {
  const { actions } = makeActions();
  const tools = byName(createToolDefinitions({ actions }));
  await assert.rejects(tools.ark_fight.execute({}), /缺少必填参数 stages/);
  await assert.rejects(tools.ark_fight.execute({ stages: null }), /缺少必填参数 stages/);
});

test('tools: 并发安全性标记（status 只读、stop 排他）', () => {
  const { actions } = makeActions();
  const tools = byName(createToolDefinitions({ actions }));
  assert.equal(tools.ark_status.isConcurrencySafe(), true);
  assert.equal(tools.ark_stop.isConcurrencySafe(), false);
});

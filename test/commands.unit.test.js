/**
 * lib/commands.js 单元测试：解析、子命令映射、确认 flag、错误收口。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flagValues, parseCommand, runCommand } from '../lib/commands.js';

test('commands: parseCommand 兼容 /ark 前缀与 flags', () => {
  assert.deepEqual(parseCommand('/ark fight 5-10 2 --yes'), {
    sub: 'fight',
    args: ['5-10', '2'],
    flags: new Set(['yes']),
  });
  assert.deepEqual(parseCommand('status'), { sub: 'status', args: [], flags: new Set() });
  assert.deepEqual(parseCommand('/ark'), { sub: 'status', args: [], flags: new Set() });
  assert.deepEqual(parseCommand('  /ark   push 5-3 --chapter=5 '), {
    sub: 'push',
    args: ['5-3'],
    flags: new Set(['chapter=5']),
  });
});

test('commands: flagValues', () => {
  assert.deepEqual(flagValues(new Set(['yes', 'chapter=5', 'max=3'])), { yes: true, chapter: '5', max: '3' });
  assert.deepEqual(flagValues(new Set(['=x', ''])), {});
});

/**
 * 造 fake 依赖。
 * @param {Record<string, any>} [overrides] - 覆盖。
 * @returns {any} deps。
 */
function makeDeps(overrides = {}) {
  const calls = [];
  const actions = {
    fight: async (params) => { calls.push(['fight', params]); return { text: 'fight-ok' }; },
    push: async (params) => { calls.push(['push', params]); return { text: 'push-ok' }; },
    rogue: async (params) => { calls.push(['rogue', params]); return { text: 'rogue-ok' }; },
    daily: async (params) => { calls.push(['daily', params]); return { text: 'daily-ok' }; },
    recruit: async (params) => { calls.push(['recruit', params]); return { text: 'recruit-ok' }; },
    infrast: async (params) => { calls.push(['infrast', params]); return { text: 'infrast-ok' }; },
    mall: async (params) => { calls.push(['mall', params]); return { text: 'mall-ok' }; },
    award: async (params) => { calls.push(['award', params]); return { text: 'award-ok' }; },
    box: async (params) => { calls.push(['box', params]); return { text: 'box-ok' }; },
    stop: async (params) => { calls.push(['stop', params]); return { text: 'stop-ok' }; },
  };
  return {
    calls,
    actions,
    status: { build: async () => ({ ok: true, schema: 2, sidecar: {}, paths: {}, emulator: {}, connection: {}, tasks: {}, sanity: {}, ledger: {}, push: {}, daily: {}, box: {}, data: {}, events: [], safety: {} }) },
    query: async (input) => {
      calls.push(['query', input]);
      if (input.kind === 'plan') {
        return { targets: [{ itemId: '30061', itemName: '固源岩', count: 10, best: { code: '1-7', expectedSanity: 4.2 } }], totalExpectedSanity: 42, warnings: [] };
      }
      return { items: [{ code: '1-7', name: '暴君' }, { code: '1-6', name: '坍塌' }] };
    },
    ...overrides,
  };
}

test('commands: status 走 status.build + renderStatus', async () => {
  const deps = makeDeps();
  const result = await runCommand('/ark status', deps);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /明日方舟助手/);
});

test('commands: fight 解析 stages/times/difficulty/--yes', async () => {
  const deps = makeDeps();
  const result = await runCommand('/ark fight 16-16 2 --difficulty=tough --yes', deps);
  assert.equal(result.kind, 'success');
  assert.deepEqual(deps.calls.find(([name]) => name === 'fight')[1], {
    stages: '16-16',
    times: 2,
    difficulty: 'tough',
    confirm: true,
  });
});

test('commands: fight 多关不带次数时都算关卡', async () => {
  const deps = makeDeps();
  await runCommand('/ark fight 5-10 6-5 --yes', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'fight')[1], {
    stages: '5-10,6-5',
    times: 1,
    confirm: true,
  });
});

test('commands: push 解析 from/chapter/max', async () => {
  const deps = makeDeps();
  await runCommand('/ark push 5-3 --chapter=5 --max=3 --yes', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'push')[1], { from: '5-3', chapter: 5, maxStages: 3, confirm: true });
});

test('commands: rogue/daily/recruit/infrast/mall/award/box/stop', async () => {
  const deps = makeDeps();
  await runCommand('/ark rogue Sami Start', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'rogue')[1], { theme: 'Sami', mode: 'Start', confirm: false });
  await runCommand('/ark daily --tasks=award,recruit --yes', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'daily')[1], { tasks: ['award', 'recruit'], confirm: true });
  await runCommand('/ark recruit execute --yes', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'recruit')[1], { mode: 'execute', confirm: true });
  await runCommand('/ark recruit', deps);
  assert.deepEqual(deps.calls.findLast(([name]) => name === 'recruit')[1], { mode: 'analyze', confirm: false });
  await runCommand('/ark infrast --yes', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'infrast')[1], { confirm: true });
  await runCommand('/ark mall', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'mall')[1], { confirm: false });
  await runCommand('/ark award', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'award')[1], {});
  await runCommand('/ark box operbox', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'box')[1], { target: 'operbox' });
  await runCommand('/ark stop', deps);
  assert.deepEqual(deps.calls.find(([name]) => name === 'stop')[1], {});
});

test('commands: data/plan 走 query 并渲染文本', async () => {
  const deps = makeDeps();
  const data = await runCommand('/ark data stage 1-7', deps);
  assert.equal(data.kind, 'success');
  assert.match(data.text, /1-7/);
  const plan = await runCommand('/ark plan 固源岩:10', deps);
  assert.equal(plan.kind, 'success');
  assert.match(plan.text, /固源岩/);
  assert.match(plan.text, /42/);
});

test('commands: 未知子命令与异常都回 error 文本', async () => {
  const deps = makeDeps();
  const unknown = await runCommand('/ark nope', deps);
  assert.equal(unknown.kind, 'error');
  const boom = await runCommand('/ark fight 1-7 --yes', makeDeps({ actions: { fight: async () => { throw new Error('炸了'); } } }));
  assert.equal(boom.kind, 'error');
  assert.match(boom.text, /炸了/);
});

/**
 * 动作共享原语测试：run 单飞、计划/确认/dryRun/安全闸、wait=false、超时。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertResourcesAllowed,
  createRunStore,
  isConfirmed,
  needsConfirm,
  planResult,
  runAction,
  summarizeParams,
  waitFor,
  withTimeout,
} from '../lib/actions/shared.js';
import { normalizeConfig } from '../lib/config.js';
import { makeLogger } from './helpers.mjs';

/**
 * 造一个可用的 run store。
 * @returns {{store:any, appends:Array<any>}} store 与历史记录。
 */
function makeStore() {
  const appends = [];
  const store = createRunStore({
    history: { append: async (entry) => { appends.push(entry); } },
    logger: makeLogger(),
    now: () => '2026-10-29T00:00:00.000Z',
  });
  return { store, appends };
}

test('shared: run store 单飞，第二个 begin 抛 E_BUSY', async () => {
  const { store } = makeStore();
  const run = store.begin({ kind: 'fight', params: { stages: '1-7' } });
  assert.equal(run.kind, 'fight');
  assert.equal(store.isRunning(), true);
  assert.throws(() => store.begin({ kind: 'daily', params: {} }), (error) => error.code === 'E_BUSY');
  await store.finish('completed', { result: { ok: true } });
  assert.equal(store.isRunning(), false);
  assert.equal(store.last().status, 'completed');
});

test('shared: run store 订阅/停止/历史', async () => {
  const { store, appends } = makeStore();
  let changes = 0;
  const off = store.subscribe(() => { changes += 1; });
  const run = store.begin({ kind: 'box', params: { target: 'both' } });
  assert.equal(run.signal.aborted, false);
  assert.equal(store.stop(), true);
  assert.equal(run.signal.aborted, true);
  await store.fail(new Error('boom'));
  off();
  assert.equal(appends.length, 1);
  assert.equal(appends[0].status, 'failed');
  assert.equal(appends[0].error.code, 'E_UNDEFINED');
  assert.ok(changes >= 2);
});

test('shared: summarizeParams 去掉 confirm/空值，保留路径', () => {
  const summary = summarizeParams('fight', {
    stages: '1-7',
    confirm: true,
    times: undefined,
    array: [],
    object: {},
    file: 'C:\\a.json',
  });
  assert.equal(summary.kind, 'fight');
  assert.equal(summary.stages, '1-7');
  assert.equal(summary.confirm, undefined);
  assert.equal(summary.file, 'C:\\a.json');
});

test('shared: 确认矩阵与 isConfirmed', () => {
  const config = normalizeConfig();
  assert.equal(isConfirmed(config, {}), false);
  assert.equal(isConfirmed(config, { confirm: true }), true);
  assert.equal(isConfirmed({ ...config, confirmRequired: false }, {}), true);
  assert.equal(needsConfirm('fight'), true);
  assert.equal(needsConfirm('recruit', { mode: 'analyze' }), false);
  assert.equal(needsConfirm('recruit', { mode: 'execute' }), true);
});

test('shared: 安全闸默认拒绝，打开后放行', () => {
  const config = normalizeConfig();
  assert.throws(() => assertResourcesAllowed(config, { medicine: 1 }), (error) => error.code === 'E_UNSAFE_RESOURCE');
  assert.throws(() => assertResourcesAllowed(config, { stone: 1 }), (error) => error.code === 'E_UNSAFE_RESOURCE');
  assert.throws(() => assertResourcesAllowed(config, { useSanityPotion: true }), (error) => error.code === 'E_UNSAFE_RESOURCE');
  assert.throws(() => assertResourcesAllowed(config, { expedite: true }), (error) => error.code === 'E_UNSAFE_RESOURCE');
  assert.throws(() => assertResourcesAllowed(config, { mode: 'execute' }), (error) => error.code === 'E_UNSAFE_RESOURCE');
  assertResourcesAllowed(config, { medicine: 0, stone: 0 });
  const open = normalizeConfig({ safety: { allowSanityPotion: true, allowOriginitePrime: true, allowRecruitPermits: true, allowExpedite: true } });
  assertResourcesAllowed(open, { medicine: 1, stone: 1, useSanityPotion: true, expedite: true, mode: 'execute' });
});

test('shared: runAction 未确认只出计划，不 begin run', async () => {
  const { store, appends } = makeStore();
  const config = normalizeConfig();
  let executed = 0;
  const response = await runAction({
    config,
    store,
    kind: 'fight',
    params: { stages: '1-7' },
    plan: () => ({ text: '计划', plannedItems: [{ stage: '1-7' }], plannedTotalSanity: 6 }),
    execute: async () => { executed += 1; return { text: '打完了' }; },
  });
  assert.equal(response.planned, true);
  assert.equal(response.plannedTotalSanity, 6);
  assert.equal(executed, 0);
  assert.equal(store.isRunning(), false);
  assert.equal(appends.length, 0);
});

test('shared: runAction 确认后执行并写历史；dryRun 只出计划', async () => {
  const { store, appends } = makeStore();
  const config = normalizeConfig({ confirmRequired: false });
  const response = await runAction({
    config,
    store,
    kind: 'award',
    params: {},
    plan: () => ({ text: '计划' }),
    execute: async () => ({ text: '领完了', result: { ok: true } }),
  });
  assert.equal(response.done, true);
  assert.equal(response.result.ok, true);
  assert.equal(appends.length, 1);
  assert.equal(appends[0].status, 'completed');

  const { store: store2 } = makeStore();
  const dry = await runAction({
    config: normalizeConfig({ dryRun: true }),
    store: store2,
    kind: 'award',
    params: {},
    plan: () => ({ text: '计划' }),
    execute: async () => ({ text: '不该执行' }),
  });
  assert.equal(dry.planned, true);
  assert.match(dry.text, /dry-run/);
  assert.equal(store2.isRunning(), false);
});

test('shared: runAction wait=false 立即返回 runId，后台完成', async () => {
  const { store, appends } = makeStore();
  const config = normalizeConfig({ confirmRequired: false });
  const response = await runAction({
    config,
    store,
    kind: 'box',
    params: { wait: false },
    plan: () => ({ text: '计划' }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { text: '识别完成', result: { box: true } };
    },
  });
  assert.equal(response.started, true);
  assert.equal(response.done, false);
  assert.match(response.runId, /^run-/);
  await waitFor(() => appends.length > 0, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(appends[0].status, 'completed');
});

test('shared: runAction 执行失败会写 failed 并重抛', async () => {
  const { store, appends } = makeStore();
  const config = normalizeConfig({ confirmRequired: false });
  await assert.rejects(
    runAction({
      config,
      store,
      kind: 'mall',
      params: {},
      plan: () => ({ text: '计划' }),
      execute: async () => { throw new Error('商店炸了'); },
    }),
    /商店炸了/,
  );
  assert.equal(appends.length, 1);
  assert.equal(appends[0].status, 'failed');
  assert.equal(store.isRunning(), false);
});

test('shared: planResult 形状', () => {
  const result = planResult({ kind: 'fight', text: '计划', planned: [{ stage: '1-7' }], totals: { sanity: 6 } });
  assert.equal(result.status, 'planned');
  assert.equal(result.planned.length, 1);
  assert.deepEqual(result.executed, []);
  assert.equal(result.text, '计划');
});

test('shared: withTimeout 与 waitFor', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), (error) => error.code === 'E_TIMEOUT');
  let count = 0;
  const value = await waitFor(() => { count += 1; return count >= 3 ? 'ok' : null; }, { timeoutMs: 1000, intervalMs: 5 });
  assert.equal(value, 'ok');
  await assert.rejects(waitFor(() => false, { timeoutMs: 30, intervalMs: 5 }), (error) => error.code === 'E_TIMEOUT');
});

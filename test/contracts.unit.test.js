/**
 * 契约常量测试：工具面、确认矩阵、肉鸽模式映射、版本。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  GLOBAL_TOOL_NAMES,
  PRESET_TOOL_NAMES,
  PRTS_TOOL_NAMES,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  STATUS_SCHEMA,
  LEDGER_VERSION,
  actionRequiresConfirm,
  isReadOnlyKind,
  rogueModeNumber,
} from '../lib/contracts.js';

test('contracts: 版本与 package.json 一致', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.equal(PROTOCOL_VERSION, '2.0.0');
  assert.equal(STATUS_SCHEMA, 2);
  assert.equal(LEDGER_VERSION, 2);
});

test('contracts: 全局 13 / 预设 2 / PRTS 10，且互不重叠', () => {
  assert.equal(GLOBAL_TOOL_NAMES.length, 13);
  assert.equal(PRESET_TOOL_NAMES.length, 2);
  assert.equal(PRTS_TOOL_NAMES.length, 10);
  assert.equal(new Set(GLOBAL_TOOL_NAMES).size, 13);
  const all = [...GLOBAL_TOOL_NAMES, ...PRESET_TOOL_NAMES, ...PRTS_TOOL_NAMES];
  assert.equal(new Set(all).size, all.length);
  for (const name of [...GLOBAL_TOOL_NAMES, ...PRESET_TOOL_NAMES]) assert.match(name, /^ark_/);
  for (const name of PRTS_TOOL_NAMES) assert.match(name, /^prts_/);
});

test('contracts: 确认矩阵', () => {
  for (const kind of ['fight', 'push', 'rogue', 'daily', 'infrast', 'mall']) {
    assert.equal(actionRequiresConfirm(kind), true, kind);
  }
  assert.equal(actionRequiresConfirm('recruit'), false);
  assert.equal(actionRequiresConfirm('recruit', { mode: 'execute' }), true);
  for (const kind of ['award', 'box', 'data', 'plan', 'status', 'stop']) {
    assert.equal(actionRequiresConfirm(kind), false, kind);
  }
});

test('contracts: 只读动作集合', () => {
  for (const kind of ['status', 'data', 'plan', 'solutions']) assert.equal(isReadOnlyKind(kind), true);
  for (const kind of ['fight', 'daily', 'box', 'stop']) assert.equal(isReadOnlyKind(kind), false);
});

test('contracts: 肉鸽模式映射到 MAA 6.21 数字', () => {
  assert.equal(rogueModeNumber('Exp'), 0);
  assert.equal(rogueModeNumber('Invest'), 1);
  assert.equal(rogueModeNumber('Start'), 4);
  assert.equal(rogueModeNumber('Collapse'), 5);
  assert.equal(rogueModeNumber('Monthly'), 6);
  assert.equal(rogueModeNumber('DeepExploration'), 7);
  assert.equal(rogueModeNumber('QuickFirstLayer'), 10001);
  assert.equal(rogueModeNumber('JieGardenNode'), 20001);
  assert.equal(rogueModeNumber('BlackFlowStart'), 30003);
  assert.equal(rogueModeNumber('invest'), 1);
  assert.equal(rogueModeNumber(7), 7);
  assert.equal(rogueModeNumber('7'), 7);
  assert.equal(rogueModeNumber('unknown'), 0);
});

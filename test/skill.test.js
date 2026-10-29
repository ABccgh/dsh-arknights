/**
 * arknights skill v2 的离线契约测试：确保 `skill/SKILL.md` 覆盖全部工具名、
 * 确认矩阵与资源安全、难度规则、理智不足、错误码与 battle-start 诊断。
 *
 * 只读仓库里的源文件（`skill/SKILL.md`），不联网、不安装 skill、不碰 `~/.agents`；
 * 安装副本由部署阶段复制，源文件才是这份测试的准则。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLOBAL_TOOL_NAMES, PRESET_TOOL_NAMES, PRTS_TOOL_NAMES } from '../lib/contracts.js';

/** 仓库根目录（本文件在 <root>/test/ 下）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** skill 源文件。 */
const SKILL_FILE = path.join(ROOT, 'skill', 'SKILL.md');

/** 读 skill 源文件（缓存一次）。 */
let cached = null;
async function readSkill() {
  if (cached !== null) return cached;
  cached = await fs.readFile(SKILL_FILE, 'utf8');
  return cached;
}

/** 全部契约工具名（13 全局 + 2 预设 + 10 PRTS）。 */
const ALL_TOOL_NAMES = [...GLOBAL_TOOL_NAMES, ...PRESET_TOOL_NAMES, ...PRTS_TOOL_NAMES];

/** 0.2.0 的旧预设工具名：skill v2 不应再教模型调用它们。 */
const LEGACY_TOOL_NAMES = ['ark_stages', 'ark_screen', 'ark_device', 'ark_game', 'ark_emulator', 'ark_log'];

test('skill: 源文件存在、是 Markdown、行数在 150–220 之间', async () => {
  const raw = await readSkill();
  assert.ok(raw.trim().length > 2000, `SKILL.md 内容过短（${raw.trim().length} 字符）`);
  const lines = raw.split('\n');
  assert.ok(lines.length >= 150 && lines.length <= 220, `SKILL.md 行数应在 150–220，实际 ${lines.length}`);
  // 不能是空壳：至少要有二级标题与表格。
  assert.ok(raw.includes('\n## '), 'SKILL.md 应包含二级标题');
  assert.ok(raw.includes('|---|'), 'SKILL.md 应包含 Markdown 表格');
});

test('skill: frontmatter 有 name=arknights、version=2.0.0 与可触发描述', async () => {
  const raw = await readSkill();
  assert.ok(raw.startsWith('---\n'), 'SKILL.md 应以 YAML frontmatter 开头');
  const end = raw.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'frontmatter 没有闭合的 ---');
  const frontmatter = raw.slice(4, end);
  assert.match(frontmatter, /^name: arknights$/m);
  assert.match(frontmatter, /^\s*version: "2\.0\.0"$/m, 'skill 版本应为 2.0.0');
  assert.match(frontmatter, /description:/);
  for (const trigger of ['ark_fight', 'ark_push', 'ark_rogue', '磨难', '险地', 'sanity']) {
    assert.ok(frontmatter.includes(trigger), `description 缺少触发词：${trigger}`);
  }
});

test('skill: 覆盖全部 25 个契约工具名（13 全局 + 2 预设 + 10 PRTS）', async () => {
  const raw = await readSkill();
  const missing = ALL_TOOL_NAMES.filter((name) => !raw.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `SKILL.md 缺少这些工具：${missing.join('、')}`);
  assert.equal(ALL_TOOL_NAMES.length, 25);
});

test('skill: 不再出现 0.2.0 旧预设工具名（已被 ark_diag 合并）', async () => {
  const raw = await readSkill();
  for (const legacy of LEGACY_TOOL_NAMES) {
    assert.equal(raw.includes(`\`${legacy}\``), false, `SKILL.md 不应再出现旧工具名 ${legacy}`);
  }
});

test('skill: 工具地图分组齐全（全局/预设/PRTS 三个小节）', async () => {
  const raw = await readSkill();
  assert.match(raw, /### 全局/);
  assert.match(raw, /### 预设/);
  assert.match(raw, /### PRTS/);
  // 每个工具表行至少出现一次，且分组标题明确写了数量。
  assert.match(raw, /13 全局 \+ 2 预设 \+ 10 PRTS/);
});

test('skill: 确认矩阵与资源安全（理智药/源石/招聘许可默认拒绝）', async () => {
  const raw = await readSkill();
  for (const phrase of [
    '确认矩阵',
    'confirm=false',
    'confirm=true',
    '理智药',
    '至纯源石',
    '招聘许可',
    '加急许可',
    '默认全部拒绝',
    'E_UNSAFE_RESOURCE',
    'safety.allowSanityPotion',
  ]) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少资源安全关键内容：${phrase}`);
  }
});

test('skill: 难度规则 10–14 磨难 / 15+ 险地 / -HARD', async () => {
  const raw = await readSkill();
  for (const phrase of ['磨难', '险地', '突袭', '-HARD', 'difficulty=tough', '10–14', '15 章']) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少难度规则：${phrase}`);
  }
});

test('skill: 代理指挥 vs 抄作业、理智不足处理', async () => {
  const raw = await readSkill();
  for (const phrase of ['代理指挥', '抄作业', '满星', '未借干员', '理智不足', 'useSanityPotion', 'medicine']) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少执行路径说明：${phrase}`);
  }
});

test('skill: 日常四项与仓库耗时（公招 analyze/execute、基建、信用、领取、干员盒）', async () => {
  const raw = await readSkill();
  for (const phrase of ['analyze', 'execute', '基建', '信用', '领取', '仓库', '干员盒', '5–20 分钟']) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少日常/仓库说明：${phrase}`);
  }
});

test('skill: 数据来源与掉率公式（expectedSanity）', async () => {
  const raw = await readSkill();
  for (const phrase of ['stages.json', 'item_index.json', 'penguin-stats', 'ArkRec', 'expectedSanity', 'dropRate', 'apCost']) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少数据来源/掉率内容：${phrase}`);
  }
});

test('skill: 错误码表覆盖高频失败码', async () => {
  const raw = await readSkill();
  for (const code of [
    'E_STAGE_UNKNOWN',
    'E_NO_SOLUTION',
    'E_CONNECT',
    'E_TIMEOUT',
    'E_BUSY',
    'E_PYTHON_NOT_FOUND',
    'E_MAA_NOT_FOUND',
    'E_NOT_READY',
    'E_PREFLIGHT',
    'E_BOX_TIMEOUT',
    'E_NO_PERMIT',
    'E_DATA_UNAVAILABLE',
    'E_PROTOCOL_VERSION',
    'E_SOLUTION_INVALID',
  ]) {
    assert.ok(raw.includes(code), `错误码表缺少 ${code}`);
  }
  assert.ok(raw.includes('错误码表'), 'SKILL.md 应有「错误码表」小节');
});

test('skill: battle-start 失败诊断包含 16-16 这类场景与排查顺序', async () => {
  const raw = await readSkill();
  for (const phrase of [
    'battle-start',
    '16-16',
    '没有进入关卡详情',
    'BattleStartAll',
    'StageQueueStageNotFound',
    'ark_diag',
    'logs',
    'screen',
    'diagnosis',
  ]) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少 battle-start 诊断：${phrase}`);
  }
});

test('skill: 配置位置与重启 DSH 说明', async () => {
  const raw = await readSkill();
  for (const phrase of [
    'dsh-bundles',
    'cordis.patch.yml',
    '?v=3',
    'skills\\arknights',
    '重启 DSH',
    'arknights-preset-activation.json',
  ]) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少配置/重启说明：${phrase}`);
  }
});

test('skill: 硬规则与「不做的事」（3 星才算满星、不猜关、不并发）', async () => {
  const raw = await readSkill();
  for (const phrase of ['stars=3', '不做的事', '不猜关', '不自动换关', '不擅自加次数', 'E_BUSY']) {
    assert.ok(raw.includes(phrase), `SKILL.md 缺少硬规则：${phrase}`);
  }
  assert.match(raw, /##\s+\d+\.\s+不做的事/, '应有独立的「不做的事」小节');
});

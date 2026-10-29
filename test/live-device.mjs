/**
 * 真机零理智验收脚本（可重复执行）。
 *
 * 默认只读：status / diag 不走这里 / box / recruit analyze / data / plan / fight 计划。
 * `--free` 才执行免费动作（award / mall / infrast），仍会走确认逻辑。
 * **绝不**执行 fight/push/rogue，也绝不消耗理智药/源石/招聘许可。
 *
 * 用法：
 *   node test/live-device.mjs [--free] [--skip-box] [--json]
 *
 * 数据写到临时目录（不污染用户账本）；会先复制真实 progress.json 做 v1→v2 迁移断言。
 *
 * @module @local/arknights/test/live-device
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDeps } from '../lib/index.js';
import { normalizeConfig } from '../lib/config.js';
import { renderStatus } from '../lib/tools/status.js';

const args = new Set(process.argv.slice(2));
const FREE = args.has('--free');
const SKIP_BOX = args.has('--skip-box');
const SKIP_DEVICE = args.has('--skip-device');
const JSON_OUT = args.has('--json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-live-'));
const realLedger = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'dsh-arknights', 'progress.json');

const config = normalizeConfig({
  ledgerFile: path.join(tmp, 'progress.json'),
  box: { file: path.join(tmp, 'box.json') },
  history: { file: path.join(tmp, 'history.jsonl'), maxEntries: 50 },
  cacheDir: path.join(tmp, 'cache'),
  copilot: { cacheDir: path.join(tmp, 'copilot'), enabled: false },
  arkrec: { enabled: true },
  penguin: { enabled: true },
  activity: { enabled: true },
});

const results = [];
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * 跑一步并记录。
 * @param {string} name - 步骤名。
 * @param {() => Promise<any>} fn - 函数。
 * @param {{ optional?: boolean }} [options] - 选项。
 * @returns {Promise<any>} 结果。
 */
async function step(name, fn, options = {}) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt, value });
    console.log(`✔ ${name}（${Date.now() - startedAt}ms）`);
    return value;
  } catch (error) {
    const text = error instanceof Error ? `${error.code ?? error.name}: ${error.message}` : String(error);
    results.push({ name, ok: false, ms: Date.now() - startedAt, error: text });
    console.error(`✖ ${name}（${Date.now() - startedAt}ms）：${text}`);
    if (options.optional !== true) throw error;
    return null;
  }
}

/**
 * 主流程。
 * @returns {Promise<void>} 无。
 */
async function main() {
  console.log(`临时目录：${tmp}`);
  const deps = createDeps(config, { logger });
  try {
    // 0) 迁移：复制真实账本（如果存在）
    if (fs.existsSync(realLedger)) {
      const copy = path.join(tmp, 'progress-real-copy.json');
      fs.copyFileSync(realLedger, copy);
      await step('ledger 迁移 v1→v2', async () => {
        const { createLedger } = await import('../lib/ledger.js');
        const ledger = createLedger({ file: copy, logger });
        const view = ledger.view();
        const raw = JSON.parse(fs.readFileSync(copy, 'utf8'));
        return { version: raw.version, backup: fs.existsSync(`${copy}.v1.bak`), fullStar: view.fullStar, missing: view.missing };
      });
    } else {
      results.push({ name: 'ledger 迁移 v1→v2', ok: true, skipped: '没有真实 progress.json' });
    }

    // 1) 状态（不拉侧车/模拟器）
    await step('ark_status', async () => {
      const object = await deps.status.build();
      const text = renderStatus(object);
      assert(text.includes('明日方舟助手'), '状态文本异常');
      return text.split('\n').slice(0, 6);
    });

    // 2) 数据（离线/缓存优先）
    await step('ark_data stage 1-7', async () => {
      const result = await deps.query({ kind: 'stage', q: '1-7', limit: 5, refresh: false, target: '', targets: '' });
      assert(Array.isArray(result.items) && result.items.length > 0, '没有关卡结果');
      return result.items[0];
    });
    await step('ark_data activity', async () => {
      const result = await deps.query({ kind: 'activity', q: '', limit: 5, refresh: false, target: '', targets: '' });
      return { activities: (result.items ?? []).length, stages: (result.stages ?? []).length };
    });
    await step('ark_plan 固源岩:10', async () => {
      const result = await deps.query({ kind: 'plan', q: '固源岩:10', limit: 5, refresh: false, target: '', targets: '固源岩:10' });
      return { targets: (result.targets ?? []).length, total: result.totalExpectedSanity };
    });

    // 3) 战斗计划（不执行）
    await step('ark_fight confirm=false', async () => {
      const response = await deps.actions.fight({ stages: '1-7', times: 1, confirm: false });
      assert(response.planned === true, '计划响应缺少 planned');
      return response.text.split('\n').slice(0, 6);
    });

    // 4) 真机动作（--skip-device 可跳过；绝不消耗理智/招聘许可）
    if (!SKIP_DEVICE) {
      if (!SKIP_BOX) {
        await step('ark_box operbox', async () => {
          const response = await deps.actions.box({ target: 'operbox', wait: true });
          return response.result?.box ?? response.text;
        });
      }

      await step('ark_recruit analyze', async () => {
        const response = await deps.actions.recruit({ mode: 'analyze', wait: true });
        return response.result?.recruit ?? response.text;
      });

      if (FREE) {
        await step('ark_award', async () => {
          const response = await deps.actions.award({ wait: true });
          return response.text;
        });
        await step('ark_mall 访问好友+购物', async () => {
          const response = await deps.actions.mall({ visitFriends: true, shopping: true, confirm: true, wait: true });
          return response.text;
        });
        await step('ark_infrast 默认换班', async () => {
          const response = await deps.actions.infrast({ mode: 0, confirm: true, wait: true });
          return response.text;
        });
      } else {
        results.push({ name: '免费动作（award/mall/infrast）', ok: true, skipped: '需要 --free' });
      }
    } else {
      results.push({ name: '真机动作（box/recruit/award/mall/infrast）', ok: true, skipped: '--skip-device' });
    }

    // 7) 状态与停止
    await step('ark_status after', async () => {
      const object = await deps.status.build();
      return { lastRun: object.lastRun?.kind ?? null, tasks: object.tasks?.running === true };
    });
  } finally {
    deps.session.dispose();
    if (JSON_OUT) {
      console.log(JSON.stringify({ tmp, free: FREE, results }, null, 2));
    } else {
      const failed = results.filter((item) => item.ok !== true);
      console.log(`\n结果：${results.length - failed.length}/${results.length} 通过` + (failed.length > 0 ? `；失败：${failed.map((item) => item.name).join('、')}` : ''));
      console.log(`临时目录（可删除）：${tmp}`);
      if (failed.length > 0) process.exitCode = 1;
      else fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * 断言。
 * @param {unknown} value - 条件。
 * @param {string} message - 消息。
 * @returns {void}
 */
function assert(value, message) {
  if (!value) throw new Error(message);
}

await main();

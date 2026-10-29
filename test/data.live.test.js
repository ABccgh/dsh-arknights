/**
 * 联网 smoke（默认 skip）：真实访问 ArkRec / 企鹅物流 / MAA StageActivityV2，并用本机 MAA
 * resource 做一次端到端数据查询。
 *
 * 运行：`DSH_PRTS_LIVE=1 node --test test/data.live.test.js`
 * 不要把它放进日常 CI：默认 skip，离线时全绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createData } from '../lib/data/query.js';

/** 是否允许联网。 */
const LIVE = process.env.DSH_PRTS_LIVE === '1';
/** 本机 MAA 候选目录（可用 DSH_MAA_PATH 覆盖）。 */
const MAA_CANDIDATES = [
  process.env.DSH_MAA_PATH ?? '',
  'D:\\MAA-v6.19.0-beta.1-win-x64',
  'D:\\MAA',
  'C:\\MAA',
].filter((value) => value !== '');

/**
 * 找一个含 resource/stages.json 的 MAA 目录。
 * @returns {string} 目录；找不到为空串。
 */
function findMaaPath() {
  for (const candidate of MAA_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'resource', 'stages.json'))) return candidate;
  }
  return '';
}

test('live: 真实数据源 smoke（ArkRec / 企鹅物流 / 活动日历 / 规划）', {
  skip: LIVE ? false : '设置 DSH_PRTS_LIVE=1 才跑联网 smoke',
  timeout: 180000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ark-live-'));
  try {
    const maaPath = findMaaPath();
    const data = createData({
      config: {},
      paths: {
        dataCacheDir: dir,
        arkrecCacheDir: path.join(dir, 'arkrec'),
        penguinCacheDir: path.join(dir, 'penguin'),
        activityCacheFile: path.join(dir, 'activity.json'),
      },
      maaPath,
    });

    const activity = await data.activity({ refresh: true });
    assert.equal(activity.ok, true, '活动日历应可用');
    assert.equal(activity.activities.length > 0, true);
    const active = activity.activities.filter((entry) => entry.active === true);
    console.log(`[live] 活动日历：${activity.activities.length} 条，开放中 ${active.length} 条`);

    const drops = await data.drops('固源岩', { refresh: true });
    assert.equal(drops.ok, true, '企鹅物流应可用');
    assert.equal(drops.candidates.length > 0, true);
    console.log(`[live] 固源岩掉率候选 ${drops.candidates.length} 个，最便宜：${drops.candidates[0].code} ${drops.candidates[0].expectedSanity} 理智/件`);

    const stage = await data.stage('5-10');
    assert.equal(stage.ok, true);
    console.log(`[live] 5-10：${stage.matches[0].displayName}，理智 ${stage.matches[0].apCost}`);

    if (maaPath !== '') {
      const status = await data.status();
      assert.equal(status.stages > 500, true, '本机 MAA 关卡表应有 500+ 关');
      console.log(`[live] MAA 资源：${status.stages} 关 / ${status.items} 材料 / ${status.operators} 干员`);
    }

    const plan = await data.plan({ targets: '固源岩:10' });
    assert.equal(plan.ok, true, '规划应能给出方案');
    console.log(`[live] 规划：${plan.stages.map((entry) => entry.code).join('、')}，总期望理智 ${plan.totals.expectedSanity}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

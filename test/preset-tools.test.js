/**
 * 预设作用域 7 个工具与 `installGlobalToolMask` 的离线单元测试。
 *
 * 覆盖：lib/preset/index.js（createDeps / createTools / installGlobalToolMask）与
 * tools/{stages,solutions,screen,device,game,emulator,logs}.js。
 *
 * 全部通过 createDeps 的测试接缝（detect / run / copilot / arkrec / ledger）注入假实现：
 * 不联网、不跑 adb/MuMuManager、不碰 MAA 与模拟器；临时资源目录一律建在 os.tmpdir() 下。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDeps, createTools, installGlobalToolMask } from '../lib/preset/index.js';
import { createToolDefinitions } from '../lib/index.js';
import { PNG_MAGIC, pruneShots } from '../lib/preset/tools/screen.js';
import { is169, parseForeground, parseWmSize } from '../lib/preset/tools/device.js';
import { DEFAULT_COMPONENT, DEFAULT_PACKAGE, parseStartComponent, resolveGameTarget } from '../lib/preset/tools/game.js';
import { renderStatus } from '../lib/preset/tools/emulator.js';

/** 预设工具的固定顺序（docs/contracts.md 与 lib/preset/index.js 一致）。 */
const PRESET_TOOL_NAMES = ['ark_stages', 'ark_solutions', 'ark_screen', 'ark_device', 'ark_game', 'ark_emulator', 'ark_log'];

/** 夹具：关卡表（code/stageId/apCost/dropInfos）。 */
const STAGES = [
  { code: '5-10', stageId: 'main_05-10', apCost: 18, dropInfos: [{ itemId: '30012' }, { itemId: '30061' }] },
  { code: '5-10', stageId: 'tough_05-10', apCost: 18, dropInfos: [] },
  { code: '5-11', stageId: 'main_05-11', apCost: 18, dropInfos: [{ itemId: '30061' }] },
  { code: 'CE-6', stageId: 'CE-6', apCost: 36, dropInfos: [{ itemId: '30012' }] },
  { code: '1-7', stageId: 'main_01-07', apCost: 6, dropInfos: [{ itemId: '30012' }] },
  { code: '7-2', stageId: 'main_07-02', apCost: 18, dropInfos: [] },
];

/** 夹具：材料 id → 中文名。 */
const ITEM_INDEX = {
  30012: { name: '固源岩' },
  30061: { name: '炽合金' },
};

/** 临时目录统一登记，测试结束一次性删掉。 */
const TMP_DIRS = [];

/**
 * 建一个临时目录并登记清理。
 * @param {string} prefix - 目录名前缀。
 * @returns {Promise<string>} 绝对路径。
 */
async function makeTmp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/** 夹具 MAA 根目录（before 里创建）。 */
let MAA_ROOT = '';

before(async () => {
  MAA_ROOT = await makeTmp('dsh-ark-preset-maa-');
  await fs.mkdir(path.join(MAA_ROOT, 'resource'), { recursive: true });
  await fs.writeFile(path.join(MAA_ROOT, 'resource', 'stages.json'), JSON.stringify(STAGES), 'utf8');
  await fs.writeFile(path.join(MAA_ROOT, 'resource', 'item_index.json'), JSON.stringify(ITEM_INDEX), 'utf8');
  // ark_game 读的 MAA 客户端配置（真实 MAA 的形状）
  await fs.writeFile(path.join(MAA_ROOT, 'resource', 'config.json'), JSON.stringify({
    packageName: {
      Official: 'com.hypergryph.arknights',
      Bilibili: 'com.hypergryph.arknights.bilibili',
    },
    connection: [{
      configName: 'General',
      start: '[Adb] -s [AdbSerial] shell am start -n [PackageName]/com.u8.sdk.U8UnityContext',
    }],
  }), 'utf8');
});

after(async () => {
  await Promise.all(TMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

/**
 * 造一个探测结果（工具的 detect 接缝返回它）。
 * @param {Record<string, any>} [overrides] - 覆盖字段（emulator 会做一层合并）。
 * @returns {Record<string, any>} 探测结果。
 */
function detection(overrides = {}) {
  const emulator = {
    managerFound: false,
    running: false,
    androidStarted: false,
    adbOnline: false,
    vmIndex: 0,
    name: '',
    errorCode: null,
    ...(overrides.emulator ?? {}),
  };
  return {
    maaPath: MAA_ROOT,
    maaTried: ['C:\\MAA'],
    mumuInstallPath: '',
    managerPath: '',
    mumuTried: ['C:\\MuMu'],
    vmConfig: null,
    vmIndex: 0,
    adbPath: 'adb',
    adbTried: ['C:\\adb'],
    address: '127.0.0.1:16384',
    pythonPath: '',
    ...overrides,
    emulator,
  };
}

/**
 * 造一个 detect 接缝：可以给多组结果，按调用次数依次返回（最后一组保持）。
 * @param {...Record<string, any>} values - 依次返回的探测覆盖。
 * @returns {Function & { calls: Array<Record<string, any>> }} detect 假实现。
 */
function makeDetect(...values) {
  /** @type {Array<Record<string, any>>} */
  const calls = [];
  const detect = async (input = {}) => {
    calls.push(input);
    const value = values[Math.min(calls.length - 1, values.length - 1)] ?? {};
    return detection(value);
  };
  detect.calls = calls;
  return detect;
}

/**
 * 造一个 run 接缝（cli / cliBuffer / adb），默认全部成功并记录调用。
 * @returns {{ run: Record<string, Function>, calls: { cli: any[], cliBuffer: any[], adb: any[] } }} 结果。
 */
function makeRun() {
  const calls = { cli: [], cliBuffer: [], adb: [] };
  return {
    calls,
    run: {
      cli: async (...args) => {
        calls.cli.push(args);
        return { ok: true, stdout: '', stderr: '', code: 0 };
      },
      cliBuffer: async (...args) => {
        calls.cliBuffer.push(args);
        return { ok: true, buffer: Buffer.alloc(0), stderr: '' };
      },
      adb: async (...args) => {
        calls.adb.push(args);
        return { ok: true, stdout: '', stderr: '' };
      },
    },
  };
}

/**
 * 造一个按命令分发的 adb 假实现（ark_device / ark_game 用）。
 * @param {Record<string, Function>} handlers - `命令子串 → () => 结果`。
 * @returns {{ adb: Function, calls: Array<{ adbPath: string, address: string, command: string[] }> }} 结果。
 */
function makeAdbRouter(handlers = {}) {
  const calls = [];
  return {
    calls,
    adb: async (adbPath, address, command) => {
      calls.push({ adbPath, address, command });
      const joined = command.join(' ');
      for (const [needle, handler] of Object.entries(handlers)) {
        if (joined.includes(needle)) return handler();
      }
      return { ok: true, stdout: '', stderr: '' };
    },
  };
}

/** 假账本：`get` 查表，其余写操作空实现。 */
function makeLedger(records = {}) {
  return {
    get: (code) => records[code],
    recordRun: () => {},
    recordFailure: () => {},
    setPush: () => {},
    nextPushStage: () => '',
    pushView: () => ({}),
  };
}

/** 假 ArkRec 客户端。 */
function makeArkrec(describe = async () => null) {
  return { describe };
}

/**
 * 造一整套预设依赖 + 按名字索引的工具。
 * @param {{ config?: Record<string, any>, detect?: Function, run?: Record<string, Function>,
 *   copilot?: Record<string, any>, arkrec?: Record<string, any>, ledger?: Record<string, any> }} [options]
 *   覆盖项。
 * @returns {{ deps: Record<string, any>, tools: object[], byName: Record<string, any> }} 结果。
 */
function makeHarness(options = {}) {
  const deps = createDeps(options.config ?? {}, {
    detect: options.detect ?? makeDetect({}),
    run: options.run ?? makeRun().run,
    copilot: options.copilot ?? { query: async () => ({ solutions: [], total: 0, reason: '' }), pick: (list) => list },
    arkrec: options.arkrec ?? makeArkrec(),
    ledger: options.ledger ?? makeLedger(),
    logger: { info() {}, warn() {}, error() {} },
  });
  const tools = createTools(deps);
  return { deps, tools, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

/** 假作业站客户端（ark_solutions 只用到 query / pick）。 */
function makeSolutionsCopilot(solutions, total = solutions.length, reason = '') {
  const calls = { query: [], pick: [] };
  return {
    calls,
    query: async (code) => {
      calls.query.push(code);
      return { solutions, total, reason };
    },
    pick: (list, input) => {
      calls.pick.push(input);
      return list;
    },
  };
}

/** 作业站列表行（形状与 lib/copilot.js parseSolution 一致）。 */
const SOLUTIONS = [
  {
    id: 104178,
    stageName: 'main_05-10',
    title: '五人速刷',
    uploader: '博士A',
    opers: ['德克萨斯', '能天使'],
    available: true,
    ratingLevel: 9,
    hotScore: 12.3,
    mentionsRaid: false,
    contentRaw: '{}',
  },
  {
    id: 205500,
    stageName: 'tough_05-10',
    title: '磨难解法',
    uploader: '',
    opers: [],
    available: true,
    ratingLevel: 3,
    hotScore: 1.5,
    mentionsRaid: true,
    contentRaw: '{}',
  },
];

/** 从工具返回值里取文本并断言形状。 */
function toolText(result) {
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.text, 'string', `工具返回值应有 text，实际：${JSON.stringify(result)}`);
  return result.text;
}

// —— 1. 工具表 ——

test('preset tools: 7 个工具按固定顺序、描述与 JSON Schema 齐备', () => {
  const { tools } = makeHarness();
  assert.deepEqual(tools.map((tool) => tool.name), PRESET_TOOL_NAMES);
  for (const tool of tools) {
    assert.ok(tool.description.length >= 20, `${tool.name} 的 description 太短`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.isConcurrencySafe, 'function');
  }
});

test('preset tools: ark_stages / ark_solutions 的文档化参数', () => {
  const { byName } = makeHarness();
  const stages = byName.ark_stages.parameters;
  assert.deepEqual(Object.keys(stages.properties).sort(), ['limit', 'query', 'scope']);
  assert.deepEqual(stages.properties.scope.enum, ['all', 'mainline', 'missing']);
  assert.equal(stages.properties.limit.type, 'integer');

  const solutions = byName.ark_solutions.parameters;
  assert.deepEqual(Object.keys(solutions.properties).sort(), ['difficulty', 'limit', 'minRating', 'stage']);
  assert.deepEqual(solutions.required, ['stage']);
  assert.deepEqual(solutions.properties.difficulty.enum, ['auto', 'easy', 'tough']);
});

// —— 2. ark_stages ——

test('ark_stages: 单关详情含中文名/理智/难度/掉落/账本', async () => {
  const { byName } = makeHarness({
    arkrec: makeArkrec(async (code) => (code === '5-10'
      ? {
        cn_name: '长夜终尽',
        story: '主线',
        group: '第五章',
        challenge: '部署费用三倍',
        minOperators: 4,
        url: 'https://wiki.arkrec.com/operation/5-10',
      }
      : null)),
    ledger: makeLedger({ '5-10': { fullStar: true, primeClaimed: true, stars: 3 } }),
  });
  const text = toolText(await byName.ark_stages.execute({ query: '5-10' }));
  assert.match(text, /关卡：5-10 长夜终尽/);
  assert.match(text, /归属：主线 · 第五章/);
  assert.match(text, /理智：18 \/ 次（难度 普通）/);
  assert.match(text, /可用难度：普通 \/ 磨难（险地\/磨难用 difficulty=tough）/);
  assert.match(text, /掉落：固源岩、炽合金/);
  assert.match(text, /突袭\/险地条件：部署费用三倍/);
  assert.match(text, /ArkRec 少人纪录：4 人/);
  assert.match(text, /账本：已满星 · 源石已领/);
});

test('ark_stages: 未满星账本显示上次星级', async () => {
  const { byName } = makeHarness({ ledger: makeLedger({ '5-10': { fullStar: false, stars: 2 } }) });
  const text = toolText(await byName.ark_stages.execute({ query: '5-10' }));
  assert.match(text, /账本：上次 2 星/);
});

test('ark_stages: 材料反查按理智升序', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_stages.execute({ query: '固源岩' }));
  assert.match(text, /掉落「固源岩」的关卡（按理智升序）：/);
  const rows = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^- 1-7 · 6 理智 · 掉落 固源岩/);
  assert.match(rows[1], /^- 5-10 · 18 理智 · 掉落 固源岩、炽合金/);
  assert.match(rows[2], /^- CE-6 · 36 理智 · 掉落 固源岩/);
});

test('ark_stages: 代码前缀列出（CE → CE-6）', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_stages.execute({ query: 'CE' }));
  assert.match(text, /代码以「CE」开头的关卡：/);
  assert.match(text, /- CE-6 · 36 理智/);
  assert.doesNotMatch(text, /- 5-10/);
});

test('ark_stages: 未知查询给可操作提示', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_stages.execute({ query: 'ZZZ' }));
  assert.match(text, /没查到「ZZZ」/);
  assert.match(text, /试试 CE-6、5-10、16-16/);
});

test('ark_stages: scope=mainline 列出主线序列', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_stages.execute({ scope: 'mainline' }));
  assert.match(text, /主线关卡（共 4 关，显示前 30）：/);
  const codes = text.split('\n').filter((line) => line.startsWith('- ')).map((line) => /^- (\S+)/.exec(line)?.[1]);
  assert.deepEqual(codes, ['1-7', '5-10', '5-11', '7-2']);
});

test('ark_stages: scope=missing 只列账本里有记录且未满星的关', async () => {
  const { byName } = makeHarness({
    ledger: makeLedger({
      '5-10': { fullStar: true },
      '5-11': { fullStar: false, stars: 2 },
      'CE-6': { fullStar: false, stars: 0 },
      '7-2': undefined,
    }),
  });
  const text = toolText(await byName.ark_stages.execute({ scope: 'missing' }));
  assert.match(text, /账本里未满星的关（2）：/);
  const rows = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^- 5-11/);
  assert.match(rows[1], /^- CE-6/);
  assert.doesNotMatch(text, /7-2/);
  assert.doesNotMatch(text, /1-7/);
});

test('ark_stages: 没有 MAA 时给出试过的路径（maaPath 为空）', async () => {
  const { byName } = makeHarness({
    detect: makeDetect({ maaPath: '', maaTried: ['C:\\A\\MaaCore.dll', 'C:\\B\\MaaCore.dll'] }),
  });
  const text = toolText(await byName.ark_stages.execute({ query: '5-10' }));
  assert.match(text, /没找到 MAA（MaaCore\.dll），查不了关卡表。/);
  assert.match(text, /试过：C:\\A\\MaaCore\.dll；C:\\B\\MaaCore\.dll/);
});

test('ark_stages: 默认 all + limit 截断', async () => {
  const { byName } = makeHarness();
  const all = toolText(await byName.ark_stages.execute({}));
  assert.match(all, /关卡表前 6 条（共 6）：/);
  const limited = toolText(await byName.ark_stages.execute({ limit: 2 }));
  assert.match(limited, /关卡表前 2 条（共 6）：/);
});

// —— 3. ark_solutions ——

test('ark_solutions: 作业行含 id/评分/干员与可复制的 ark_fight 调用串', async () => {
  const copilot = makeSolutionsCopilot(SOLUTIONS, 2);
  const { byName } = makeHarness({ copilot });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10' }));
  assert.match(text, /5-10 的作业（站上共 2 份，匹配 当前难度 2 份显示 2 条）：/);
  assert.match(text, /- id=104178 · 评分 9\/10（好评） · 热度 12\.3 · 干员 2/);
  assert.match(text, /需要：德克萨斯、能天使/);
  assert.match(text, /- id=205500 · 评分 3\/10 · 热度 1\.5 · 干员 0 \[险地\/磨难\]/);
  assert.match(text, /用它打：ark_fight stages=5-10 copilotId=104178 confirm=true/);
  assert.match(text, /（作业站列表接口的内容是截断版，真正执行时插件会按 id 取完整作业）/);
  assert.deepEqual(copilot.calls.query, ['5-10']);
  assert.equal(copilot.calls.pick.length, 1);
  assert.equal(copilot.calls.pick[0].code, '5-10');
  assert.equal(copilot.calls.pick[0].difficulty, 'auto');
});

test('ark_solutions: difficulty=tough 时调用串带 difficulty 且提示磨难/险地', async () => {
  const copilot = makeSolutionsCopilot(SOLUTIONS, 2);
  const { byName } = makeHarness({ copilot });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10', difficulty: 'tough' }));
  assert.match(text, /匹配 磨难\/险地 2 份显示 2 条/);
  assert.match(text, /用它打：ark_fight stages=5-10 difficulty=tough copilotId=104178 confirm=true/);
  assert.equal(copilot.calls.pick[0].difficulty, 'tough');
});

test('ark_solutions: minRating 过滤作业', async () => {
  const { byName } = makeHarness({ copilot: makeSolutionsCopilot(SOLUTIONS, 2) });
  const filtered = toolText(await byName.ark_solutions.execute({ stage: '5-10', minRating: 5 }));
  assert.match(filtered, /id=104178/);
  assert.doesNotMatch(filtered, /id=205500/);

  const none = toolText(await byName.ark_solutions.execute({ stage: '5-10', minRating: 10 }));
  assert.match(none, /没有评分 ≥ 10 的匹配作业/);
  assert.doesNotMatch(none, /用它打：/);
});

test('ark_solutions: 作业站没有作业时给原因与三条出路', async () => {
  const { byName } = makeHarness({
    copilot: makeSolutionsCopilot([], 0, '作业站返回 HTTP 503'),
  });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10' }));
  assert.match(text, /作业站上没查到「5-10」的作业（作业站返回 HTTP 503）。/);
  assert.match(text, /换关卡代码重试、用 file= 传本地作业/);
});

// —— 4. ark_screen ——

test('ark_screen: 抓到的 PNG 落到 screenshotDir 并按 keep 裁剪旧图', async () => {
  const shotDir = await makeTmp('dsh-ark-preset-shots-');
  for (let index = 0; index < 4; index += 1) {
    await fs.writeFile(path.join(shotDir, `a-${index}.png`), Buffer.from('old'));
  }
  const png = Buffer.concat([PNG_MAGIC, Buffer.from([0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])]);
  const { run, calls } = makeRun();
  run.cliBuffer = async (...args) => {
    calls.cliBuffer.push(args);
    return { ok: true, buffer: png, stderr: '' };
  };
  const { byName } = makeHarness({
    config: { screenshotDir: shotDir },
    detect: makeDetect({ address: 'x:1', emulator: { androidStarted: true } }),
    run,
  });
  const text = toolText(await byName.ark_screen.execute({ keep: 2 }));
  assert.match(text, /已抓图：/);
  assert.match(text, /用 read_image 打开这个路径/);

  const names = (await fs.readdir(shotDir)).filter((name) => name.endsWith('.png')).sort();
  assert.equal(names.length, 2, 'keep=2 应只留两张');
  const shotName = names.find((name) => name.startsWith('shot-'));
  assert.ok(shotName, `截图文件应叫 shot-*.png，实际：${names.join(', ')}`);
  assert.deepEqual(await fs.readFile(path.join(shotDir, shotName)), png);

  // 传给 adb 的参数：-s <address> exec-out screencap -p
  assert.deepEqual(calls.cliBuffer[0][1], ['-s', 'x:1', 'exec-out', 'screencap', '-p']);
});

test('ark_screen: pruneShots 只保留最近 keep 张 png，忽略非 png', async () => {
  const dir = await makeTmp('dsh-ark-preset-prune-');
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(dir, `0${index}.png`), 'x');
  }
  await fs.writeFile(path.join(dir, 'note.txt'), 'x');
  await pruneShots(dir, 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['03.png', '04.png', 'note.txt']);
});

test('ark_screen: 模拟器没开机 → E_CONNECT', async () => {
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { androidStarted: false } }),
  });
  const text = toolText(await byName.ark_screen.execute({}));
  assert.match(text, /抓图失败。/);
  assert.match(text, /E_CONNECT/);
  assert.match(text, /模拟器没有开机/);
});

test('ark_screen: screencap 返回的不是 PNG → E_CONNECT', async () => {
  const shotDir = await makeTmp('dsh-ark-preset-shot-junk-');
  const { run } = makeRun();
  run.cliBuffer = async () => ({ ok: true, buffer: Buffer.from('not-a-png'), stderr: 'junk' });
  const { byName } = makeHarness({
    config: { screenshotDir: shotDir },
    detect: makeDetect({ emulator: { androidStarted: true } }),
    run,
  });
  const text = toolText(await byName.ark_screen.execute({}));
  assert.match(text, /E_CONNECT/);
  assert.match(text, /screencap 没拿到有效 PNG/);
  assert.match(text, /建议：/);
});

test('ark_screen: 没找到 adb 时给提示（不抛）', async () => {
  const { byName } = makeHarness({ detect: makeDetect({ adbPath: '', adbTried: ['C:\\adb.exe'] }) });
  const text = toolText(await byName.ark_screen.execute({}));
  assert.match(text, /没找到 adb，抓不了图。/);
  assert.match(text, /试过：C:\\adb\.exe/);
});

// —— 5. ark_device ——

test('ark_device: 读出分辨率/机型/前台，游戏在前台', async () => {
  const { adb, calls } = makeAdbRouter({
    'wm size': () => ({ ok: true, stdout: 'Physical size: 1920x1080\nOverride size: 1920x1080\n', stderr: '' }),
    getprop: () => ({ ok: true, stdout: 'MuMu 12\n', stderr: '' }),
    dumpsys: () => ({
      ok: true,
      stdout: '  ResumedActivity: ActivityRecord{abc123 u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t42}\n',
      stderr: '',
    }),
  });
  const run = { ...makeRun().run, adb };
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run,
  });
  const text = toolText(await byName.ark_device.execute());
  assert.match(text, /adb：adb · 设备 127\.0\.0\.1:16384 · 在线/);
  assert.match(text, /分辨率：1920x1080/);
  assert.match(text, /机型：MuMu 12/);
  assert.match(text, /前台：com\.hypergryph\.arknights\/com\.u8\.sdk\.U8UnityContext/);
  assert.match(text, /游戏在前台 ✅/);
  assert.doesNotMatch(text, /不是 16:9/);
  assert.deepEqual(calls.map((call) => call.command), [
    ['shell', 'wm', 'size'],
    ['shell', 'getprop', 'ro.product.model'],
    ['shell', 'dumpsys', 'activity', 'activities'],
  ]);
});

test('ark_device: 非 16:9 分辨率给警告', async () => {
  const { adb } = makeAdbRouter({
    'wm size': () => ({ ok: true, stdout: 'Physical size: 1280x800\n', stderr: '' }),
    getprop: () => ({ ok: true, stdout: 'MuMu\n', stderr: '' }),
    dumpsys: () => ({ ok: true, stdout: '  ResumedActivity: ActivityRecord{abc u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t1}\n', stderr: '' }),
  });
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run: { ...makeRun().run, adb },
  });
  const text = toolText(await byName.ark_device.execute());
  assert.match(text, /分辨率：1280x800/);
  assert.match(text, /⚠️ 当前不是 16:9 分辨率/);
  assert.match(text, /1920×1080/);
});

test('ark_device: adb 离线时打印建议块且不跑任何 adb 命令', async () => {
  const { adb, calls } = makeAdbRouter({});
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, adbOnline: false, name: 'MuMu-12' } }),
    run: { ...makeRun().run, adb },
  });
  const text = toolText(await byName.ark_device.execute());
  assert.match(text, /adb：adb · 设备 127\.0\.0\.1:16384 · 离线/);
  assert.match(text, /模拟器：未开机（MuMu-12 #0）/);
  assert.match(text, /结论：adb 不可用/);
  assert.match(text, /建议：① ark_emulator start/);
  assert.equal(calls.length, 0);
});

test('device 解析函数：parseWmSize / parseForeground / is169', () => {
  assert.equal(parseWmSize('Physical size: 1920x1080\n'), '1920x1080');
  assert.equal(parseWmSize('Override size: 1600x900\n'), '1600x900');
  assert.equal(parseWmSize('garbage'), null);
  assert.equal(parseWmSize(undefined), null);

  assert.equal(
    parseForeground('  ResumedActivity: ActivityRecord{1a2b u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t42}\n'),
    'com.hypergryph.arknights/com.u8.sdk.U8UnityContext',
  );
  assert.equal(
    parseForeground('  topResumedActivity=ActivityRecord{1a2b u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t42}\n'),
    'com.hypergryph.arknights/com.u8.sdk.U8UnityContext',
  );
  assert.equal(parseForeground('no activity here'), null);

  assert.equal(is169('1920x1080'), true);
  assert.equal(is169('2560x1440'), true);
  assert.equal(is169('1280x800'), false);
  assert.equal(is169('1600x1000'), false);
  assert.equal(is169('not-a-resolution'), true);
});

// —— 6. ark_game ——

test('resolveGameTarget: 优先 MAA config.json，缺省回退官方包名', async () => {
  const target = await resolveGameTarget(MAA_ROOT, 'Official');
  assert.deepEqual(target, {
    packageName: 'com.hypergryph.arknights',
    component: DEFAULT_COMPONENT,
    source: 'maa',
  });
  const bilibili = await resolveGameTarget(MAA_ROOT, 'Bilibili');
  assert.equal(bilibili.packageName, 'com.hypergryph.arknights.bilibili');
  assert.equal(bilibili.source, 'maa');

  const missing = await resolveGameTarget(path.join(MAA_ROOT, 'no-such-dir'), 'Official');
  assert.deepEqual(missing, { packageName: DEFAULT_PACKAGE, component: DEFAULT_COMPONENT, source: 'default' });
  assert.equal(await resolveGameTarget('', 'Official').then((value) => value.source), 'default');

  assert.equal(parseStartComponent('[Adb] -s [AdbSerial] shell am start -n [PackageName]/com.u8.sdk.U8UnityContext'), 'com.u8.sdk.U8UnityContext');
  assert.equal(parseStartComponent('no component here'), null);
});

test('ark_game: start/stop 传对 adb 参数', async () => {
  const { adb, calls } = makeAdbRouter({});
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run: { ...makeRun().run, adb },
  });
  const start = toolText(await byName.ark_game.execute({ action: 'start' }));
  assert.match(start, /已发送启动：com\.hypergryph\.arknights\/com\.u8\.sdk\.U8UnityContext/);
  assert.match(start, /（包名来自 MAA config\.json）/);
  assert.deepEqual(calls.at(-1).command, [
    'shell', 'am', 'start', '-n', 'com.hypergryph.arknights/com.u8.sdk.U8UnityContext',
  ]);

  const stop = toolText(await byName.ark_game.execute({ action: 'stop' }));
  assert.match(stop, /已强制关闭 com\.hypergryph\.arknights。/);
  assert.deepEqual(calls.at(-1).command, ['shell', 'am', 'force-stop', 'com.hypergryph.arknights']);
});

test('ark_game: adb 离线 → E_CONNECT，非法 action → E_BAD_ARGS', async () => {
  const offline = makeHarness({ detect: makeDetect({ emulator: { adbOnline: false } }) });
  const failText = toolText(await offline.byName.ark_game.execute({ action: 'start' }));
  assert.match(failText, /E_CONNECT/);
  assert.match(failText, /adb 不在线/);

  const online = makeHarness({ detect: makeDetect({ emulator: { adbOnline: true } }) });
  const badText = toolText(await online.byName.ark_game.execute({ action: 'reboot' }));
  assert.match(badText, /E_BAD_ARGS/);
  assert.match(badText, /action 只能是 start 或 stop/);
});

// —— 7. ark_emulator ——

test('renderStatus: 渲染实例/三态/地址/错误码', () => {
  const text = renderStatus({
    vmIndex: 1,
    address: '127.0.0.1:16384',
    managerPath: 'C:\\MuMu\\MuMuManager.exe',
    vmConfig: { width: 1920, height: 1080 },
    emulator: {
      name: 'MuMu-12',
      running: true,
      androidStarted: true,
      adbOnline: true,
      errorCode: 5,
    },
  });
  assert.match(text, /实例：#1 MuMu-12/);
  assert.match(text, /进程：运行中 · 安卓：已启动 · adb：在线/);
  assert.match(text, /adb 地址：127\.0\.0\.1:16384 · 分辨率 1920×1080/);
  assert.match(text, /MuMuManager：C:\\MuMu\\MuMuManager\.exe/);
  assert.match(text, /MuMu 错误码：5/);
});

test('ark_emulator: status 走 detect，stop 调 MuMuManager shutdown', async () => {
  const { run, calls } = makeRun();
  const { byName } = makeHarness({
    detect: makeDetect({
      managerPath: 'C:\\MuMu\\MuMuManager.exe',
      emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, name: 'MuMu-12' },
    }),
    run,
  });
  const status = toolText(await byName.ark_emulator.execute({ action: 'status' }));
  assert.match(status, /实例：#0 MuMu-12/);
  assert.match(status, /进程：运行中/);

  const stop = toolText(await byName.ark_emulator.execute({ action: 'stop' }));
  assert.match(stop, /已发送关闭指令（实例 #0）。/);
  assert.deepEqual(calls.cli[0], [
    'C:\\MuMu\\MuMuManager.exe',
    ['control', '-v', '0', 'shutdown'],
    { timeoutMs: 30000 },
  ]);
});

test('ark_emulator: 已开机时 start 不发 launch 指令', async () => {
  const { run, calls } = makeRun();
  const { byName } = makeHarness({
    detect: makeDetect({
      managerPath: 'C:\\MuMu\\MuMuManager.exe',
      emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true },
    }),
    run,
  });
  const text = toolText(await byName.ark_emulator.execute({ action: 'start' }));
  assert.match(text, /模拟器已经开机。/);
  assert.equal(calls.cli.length, 0);
});

test('ark_emulator: 未开机时 start 发 launch 并等到安卓启动（≈3s 轮询）', async () => {
  const { run, calls } = makeRun();
  const { deps, byName } = makeHarness({
    detect: makeDetect(
      { managerPath: 'C:\\MuMu\\MuMuManager.exe', emulator: { managerFound: true, running: false, androidStarted: false } },
      { managerPath: 'C:\\MuMu\\MuMuManager.exe', emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, name: 'MuMu-12' } },
    ),
    run,
  });
  // 只保留一次轮询（真实 sleep 仍是 3s，避免第二个 3s 周期）
  deps.config.launchTimeoutMs = 100;
  const text = toolText(await byName.ark_emulator.execute({ action: 'start' }));
  assert.match(text, /模拟器已开机（用时约 \d+s）。/);
  assert.equal(calls.cli.length, 1);
  assert.deepEqual(calls.cli[0][1], ['control', '-v', '0', 'launch']);
});

test('ark_emulator: 找不到 MuMuManager / 非法 action 都给明确错误', async () => {
  const notFound = toolText(await makeHarness({ detect: makeDetect({ managerPath: '' }) }).byName.ark_emulator.execute({ action: 'status' }));
  assert.match(notFound, /E_EMULATOR_NOT_FOUND/);
  assert.match(notFound, /没找到 MuMuManager\.exe。/);

  const badAction = toolText(await makeHarness({
    detect: makeDetect({ managerPath: 'C:\\MuMu\\MuMuManager.exe' }),
  }).byName.ark_emulator.execute({ action: 'reboot' }));
  assert.match(badAction, /E_BAD_ARGS/);
  assert.match(badAction, /action 只能是 status \/ start \/ stop/);
});

// —— 8. ark_log ——

/** 写一份混合级别的 MAA 日志，返回路径。 */
async function writeSampleLog() {
  const dir = await makeTmp('dsh-ark-preset-log-');
  const file = path.join(dir, 'asst.log');
  await fs.writeFile(file, [
    '[2026-10-28 10:00:00.000][INF][Px1] start up',
    '[2026-10-28 10:00:01.000][WRN][Px1] warn one',
    '[2026-10-28 10:00:02.000][ERR][Px1] err one',
    '[2026-10-28 10:00:03.000][INF][Px1] middle line',
    '[2026-10-28 10:00:04.000][FTL][Px1] fatal one',
  ].join('\n') + '\n', 'utf8');
  return file;
}

test('ark_log: 默认取最后 N 行', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_log.execute({ lines: 2 }));
  assert.match(text, /筛选：all · 匹配 5 行 · 显示最后 2 行/);
  assert.match(text, /middle line/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /warn one/);
  assert.doesNotMatch(text, /err one/);
});

test('ark_log: level=error 只留 ERR/FTL', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_log.execute({ level: 'error' }));
  assert.match(text, /筛选：error · 匹配 2 行 · 显示最后 2 行/);
  assert.match(text, /err one/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /warn one/);
  assert.doesNotMatch(text, /middle line/);
});

test('ark_log: level=warn 留 WRN/ERR/FTL', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_log.execute({ level: 'warn' }));
  assert.match(text, /筛选：warn · 匹配 3 行 · 显示最后 3 行/);
  assert.match(text, /warn one/);
  assert.match(text, /err one/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /start up/);
});

test('ark_log: 日志不存在时给路径与修复建议', async () => {
  const dir = await makeTmp('dsh-ark-preset-log-missing-');
  const file = path.join(dir, 'no-such-asst.log');
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_log.execute({}));
  assert.match(text, /读取日志失败。/);
  assert.match(text, /E_BAD_ARGS/);
  assert.match(text, /还没有日志文件：/);
  assert.match(text, /建议：/);
  assert.match(text, /ark_fight 会启动侧车/);
});

// —— 9. installGlobalToolMask ——

/**
 * 造一个假的插件上下文（tools / effect / logger）。
 * @param {{ schemas?: object[], schemasThrows?: boolean, restrictThrows?: boolean }} [options] - 行为开关。
 * @returns {{ ctx: Record<string, any>, calls: Record<string, any>, effects: any[], logs: any[][] }} 结果。
 */
function makeMaskCtx(options = {}) {
  const calls = { schemas: 0, restrict: [] };
  const effects = [];
  const logs = [];
  const schemas = options.schemas ?? [
    { name: 'ark_fight' },
    { name: 'steam_x' },
    { name: 'input_status' },
    { name: 'plans' },
    { name: 'run_code' },
  ];
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    effect: (callback) => {
      const disposer = callback();
      effects.push(disposer);
      return disposer;
    },
    tools: {
      schemas: () => {
        calls.schemas += 1;
        if (options.schemasThrows === true) throw new Error('schemas boom');
        return schemas;
      },
      restrict: (restriction) => {
        calls.restrict.push(restriction);
        if (options.restrictThrows === true) throw new Error('restrict boom');
        return () => {};
      },
    },
  };
  return { ctx, calls, effects, logs };
}

/**
 * 调掉所有 effect 的 disposer（清掉 2s 补屏蔽定时器）。
 * @param {any[]} effects - effect 返回值。
 * @returns {void}
 */
function disposeAll(effects) {
  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose();
  }
}

test('installGlobalToolMask: 只 deny 白名单之外的已注册工具', () => {
  const { ctx, calls, effects } = makeMaskCtx();
  try {
    const mask = installGlobalToolMask(ctx, { allowGlobalToolPrefixes: ['ark_', 'prts_', 'input_'] });
    assert.equal(mask.skip, false);
    assert.deepEqual(calls.restrict.at(-1).deny, ['steam_x', 'plans']);
    assert.ok(!calls.restrict.at(-1).deny.includes('ark_fight'));
    assert.ok(!calls.restrict.at(-1).deny.includes('input_status'));
    assert.deepEqual(mask.deny(), ['steam_x', 'plans']);
    assert.equal(calls.schemas, 1);
    assert.equal(effects.length, 2, '应有立即屏蔽 + 2s 补屏蔽两个 effect');
    for (const dispose of effects) assert.equal(typeof dispose, 'function');
  } finally {
    disposeAll(effects);
  }
});

test('installGlobalToolMask: 白名单为空 → skip 且不调用 restrict/schemas', () => {
  const { ctx, calls } = makeMaskCtx();
  const mask = installGlobalToolMask(ctx, { allowGlobalToolPrefixes: [] });
  assert.equal(mask.skip, true);
  assert.deepEqual(mask.deny(), []);
  assert.equal(calls.restrict.length, 0);
  assert.equal(calls.schemas, 0);
});

test('installGlobalToolMask: schemas 抛错被吞掉且不 restrict', () => {
  const { ctx, calls, effects, logs } = makeMaskCtx({ schemasThrows: true });
  try {
    const mask = installGlobalToolMask(ctx, { allowGlobalToolPrefixes: ['ark_'] });
    assert.equal(mask.skip, false);
    assert.equal(calls.restrict.length, 0);
    assert.deepEqual(mask.deny(), []);
    assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('读取工具表失败')));
  } finally {
    disposeAll(effects);
  }
});

test('installGlobalToolMask: restrict 抛错被吞掉（deny 仍可查）', () => {
  const { ctx, calls, effects, logs } = makeMaskCtx({ restrictThrows: true });
  try {
    const mask = installGlobalToolMask(ctx, { allowGlobalToolPrefixes: ['ark_', 'input_'] });
    assert.equal(mask.skip, false);
    assert.equal(calls.restrict.length, 1);
    assert.deepEqual(mask.deny(), ['steam_x', 'plans']);
    assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('屏蔽工具失败')));
  } finally {
    disposeAll(effects);
  }
});

test('installGlobalToolMask: 2s 补屏蔽定时器 unref，不会吊住 Node 进程', () => {
  const realSetTimeout = globalThis.setTimeout;
  /** @type {any} */
  let timerHandle = null;
  let unrefCalled = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = realSetTimeout(callback, delay, ...args);
    if (delay === 2000 && timerHandle === null) {
      timerHandle = handle;
      const originalUnref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefCalled = true;
        return originalUnref();
      };
    }
    return handle;
  };
  const { ctx, effects } = makeMaskCtx();
  try {
    installGlobalToolMask(ctx, { allowGlobalToolPrefixes: ['ark_'] });
    assert.notEqual(timerHandle, null, '应设置 2 秒补屏蔽定时器');
    assert.equal(unrefCalled, true, '定时器必须 unref，否则会吊住 Node 进程');
    assert.equal(timerHandle._idleTimeout, 2000);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    disposeAll(effects);
  }
});

// —— 10. 预设/全局工具互不重叠 ——

test('preset/global: 7 个预设工具与 5 个全局工具互不重叠，并集 12 个', () => {
  const presetNames = makeHarness().tools.map((tool) => tool.name);
  const globalTools = createToolDefinitions({ actions: {} });
  const globalNames = globalTools.map((tool) => tool.name);
  assert.deepEqual(globalNames, ['ark_status', 'ark_fight', 'ark_push', 'ark_rogue', 'ark_stop']);
  assert.equal(new Set([...presetNames, ...globalNames]).size, 12);
  for (const name of presetNames) {
    assert.equal(globalNames.includes(name), false, `${name} 不应同时出现在全局工具表`);
  }
  assert.deepEqual([...new Set(presetNames)], PRESET_TOOL_NAMES);
});

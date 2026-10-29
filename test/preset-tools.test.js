/**
 * 预设作用域 2 个工具（`ark_diag` / `ark_solutions`）与 `installGlobalToolMask` 的离线单元测试。
 *
 * 覆盖：lib/preset/index.js（createDeps / createTools / installGlobalToolMask / apply / 激活报告）、
 * lib/preset/config.js（配置归一与路径）、lib/preset/tools/diag.js（六个 action 的纯逻辑与假 adb 输出）、
 * lib/preset/tools/solutions.js（作业站过滤与调用串）。
 *
 * 全部通过 createDeps 的测试接缝（detect / run / copilot / sleep）注入假实现：
 * 不联网、不跑 adb/MuMuManager、不碰 MAA 与模拟器；临时资源目录一律建在 os.tmpdir() 下。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GLOBAL_TOOL_NAMES, PRESET_TOOL_NAMES, PRTS_TOOL_NAMES } from '../lib/contracts.js';
import {
  apply,
  createDeps,
  createTools,
  installGlobalToolMask,
  writeActivationReport,
} from '../lib/preset/index.js';
import { normalizePresetConfig, PRESET_VERSION, resolvePresetPaths } from '../lib/preset/config.js';
import {
  DEFAULT_COMPONENT,
  DEFAULT_PACKAGE,
  is169,
  parseForeground,
  parsePngSize,
  parseStartComponent,
  parseWmSize,
  PNG_SIGNATURE,
  pruneShots,
  readLogWindow,
  renderEmulatorStatus,
  resolveGameTarget,
} from '../lib/preset/tools/diag.js';
import { difficultyLabel, isRaidSolution } from '../lib/preset/tools/solutions.js';

/** 夹具：关卡表（code/stageId/apCost/dropInfos）。 */
const STAGES = [
  { code: '5-10', stageId: 'main_05-10', apCost: 18, dropInfos: [{ itemId: '30012' }] },
  { code: '5-10', stageId: 'tough_05-10', apCost: 18, dropInfos: [] },
  { code: 'CE-6', stageId: 'CE-6', apCost: 36, dropInfos: [{ itemId: '30012' }] },
];

/** 夹具：材料 id → 中文名（loadResources 需要）。 */
const ITEM_INDEX = { 30012: { name: '固源岩' } };

/** 临时目录统一登记，测试结束一次性删掉。 */
const TMP_DIRS = [];

/** 夹具 MAA 根目录（before 里创建）。 */
let MAA_ROOT = '';

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

before(async () => {
  MAA_ROOT = await makeTmp('dsh-ark-preset-maa-');
  await fs.mkdir(path.join(MAA_ROOT, 'resource'), { recursive: true });
  await fs.writeFile(path.join(MAA_ROOT, 'resource', 'stages.json'), JSON.stringify(STAGES), 'utf8');
  await fs.writeFile(path.join(MAA_ROOT, 'resource', 'item_index.json'), JSON.stringify(ITEM_INDEX), 'utf8');
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

// —— 夹具 ——

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
    adbTried: ['C:\\adb.exe'],
    address: '127.0.0.1:16384',
    pythonPath: '',
    pythonVersion: '',
    pythonTried: [],
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
 * 造一个按命令分发的 adb 假实现（device / game 用）。
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

/**
 * 造一整套预设依赖 + 按名字索引的工具。
 * @param {{ config?: Record<string, any>, detect?: Function, run?: Record<string, Function>,
 *   copilot?: Record<string, any>, sleep?: Function, logger?: Record<string, any> }} [options] 覆盖项。
 * @returns {{ deps: Record<string, any>, tools: object[], byName: Record<string, any> }} 结果。
 */
function makeHarness(options = {}) {
  const deps = createDeps(options.config ?? {}, {
    detect: options.detect ?? makeDetect({}),
    run: options.run ?? makeRun().run,
    copilot: options.copilot ?? {
      query: async () => ({ solutions: [], total: 0, reason: '' }),
      pick: (list) => list,
    },
    sleep: options.sleep ?? (async () => {}),
    logger: options.logger ?? { info() {}, warn() {}, error() {} },
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

/**
 * 造一个 PNG 块。
 * @param {string} type - 4 字符块类型。
 * @param {Buffer} data - 块数据。
 * @returns {Buffer} 块字节。
 */
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

/**
 * 造一个最小可解析 PNG（签名 + IHDR；CRC 留 0，解析器不校验 CRC）。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @returns {Buffer} PNG 字节。
 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), Buffer.from([0x00, 0x00, 0x00, 0x00])]);
}

// ============================================================
// 1. 工具表
// ============================================================

test('preset tools: 2 个工具、顺序与 contracts 一致、描述与 JSON Schema 齐备', () => {
  const { tools } = makeHarness();
  assert.deepEqual(tools.map((tool) => tool.name), PRESET_TOOL_NAMES);
  assert.deepEqual(tools.map((tool) => tool.name), ['ark_diag', 'ark_solutions']);
  for (const tool of tools) {
    assert.ok(tool.description.length >= 40, `${tool.name} 的 description 太短`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.isConcurrencySafe, 'function');
  }
});

test('preset tools: ark_diag 的 action 六值必填，子动作参数都有枚举', () => {
  const { byName } = makeHarness();
  const parameters = byName.ark_diag.parameters;
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['action', 'emulatorAction', 'gameAction', 'keep', 'level', 'lines']);
  assert.deepEqual(parameters.required, ['action']);
  assert.deepEqual(parameters.properties.action.enum, ['screen', 'logs', 'device', 'emulator', 'game', 'probe']);
  assert.equal(parameters.properties.action.type, 'string');
  assert.deepEqual(parameters.properties.level.enum, ['all', 'warn', 'error']);
  assert.deepEqual(parameters.properties.emulatorAction.enum, ['status', 'start', 'stop']);
  assert.deepEqual(parameters.properties.gameAction.enum, ['start', 'stop']);
  assert.equal(parameters.properties.keep.type, 'integer');
  assert.equal(parameters.properties.lines.type, 'integer');
});

test('preset tools: ark_solutions 的 stage 必填、difficulty 三档', () => {
  const { byName } = makeHarness();
  const parameters = byName.ark_solutions.parameters;
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['difficulty', 'limit', 'minRating', 'stage']);
  assert.deepEqual(parameters.required, ['stage']);
  assert.deepEqual(parameters.properties.difficulty.enum, ['auto', 'easy', 'tough']);
  assert.equal(parameters.properties.limit.type, 'integer');
  assert.equal(parameters.properties.minRating.type, 'integer');
});

// ============================================================
// 2. ark_diag — screen
// ============================================================

test('ark_diag screen: 抓图落盘、返回路径与 PNG 尺寸、按 keep 环形清理', async () => {
  const shotDir = await makeTmp('dsh-ark-preset-shots-');
  for (let index = 0; index < 4; index += 1) {
    await fs.writeFile(path.join(shotDir, `a-${index}.png`), Buffer.from('old'));
  }
  const png = makePng(1920, 1080);
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
  const text = toolText(await byName.ark_diag.execute({ action: 'screen', keep: 2 }));
  assert.match(text, /已抓图：/);
  assert.match(text, /尺寸 1920×1080/);
  assert.match(text, /目录只保留最近 2 张/);
  assert.match(text, /用 read_image 打开这个路径/);

  const names = (await fs.readdir(shotDir)).filter((name) => name.endsWith('.png')).sort();
  assert.equal(names.length, 2, 'keep=2 应只留两张');
  const shotName = names.find((name) => name.startsWith('shot-'));
  assert.ok(shotName, `截图文件应叫 shot-*.png，实际：${names.join(', ')}`);
  assert.deepEqual(await fs.readFile(path.join(shotDir, shotName)), png);
  assert.deepEqual(calls.cliBuffer[0][1], ['-s', 'x:1', 'exec-out', 'screencap', '-p']);
});

test('parsePngSize: 逐块走到 IHDR 取宽高；截断/非 PNG/坏块返回 null', () => {
  assert.deepEqual(parsePngSize(makePng(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(parsePngSize(makePng(2560, 1440)), { width: 2560, height: 1440 });

  // IHDR 不在第一个块：tEXt 之后仍能走块解析找到。
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1280, 0);
  ihdr.writeUInt32BE(720, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const walked = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('tEXt', Buffer.from('Comment\0hi', 'latin1')),
    pngChunk('IHDR', ihdr),
    Buffer.alloc(4),
  ]);
  assert.deepEqual(parsePngSize(walked), { width: 1280, height: 720 });

  assert.equal(parsePngSize(Buffer.alloc(0)), null);
  assert.equal(parsePngSize(Buffer.from('not-a-png-at-all')), null);
  assert.equal(parsePngSize(Buffer.concat([PNG_SIGNATURE, Buffer.from('garbage')])), null);
  assert.equal(parsePngSize(makePng(0, 1080)), null);
  assert.equal(parsePngSize(makePng(1920, 1080).subarray(0, 20)), null, '截断的 IHDR 应返回 null');
});

test('pruneShots: 只保留最近 keep 张 png，忽略非 png', async () => {
  const dir = await makeTmp('dsh-ark-preset-prune-');
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(dir, `0${index}.png`), 'x');
  }
  await fs.writeFile(path.join(dir, 'note.txt'), 'x');
  await pruneShots(dir, 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['03.png', '04.png', 'note.txt']);
});

test('ark_diag screen: 模拟器没开机 → E_CONNECT，提示 emulatorAction=start', async () => {
  const { byName } = makeHarness({ detect: makeDetect({ emulator: { androidStarted: false } }) });
  const text = toolText(await byName.ark_diag.execute({ action: 'screen' }));
  assert.match(text, /排查动作 screen 失败。/);
  assert.match(text, /E_CONNECT/);
  assert.match(text, /模拟器没有开机/);
  assert.match(text, /emulatorAction=start/);
});

test('ark_diag screen: screencap 返回的不是 PNG → E_CONNECT + 可执行提示', async () => {
  const shotDir = await makeTmp('dsh-ark-preset-shot-junk-');
  const { run } = makeRun();
  run.cliBuffer = async () => ({ ok: true, buffer: Buffer.from('not-a-png'), stderr: 'junk' });
  const { byName } = makeHarness({
    config: { screenshotDir: shotDir },
    detect: makeDetect({ emulator: { androidStarted: true } }),
    run,
  });
  const text = toolText(await byName.ark_diag.execute({ action: 'screen' }));
  assert.match(text, /E_CONNECT/);
  assert.match(text, /screencap 没拿到有效 PNG/);
  assert.match(text, /建议：/);
  assert.equal((await fs.readdir(shotDir)).length, 0, '失败时不应留下文件');
});

test('ark_diag screen: 没找到 adb 时给试过的路径与 probe 建议（不抛）', async () => {
  const { byName } = makeHarness({ detect: makeDetect({ adbPath: '', adbTried: ['C:\\adb.exe'] }) });
  const text = toolText(await byName.ark_diag.execute({ action: 'screen' }));
  assert.match(text, /没找到 adb，抓不了图。/);
  assert.match(text, /试过：C:\\adb\.exe/);
  assert.match(text, /action=probe/);
});

// ============================================================
// 3. ark_diag — logs
// ============================================================

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

test('ark_diag logs: 默认取最后 N 行', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_diag.execute({ action: 'logs', lines: 2 }));
  assert.match(text, /筛选：all · 窗口最后 400 行内匹配 5 行 · 显示 2 行/);
  assert.match(text, /middle line/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /warn one/);
  assert.doesNotMatch(text, /err one/);
});

test('ark_diag logs: level=error 只留 ERR/FTL', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_diag.execute({ action: 'logs', level: 'error' }));
  assert.match(text, /筛选：error · 窗口最后 400 行内匹配 2 行 · 显示 2 行/);
  assert.match(text, /err one/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /warn one/);
  assert.doesNotMatch(text, /middle line/);
});

test('ark_diag logs: level=warn 留 WRN/ERR/FTL', async () => {
  const file = await writeSampleLog();
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_diag.execute({ action: 'logs', level: 'warn' }));
  assert.match(text, /筛选：warn · 窗口最后 400 行内匹配 3 行 · 显示 3 行/);
  assert.match(text, /warn one/);
  assert.match(text, /err one/);
  assert.match(text, /fatal one/);
  assert.doesNotMatch(text, /start up/);
});

test('ark_diag logs: 日志不存在时给路径与修复建议', async () => {
  const dir = await makeTmp('dsh-ark-preset-log-missing-');
  const file = path.join(dir, 'no-such-asst.log');
  const { byName } = makeHarness({ config: { logFile: file } });
  const text = toolText(await byName.ark_diag.execute({ action: 'logs' }));
  assert.match(text, /E_BAD_ARGS/);
  assert.match(text, /还没有日志文件：/);
  assert.match(text, /建议：/);
  assert.match(text, /ark_fight 会启动侧车/);
});

test('readLogWindow: 只取窗口内最后 N 行', async () => {
  const dir = await makeTmp('dsh-ark-preset-log-window-');
  const file = path.join(dir, 'asst.log');
  await fs.writeFile(file, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n', 'utf8');
  const window = await readLogWindow(file, 3);
  assert.deepEqual(window.lines, ['line 8', 'line 9', 'line 10']);
  assert.equal(window.truncated, false);
});

// ============================================================
// 4. ark_diag — device
// ============================================================

test('ark_diag device: 读出分辨率/机型/前台，游戏在前台', async () => {
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
  const text = toolText(await byName.ark_diag.execute({ action: 'device' }));
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

test('ark_diag device: 非 16:9 分辨率给警告', async () => {
  const { adb } = makeAdbRouter({
    'wm size': () => ({ ok: true, stdout: 'Physical size: 1280x800\n', stderr: '' }),
    getprop: () => ({ ok: true, stdout: 'MuMu\n', stderr: '' }),
    dumpsys: () => ({ ok: true, stdout: '  ResumedActivity: ActivityRecord{abc u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t1}\n', stderr: '' }),
  });
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run: { ...makeRun().run, adb },
  });
  const text = toolText(await byName.ark_diag.execute({ action: 'device' }));
  assert.match(text, /分辨率：1280x800/);
  assert.match(text, /⚠️ 当前不是 16:9 分辨率/);
  assert.match(text, /1920×1080/);
});

test('ark_diag device: adb 离线时打印建议块且不跑任何 adb 命令', async () => {
  const { adb, calls } = makeAdbRouter({});
  const detect = makeDetect({ emulator: { managerFound: true, adbOnline: false, name: 'MuMu-12' } });
  const { byName } = makeHarness({ detect, run: { ...makeRun().run, adb } });
  const text = toolText(await byName.ark_diag.execute({ action: 'device' }));
  assert.match(text, /adb：adb · 设备 127\.0\.0\.1:16384 · 离线/);
  assert.match(text, /模拟器：未开机（MuMu-12 #0）/);
  assert.match(text, /结论：adb 不可用/);
  assert.match(text, /ark_diag action=emulator emulatorAction=start/);
  assert.equal(calls.length, 0);
  assert.equal(detect.calls[0].fresh, true, 'device 应强制重探（fresh=true）');
});

test('ark_diag device: wm size 报竖屏 16:9 时不误报（MAA 以实际截图分辨率为准）', async () => {
  const { adb } = makeAdbRouter({
    'wm size': () => ({ ok: true, stdout: 'Physical size: 1080x1920\n', stderr: '' }),
    getprop: () => ({ ok: true, stdout: 'MuMu\n', stderr: '' }),
    dumpsys: () => ({ ok: true, stdout: '  ResumedActivity: ActivityRecord{abc u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext t1}\n', stderr: '' }),
  });
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run: { ...makeRun().run, adb },
  });
  const text = toolText(await byName.ark_diag.execute({ action: 'device' }));
  assert.match(text, /分辨率：1080x1920/);
  assert.match(text, /是竖屏尺寸；旋转后实际为横屏 16:9/);
  assert.doesNotMatch(text, /⚠️ 当前不是 16:9/);
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
  assert.equal(is169('1080x1920'), true, '竖屏报告也按横屏 16:9 计算');
  assert.equal(is169('1280x800'), false);
  assert.equal(is169('1600x1000'), false);
  assert.equal(is169('800x1280'), false);
  assert.equal(is169('not-a-resolution'), true);
});

// ============================================================
// 5. ark_diag — emulator
// ============================================================

test('renderEmulatorStatus: 渲染实例/三态/地址/错误码', () => {
  const text = renderEmulatorStatus({
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

test('ark_diag emulator: status 走 detect，stop 调 MuMuManager shutdown', async () => {
  const { run, calls } = makeRun();
  const { byName } = makeHarness({
    detect: makeDetect({
      managerPath: 'C:\\MuMu\\MuMuManager.exe',
      emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, name: 'MuMu-12' },
    }),
    run,
  });
  const status = toolText(await byName.ark_diag.execute({ action: 'emulator' }));
  assert.match(status, /实例：#0 MuMu-12/);
  assert.match(status, /进程：运行中/);

  const stop = toolText(await byName.ark_diag.execute({ action: 'emulator', emulatorAction: 'stop' }));
  assert.match(stop, /已发送关闭指令（实例 #0）。/);
  assert.deepEqual(calls.cli[0], [
    'C:\\MuMu\\MuMuManager.exe',
    ['control', '-v', '0', 'shutdown'],
    { timeoutMs: 30000 },
  ]);
});

test('ark_diag emulator: 已开机时 start 不发 launch 指令', async () => {
  const { run, calls } = makeRun();
  const { byName } = makeHarness({
    detect: makeDetect({
      managerPath: 'C:\\MuMu\\MuMuManager.exe',
      emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true },
    }),
    run,
  });
  const text = toolText(await byName.ark_diag.execute({ action: 'emulator', emulatorAction: 'start' }));
  assert.match(text, /模拟器已经开机/);
  assert.equal(calls.cli.length, 0);
});

test('ark_diag emulator: 未开机时 start 发 launch 并等安卓启动', async () => {
  const { run, calls } = makeRun();
  const sleeps = [];
  const { byName } = makeHarness({
    detect: makeDetect(
      { managerPath: 'C:\\MuMu\\MuMuManager.exe', emulator: { managerFound: true, running: false, androidStarted: false } },
      { managerPath: 'C:\\MuMu\\MuMuManager.exe', emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, name: 'MuMu-12' } },
    ),
    run,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const text = toolText(await byName.ark_diag.execute({ action: 'emulator', emulatorAction: 'start' }));
  assert.match(text, /模拟器已开机（用时约 \d+s）。/);
  assert.equal(calls.cli.length, 1);
  assert.deepEqual(calls.cli[0][1], ['control', '-v', '0', 'launch']);
  assert.deepEqual(sleeps, [3000], '启动轮询步长应为 3s');
});

test('ark_diag emulator: 找不到 MuMuManager / 非法 emulatorAction 都给明确错误', async () => {
  const notFound = toolText(await makeHarness({ detect: makeDetect({ managerPath: '' }) }).byName.ark_diag.execute({ action: 'emulator' }));
  assert.match(notFound, /E_EMULATOR_NOT_FOUND/);
  assert.match(notFound, /没找到 MuMuManager\.exe。/);

  const badAction = toolText(await makeHarness({
    detect: makeDetect({ managerPath: 'C:\\MuMu\\MuMuManager.exe' }),
  }).byName.ark_diag.execute({ action: 'emulator', emulatorAction: 'reboot' }));
  assert.match(badAction, /E_BAD_ARGS/);
  assert.match(badAction, /emulatorAction 只能是 status \/ start \/ stop/);
});

// ============================================================
// 6. ark_diag — game
// ============================================================

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

test('ark_diag game: start/stop 传对 adb 参数', async () => {
  const { adb, calls } = makeAdbRouter({});
  const { byName } = makeHarness({
    detect: makeDetect({ emulator: { managerFound: true, androidStarted: true, adbOnline: true } }),
    run: { ...makeRun().run, adb },
  });
  const start = toolText(await byName.ark_diag.execute({ action: 'game', gameAction: 'start' }));
  assert.match(start, /已发送启动：com\.hypergryph\.arknights\/com\.u8\.sdk\.U8UnityContext/);
  assert.match(start, /（包名来自 MAA config\.json）/);
  assert.deepEqual(calls.at(-1).command, [
    'shell', 'am', 'start', '-n', 'com.hypergryph.arknights/com.u8.sdk.U8UnityContext',
  ]);

  const stop = toolText(await byName.ark_diag.execute({ action: 'game', gameAction: 'stop' }));
  assert.match(stop, /已强制关闭 com\.hypergryph\.arknights。/);
  assert.deepEqual(calls.at(-1).command, ['shell', 'am', 'force-stop', 'com.hypergryph.arknights']);
});

test('ark_diag game: 缺 gameAction / 非法 gameAction / adb 离线都给明确错误', async () => {
  const online = makeHarness({ detect: makeDetect({ emulator: { adbOnline: true } }) });
  const missing = toolText(await online.byName.ark_diag.execute({ action: 'game' }));
  assert.match(missing, /E_BAD_ARGS/);
  assert.match(missing, /必须显式给 gameAction=start 或 stop/);

  const bad = toolText(await online.byName.ark_diag.execute({ action: 'game', gameAction: 'reboot' }));
  assert.match(bad, /E_BAD_ARGS/);

  const offline = makeHarness({ detect: makeDetect({ emulator: { adbOnline: false } }) });
  const failText = toolText(await offline.byName.ark_diag.execute({ action: 'game', gameAction: 'start' }));
  assert.match(failText, /E_CONNECT/);
  assert.match(failText, /adb 不在线/);
});

// ============================================================
// 7. ark_diag — probe
// ============================================================

test('ark_diag probe: 强制重探（fresh + includePython）并列出 MAA/Python/MuMu/adb 与结论', async () => {
  const detect = makeDetect({
    maaPath: MAA_ROOT,
    pythonPath: 'C:\\py\\python.exe',
    pythonVersion: '3.12.14',
    pythonTried: ['C:\\py\\python.exe'],
    mumuInstallPath: 'C:\\MuMu',
    managerPath: 'C:\\MuMu\\shell\\MuMuManager.exe',
    adbPath: 'C:\\adb.exe',
    emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, name: 'MuMu-12' },
  });
  const { byName } = makeHarness({ detect });
  const text = toolText(await byName.ark_diag.execute({ action: 'probe' }));
  assert.equal(detect.calls.length, 1);
  assert.equal(detect.calls[0].fresh, true);
  assert.equal(detect.calls[0].includePython, true);
  assert.match(text, /环境探测（只读/);
  assert.match(text, /MAA：/);
  assert.match(text, /资源：resource\/stages\.json 存在/);
  assert.match(text, /Python：C:\\py\\python\.exe（3\.12\.14）/);
  assert.match(text, /MuMu：C:\\MuMu/);
  assert.match(text, /MuMuManager：C:\\MuMu\\shell\\MuMuManager\.exe/);
  assert.match(text, /adb：C:\\adb\.exe · 设备 127\.0\.0\.1:16384 · 在线/);
  assert.match(text, /结论：链路探测全部通过/);
});

test('ark_diag probe: 缺项时逐条给修复建议', async () => {
  const detect = makeDetect({
    maaPath: '',
    maaTried: ['C:\\A\\MaaCore.dll', 'C:\\B\\MaaCore.dll'],
    pythonPath: '',
    pythonTried: ['C:\\py\\python.exe'],
    mumuInstallPath: '',
    managerPath: '',
    mumuTried: ['C:\\MuMu'],
    adbPath: '',
    adbTried: ['C:\\adb.exe'],
  });
  const { byName } = makeHarness({ detect });
  const text = toolText(await byName.ark_diag.execute({ action: 'probe' }));
  assert.match(text, /MAA：未找到/);
  assert.match(text, /试过：C:\\A\\MaaCore\.dll；C:\\B\\MaaCore\.dll/);
  assert.match(text, /Python：未找到/);
  assert.match(text, /MuMu：未找到/);
  assert.match(text, /adb：未找到/);
  assert.match(text, /结论：有未通过项/);
  assert.match(text, /写 maaPath/);
  assert.match(text, /写 mumuInstallPath/);
  assert.match(text, /写 adbPath/);
});

test('ark_diag: 未知 / 缺失 action 给 E_BAD_ARGS 与六个合法值', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_diag.execute({ action: 'reboot' }));
  assert.match(text, /E_BAD_ARGS/);
  assert.match(text, /action 只能是 screen \/ logs \/ device \/ emulator \/ game \/ probe/);
});

// ============================================================
// 8. ark_solutions
// ============================================================

test('ark_solutions: 行含 id/评分/干员需求/is_raid/难度 与可复制的 ark_fight 调用串', async () => {
  const copilot = makeSolutionsCopilot(SOLUTIONS, 2);
  const { byName } = makeHarness({ copilot });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10' }));
  assert.match(text, /5-10 的作业（站上共 2 份，当前难度档匹配 2 份，显示 2 条）：/);
  assert.match(text, /- id=104178 · 评分 9\/10（好评） · 干员需求 2 · is_raid=否 · 难度=标准\/常规 · 热度 12\.3/);
  assert.match(text, /五人速刷 — 博士A/);
  assert.match(text, /需要：德克萨斯、能天使/);
  assert.match(text, /- id=205500 · 评分 3\/10 · 干员需求 0 · is_raid=是 · 难度=磨难\/险地 · 热度 1\.5/);
  assert.match(text, /磨难解法/);
  assert.match(text, /用它打：ark_fight stages=5-10 copilotId=104178 confirm=true/);
  assert.match(text, /（作业站列表接口的内容是截断版，真正执行时全局 ark_fight 会按 id 取完整作业）/);
  assert.deepEqual(copilot.calls.query, ['5-10']);
  assert.equal(copilot.calls.pick.length, 1);
  assert.equal(copilot.calls.pick[0].code, '5-10');
  assert.equal(copilot.calls.pick[0].difficulty, 'auto');
});

test('ark_solutions: difficulty=tough 时调用串带 difficulty 且标磨难/险地', async () => {
  const copilot = makeSolutionsCopilot([SOLUTIONS[1]], 1);
  const { byName } = makeHarness({ copilot });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10', difficulty: 'tough' }));
  assert.match(text, /磨难\/险地档匹配 1 份，显示 1 条/);
  assert.match(text, /is_raid=是 · 难度=磨难\/险地/);
  assert.match(text, /用它打：ark_fight stages=5-10 difficulty=tough copilotId=205500 confirm=true/);
  assert.equal(copilot.calls.pick[0].difficulty, 'tough');
});

test('ark_solutions: minRating 过滤作业；全被过滤时给 file= 备用', async () => {
  const { byName } = makeHarness({ copilot: makeSolutionsCopilot(SOLUTIONS, 2) });
  const filtered = toolText(await byName.ark_solutions.execute({ stage: '5-10', minRating: 5 }));
  assert.match(filtered, /id=104178/);
  assert.doesNotMatch(filtered, /id=205500/);

  const none = toolText(await byName.ark_solutions.execute({ stage: '5-10', minRating: 10 }));
  assert.match(none, /匹配到的作业评分都低于 minRating=10/);
  assert.match(none, /备用：ark_fight stages=5-10 file=<本地作业 JSON> confirm=true/);
  assert.doesNotMatch(none, /copilotId=/);
});

test('ark_solutions: 作业站没有作业时给原因与多条出路', async () => {
  const { byName } = makeHarness({
    copilot: makeSolutionsCopilot([], 0, '作业站返回 HTTP 503'),
  });
  const text = toolText(await byName.ark_solutions.execute({ stage: '5-10' }));
  assert.match(text, /作业站上没查到「5-10」的作业（作业站返回 HTTP 503）。/);
  assert.match(text, /用 file= 传本地作业 JSON/);
  assert.match(text, /copilotId= 直接指定/);
});

test('ark_solutions: 没找到 MAA / 关卡代码不认识都给可执行提示', async () => {
  const noMaa = makeHarness({
    detect: makeDetect({ maaPath: '', maaTried: ['C:\\A\\MaaCore.dll'] }),
  });
  const text = toolText(await noMaa.byName.ark_solutions.execute({ stage: '5-10' }));
  assert.match(text, /没找到 MAA（MaaCore\.dll），没法解析关卡代码。/);
  assert.match(text, /试过：C:\\A\\MaaCore\.dll/);
  assert.match(text, /action=probe/);

  const harness = makeHarness();
  const unknown = toolText(await harness.byName.ark_solutions.execute({ stage: 'ZZZ-9' }));
  assert.match(unknown, /查不到关卡「ZZZ-9」/);
  assert.match(unknown, /ark_data\(kind=stage/);
});

test('ark_solutions: 空白 stage 直接 E_BAD_ARGS', async () => {
  const { byName } = makeHarness();
  const text = toolText(await byName.ark_solutions.execute({ stage: '   ' }));
  assert.match(text, /E_BAD_ARGS/);
  assert.match(text, /stage 不能为空/);
});

test('solutions 纯函数：difficultyLabel / isRaidSolution', () => {
  assert.equal(difficultyLabel('auto'), '当前难度');
  assert.equal(difficultyLabel('easy'), '标准/常规');
  assert.equal(difficultyLabel('tough'), '磨难/险地');
  assert.equal(isRaidSolution({ mentionsRaid: true }), true);
  assert.equal(isRaidSolution({ stageName: 'tough_05-10' }), true);
  assert.equal(isRaidSolution({ mentionsRaid: false, stageName: 'main_05-10' }), false);
});

// ============================================================
// 9. installGlobalToolMask
// ============================================================

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

// ============================================================
// 10. apply / 激活报告 / 配置
// ============================================================

/**
 * 造一个 apply 用的假上下文（工具注册 + 屏蔽 + 日志）。
 * @param {{ registerThrows?: boolean }} [options] - 行为开关。
 * @returns {{ ctx: Record<string, any>, registered: Map<string, any>, restrictions: any[], effects: any[] }} 结果。
 */
function makeApplyCtx(options = {}) {
  const registered = new Map();
  const restrictions = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (callback) => {
      const disposer = callback();
      effects.push(disposer);
      return disposer;
    },
    tools: {
      register(definition) {
        if (options.registerThrows === true) throw new Error('register boom');
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      schemas: () => [
        { name: 'ark_diag' },
        { name: 'ark_solutions' },
        { name: 'steam_x' },
        { name: 'run_code' },
      ],
      restrict(restriction) {
        restrictions.push(restriction);
        return () => {};
      },
    },
  };
  return { ctx, registered, restrictions, effects };
}

test('apply: 注册 2 个工具、写 ok:true 激活报告、屏蔽无关工具', async () => {
  const reportFile = path.join(await makeTmp('dsh-ark-preset-report-'), 'activation.json');
  const { ctx, registered, restrictions, effects } = makeApplyCtx();
  try {
    await apply(ctx, {}, {
      detect: makeDetect({}),
      run: makeRun().run,
      copilot: makeSolutionsCopilot([]),
      reportFile,
    });
    assert.deepEqual([...registered.keys()], ['ark_diag', 'ark_solutions']);
    assert.deepEqual(restrictions.at(-1).deny, ['steam_x'], '只屏蔽白名单之外的工具（run_code 保留）');

    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.equal(report.presetVersion, PRESET_VERSION);
    assert.equal(report.presetVersion, '1.0.0');
    assert.equal(report.ok, true);
    assert.deepEqual(report.tools, ['ark_diag', 'ark_solutions']);
    assert.deepEqual(report.allowGlobalToolPrefixes, ['ark_', 'prts_', 'input_']);
    assert.deepEqual(report.maskedGlobals, ['steam_x']);
    assert.equal(typeof report.at, 'string');
  } finally {
    disposeAll(effects);
  }
});

test('apply: 注册失败时写 ok:false 现场并重新抛出', async () => {
  const reportFile = path.join(await makeTmp('dsh-ark-preset-report-fail-'), 'activation.json');
  const { ctx, effects } = makeApplyCtx({ registerThrows: true });
  try {
    await assert.rejects(
      () => apply(ctx, {}, {
        detect: makeDetect({}),
        run: makeRun().run,
        copilot: makeSolutionsCopilot([]),
        reportFile,
      }),
      /register boom/,
    );
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.equal(report.ok, false);
    assert.match(report.error, /register boom/);
    assert.deepEqual(report.tools, []);
  } finally {
    disposeAll(effects);
  }
});

test('writeActivationReport: 显式 file 写 JSON；无显式 file 时测试环境跳过', () => {
  const file = path.join(os.tmpdir(), `dsh-ark-preset-report-direct-${Date.now()}.json`);
  const written = writeActivationReport({ ok: true, tools: ['ark_diag'] }, { file });
  assert.equal(written, file);
  assert.equal(typeof written, 'string');
  const skipped = writeActivationReport({ ok: true }, {});
  assert.equal(skipped, null, 'node --test 下（NODE_TEST_CONTEXT）不应覆盖真实激活现场');
});

test('config: 默认值、范围夹紧、白名单去重', () => {
  const config = normalizePresetConfig({});
  assert.equal(config.maaPath, '');
  assert.equal(config.pythonPath, '');
  assert.equal(config.clientType, 'Official');
  assert.equal(config.maxScreenshots, 20);
  assert.equal(config.maxLogLines, 400);
  assert.equal(config.launchTimeoutMs, 120000);
  assert.deepEqual(config.allowGlobalToolPrefixes, ['ark_', 'prts_', 'input_']);
  assert.equal(config.copilot.api, 'https://prts.maa.plus');

  const clamped = normalizePresetConfig({
    maxScreenshots: 500,
    maxLogLines: 1,
    launchTimeoutMs: 1,
    allowGlobalToolPrefixes: ['ark_', 'ark_', ' prts_ ', ''],
  });
  assert.equal(clamped.maxScreenshots, 200);
  assert.equal(clamped.maxLogLines, 10);
  assert.equal(clamped.launchTimeoutMs, 10000);
  assert.deepEqual(clamped.allowGlobalToolPrefixes, ['ark_', 'prts_']);

  const empty = normalizePresetConfig({ allowGlobalToolPrefixes: [] });
  assert.deepEqual(empty.allowGlobalToolPrefixes, ['ark_', 'prts_', 'input_'], '空数组回退默认白名单');
});

test('config: 路径补默认值（userDir → debug/asst.log、截图目录）', () => {
  const paths = resolvePresetPaths(normalizePresetConfig({}));
  assert.ok(paths.userDir.includes('dsh-arknights'));
  assert.ok(paths.logFile.endsWith(path.join('debug', 'asst.log')));
  assert.ok(paths.screenshotDir.includes('dsh-arknights'));
  assert.ok(paths.copilotCacheDir.includes('copilot'));

  const custom = resolvePresetPaths(normalizePresetConfig({ userDir: 'C:\\maa', logFile: 'D:\\x\\asst.log', screenshotDir: 'D:\\shots' }));
  assert.equal(custom.logFile, 'D:\\x\\asst.log');
  assert.equal(custom.screenshotDir, 'D:\\shots');
});

// ============================================================
// 11. 工具名不相交
// ============================================================

test('preset/global/prts: 2 个预设工具与 13 全局 + 10 PRTS 互不重叠，并集 25 个', () => {
  const presetNames = makeHarness().tools.map((tool) => tool.name);
  assert.deepEqual(presetNames, PRESET_TOOL_NAMES);
  assert.equal(GLOBAL_TOOL_NAMES.length, 13);
  assert.equal(PRTS_TOOL_NAMES.length, 10);
  const all = [...presetNames, ...GLOBAL_TOOL_NAMES, ...PRTS_TOOL_NAMES];
  assert.equal(new Set(all).size, 25);
  for (const name of presetNames) {
    assert.equal(GLOBAL_TOOL_NAMES.includes(name), false, `${name} 不应同时出现在全局工具表`);
    assert.equal(PRTS_TOOL_NAMES.includes(name), false, `${name} 不应同时出现在 PRTS 工具表`);
  }
  for (const name of ['ark_stages', 'ark_screen', 'ark_device', 'ark_game', 'ark_emulator', 'ark_log']) {
    assert.equal(presetNames.includes(name), false, `旧预设工具 ${name} 应已被合并进 ark_diag`);
  }
});

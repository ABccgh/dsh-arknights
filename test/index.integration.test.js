/**
 * 插件入口集成测试：apply 注册 13 工具 + /ark 命令 + 3 个端点；createDeps 可注入。
 * 不联网、不启动侧车/模拟器。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { apply, createDeps, createToolDefinitions } from '../lib/index.js';
import { normalizeConfig, resolvePaths } from '../lib/config.js';
import { createState } from '../lib/state.js';
import { createLedger } from '../lib/ledger.js';
import { createBox } from '../lib/box.js';
import { createHistory } from '../lib/history.js';
import { makeLogger, makeTempDir, removeDir } from './helpers.mjs';

/**
 * 造 fake 环境。
 * @returns {any} env。
 */
function fakeEnv() {
  const detection = {
    maaPath: 'D:\\MAA',
    pythonPath: 'C:\\py\\python.exe',
    adbPath: 'C:\\adb.exe',
    address: '127.0.0.1:16384',
    managerPath: 'C:\\MuMuManager.exe',
    mumuInstallPath: 'C:\\MuMu',
    vmConfig: null,
    emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, vmIndex: 0, name: 'MuMu' },
  };
  const env = {
    getCalls: 0,
    peek: () => detection,
    get: async () => {
      env.getCalls += 1;
      return detection;
    },
    initArgs: async () => ({ maaPath: detection.maaPath, userDir: 'C:\\user', touchMode: 'minitouch', deploymentWithPause: false }),
    clear: () => {},
  };
  return env;
}

/**
 * 造 fake session。
 * @returns {any} session。
 */
function fakeSession() {
  return {
    info: null,
    disposeCalls: 0,
    ensureStarted: async () => ({ coreVersion: 'v6.21.0', resourceLoaded: true, protocolVersion: '2.0.0' }),
    request: async () => ({ running: false, connected: false }),
    getInfo() { return this.info; },
    isRunning: () => false,
    hold: () => {},
    release: () => {},
    subscribe: () => () => {},
    dispose() { this.disposeCalls += 1; },
  };
}

/**
 * 造 fake data。
 * @returns {any} data。
 */
function fakeData() {
  return {
    stage: async () => ({ matches: [] }),
    item: async () => ({ item: null }),
    operator: async () => ({ matches: [] }),
    activity: async () => ({ activities: [] }),
    search: async () => ({ stages: [], items: [], operators: [], activities: [] }),
    drops: async () => ({ candidates: [] }),
    plan: async () => ({ targets: [], totals: {} }),
    status: async () => ({ ok: true, stages: 0, items: 0, arkrec: { ok: false }, penguin: { ok: false }, activity: { ok: false } }),
    meta: () => ({ stages: 0, items: 0, arkrec: { ok: false, ageMs: null }, penguin: { ageMs: null }, activity: { ageMs: null }, warnings: [] }),
  };
}

/**
 * 造 fake ctx。
 * @returns {any} ctx。
 */
function fakeCtx() {
  const toolsList = [];
  const commandsList = [];
  const routes = [];
  const toolsApi = { register(definition) { toolsList.push(definition); return () => {}; } };
  const commandsApi = { register(definition) { commandsList.push(definition); return () => {}; } };
  const webServerApi = { register(route) { routes.push(route); return () => {}; } };
  return {
    tools: toolsApi,
    toolsList,
    commandsList,
    routes,
    logger: makeLogger(),
    effect(callback) { callback(); return () => {}; },
    get(name) {
      if (name === 'commands') return commandsApi;
      if (name === 'webServer') return webServerApi;
      return undefined;
    },
  };
}

/**
 * 造完整 deps。
 * @param {string} dir - 临时目录。
 * @returns {any} deps。
 */
function makeDeps(dir) {
  const config = normalizeConfig({
    ledgerFile: path.join(dir, 'progress.json'),
    box: { file: path.join(dir, 'box.json') },
    history: { file: path.join(dir, 'history.jsonl') },
    cacheDir: path.join(dir, 'cache'),
    copilot: { cacheDir: path.join(dir, 'copilot') },
    arkrec: { enabled: false },
    penguin: { enabled: false },
    activity: { enabled: false },
  });
  return createDeps(config, {
    logger: makeLogger(),
    env: fakeEnv(),
    state: createState(),
    session: fakeSession(),
    data: fakeData(),
    ledger: createLedger({ file: path.join(dir, 'progress.json'), logger: makeLogger() }),
    box: createBox({ file: path.join(dir, 'box.json'), logger: makeLogger() }),
    history: createHistory({ file: path.join(dir, 'history.jsonl'), maxEntries: 10, logger: makeLogger() }),
  });
}

test('index: createDeps 装配 13 工具，且不启动侧车', async () => {
  const dir = makeTempDir();
  try {
    const deps = makeDeps(dir);
    const tools = createToolDefinitions(deps);
    assert.equal(tools.length, 13);
    assert.deepEqual(tools.map((tool) => tool.name), [
      'ark_status', 'ark_fight', 'ark_push', 'ark_rogue', 'ark_daily', 'ark_recruit',
      'ark_infrast', 'ark_mall', 'ark_award', 'ark_box', 'ark_data', 'ark_plan', 'ark_stop',
    ]);
    assert.equal(deps.session.isRunning(), false);
    deps.session.dispose();
  } finally {
    removeDir(dir);
  }
});

test('index: apply 注册工具/命令/端点，且 status 可读', async () => {
  const dir = makeTempDir();
  try {
    const ctx = fakeCtx();
    const deps = makeDeps(dir);
    await apply(ctx, {}, {
      logger: makeLogger(),
      env: fakeEnv(),
      state: createState(),
      session: fakeSession(),
      data: fakeData(),
      ledger: deps.ledger,
      box: deps.box,
      history: deps.history,
    });
    assert.equal(ctx.toolsList.length, 13);
    assert.equal(ctx.commandsList.length, 1);
    assert.equal(ctx.commandsList[0].name, 'ark');
    assert.deepEqual(ctx.routes.map((route) => route.path).sort(), [
      '/arknights/action', '/arknights/query', '/arknights/status',
    ]);
    const statusTool = ctx.toolsList.find((tool) => tool.name === 'ark_status');
    const result = await statusTool.execute({}, {});
    assert.match(result.text, /明日方舟助手/);
  } finally {
    removeDir(dir);
  }
});

test('index: createDeps 对未归一配置也能兜底（自动 normalize）', () => {
  const deps = createDeps({ confirmRequired: false }, {
    logger: makeLogger(),
    env: fakeEnv(),
    state: createState(),
    session: fakeSession(),
    data: fakeData(),
  });
  assert.equal(deps.config.confirmRequired, false);
  assert.equal(deps.config.defaultDifficulty, 'auto');
  assert.equal(deps.paths.ledgerFile, resolvePaths(deps.config).ledgerFile);
  deps.session.dispose();
});


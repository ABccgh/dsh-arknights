// End-to-end test for lib/sidecar/maa_sidecar.py against the real MaaCore.dll.
//
// Run standalone with:
//   node --test test/sidecar.test.mjs
//
// What is covered (all *zero-resource* ops):
//   ready handshake (protocol 2.0.0), ping before init, init, append (never
//   started!), tasks, setParams, version, screenshot before/after connect,
//   backHome, stop, destroy and stdin EOF.
//
// It never calls `start`: no task chain is ever executed, so no sanity, no
// recruitment permits, no originite prime is consumed. The emulator only needs
// to be running for the screenshot/backHome subtests; every other check works
// without a device.
//
// It auto-skips when python.exe or MaaCore.dll is missing; the paths are
// auto-detected through lib/detect.js and can be overridden with
// DSH_ARKNIGHTS_PYTHON / DSH_ARKNIGHTS_MAA_PATH / DSH_ARKNIGHTS_ADB /
// DSH_ARKNIGHTS_ADDRESS.
//
// Protocol under test: docs/contracts.md §2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '../lib/contracts.js';
import { findAdb, findMaaPath, findMuMu, findPython, readVmConfig } from '../lib/detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// 路径解析顺序：环境变量 → 自动探测（扫盘/扫 .dsh 运行时）→ 空（空则下面自动 skip）。
const PYTHON = process.env.DSH_ARKNIGHTS_PYTHON || (await findPython({})).path;
const MAA_PATH = process.env.DSH_ARKNIGHTS_MAA_PATH || (await findMaaPath({})).path;
const SIDECAR_SCRIPT = path.join(REPO_ROOT, 'lib', 'sidecar', 'maa_sidecar.py');
const MAA_DLL = MAA_PATH === '' ? '' : path.join(MAA_PATH, 'MaaCore.dll');
const USER_DIR = path.join(os.tmpdir(), `dsh-arknights-sidecar-test-${process.pid}`);
const SHOT_DIR = path.join(os.tmpdir(), `dsh-arknights-sidecar-shots-${process.pid}`);

// 真机（模拟器）相关路径：探测不到就只跑零设备用例。
const MUMU = await findMuMu({});
const VM = MUMU.path === '' ? null : await readVmConfig(MUMU.path, 0);
const ADB_PATH = process.env.DSH_ARKNIGHTS_ADB || (await findAdb({}, { mumuInstallPath: MUMU.path, maaPath: MAA_PATH })).path;
const ADDRESS = process.env.DSH_ARKNIGHTS_ADDRESS || `127.0.0.1:${VM?.adbPort ?? 16384}`;

const skipReason = [
  PYTHON === '' || !fs.existsSync(PYTHON) ? `python.exe not found: ${PYTHON || '(auto-detect failed)'}` : null,
  MAA_DLL === '' || !fs.existsSync(MAA_DLL) ? `MaaCore.dll not found: ${MAA_DLL || '(auto-detect failed)'}` : null,
  !fs.existsSync(SIDECAR_SCRIPT) ? `sidecar script not found: ${SIDECAR_SCRIPT}` : null,
]
  .filter(Boolean)
  .join('; ');

// 真机实测的期望协议版本以 contracts.js 为唯一来源。
const EXPECTED_PROTOCOL = PROTOCOL_VERSION;

/**
 * Minimal NDJSON client for the sidecar process: reads protocol lines from
 * stdout, routes responses by id and collects async "maa" events.
 */
class SidecarClient {
  constructor() {
    this.child = spawn(PYTHON, ['-u', SIDECAR_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    this._stdoutDecoder = new StringDecoder('utf8');
    this._stderrDecoder = new StringDecoder('utf8');
    this._stdoutBuffer = '';
    this.rawLines = [];
    this.stderrText = '';
    this.pending = new Map();
    this.nextId = 1;
    this.messages = [];
    this.events = [];
    this.protocolErrors = [];
    this.firstMessage = null;
    this.readyEvent = null;
    this.exited = null;

    this._readySettled = false;
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });

    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrText = (this.stderrText + this._stderrDecoder.write(chunk)).slice(-12000);
    });
    this.child.on('error', (err) => this._failAll(err));
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      const err = new Error(
        `sidecar exited prematurely (code=${code}, signal=${signal})\n--- stderr ---\n${this.stderrTail()}`,
      );
      this._failAll(err);
      this._resolveExit({ code, signal });
    });
  }

  stderrTail() {
    const lines = this.stderrText.trim().split(/\r?\n/);
    return lines.slice(-25).join('\n');
  }

  _failAll(err) {
    if (!this._readySettled) {
      this._readySettled = true;
      this._rejectReady(err);
    }
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  _onStdout(chunk) {
    this._stdoutBuffer += this._stdoutDecoder.write(chunk);
    let index;
    while ((index = this._stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this._stdoutBuffer.slice(0, index);
      this._stdoutBuffer = this._stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        this.protocolErrors.push(`non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.rawLines.push({ line, message });
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    this.messages.push(message);
    if (this.firstMessage === null) this.firstMessage = message;

    if (message && message.event === 'ready') {
      this.readyEvent = message;
      if (!this._readySettled) {
        this._readySettled = true;
        this._resolveReady(message);
      }
      return;
    }
    if (message && message.event === 'maa') {
      this.events.push(message);
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message);
        return;
      }
      this.protocolErrors.push(
        `response for unknown id ${JSON.stringify(message.id)}: ${JSON.stringify(message).slice(0, 200)}`,
      );
      return;
    }
    this.protocolErrors.push(`unexpected stdout message: ${JSON.stringify(message).slice(0, 200)}`);
  }

  waitReady(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ready event within ${timeoutMs}ms\n--- stderr ---\n${this.stderrTail()}`)),
        timeoutMs,
      );
      this._readyPromise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  request(op, args = {}, timeoutMs = 60000) {
    if (this.exited) {
      return Promise.reject(new Error(`cannot send ${op}: sidecar already exited`));
    }
    const id = this.nextId++;
    const line = `${JSON.stringify({ id, op, args })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `sidecar request timed out after ${timeoutMs}ms: op=${op}\n--- stderr ---\n${this.stderrTail()}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.child.stdin.write(line, 'utf8');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  endInput() {
    try {
      this.child.stdin.end();
    } catch (err) {
      // Already closed; the exit wait below will surface the real state.
    }
  }

  waitExit(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`sidecar did not exit within ${timeoutMs}ms after stdin EOF`)),
        timeoutMs,
      );
      this._exitPromise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async dispose() {
    if (this.exited) return;
    this.endInput();
    const graceful = await Promise.race([
      this._exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!graceful && !this.exited) {
      try {
        this.child.kill();
      } catch (err) {
        // ignore
      }
    }
  }
}

function failureHint(response) {
  return JSON.stringify(response, null, 2);
}

/** 清掉临时目录（尽力而为）。 */
function cleanupDir(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

test('sidecar NDJSON protocol 2.0 with real MaaCore', { timeout: 300000 }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  // 初始化参数覆盖 gpuOcr=auto（默认不干预）也要能接受。
  const initArgs = {
    maaPath: MAA_PATH,
    userDir: USER_DIR,
    touchMode: 'minitouch',
    deploymentWithPause: false,
    gpuOcr: 'auto',
  };
  /** @type {{ taskId: number } | null} */
  let appended = null;
  let deviceReady = false;
  const client = new SidecarClient();
  try {
    await t.test('(a) emits ready 2.0.0 as the very first stdout line', async () => {
      const ready = await client.waitReady(30000);
      assert.equal(ready.event, 'ready');
      assert.equal(ready.platform, 'win32');
      assert.equal(ready.sidecarVersion, EXPECTED_PROTOCOL);
      assert.equal(ready.protocolVersion, EXPECTED_PROTOCOL);
      assert.match(ready.python, /^\d+\.\d+\.\d+$/);
      assert.equal(client.firstMessage, ready, 'ready must be the very first stdout message');
    });

    await t.test('(b) ping works before init and reports inited:false', async () => {
      const response = await client.request('ping');
      assert.equal(response.ok, true, failureHint(response));
      assert.deepEqual(response.result, { pong: true, inited: false });
    });

    await t.test('(c) version before init returns E_NOT_INIT (protocol 2.0 lifecycle)', async () => {
      const response = await client.request('version');
      assert.equal(response.ok, false, failureHint(response));
      assert.equal(response.error.code, 'E_NOT_INIT');
    });

    await t.test('(d) init loads the real MaaCore and reports protocolVersion 2.0.0', async () => {
      assert.equal(fs.existsSync(USER_DIR), false, 'user dir must not exist before init');
      const response = await client.request('init', initArgs, 180000);
      assert.equal(response.ok, true, failureHint(response));
      const { coreVersion, resourceLoaded, protocolVersion, maaPath, userDir } = response.result;
      assert.equal(typeof coreVersion, 'string');
      assert.match(coreVersion, /^v?\d+\.\d+/, `unexpected core version: ${coreVersion}`);
      assert.equal(resourceLoaded, true);
      assert.equal(protocolVersion, EXPECTED_PROTOCOL);
      assert.equal(path.resolve(maaPath).toLowerCase(), path.resolve(MAA_PATH).toLowerCase());
      assert.equal(path.resolve(userDir).toLowerCase(), path.resolve(USER_DIR).toLowerCase());
      assert.equal(fs.existsSync(USER_DIR), true, 'sidecar must create the user dir');
      // 目录名里的版本可能过时（本机目录 6.19、实际 6.21），只校验真实 coreVersion 可读。
      t.diagnostic(`coreVersion=${coreVersion}（目录名提示：${path.basename(MAA_PATH)}）`);
    });

    await t.test('(e) init is idempotent', async () => {
      const response = await client.request('init', initArgs, 60000);
      assert.equal(response.ok, true, failureHint(response));
      assert.equal(response.result.protocolVersion, EXPECTED_PROTOCOL);
    });

    await t.test('(f) append StartUp returns taskId > 0', async () => {
      const response = await client.request(
        'append',
        { type: 'StartUp', params: { client_type: 'Official', start_game_enabled: false } },
        60000,
      );
      assert.equal(response.ok, true, failureHint(response));
      assert.equal(typeof response.result.taskId, 'number');
      assert.ok(
        Number.isInteger(response.result.taskId) && response.result.taskId > 0,
        `taskId must be a positive integer, got ${response.result.taskId}`,
      );
      appended = { taskId: response.result.taskId };
    });

    await t.test('(g) append Bogus returns ok:false with E_TASK_TYPE', async () => {
      const response = await client.request('append', { type: 'Bogus', params: {} });
      assert.equal(response.ok, false, failureHint(response));
      assert.equal(response.error.code, 'E_TASK_TYPE');
      assert.equal(typeof response.error.message, 'string');
      // Error messages are Chinese: this proves UTF-8 bytes cross the pipe intact
      // and that JSON is emitted with ensure_ascii=False (non-ASCII on the wire).
      assert.match(response.error.message, /[\u4e00-\u9fff]/);
      const raw = client.rawLines.find(({ message }) => message.id === response.id);
      assert.ok(raw, 'response must be traceable to a raw stdout line');
      assert.match(raw.line, /[\u4e00-\u9fff]/, 'stdout JSON must be UTF-8, not \\u-escaped');
    });

    await t.test('(h) tasks lists the appended (not started) task id', async () => {
      assert.ok(appended !== null);
      const response = await client.request('tasks');
      assert.equal(response.ok, true, failureHint(response));
      assert.ok(Array.isArray(response.result.taskIds), `taskIds 必须是数组：${failureHint(response)}`);
      assert.ok(response.result.taskIds.includes(appended.taskId), `taskIds=${JSON.stringify(response.result.taskIds)}`);
      assert.equal(response.result.supported, true);
    });

    await t.test('(i) setParams updates the appended task; unknown id is rejected', async () => {
      assert.ok(appended !== null);
      const params = { client_type: 'Official', start_game_enabled: false };
      const ok = await client.request('setParams', { taskId: appended.taskId, params });
      assert.equal(ok.ok, true, failureHint(ok));
      assert.deepEqual(ok.result.ok, true);
      const bogus = await client.request('setParams', { taskId: 999999, params });
      assert.equal(bogus.ok, false, failureHint(bogus));
      assert.equal(bogus.error.code, 'E_TASK_REJECTED');
    });

    await t.test('(j) version returns the real coreVersion', async () => {
      const response = await client.request('version');
      assert.equal(response.ok, true, failureHint(response));
      assert.match(response.result.coreVersion, /^v?\d+\.\d+/);
    });

    await t.test('(k) screenshot before connect degrades to E_NOT_SUPPORTED', async () => {
      const response = await client.request('screenshot', { format: 'png', dir: SHOT_DIR });
      if (response.ok) {
        // 某些环境未 connect 也可能能截到画面；此时只校验字段形状。
        assert.ok(fs.existsSync(response.result.path));
        return;
      }
      assert.equal(response.error.code, 'E_NOT_SUPPORTED', failureHint(response));
      assert.match(response.error.message, /截图/);
    });

    await t.test('(l) connect to the emulator (skipped when no adb/device)', async (sub) => {
      if (ADB_PATH === '' || !fs.existsSync(ADB_PATH)) {
        sub.skip(`adb.exe not found: ${ADB_PATH || '(auto-detect failed)'}`);
        return;
      }
      const response = await client.request(
        'connect',
        { adbPath: ADB_PATH, address: ADDRESS, config: 'MuMuEmulator12', clientType: 'Official' },
        180000,
      );
      if (!response.ok) {
        sub.skip(`connect failed（模拟器可能没开机）：${response.error?.code} ${response.error?.message}`);
        return;
      }
      assert.equal(response.result.connected, true);
      const connected = await client.request('connected');
      assert.equal(connected.result.connected, true, failureHint(connected));
      deviceReady = true;
    });

    await t.test('(m) screenshot after connect returns a real PNG on disk', async (sub) => {
      if (!deviceReady) {
        sub.skip('模拟器未连接，跳过截图');
        return;
      }
      const response = await client.request('screenshot', { format: 'png', dir: SHOT_DIR, prefix: 'e2e' }, 60000);
      assert.equal(response.ok, true, failureHint(response));
      const { path: shotPath, width, height, bytes } = response.result;
      assert.match(path.basename(shotPath), /^e2e-.+\.png$/);
      assert.ok(fs.existsSync(shotPath), `截图文件不存在：${shotPath}`);
      assert.ok(width > 0 && height > 0, `截图尺寸异常：${width}x${height}`);
      const data = fs.readFileSync(shotPath);
      assert.equal(data.length, bytes, 'bytes 必须等于文件大小');
      assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '必须是 PNG');
      // IHDR 宽高应与返回值一致
      assert.equal(data.readUInt32BE(16), width);
      assert.equal(data.readUInt32BE(20), height);
    });

    await t.test('(n) screenshot rejects unsupported format', async () => {
      const response = await client.request('screenshot', { format: 'jpeg' });
      assert.equal(response.ok, false, failureHint(response));
      assert.equal(response.error.code, 'E_NOT_SUPPORTED');
    });

    await t.test('(o) backHome returns ok (device only)', async (sub) => {
      if (!deviceReady) {
        sub.skip('模拟器未连接，跳过 backHome');
        return;
      }
      const response = await client.request('backHome', {}, 60000);
      assert.equal(response.ok, true, failureHint(response));
      assert.equal(response.result.ok, true);
    });

    await t.test('(p) stop returns running:false (nothing was started)', async () => {
      const response = await client.request('stop');
      assert.equal(response.ok, true, failureHint(response));
      assert.deepEqual(response.result, { running: false });
    });

    await t.test('(q) destroy succeeds and ping then reports inited:false', async () => {
      const destroyed = await client.request('destroy');
      assert.equal(destroyed.ok, true, failureHint(destroyed));
      assert.equal(destroyed.result.destroyed, true);

      const ping = await client.request('ping');
      assert.equal(ping.ok, true, failureHint(ping));
      assert.deepEqual(ping.result, { pong: true, inited: false });
    });

    await t.test('(r) stdin EOF exits the process with code 0 and a clean stdout', async () => {
      client.endInput();
      const result = await client.waitExit(20000);
      assert.equal(result.code, 0, `unexpected exit: ${JSON.stringify(result)}\n${client.stderrTail()}`);
      assert.deepEqual(client.protocolErrors, [], 'stdout must contain protocol lines only');
    });
  } finally {
    await client.dispose();
    cleanupDir(USER_DIR);
    cleanupDir(SHOT_DIR);
  }
});

// docs/contracts.md §2.4: “收到 stdin EOF → AsstDestroy → 退出码 0”.
// This must also hold when the Node side never sent an explicit destroy op.
test('sidecar destroys the MAA instance on stdin EOF and exits 0', { timeout: 180000 }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const client = new SidecarClient();
  try {
    const ready = await client.waitReady(30000);
    assert.equal(ready.protocolVersion, EXPECTED_PROTOCOL);
    const response = await client.request(
      'init',
      {
        maaPath: MAA_PATH,
        userDir: USER_DIR,
        touchMode: 'maatouch',
        deploymentWithPause: true,
      },
      180000,
    );
    assert.equal(response.ok, true, failureHint(response));
    assert.equal(response.result.protocolVersion, EXPECTED_PROTOCOL);

    client.endInput();
    const exit = await client.waitExit(20000);
    assert.equal(exit.code, 0, `unexpected exit: ${JSON.stringify(exit)}\n${client.stderrTail()}`);
    assert.deepEqual(client.protocolErrors, [], 'stdout must contain protocol lines only');
  } finally {
    await client.dispose();
    cleanupDir(USER_DIR);
  }
});

test('sidecar reports E_BAD_OP for unknown ops', { timeout: 120000 }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }
  const client = new SidecarClient();
  try {
    await client.waitReady(30000);
    const response = await client.request('not-a-real-op');
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'E_BAD_OP');
    assert.deepEqual(client.protocolErrors, []);
  } finally {
    client.endInput();
    await client.waitExit(20000).catch(() => {});
    await client.dispose();
    cleanupDir(USER_DIR);
  }
});

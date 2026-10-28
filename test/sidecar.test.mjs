// End-to-end test for lib/sidecar/maa_sidecar.py against the real MaaCore.dll.
//
// Run standalone with:
//   node --test test/sidecar.test.mjs
//
// The emulator does NOT need to be running: this test only exercises
// ready/ping/init/append(StartUp + Bogus)/version/destroy and stdin EOF, exactly
// the ops that do not touch a device. It auto-skips when python.exe or
// MaaCore.dll is missing; the paths are auto-detected through lib/detect.js and
// can be overridden with DSH_ARKNIGHTS_PYTHON / DSH_ARKNIGHTS_MAA_PATH.
//
// Protocol under test: docs/contracts.md sections 2, 3, 6 and 7.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { findMaaPath, findPython } from '../lib/detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// 路径解析顺序：环境变量 → 自动探测（扫盘/扫 .dsh 运行时）→ 空（空则下面自动 skip）。
const PYTHON = process.env.DSH_ARKNIGHTS_PYTHON || (await findPython({})).path;
const MAA_PATH = process.env.DSH_ARKNIGHTS_MAA_PATH || (await findMaaPath({})).path;
const SIDECAR_SCRIPT = path.join(REPO_ROOT, 'lib', 'sidecar', 'maa_sidecar.py');
const MAA_DLL = MAA_PATH === '' ? '' : path.join(MAA_PATH, 'MaaCore.dll');
const USER_DIR = path.join(os.tmpdir(), `dsh-arknights-sidecar-test-${process.pid}`);

const skipReason = [
  PYTHON === '' || !fs.existsSync(PYTHON) ? `python.exe not found: ${PYTHON || '(auto-detect failed)'}` : null,
  MAA_DLL === '' || !fs.existsSync(MAA_DLL) ? `MaaCore.dll not found: ${MAA_DLL || '(auto-detect failed)'}` : null,
  !fs.existsSync(SIDECAR_SCRIPT) ? `sidecar script not found: ${SIDECAR_SCRIPT}` : null,
]
  .filter(Boolean)
  .join('; ');

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

test('sidecar NDJSON protocol with real MaaCore', { timeout: 240000 }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const client = new SidecarClient();
  try {
    await t.test('(a) emits the ready event as the first stdout line', async () => {
      const ready = await client.waitReady(30000);
      assert.equal(ready.event, 'ready');
      assert.equal(ready.platform, 'win32');
      assert.equal(typeof ready.sidecarVersion, 'string');
      assert.ok(ready.sidecarVersion.length > 0);
      assert.match(ready.python, /^\d+\.\d+\.\d+$/);
      assert.equal(client.firstMessage, ready, 'ready must be the very first stdout message');
    });

    await t.test('(b) ping works before init and reports inited:false', async () => {
      const response = await client.request('ping');
      assert.equal(response.ok, true, failureHint(response));
      assert.deepEqual(response.result, { pong: true, inited: false });
    });

    await t.test('(c) init loads the real MaaCore and reports coreVersion + resourceLoaded', async () => {
      assert.equal(fs.existsSync(USER_DIR), false, 'user dir must not exist before init');
      const response = await client.request(
        'init',
        {
          maaPath: MAA_PATH,
          userDir: USER_DIR,
          touchMode: 'minitouch',
          deploymentWithPause: false,
        },
        180000,
      );
      assert.equal(response.ok, true, failureHint(response));
      const { coreVersion, resourceLoaded, maaPath, userDir } = response.result;
      assert.equal(typeof coreVersion, 'string');
      assert.match(coreVersion, /^v?\d+\.\d+/, `unexpected core version: ${coreVersion}`);
      assert.equal(resourceLoaded, true);
      assert.equal(path.resolve(maaPath).toLowerCase(), path.resolve(MAA_PATH).toLowerCase());
      assert.equal(path.resolve(userDir).toLowerCase(), path.resolve(USER_DIR).toLowerCase());
      assert.equal(fs.existsSync(USER_DIR), true, 'sidecar must create the user dir');
    });

    await t.test('(d) append StartUp returns taskId > 0', async () => {
      const response = await client.request(
        'append',
        { type: 'StartUp', params: { client_type: 'Official' } },
        60000,
      );
      assert.equal(response.ok, true, failureHint(response));
      assert.equal(typeof response.result.taskId, 'number');
      assert.ok(
        Number.isInteger(response.result.taskId) && response.result.taskId > 0,
        `taskId must be a positive integer, got ${response.result.taskId}`,
      );
    });

    await t.test('(e) append Bogus returns ok:false with E_TASK_TYPE', async () => {
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

    await t.test('(f) version returns the coreVersion', async () => {
      const response = await client.request('version');
      assert.equal(response.ok, true, failureHint(response));
      assert.match(response.result.coreVersion, /^v?\d+\.\d+/);
    });

    await t.test('(g) destroy succeeds and ping then reports inited:false', async () => {
      const destroyed = await client.request('destroy');
      assert.equal(destroyed.ok, true, failureHint(destroyed));
      assert.equal(destroyed.result.destroyed, true);

      const ping = await client.request('ping');
      assert.equal(ping.ok, true, failureHint(ping));
      assert.deepEqual(ping.result, { pong: true, inited: false });
    });

    await t.test('(h) stdin EOF exits the process with code 0', async () => {
      client.endInput();
      const result = await client.waitExit(20000);
      assert.equal(result.code, 0, `unexpected exit: ${JSON.stringify(result)}\n${client.stderrTail()}`);
      assert.deepEqual(client.protocolErrors, [], 'stdout must contain protocol lines only');
    });
  } finally {
    await client.dispose();
    try {
      fs.rmSync(USER_DIR, { recursive: true, force: true });
    } catch (err) {
      // Temp dir cleanup is best effort.
    }
  }
});

// docs/contracts.md section 2.5: "收到 stdin EOF → AsstDestroy → 退出码 0".
// This must also hold when the Node side never sent an explicit destroy op.
test('sidecar destroys the MAA instance on stdin EOF and exits 0', { timeout: 120000 }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const client = new SidecarClient();
  try {
    await client.waitReady(30000);
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

    client.endInput();
    const exit = await client.waitExit(20000);
    assert.equal(exit.code, 0, `unexpected exit: ${JSON.stringify(exit)}\n${client.stderrTail()}`);
    assert.deepEqual(client.protocolErrors, [], 'stdout must contain protocol lines only');
  } finally {
    await client.dispose();
    try {
      fs.rmSync(USER_DIR, { recursive: true, force: true });
    } catch (err) {
      // Temp dir cleanup is best effort.
    }
  }
});

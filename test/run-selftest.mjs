/**
 * 手动冒烟脚本：不经过 DSH、不经过侧车协议，直接跑 Python 侧车的自检。
 *
 * 用法（PATH 里没有 node，用完整路径）：
 *   node test/run-selftest.mjs
 *
 * 它做三件事：找 Python / 找 MAA → 跑 `lib/sidecar/selftest.py --json` → 打印结果。
 * 退出码：0 = 通过；1 = 失败（会带 Python 的 stdout/stderr）。
 *
 * @module @local/arknights/test/run-selftest
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMaaPath, findPython } from '../lib/detect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sidecarDir = path.join(here, '..', 'lib', 'sidecar');
const selftestPath = path.join(sidecarDir, 'selftest.py');

const python = await findPython({});
if (python.path === '') {
  console.error('[selftest] 没找到可用 Python，试过：');
  for (const candidate of python.tried.slice(0, 10)) console.error(`  - ${candidate}`);
  process.exit(1);
}

const maa = await findMaaPath({});
if (maa.path === '') {
  console.error('[selftest] 没找到 MaaCore.dll，试过：');
  for (const candidate of maa.tried.slice(0, 10)) console.error(`  - ${candidate}`);
  process.exit(1);
}

console.log(`[selftest] python: ${python.path} (${python.version})`);
console.log(`[selftest] MAA:    ${maa.path}`);

const child = spawn(
  python.path,
  ['-u', selftestPath, '--maa-path', maa.path, '--json'],
  {
    cwd: sidecarDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
  },
);

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const timer = setTimeout(() => {
  console.error('[selftest] 超时（120s），杀掉进程。');
  child.kill();
}, 120_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (stdout.trim() !== '') console.log(stdout.trim());
  if (stderr.trim() !== '') console.error(stderr.trim());
  console.log(`[selftest] 退出码 ${code === null ? 'null' : code}`);
  process.exit(code === 0 ? 0 : 1);
});

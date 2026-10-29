/**
 * 打包元数据单元测试：package.json 的 name/version/exports/files/meta、cordis.patch.yml、
 * locale 双语键集合、icon.svg、README 与 docs/contracts.md 的存在性。
 * 契约：docs/contracts.md §7（版本）与 Cordis bundle 安装约定。全部离线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_VERSION, PROTOCOL_VERSION } from '../lib/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 读项目内文件为文本。 */
async function readText(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

/** 读 JSON 文件。 */
async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

/** 递归列出目录下所有文件（返回相对路径，正斜杠）。 */
async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else files.push(path.relative(root, full).replace(/\\/g, '/'));
  }
  return files;
}

/** 极简 glob → 正则（只支持 `**`、`*`）。 */
function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
      if (pattern[index + 1] === '/') index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** 判断一个相对路径是否被 files 模式覆盖。 */
function matchesFiles(relativePath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

/** 把嵌套对象拍平成 `a.b.c` 键集合。 */
function flattenKeys(value, prefix = '') {
  const keys = [];
  for (const [key, child] of Object.entries(value)) {
    const full = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) keys.push(...flattenKeys(child, full));
    else keys.push(full);
  }
  return keys.sort();
}

test('package: name/version/type/private 与仓库一致', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.name, '@local/arknights');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
});

test('package: exports 映射齐全（主入口/client/locale/icon/package.json）', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./package.json'], './package.json');
});

test('package: files 覆盖将要发布的全部文件', async () => {
  const pkg = await readJson('package.json');
  for (const pattern of ['lib/**/*.js', 'lib/sidecar/*.py', 'client.js', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md', 'docs/*.md', 'skill/**']) {
    assert.ok(pkg.files.includes(pattern), `files 缺 ${pattern}`);
  }
});

test('package: files 模式能覆盖仓库里的每个 lib/**/*.js 与 sidecar py', async () => {
  const pkg = await readJson('package.json');
  const libFiles = (await listFiles(path.join(root, 'lib')));
  const jsFiles = libFiles.filter((file) => file.endsWith('.js'));
  const pyFiles = libFiles.filter((file) => file.endsWith('.py'));
  assert.ok(jsFiles.length >= 15, `lib 下 js 文件过少：${jsFiles.length}`);
  for (const file of jsFiles) assert.ok(matchesFiles(file, pkg.files), `${file} 没有被 files 覆盖`);
  assert.ok(pyFiles.length >= 2, 'sidecar py 文件缺失');
  for (const file of pyFiles) assert.ok(matchesFiles(file, pkg.files), `${file} 没有被 files 覆盖`);
});

test('package: client.js / icon.svg / README / 双语文案文件存在', async () => {
  for (const file of ['client.js', 'icon.svg', 'README.md', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'docs/contracts.md']) {
    await fs.access(path.join(root, file));
  }
});

test('package: dsh bundle/client 声明', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(typeof pkg.dsh.client.immediately, 'boolean');
  assert.match(pkg.scripts.test, /test\/\*\.test\.js/);
});

test('package: meta.title / meta.description 与 locale/zh.json 完全一致', async () => {
  const pkg = await readJson('package.json');
  const zh = await readJson('locale/zh.json');
  assert.equal(pkg.meta.title, zh.meta.title);
  assert.equal(pkg.meta.description, zh.meta.description);
  assert.ok(pkg.meta.title.length > 0);
  assert.ok(pkg.meta.description.length > 0);
});

test('package: zh/en locale 键集合一致且 meta 双语文案非空', async () => {
  const zh = await readJson('locale/zh.json');
  const en = await readJson('locale/en.json');
  assert.deepEqual(flattenKeys(en), flattenKeys(zh));
  for (const locale of [zh, en]) {
    assert.ok(locale.meta.title.length > 0);
    assert.ok(locale.meta.description.length > 0);
  }
  for (const section of ['panel', 'labels', 'actions', 'hints']) {
    assert.ok(section in zh && section in en);
  }
});

test('package: cordis.patch.yml 的 id/name/config 与实现一致', async () => {
  const yaml = await readText('cordis.patch.yml');
  assert.match(yaml, /^\s*-\s*id:\s*arknights\s*$/m);
  assert.match(yaml, /name:\s*'@local\/arknights'/);
  for (const key of ['maaPath:', 'pythonPath:', 'ledgerFile:', 'connectionConfig:', 'touchMode:', 'confirmRequired: true', 'dryRun: false', 'webStatus: true']) {
    assert.ok(yaml.includes(key), `cordis.patch.yml 缺 ${key}`);
  }
  for (const section of ['emulator:', 'copilot:', 'arkrec:', 'rogue:', 'push:']) {
    assert.ok(yaml.includes(section), `cordis.patch.yml 缺 ${section}`);
  }
});

test('package: PLUGIN_VERSION 与 package.json 一致，PROTOCOL_VERSION 与契约一致', async () => {
  const pkg = await readJson('package.json');
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.equal(PROTOCOL_VERSION, '2.0.0');
  const contracts = await readText('docs/contracts.md');
  assert.ok(contracts.includes(PROTOCOL_VERSION), 'docs/contracts.md 里的协议版本应与 PROTOCOL_VERSION 一致');
});

test('package: icon.svg 是带 xmlns 的合法 SVG 文档', async () => {
  const svg = await readText('icon.svg');
  assert.match(svg, /<svg[\s>]/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.match(svg, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  const openCount = (svg.match(/<svg[\s>]/g) ?? []).length;
  assert.equal(openCount, 1);
});

test('package: docs/contracts.md 覆盖关键契约章节', async () => {
  const contracts = await readText('docs/contracts.md');
  for (const heading of ['## 2.', '## 3.', '## 5.', '## 6.', '## 7.', '## 9.', '## 10.']) {
    assert.ok(contracts.includes(heading), `docs/contracts.md 缺 ${heading}`);
  }
});

test('package: README 长度合理且包含安装/测试说明', async () => {
  const readme = await readText('README.md');
  const lines = readme.split('\n').filter((line) => line.trim() !== '');
  assert.ok(lines.length >= 50, `README 有效行数过少：${lines.length}`);
  for (const keyword of ['dsh-bundles', 'plugin_manager', 'node --test', '账本', 'confirm']) {
    assert.ok(readme.includes(keyword), `README 缺 ${keyword}`);
  }
});

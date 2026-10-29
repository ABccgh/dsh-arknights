/**
 * Static / contract tests for the browser panel (`client.js`).
 *
 * These tests never start a host, an emulator or a browser: they read the
 * shipped file, load it in a bare Node VM with a stub React (to prove the
 * module wrapper and slot registrations are well formed), and cross-check the
 * embedded dictionaries with `locale/zh.json` and `locale/en.json`.
 *
 * Run with: node --test test/client.static.test.js
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ACTION_KINDS,
  CONFIRM_REQUIRED_ACTIONS,
  DIFFICULTIES,
  ROGUE_MODES,
  ROGUE_THEMES,
} from '../lib/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_PATH = path.join(ROOT, 'client.js');
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const ZH_LOCALE = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'));
const EN_LOCALE = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'));

/** Top-level dictionary groups (used to recognise dictionary key literals). */
const DICTIONARY_GROUPS = [
  'meta',
  'panel',
  'nav',
  'common',
  'time',
  'labels',
  'runStatus',
  'kinds',
  'actions',
  'overview',
  'battle',
  'daily',
  'data',
  'box',
  'settings',
  'hints',
  'errors',
];

const PAGE_KEYS = ['overview', 'battle', 'daily', 'data', 'box', 'settings'];

/**
 * Flatten a nested dictionary into dot keys.
 * @param {Record<string, any>} source - nested dictionary.
 * @param {string} [prefix] - key prefix.
 * @param {Record<string, string>} [out] - accumulator.
 * @returns {Record<string, string>} flattened dictionary.
 */
function flatten(source, prefix = '', out = {}) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    const full = prefix === '' ? key : prefix + '.' + key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

/**
 * Read a `const NAME = [ ... ]` single-line literal from the client source.
 * @param {string} name - constant name.
 * @returns {string[]} parsed array.
 */
function readConstArray(name) {
  const match = CLIENT_SOURCE.match(new RegExp('const ' + name + ' = \\[([^\\]]*)\\];'));
  assert.ok(match, 'client.js must declare the ' + name + ' array');
  return JSON.parse('[' + match[1] + ']');
}

/**
 * Extract one embedded dictionary object literal from the client source.
 * @param {string} startMarker - text right before the JSON literal.
 * @param {string} endMarker - text right after it.
 * @returns {Record<string, any>} parsed nested dictionary.
 */
function readEmbeddedDictionary(startMarker, endMarker) {
  const start = CLIENT_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, 'embedded dictionary start marker must exist');
  const end = CLIENT_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, 'embedded dictionary end marker must exist');
  const chunk = CLIENT_SOURCE.slice(start + startMarker.length, end).trim().replace(/;$/, '').trim();
  return JSON.parse(chunk);
}

/**
 * Every quoted string shaped like a dictionary key (`group.rest`) in the file.
 * This catches keys that are passed through variables instead of t('literal').
 * @returns {string[]} sorted unique keys.
 */
function collectDictionaryLiterals() {
  const found = new Set();
  const pattern = /['"]([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)['"]/g;
  let match;
  while ((match = pattern.exec(CLIENT_SOURCE)) !== null) {
    const group = match[1].split('.')[0];
    if (DICTIONARY_GROUPS.includes(group)) found.add(match[1]);
  }
  return Array.from(found).sort();
}

/**
 * Load client.js inside a bare VM with a stub window and stub React.
 * @param {{ withLocale?: boolean }} [options] - locale service availability.
 * @returns {{ plugin: Record<string, any>, requested: string[], slotRegistrations: any[],
 *   localeRegistrations: any[], injectedSlots: string[] }} captured state.
 */
function loadClientModule(options = {}) {
  // Set after the status-polling hook is recognised; the next three useState
  // calls belong to the action runner (inflight / result / plans).
  let injectedActionHook = -1;
  const loaded = [];
  const windowStub = {
    __ModuleLoader__: {
      load(plugin) {
        loaded.push(plugin);
      },
    },
  };
  const reactStub = {
    createElement(type, props, ...children) {
      const normalized = Object.assign({}, props || {});
      if (children.length === 1) normalized.children = children[0];
      else if (children.length > 1) normalized.children = children;
      return { type, props: normalized, children };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      // Test seam: seed the status-polling hook and then the three action-runner
      // hooks (inflight / result / plans) declared right after it in the panel,
      // so the populated render branches are exercised without a live host.
      if (options.status !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, 'offline')
        && Object.prototype.hasOwnProperty.call(value, 'lastAt')) {
        if (options.action !== undefined) injectedActionHook = 0;
        return [Object.assign({}, value, { status: options.status, loading: false, offline: false, lastAt: Date.now(), error: null }), function () {}];
      }
      if (options.action !== undefined && injectedActionHook >= 0 && injectedActionHook < 3) {
        const hookIndex = injectedActionHook;
        injectedActionHook += 1;
        if (hookIndex === 1) {
          const result = options.action.result === undefined ? null : options.action.result;
          return [result, function () {}];
        }
        if (hookIndex === 2) {
          const plans = options.action.plans === undefined ? {} : options.action.plans;
          return [plans, function () {}];
        }
        return [value, function () {}];
      }
      return [value, function () {}];
    },
    useRef(initial) {
      return { current: initial === undefined ? null : initial };
    },
    useEffect() {
      /* effects are irrelevant for the static harness */
    },
    useCallback(callback) {
      return callback;
    },
  };
  const fetchCalls = [];
  const sandbox = {
    window: windowStub,
    console,
    navigator: { language: 'en-US' },
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch(url) {
      fetchCalls.push(String(url));
      return Promise.reject(new Error('static test: network is not available'));
    },
  };
  vm.createContext(sandbox);
  new vm.Script(CLIENT_SOURCE, { filename: 'client.js' }).runInContext(sandbox);
  assert.equal(loaded.length, 1, 'window.__ModuleLoader__.load must be called exactly once');

  const plugin = loaded[0];
  assert.equal(plugin.id, '@local/arknights');

  const requested = [];
  const body = plugin.factory(function (name) {
    requested.push(name);
    return reactStub;
  });

  const slotRegistrations = [];
  const localeRegistrations = [];
  const injectedSlots = [];
  const localeStub = {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      return function () {};
    },
    bind() {
      return function (key) {
        return key === 'panel.title' ? 'Arknights' : '[' + key + ']';
      };
    },
  };
  const ctx = {
    effect(callback) {
      return callback();
    },
    get(name) {
      if (options.withLocale === true && name === 'locale') return localeStub;
      return undefined;
    },
    slots: {
      inject(slot, factory) {
        injectedSlots.push(slot);
        return factory();
      },
      register(registration, component) {
        slotRegistrations.push({ registration, component });
        return registration;
      },
    },
  };
  body.apply(ctx);

  // Arrays created inside the VM live in another realm; copy them for strict
  // deepEqual assertions in this realm.
  return { plugin, body, inject: Array.from(body.inject), requested, slotRegistrations, localeRegistrations, injectedSlots, fetchCalls };
}

/* ------------------------------------------------------------------ *
 * 1. Module shape
 * ------------------------------------------------------------------ */

test('client.js is a single plain-browser module for @local/arknights', () => {
  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(CLIENT_SOURCE, /id:\s*'@local\/arknights'/);
  assert.match(CLIENT_SOURCE, /factory\(require\)/);

  const requires = Array.from(CLIENT_SOURCE.matchAll(/require\(\s*'([^']+)'\s*\)/g)).map((match) => match[1]);
  assert.ok(requires.length > 0, 'the factory must take React from the page module table');
  for (const name of requires) assert.equal(name, 'react', 'the client half may only require react');

  assert.doesNotMatch(CLIENT_SOURCE, /^\s*import\s/m, 'no ESM imports in the browser half');
  assert.doesNotMatch(CLIENT_SOURCE, /^\s*export\s/m, 'no ESM exports in the browser half');
  assert.doesNotMatch(CLIENT_SOURCE, /^\s*interface\s|\binterface\s+[A-Z]\w*/m, 'no TypeScript interfaces');
  assert.doesNotMatch(CLIENT_SOURCE, /<[A-Za-z]/, 'no JSX tags may appear in the shipped file');
  assert.doesNotMatch(CLIENT_SOURCE, /<\/[A-Za-z]|<>|<\/>/, 'no JSX fragments/end tags');
  assert.doesNotMatch(CLIENT_SOURCE, /https?:\/\//, 'no external links in the shipped file');
  assert.doesNotMatch(CLIENT_SOURCE, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded hex colors');
  assert.doesNotMatch(CLIENT_SOURCE, /\b(?:rgb|rgba|hsl|hsla)\(/, 'no hard-coded color functions');

  const tokens = new Set(Array.from(CLIENT_SOURCE.matchAll(/var\((--[A-Za-z0-9-]+)\)/g)).map((match) => match[1]));
  assert.ok(tokens.size > 10, 'the panel styles must use theme tokens');
  for (const token of tokens) {
    assert.ok(token.startsWith('--dsw-alias-'), 'only --dsw-alias-* tokens are allowed, got ' + token);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Host HTTP surface and polling rules
 * ------------------------------------------------------------------ */

test('status polling is 2 s idle / 1 s while running and fully abortable', () => {
  assert.match(CLIENT_SOURCE, /const STATUS_URL = '\/arknights\/status'/);
  assert.match(CLIENT_SOURCE, /const ACTION_URL = '\/arknights\/action'/);
  assert.match(CLIENT_SOURCE, /const QUERY_URL = '\/arknights\/query'/);
  assert.match(CLIENT_SOURCE, /const POLL_IDLE_MS = 2000/);
  assert.match(CLIENT_SOURCE, /const POLL_RUN_MS = 1000/);
  assert.match(CLIENT_SOURCE, /new AbortController\(\)/);
  assert.match(CLIENT_SOURCE, /init\.signal = controller\.signal/);
  assert.match(CLIENT_SOURCE, /controller\.abort\(\)/);
  assert.match(CLIENT_SOURCE, /setInterval\(refresh/);
  assert.match(CLIENT_SOURCE, /clearInterval\(timer\)/);
  assert.match(CLIENT_SOURCE, /runActive \? POLL_RUN_MS : POLL_IDLE_MS/);
  assert.match(CLIENT_SOURCE, /apiRef\.current\.dispose\(\)/, 'the API wrapper is disposed on unmount');
});

test('actions use the plan/confirm envelope and never wait on long runs', () => {
  assert.match(CLIENT_SOURCE, /Object\.assign\(\{\}, payload, \{ action: kind, confirm: false \}\)/);
  assert.match(CLIENT_SOURCE, /Object\.assign\(\{\}, payload, \{ action: kind, confirm: true \}\)/);
  assert.match(CLIENT_SOURCE, /plannedItems/);
  assert.match(CLIENT_SOURCE, /plannedTotalSanity/);
  assert.match(CLIENT_SOURCE, /action: 'stop'/);
  assert.match(CLIENT_SOURCE, /wait: true/, 'only the blocking recruitment analysis asks the host to wait');
  assert.match(CLIENT_SOURCE, /disabled: !allowMedicine/, 'medicine is locked by the safety gate');
  assert.match(CLIENT_SOURCE, /disabled: !allowStone/, 'originite prime is locked by the safety gate');
  assert.match(CLIENT_SOURCE, /React\.useState\('0'\)/, 'resource inputs default to 0');
});

/* ------------------------------------------------------------------ *
 * 3. Contract enums
 * ------------------------------------------------------------------ */

test('client enums mirror lib/contracts.js', () => {
  assert.deepEqual(readConstArray('DIFFICULTIES'), DIFFICULTIES);
  assert.deepEqual(readConstArray('ROGUE_THEMES'), ROGUE_THEMES);
  assert.deepEqual(readConstArray('ROGUE_MODES'), ROGUE_MODES);
  assert.deepEqual(readConstArray('CONFIRM_REQUIRED_ACTIONS'), CONFIRM_REQUIRED_ACTIONS);

  const actionNames = readConstArray('ACTION_NAMES');
  for (const kind of ACTION_KINDS) {
    assert.ok(actionNames.includes(kind), 'ACTION_NAMES must include contract action ' + kind);
  }
  assert.ok(actionNames.includes('stop'), 'ACTION_NAMES must include stop');
  assert.ok(!actionNames.includes('plan'), 'the planner is a GET query in v1.0, not an action');
  assert.equal(actionNames.length, ACTION_KINDS.length + 1);

  assert.deepEqual(readConstArray('PAGE_KEYS'), PAGE_KEYS);
  assert.deepEqual(readConstArray('DAILY_TASK_KEYS'), ['award', 'mall', 'infrast', 'recruit', 'box']);
  assert.deepEqual(readConstArray('DAILY_DEFAULT_TASKS'), ['award', 'mall', 'infrast']);
});

test('all six pages are implemented as components', () => {
  for (const name of ['OverviewPage', 'BattlePage', 'DailyPage', 'DataPage', 'BoxPage', 'SettingsPage']) {
    assert.match(CLIENT_SOURCE, new RegExp('function ' + name + '\\('), name + ' component must exist');
  }
  for (const page of PAGE_KEYS) {
    assert.ok(CLIENT_SOURCE.includes("'" + page + "'"), 'page key ' + page + ' must be listed');
  }
  assert.match(CLIENT_SOURCE, /function ArknightsIcon\(/, 'the sidebar icon component must exist');
  assert.match(CLIENT_SOURCE, /currentColor/, 'the icon must inherit the sidebar theme color');
});

/* ------------------------------------------------------------------ *
 * 4. Locale dictionaries
 * ------------------------------------------------------------------ */

test('embedded dictionaries match locale files and cover every used key', () => {
  const zhEmbedded = flatten(readEmbeddedDictionary('const ZH_NESTED = ', '\n    const EN_NESTED = '));
  const enEmbedded = flatten(readEmbeddedDictionary('const EN_NESTED = ', '\n\n    /** Flatten '));
  const zhLocale = flatten(ZH_LOCALE);
  const enLocale = flatten(EN_LOCALE);

  assert.deepEqual(zhEmbedded, zhLocale, 'the embedded zh dictionary must mirror locale/zh.json');
  assert.deepEqual(enEmbedded, enLocale, 'the embedded en dictionary must mirror locale/en.json');
  assert.deepEqual(Object.keys(zhLocale).sort(), Object.keys(enLocale).sort(), 'zh/en keys must be aligned');
  assert.ok(Object.keys(zhLocale).length > 250, 'the dictionary must be large enough for the six pages');

  const literals = collectDictionaryLiterals();
  assert.ok(literals.length > 200, 'dictionary key literals are discovered');
  for (const key of literals) {
    assert.ok(key in zhLocale, 'zh dictionary is missing ' + key);
    assert.ok(key in enLocale, 'en dictionary is missing ' + key);
  }

  const translated = Array.from(CLIENT_SOURCE.matchAll(/\bt\(\s*'([^']+)'/g)).map((match) => match[1]);
  for (const key of translated) {
    assert.ok(key in zhLocale, 't() key without zh text: ' + key);
    assert.ok(key in enLocale, 't() key without en text: ' + key);
  }

  for (const page of PAGE_KEYS) {
    assert.ok(('nav.' + page) in zhLocale, 'nav label for ' + page);
  }
  assert.ok('common.zeroCost' in zhLocale, 'the zero-cost badge text must exist');
  assert.ok('common.needsConfirm' in zhLocale, 'the needs-confirm badge text must exist');
  assert.ok('daily.zeroSanity' in zhLocale, 'the daily zero-sanity badge text must exist');
});

/* ------------------------------------------------------------------ *
 * 5. Slot registration (module loaded in a bare VM)
 * ------------------------------------------------------------------ */

test('plugin registers exactly sidebar.panellist and main', () => {
  const loaded = loadClientModule({ withLocale: true });
  assert.deepEqual(loaded.requested, ['react'], 'the factory only asks the page for react');
  assert.deepEqual(loaded.inject, ['slots', 'locale']);
  assert.deepEqual(loaded.injectedSlots, ['sidebar.panellist', 'main']);

  assert.equal(loaded.localeRegistrations.length, 1);
  const localeRegistration = loaded.localeRegistrations[0];
  assert.equal(localeRegistration.namespace, 'arknights');
  assert.ok(Object.keys(flatten(localeRegistration.dictionaries.zh)).length > 250);
  assert.ok(Object.keys(flatten(localeRegistration.dictionaries.en)).length > 250);

  assert.equal(loaded.slotRegistrations.length, 2);
  const sidebar = loaded.slotRegistrations.find((entry) => entry.registration.name === 'sidebar.panellist');
  const main = loaded.slotRegistrations.find((entry) => entry.registration.name === 'main');
  assert.ok(sidebar, 'sidebar.panellist must be registered');
  assert.ok(main, 'main must be registered');

  assert.equal(sidebar.registration.id, 'arknights');
  assert.equal(sidebar.registration.order, 5);
  assert.equal(sidebar.registration.locale, 'arknights');
  assert.equal(typeof sidebar.registration.label, 'function');
  assert.equal(sidebar.registration.label(), 'Arknights');
  assert.equal(typeof sidebar.component, 'function');

  assert.equal(main.registration.key, 'arknights');
  assert.equal(main.registration.locale, 'arknights');
  assert.equal(typeof main.component, 'function');
  assert.notEqual(main.component, sidebar.component);
});

test('plugin still activates when the locale service is missing (embedded fallback)', () => {
  const loaded = loadClientModule({ withLocale: false });
  assert.deepEqual(loaded.injectedSlots, ['sidebar.panellist', 'main']);
  assert.equal(loaded.localeRegistrations.length, 0);
  const sidebar = loaded.slotRegistrations.find((entry) => entry.registration.name === 'sidebar.panellist');
  assert.ok(sidebar);
  assert.equal(sidebar.registration.locale, undefined);
  assert.equal(sidebar.registration.label(), 'Arknights', 'fallback dictionary is used for the sidebar label');
});

/* ------------------------------------------------------------------ *
 * 6. Syntax check with the shipped file
 * ------------------------------------------------------------------ */

test('node --check accepts client.js', () => {
  const result = spawnSync(process.execPath, ['--check', CLIENT_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'node --check failed');
});

/* ------------------------------------------------------------------ *
 * 7. Shallow render smoke test with stub React and fixture status.
 * This catches render-path crashes (undefined references, bad prop access)
 * without a DOM, a host or a browser.
 * ------------------------------------------------------------------ */

const ISO_AT = '2026-10-29T11:00:00.000Z';

const FIXTURE_STATUS = {
  ok: true,
  schema: 2,
  ts: ISO_AT,
  sidecar: { alive: true, inited: true, pid: 1, coreVersion: 'v6.21.0-beta.2', resourceLoaded: true, protocolVersion: '2.0.0' },
  paths: {
    maaPath: 'D:\\MAA',
    pythonPath: 'D:\\Python\\python.exe',
    adbPath: 'D:\\MuMu\\adb.exe',
    userDir: 'D:\\maa-data',
    ledgerFile: 'D:\\data\\progress.json',
    boxFile: 'D:\\data\\box.json',
    historyFile: 'D:\\data\\history.jsonl',
  },
  emulator: { managerFound: true, running: true, androidStarted: true, adbOnline: true, vmIndex: 0, name: 'MuMu' },
  connection: { connected: true, address: '127.0.0.1:16384', config: 'MuMuEmulator12', clientType: 'Official' },
  tasks: { running: true, current: 'Fight', chains: ['Fight'] },
  sanity: { current: 100, max: 135, at: ISO_AT },
  drops: { '固源岩': 12 },
  run: { id: 'run-demo', kind: 'fight', status: 'running', startedAt: ISO_AT, updatedAt: ISO_AT, phase: 'battle' },
  lastRun: { id: 'run-last', kind: 'daily', status: 'completed', endedAt: ISO_AT },
  ledger: {
    fullStar: 3,
    missing: 2,
    primeClaimed: 3,
    entries: [
      { code: '5-10', stars: 3, fullStar: true, method: 'copilot' },
      { code: '5-11', stars: 2, fullStar: false, method: 'agent' },
    ],
  },
  push: { nextStage: '5-11', lastStopped: '5-10', lastReason: 'no agent' },
  daily: { date: '2026-10-29', tasks: { award: { ok: true, at: ISO_AT }, mall: { ok: false, at: ISO_AT }, infrast: {} } },
  box: { operators: 12, depotItems: 34, updatedAt: ISO_AT, partial: true },
  data: {
    stages: 608,
    items: 482,
    arkrec: { ok: true, ageMs: 3600000 },
    penguin: { ageMs: 7200000 },
    activity: { ageMs: 600000 },
    warnings: ['fixture warning'],
  },
  errors: { lastCode: 'E_PREFLIGHT', lastMessage: 'fixture error', at: ISO_AT },
  safety: {
    confirmRequired: true,
    dryRun: false,
    allowSanityPotion: false,
    allowOriginitePrime: false,
    allowRecruitPermits: false,
    allowExpedite: false,
  },
  config: { defaultDifficulty: 'auto', dryRun: false, confirmRequired: true },
  events: [
    { seq: 3, name: 'TaskChainCompleted', task: 'Fight' },
    { seq: 2, name: 'StageDrops' },
  ],
};

const FIGHT_FIXTURE_SIGNATURE = JSON.stringify({ stages: '', times: 1, difficulty: 'auto' });
const DAILY_FIXTURE_SIGNATURE = JSON.stringify({
  tasks: ['award', 'mall', 'infrast'],
  skipDone: true,
  award: { award: true, mail: false, dailyPull: false, orundum: false, mining: false, specialAccess: false, signInEvent: false },
  mall: { visitFriends: true, shopping: true, onlyDiscount: false, forceWhenFull: false, reserveMaxCredit: false },
});

const FIXTURE_PLANS = {
  fight: {
    signature: FIGHT_FIXTURE_SIGNATURE,
    plannedItems: [{ stage: '5-10', difficulty: 'easy', times: 1, sanity: 0, note: 'auto deploy' }],
    totalSanity: 0,
  },
  push: { signature: JSON.stringify({}), plannedItems: [{ stage: '5-11' }], totalSanity: 21 },
  rogue: { signature: JSON.stringify({ theme: 'Sarkaz', mode: 'Exp' }), plannedItems: [], totalSanity: null },
  daily: {
    signature: DAILY_FIXTURE_SIGNATURE,
    plannedItems: [{ task: 'award', note: 'daily fixture' }],
    totalSanity: 0,
  },
};

const FIXTURE_PLAN_RESULT = {
  tone: 'plan',
  action: 'fight',
  payload: { stages: '5-10' },
  text: 'Plan ready, zero cost',
  plannedItems: [{ stage: '5-10', difficulty: 'easy', times: 1, sanity: 0 }],
  totalSanity: 0,
  at: 1730000000000,
  data: { ok: true, planned: true, plannedItems: [{ stage: '5-10', sanity: 0 }] },
};

const FIXTURE_ERROR_RESULT = {
  tone: 'error',
  action: 'daily',
  payload: { tasks: ['award'] },
  text: 'safety gate rejected the run',
  error: { code: 'E_UNSAFE_RESOURCE', message: 'blocked by safety', hint: 'enable safety in config' },
  at: 1730000000000,
  data: { ok: false, error: { code: 'E_UNSAFE_RESOURCE' } },
};

/**
 * Shallow-render a React element tree with the stub components.
 * @param {any} node - element tree.
 * @returns {any} rendered tag tree.
 */
function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderNode).filter((item) => item !== null);
  if (typeof node !== 'object') return null;
  const type = node.type;
  if (typeof type === 'function') return renderNode(type(node.props || {}));
  if (typeof type === 'string') {
    const props = node.props || {};
    return { tag: type, props, children: renderNode(props.children === undefined ? null : props.children) };
  }
  return null;
}

/**
 * Walk a rendered tree.
 * @param {any} tree - rendered tree.
 * @param {(node: any, text: string|null) => void} visit - visitor.
 */
function walkTree(tree, visit) {
  if (tree === null || tree === undefined) return;
  if (Array.isArray(tree)) {
    for (const item of tree) walkTree(item, visit);
    return;
  }
  if (typeof tree === 'string') {
    visit(null, tree);
    return;
  }
  visit(tree, null);
  walkTree(tree.children, visit);
}

function collectTags(tree) {
  const tags = new Set();
  walkTree(tree, (node) => {
    if (node !== null && typeof node.tag === 'string') tags.add(node.tag);
  });
  return tags;
}

function collectText(tree) {
  const parts = [];
  walkTree(tree, (node, text) => {
    if (typeof text === 'string') parts.push(text);
  });
  return parts.join(' ');
}

function countClass(tree, className) {
  let count = 0;
  walkTree(tree, (node) => {
    if (node === null || node.props === undefined) return;
    const value = node.props.className;
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) count += 1;
  });
  return count;
}

/** Render the main slot component with the configured hook fixtures. */
function renderPanel(options) {
  const loaded = loadClientModule(options);
  const main = loaded.slotRegistrations.find((entry) => entry.registration.name === 'main');
  assert.ok(main, 'main slot registration must exist');
  return { loaded, tree: renderNode({ type: main.component, props: {} }) };
}

test('panel renders all six pages with a populated status (stub React)', () => {
  const { tree } = renderPanel({
    withLocale: false,
    status: FIXTURE_STATUS,
    action: { result: FIXTURE_PLAN_RESULT, plans: FIXTURE_PLANS },
  });
  assert.ok(tree !== null, 'the panel must render');
  const tags = collectTags(tree);
  for (const tag of ['header', 'nav', 'section', 'div', 'span', 'button', 'input', 'select', 'ul', 'li', 'style']) {
    assert.ok(tags.has(tag), 'rendered tree must contain ' + tag);
  }
  const text = collectText(tree);
  assert.ok(text.includes('Arknights'), 'panel title is rendered');
  assert.ok(text.includes('Overview'), 'overview nav label is rendered');
  assert.ok(text.includes('5-10'), 'planned stage / ledger entry is rendered');
  assert.ok(!text.includes('undefined'), 'rendered text must not leak undefined');
  assert.ok(!text.includes('NaN'), 'rendered text must not leak NaN');
  assert.ok(!text.includes('[object Object]'), 'rendered text must not leak objects');
  assert.ok(countClass(tree, 'ark-page-grid') >= 1, 'page grid is rendered');
  assert.ok(countClass(tree, 'ark-plan-box') >= 2, 'battle and daily plan previews are rendered');
  assert.ok(countClass(tree, 'ark-tab-active') >= 1, 'the active page tab is rendered');
  assert.ok(countClass(tree, 'ark-empty') >= 1, 'empty states are rendered');
});

test('panel renders an error result with code/message/hint and diagnostics', () => {
  const { tree } = renderPanel({
    withLocale: false,
    status: FIXTURE_STATUS,
    action: { result: FIXTURE_ERROR_RESULT, plans: {} },
  });
  const text = collectText(tree);
  assert.ok(text.includes('E_UNSAFE_RESOURCE'), 'error code is rendered');
  assert.ok(text.includes('blocked by safety'), 'error message is rendered');
  assert.ok(text.includes('enable safety in config'), 'error hint is rendered');
  assert.ok(text.includes('Copy diagnostic JSON'), 'diagnostic copy action is rendered');
  assert.ok(countClass(tree, 'ark-badge-danger') >= 1, 'the error badge is rendered');
});

test('panel renders the loading state when no status has arrived', () => {
  const { tree } = renderPanel({ withLocale: false });
  assert.ok(tree !== null);
  const text = collectText(tree);
  assert.ok(text.includes('Arknights'));
  assert.ok(text.includes('Loading'), 'loading summary is rendered before the first status');
});

test('sidebar icon renders an inline currentColor SVG', () => {
  const loaded = loadClientModule({ withLocale: false });
  const sidebar = loaded.slotRegistrations.find((entry) => entry.registration.name === 'sidebar.panellist');
  assert.ok(sidebar);
  const tree = renderNode({ type: sidebar.component, props: { size: 18, active: true } });
  const tags = collectTags(tree);
  assert.ok(tags.has('svg'));
  assert.ok(tags.has('path'));
  const text = JSON.stringify(tree);
  assert.ok(text.includes('currentColor'), 'the icon must inherit the row color');
});

test('panel handlers issue host requests and never throw when the host is down', () => {
  const { loaded, tree } = renderPanel({
    withLocale: false,
    status: FIXTURE_STATUS,
    action: { result: FIXTURE_PLAN_RESULT, plans: FIXTURE_PLANS },
  });
  const clickable = [];
  walkTree(tree, (node) => {
    if (node !== null && node.props !== undefined && typeof node.props.onClick === 'function') clickable.push(node);
  });
  assert.ok(clickable.length > 10, 'interactive controls are rendered');
  for (const node of clickable) {
    try {
      node.props.onClick();
    } catch (error) {
      assert.fail('onClick threw: ' + (error && error.message ? error.message : String(error)));
    }
  }
  assert.ok(loaded.fetchCalls.some((url) => url.indexOf('/arknights/action') >= 0), 'action requests are issued');
  assert.ok(loaded.fetchCalls.some((url) => url.indexOf('/arknights/query') >= 0), 'query requests are issued');
});

/**
 * `@local/arknights` 的 Cordis 插件入口。
 *
 * 注册 5 个 `ark_*` 工具（status / fight / push / rogue / stop）、`/ark` 命令、
 * 以及面板用的 `GET /arknights/status` 与 `POST /arknights/action` 两个只读/本地端点。
 *
 * 注意三件事：
 * 1. **不 import 任何 `@deepseek-ai/*`**。插件是 `link:` 安装的 profile bundle，
 *    代码在 DSH 安装作用域之外，这类 import 会以 `ERR_MODULE_NOT_FOUND` 让插件加载失败。
 * 2. **`apply` 不返回值**。Cordis 会把返回值当 effect 收集，返回数组会让插件激活失败。
 * 3. 所有注册都包在 `ctx.effect` 里，取得 disposer，HMR/卸载时才能干净地回收。
 *
 * @module @local/arknights
 */

import { fileURLToPath } from 'node:url';

import { createActions } from './actions.js';
import { createArkrec } from './arkrec.js';
import { normalizeConfig, resolvePaths } from './config.js';
import { createCopilot } from './copilot.js';
import { createEnvironment } from './environment.js';
import { arkError, describeError, normalizeError } from './errors.js';
import { createLedger } from './ledger.js';
import { createMaaSession } from './maa-session.js';
import { createPush } from './push.js';
import { createRunner } from './runner.js';
import { loadResources } from './stages.js';
import { createFightTools } from './tools/fight.js';
import { createPushTools } from './tools/push.js';
import { createRogueTools } from './tools/rogue.js';
import { createStatusTools } from './tools/status.js';
import { createStopTools } from './tools/stop.js';
import { createState } from './state.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'arknights';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 组装运行时依赖。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @param {{ logger?: any, session?: any, env?: any, ledger?: any, copilot?: any, arkrec?: any,
 *   fetchImpl?: Function, platform?: string, spawn?: Function }} [overrides] - 测试接缝。
 * @returns {Record<string, any>} 依赖对象。
 */
export function createDeps(config, overrides = {}) {
  const logger = overrides.logger;
  const paths = resolvePaths(config);
  const env = overrides.env ?? createEnvironment({ config, paths, logger });
  const state = createState();
  const ledger = overrides.ledger ?? createLedger({ file: paths.ledgerFile, logger });
  const copilot = overrides.copilot ?? createCopilot({
    api: config.copilot.api,
    timeoutMs: config.copilot.timeoutMs,
    maxCandidates: config.copilot.maxCandidates,
    maxSolutionsPerStage: config.copilot.maxSolutionsPerStage,
    allowBorrowedOper: config.copilot.allowBorrowedOper,
    cacheDir: paths.copilotCacheDir,
    logger,
    ...(typeof overrides.fetchImpl === 'function' ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  const arkrec = overrides.arkrec ?? createArkrec({
    api: config.arkrec.api,
    timeoutMs: config.arkrec.timeoutMs,
    cacheTtlHours: config.arkrec.cacheTtlHours,
    cacheDir: paths.arkrecCacheDir,
    logger,
    ...(typeof overrides.fetchImpl === 'function' ? { fetchImpl: overrides.fetchImpl } : {}),
  });

  // —— 侧车：懒创建（第一次真正需要 MAA 时才去找 python 并起进程）——
  const sidecarPath = overrides.sidecarPath ?? fileURLToPath(new URL('./sidecar/maa_sidecar.py', import.meta.url));
  /** @type {any} */
  let inner = overrides.session ?? null;
  const ensureInner = async () => {
    if (inner !== null) return inner;
    const detected = await env.get();
    if (detected.pythonPath === '') {
      throw arkError('E_PYTHON_NOT_FOUND', '没有找到可用的 Python 解释器。', {
        detail: `试过：${detected.pythonTried.slice(0, 8).join('；')}`,
        hint: '在 cordis.patch.yml 的 arknights 行里把 pythonPath 指到可用的 python.exe。',
      });
    }
    inner = createMaaSession({
      pythonPath: detected.pythonPath,
      sidecarPath,
      startupTimeoutMs: config.startupTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      resolveInit: env.initArgs,
      logger,
      onEvent: (event) => {
        if (event.name === 'maa') state.pushEvent(event.payload);
      },
      ...(typeof overrides.spawn === 'function' ? { spawn: overrides.spawn } : {}),
      ...(typeof overrides.platform === 'string' ? { platform: overrides.platform } : {}),
    });
    return inner;
  };

  /** 侧车门面：把懒创建藏在一个稳定的对象后面。 */
  const session = {
    ensureStarted: async () => (await ensureInner()).ensureStarted(),
    request: async (op, args = {}, requestOptions = {}) => (await ensureInner()).request(op, args, requestOptions),
    getInfo: () => (inner === null ? null : inner.getInfo()),
    isRunning: () => (inner === null ? false : inner.isRunning()),
    hold: () => {
      if (inner !== null) inner.hold();
    },
    release: () => {
      if (inner !== null) inner.release();
    },
    subscribe: (listener) => (inner === null ? () => {} : inner.subscribe(listener)),
    dispose: () => {
      if (inner !== null) inner.dispose();
      inner = null;
    },
  };

  const resources = async () => {
    const detected = await env.get();
    return loadResources(detected.maaPath);
  };
  const runner = overrides.runner ?? createRunner({ config, paths, env, session, state, ledger, copilot, arkrec, resources, logger });
  const push = overrides.push ?? createPush({ config, ledger, resources, runner: () => runner });
  const actions = overrides.actions ?? createActions({ config, paths, env, session, state, ledger, runner, push, arkrec, logger });
  return { config, paths, env, session, state, ledger, copilot, arkrec, runner, push, actions, logger, resources };
}

/**
 * 造全部工具定义（顺序即工具表顺序，status 在最前）。
 * @param {Record<string, any>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createToolDefinitions(deps) {
  return [
    ...createStatusTools(deps),
    ...createFightTools(deps),
    ...createPushTools(deps),
    ...createRogueTools(deps),
    ...createStopTools(deps),
  ];
}

/**
 * 解析 `/ark` 命令的一行输入。
 * @param {string} rawInput - 命令原始输入（可能带前导 `/ark`）。
 * @returns {{ sub: string, args: string[], flags: Set<string> }} 解析结果。
 */
export function parseCommand(rawInput) {
  const text = String(rawInput ?? '').trim();
  const withoutSlash = text.startsWith('/') ? text.slice(1) : text;
  const parts = withoutSlash.split(/\s+/).filter((part) => part !== '');
  if (parts.length > 0 && parts[0] === 'ark') parts.shift();
  const sub = parts.shift() ?? 'status';
  const flags = new Set(parts.filter((part) => part.startsWith('--')).map((part) => part.slice(2)));
  const args = parts.filter((part) => !part.startsWith('--'));
  return { sub, args, flags };
}

/**
 * 把 flag 解析成对象键值（`--chapter=5`）。
 * @param {string[]} args - 位置参数。
 * @param {Set<string>} flags - flag 集合。
 * @returns {Record<string, string | true>} 映射。
 */
function flagValues(args, flags) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (const flag of flags) {
    const [key, value] = flag.split('=');
    if (key === undefined || key === '') continue;
    out[key] = value === undefined ? true : value;
  }
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    if (key !== undefined && key !== '') out[key] = value === undefined ? true : value;
  }
  return out;
}

/**
 * 装配插件。
 * @param {any} ctx - Cordis 上下文（硬依赖 `tools`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @param {Record<string, any>} [overrides] - 测试接缝。
 * @returns {Promise<void>} 无。**不要返回任何值**。
 */
export async function apply(ctx, config, overrides = {}) {
  const effective = normalizeConfig(config);
  const deps = createDeps(effective, { ...overrides, logger: overrides.logger ?? ctx.logger });
  const definitions = createToolDefinitions(deps);
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();

  for (const definition of definitions) effect(() => ctx.tools.register(definition));
  effect(() => () => deps.session.dispose());

  // —— /ark 命令（可选服务）——
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
  if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
    effect(() => commands.register({
      name: 'ark',
      description: '明日方舟：`/ark status | fight <关卡> [次数] [--yes] | push [起点] [--chapter=N] [--yes] | rogue [主题] | stop`',
      input: { hint: 'status | fight 5-10 | push 5-3 | rogue Sarkaz | stop' },
      handler: async (invocation) => {
        try {
          const parsed = parseCommand(invocation?.rawInput ?? '');
          const flags = flagValues(parsed.args, parsed.flags);
          switch (parsed.sub) {
            case 'status': {
              const { text } = await deps.actions.status();
              return { kind: 'success', text };
            }
            case 'fight': {
              const stages = parsed.args.filter((arg) => !arg.startsWith('--')).join(',');
              const times = parsed.args.length > 1 ? Number.parseInt(parsed.args[1], 10) : 1;
              const result = await deps.actions.fight({
                stages,
                times: Number.isFinite(times) ? times : 1,
                confirm: flags['yes'] === true || flags.confirm === true,
              });
              return { kind: 'success', text: result.text };
            }
            case 'push': {
              const from = parsed.args.find((arg) => !arg.startsWith('--')) ?? '';
              const chapterRaw = flags.chapter;
              const chapter = typeof chapterRaw === 'string' ? Number.parseInt(chapterRaw, 10) : undefined;
              const result = await deps.actions.push({
                ...(from === '' ? {} : { from }),
                ...(Number.isFinite(chapter) ? { chapter } : {}),
                confirm: flags['yes'] === true || flags.confirm === true,
              });
              return { kind: 'success', text: result.text };
            }
            case 'rogue': {
              const theme = parsed.args.find((arg) => !arg.startsWith('--'));
              const result = await deps.actions.rogue({ ...(theme === undefined ? {} : { theme }) });
              return { kind: 'success', text: result.text };
            }
            case 'stop': {
              const result = await deps.actions.stop();
              return { kind: 'success', text: result.text };
            }
            default:
              return { kind: 'error', text: `未知子命令「${parsed.sub}」。可用：status / fight / push / rogue / stop。` };
          }
        } catch (error) {
          return { kind: 'error', text: describeError(error) };
        }
      },
    }));
  }

  // —— 面板端点（可选服务）——
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (effective.webStatus === true && webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    effect(() => webServer.register({
      kind: 'exact',
      path: '/arknights/status',
      handler: async (req, res) => {
        try {
          const body = JSON.stringify(deps.actions.statusObject({ refreshEmulator: true }));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        } catch (error) {
          const body = JSON.stringify({ ok: false, error: describeError(error) });
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        }
      },
    }));

    effect(() => webServer.register({
      kind: 'exact',
      path: '/arknights/action',
      handler: async (req, res) => {
        /** @param {number} status - HTTP 状态码。 @param {Record<string, any>} payload - 响应体。 */
        const reply = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        };
        try {
          if (req.method !== 'POST') {
            reply(405, { ok: false, error: { code: 'E_BAD_ARGS', message: '只接受 POST。' } });
            return;
          }
          const raw = await readBody(req, 64 * 1024);
          let payload;
          try {
            payload = raw === '' ? {} : JSON.parse(raw);
          } catch {
            reply(400, { ok: false, error: { code: 'E_BAD_ARGS', message: '请求体不是合法 JSON。' } });
            return;
          }
          if (payload === null || typeof payload !== 'object') {
            reply(400, { ok: false, error: { code: 'E_BAD_ARGS', message: '请求体必须是对象。' } });
            return;
          }
          switch (payload.action) {
            case 'fight': {
              const result = await deps.actions.fight({
                stages: String(payload.stages ?? ''),
                times: Number.isFinite(payload.times) ? payload.times : 1,
                ...(typeof payload.difficulty === 'string' ? { difficulty: payload.difficulty } : {}),
                confirm: payload.confirm === true,
              });
              reply(200, { ok: true, text: result.text, planned: result.planned, status: deps.actions.statusObject() });
              return;
            }
            case 'push': {
              const chapter = Number.isFinite(payload.chapter) ? payload.chapter : undefined;
              const result = await deps.actions.push({
                ...(typeof payload.from === 'string' && payload.from !== '' ? { from: payload.from } : {}),
                ...(chapter === undefined ? {} : { chapter }),
                confirm: payload.confirm === true,
              });
              reply(200, { ok: true, text: result.text, planned: result.planned, status: deps.actions.statusObject() });
              return;
            }
            case 'rogue': {
              const result = await deps.actions.rogue({
                ...(typeof payload.theme === 'string' ? { theme: payload.theme } : {}),
                ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}),
              });
              reply(200, { ok: true, text: result.text, status: deps.actions.statusObject() });
              return;
            }
            case 'stop': {
              const result = await deps.actions.stop();
              reply(200, { ok: true, text: result.text, status: deps.actions.statusObject() });
              return;
            }
            default:
              reply(400, { ok: false, error: { code: 'E_BAD_ARGS', message: `未知 action「${String(payload.action)}」。` } });
          }
        } catch (error) {
          const normalized = normalizeError(error);
          reply(normalized.code === 'E_BUSY' ? 409 : 500, {
            ok: false,
            error: { code: normalized.code, message: normalized.message, ...(normalized.hint ? { hint: normalized.hint } : {}) },
          });
        }
      },
    }));
  }

  try {
    ctx.logger?.info?.(
      `[arknights] 就绪：${definitions.length} 个工具（${definitions.map((definition) => definition.name).join(', ')}）；`
      + `confirmRequired=${effective.confirmRequired}，dryRun=${effective.dryRun}，`
      + `作业站 ${effective.copilot.enabled ? '开' : '关'}，账本 ${deps.paths.ledgerFile}。`,
    );
  } catch {
    // 日志不可用无所谓。
  }
}

/**
 * 读请求体（带上限）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<string>} 请求体。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(arkError('E_BAD_ARGS', '请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(normalizeError(error)));
  });
}

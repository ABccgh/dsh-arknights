/**
 * `@local/arknights` v1.0 插件入口。
 *
 * 组装：环境探测、懒启动侧车、状态/账本/历史/仓库、数据层、动作门面、13 个全局工具、
 * `/ark` 命令、`/arknights/{status,query,action}` 三个面板端点。
 *
 * 三条硬约束：
 * 1. 不 import 任何 `@deepseek-ai/*`（link 安装的 bundle 在 DSH 安装作用域之外）；
 * 2. `apply` 不返回值（Cordis 会把返回值当 effect 收集）；
 * 3. 所有注册走 `ctx.effect`，HMR/卸载时能回收。
 *
 * @module @local/arknights
 */

import { fileURLToPath } from 'node:url';

import { createActions } from './actions/index.js';
import { createRuntime } from './actions/runtime.js';
import { createRunStore } from './actions/shared.js';
import { createArkrec } from './arkrec.js';
import { createBox } from './box.js';
import { normalizeConfig, resolvePaths } from './config.js';
import { parseCommand, runCommand } from './commands.js';
import { createCopilot } from './copilot.js';
import { createData } from './data/query.js';
import { createEnvironment } from './environment.js';
import { arkError, describeError } from './errors.js';
import { createHistory } from './history.js';
import { createHttp } from './http.js';
import { createLedger } from './ledger.js';
import { createMaaSession } from './maa-session.js';
import { createQuery } from './query.js';
import { createStatus } from './status.js';
import { createState } from './state.js';
import { loadResources } from './stages.js';
import { createAwardTools } from './tools/award.js';
import { createBoxTools } from './tools/box.js';
import { createDailyTools } from './tools/daily.js';
import { createDataTools } from './tools/data.js';
import { createFightTools } from './tools/fight.js';
import { createInfrastTools } from './tools/infrast.js';
import { createMallTools } from './tools/mall.js';
import { createPlanTools } from './tools/plan.js';
import { createPushTools } from './tools/push.js';
import { createRecruitTools } from './tools/recruit.js';
import { createRogueTools } from './tools/rogue.js';
import { createStatusTools } from './tools/status.js';
import { createStopTools } from './tools/stop.js';

export { parseCommand };

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'arknights';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 组装运行时依赖。
 * @param {Record<string, any>} config - 生效配置。
 * @param {Record<string, any>} [overrides] - 测试接缝。
 * @returns {Record<string, any>} 依赖。
 */
export function createDeps(config, overrides = {}) {
  config = normalizeConfig(config);
  const logger = overrides.logger;
  const paths = resolvePaths(config);
  const env = overrides.env ?? createEnvironment({ config, paths, logger });
  const state = overrides.state ?? createState();
  const ledger = overrides.ledger ?? createLedger({ file: paths.ledgerFile, logger });
  const history = overrides.history ?? createHistory({ file: paths.historyFile, maxEntries: config.history.maxEntries, logger });
  const box = overrides.box ?? createBox({ file: paths.boxFile, logger });
  const data = overrides.data ?? createData({
    config,
    paths,
    logger,
    maaPath: async () => {
      const detected = await env.get({ fresh: false });
      return detected.maaPath;
    },
    ...(typeof overrides.fetchImpl === 'function' ? { fetchImpl: overrides.fetchImpl } : {}),
  });
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

  /** 连接状态（给状态面板与 run 诊断用）。 */
  const connection = { connected: false, address: '', at: null, clientType: config.clientType };

  // —— 侧车：懒创建（第一次真正需要 MAA 时才找 python 并起进程）——
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

  /** 侧车门面：把懒创建藏在稳定对象后面。 */
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
    screenshot: async (options = {}) => {
      if (inner === null) throw arkError('E_NOT_READY', '侧车尚未启动，无法用 MAA 截图。');
      if (typeof inner.screenshot !== 'function') throw arkError('E_NOT_SUPPORTED', '侧车不支持 screenshot。');
      return inner.screenshot(options);
    },
    setParams: async (taskId, params) => {
      if (inner === null) throw arkError('E_NOT_READY', '侧车尚未启动。');
      if (typeof inner.setParams !== 'function') throw arkError('E_NOT_SUPPORTED', '侧车不支持 setParams。');
      return inner.setParams(taskId, params);
    },
    backHome: async () => {
      if (inner === null) throw arkError('E_NOT_READY', '侧车尚未启动。');
      if (typeof inner.backHome !== 'function') throw arkError('E_NOT_SUPPORTED', '侧车不支持 backHome。');
      return inner.backHome();
    },
    stop: async (options = {}) => {
      if (inner === null) return { running: false };
      if (typeof inner.stop === 'function') return inner.stop(options);
      return inner.request('stop', {}, options);
    },
    requestPriority: async (op, args = {}, requestOptions = {}) => {
      if (inner === null) throw arkError('E_NOT_READY', '侧车尚未启动。');
      if (typeof inner.requestPriority === 'function') return inner.requestPriority(op, args, requestOptions);
      return inner.request(op, args, requestOptions);
    },
    dispose: () => {
      if (inner !== null) inner.dispose();
      inner = null;
    },
  };

  const resources = async () => {
    const detected = await env.get();
    return loadResources(detected.maaPath);
  };

  const store = overrides.store ?? createRunStore({
    history,
    logger,
    onChange: (snapshot) => {
      if (typeof state.setRun === 'function') state.setRun(snapshot);
    },
  });

  const runtime = overrides.runtime ?? createRuntime({
    config,
    paths,
    env,
    session,
    state,
    logger,
    onReady: ({ address }) => {
      connection.connected = true;
      connection.address = String(address ?? '');
      connection.at = new Date().toISOString();
    },
  });

  const actions = overrides.actions ?? createActions({
    config,
    paths,
    env,
    session,
    state,
    ledger,
    history,
    box,
    data,
    copilot,
    arkrec,
    resources,
    runtime,
    store,
    logger,
  });

  const status = overrides.status ?? createStatus({
    config,
    paths,
    env,
    session,
    state,
    ledger,
    box,
    data,
    runStore: store,
    connection: () => connection,
    lastError: () => {
      const last = store.last();
      if (last === null || last?.error === undefined) return { lastCode: null, lastMessage: null, at: null };
      return { lastCode: last.error.code, lastMessage: last.error.message, at: last.endedAt ?? last.updatedAt ?? null };
    },
  });

  const query = overrides.query ?? createQuery({ data, box, copilot, config });

  return {
    config,
    paths,
    env,
    state,
    ledger,
    history,
    box,
    data,
    copilot,
    arkrec,
    session,
    store,
    runtime,
    actions,
    status,
    query,
    resources,
    logger,
  };
}

/**
 * 造全部工具定义（顺序即工具表顺序）。
 * @param {ReturnType<typeof createDeps>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createToolDefinitions(deps) {
  return [
    ...createStatusTools(deps),
    ...createFightTools(deps),
    ...createPushTools(deps),
    ...createRogueTools(deps),
    ...createDailyTools(deps),
    ...createRecruitTools(deps),
    ...createInfrastTools(deps),
    ...createMallTools(deps),
    ...createAwardTools(deps),
    ...createBoxTools(deps),
    ...createDataTools(deps),
    ...createPlanTools(deps),
    ...createStopTools(deps),
  ];
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
      description: '明日方舟：`/ark status | fight <关卡> [次数] [--yes] | push [起点] | rogue [主题] | daily | recruit [execute] | infrast | mall | award | box | data <kind> <q> | plan <目标> | stop`',
      input: { hint: 'status | fight 5-10 | push 5-3 | rogue Sarkaz | daily | recruit | stop' },
      handler: async (invocation) => {
        const result = await runCommand(invocation?.rawInput ?? '', {
          actions: deps.actions,
          status: deps.status,
          query: deps.query,
          config: effective,
        });
        return result;
      },
    }));
  }

  // —— 面板端点（可选服务）——
  // webServer 可能在本插件 apply 时尚未就绪（bundle 激活顺序不确定）；这里先试一次，
  // 未就绪则短轮询到它出现为止，避免“每次重启都要手动重载插件才有路由”。
  if (effective.webStatus === true) {
    const http = createHttp({
      config: effective,
      status: deps.status,
      actions: deps.actions,
      query: deps.query,
      logger: deps.logger,
    });
    /**
     * 尝试注册三个路由。
     * @returns {(() => void) | null} 清理函数；服务未就绪返回 null。
     */
    const installWebRoutes = () => {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return null;
      try {
        const disposers = http.register(webServer);
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // 单个路由清理失败不影响其它路由。
            }
          }
        };
      } catch (error) {
        ctx.logger?.warn?.(`[arknights] 面板路由注册失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    const immediateCleanup = installWebRoutes();
    if (immediateCleanup !== null) {
      effect(() => immediateCleanup);
    } else {
      /** @type {ReturnType<typeof setInterval> | null} */
      let timer = null;
      /** @type {(() => void) | null} */
      let retryCleanup = null;
      let attempts = 0;
      effect(() => () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (retryCleanup !== null) {
          retryCleanup();
          retryCleanup = null;
        }
      });
      const retry = () => {
        retryCleanup = installWebRoutes();
        if (retryCleanup !== null) {
          if (timer !== null) clearInterval(timer);
          timer = null;
          ctx.logger?.info?.('[arknights] webServer 就绪，面板路由已注册。');
          return;
        }
        attempts += 1;
        if (attempts >= 240) {
          if (timer !== null) clearInterval(timer);
          timer = null;
          ctx.logger?.warn?.('[arknights] webServer 60s 内仍不可用，面板端点未注册；工具仍可用。');
        }
      };
      timer = setInterval(retry, 250);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  try {
    ctx.logger?.info?.(
      `[arknights] v1.0 就绪：${definitions.length} 个全局工具（${definitions.map((definition) => definition.name).join(', ')}）；`
      + `confirmRequired=${effective.confirmRequired}，dryRun=${effective.dryRun}，`
      + `作业站 ${effective.copilot.enabled ? '开' : '关'}，账本 ${deps.paths.ledgerFile}。`,
    );
  } catch {
    // 日志不可用无所谓。
  }
}

/**
 * 兼容旧测试/旧调用的错误描述。
 * @param {unknown} error - 错误。
 * @returns {string} 文本。
 */
export function describe(error) {
  return describeError(error);
}

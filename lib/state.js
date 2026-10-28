/**
 * 运行时状态：MAA 事件环形缓冲 + 派生状态（任务链、星级、理智、掉落）。
 *
 * 工具、`/ark` 命令、状态路由、面板都读这一份快照，避免各写一套解析。
 * 事件来自 `lib/maa-session.js` 推送的 `event` 行（见 docs/contracts.md §2.3、§4）。
 *
 * @module @local/arknights/state
 */

/** 环形缓冲上限。 */
const MAX_EVENTS = 300;
/** 状态 JSON 里最多带多少条事件。 */
const STATUS_EVENTS = 10;
/** 掉落表最多保留多少种材料。 */
const MAX_DROPS = 40;

/** MAA 消息码 → 名字（docs/contracts.md §6）。 */
export const MESSAGE_NAMES = {
  0: 'InternalError',
  1: 'InitFailed',
  2: 'ConnectionInfo',
  3: 'AllTasksCompleted',
  4: 'AsyncCallInfo',
  5: 'Destroyed',
  10000: 'TaskChainError',
  10001: 'TaskChainStart',
  10002: 'TaskChainCompleted',
  10003: 'TaskChainExtraInfo',
  10004: 'TaskChainStopped',
  20000: 'SubTaskError',
  20001: 'SubTaskStart',
  20002: 'SubTaskCompleted',
  20003: 'SubTaskExtraInfo',
  20004: 'SubTaskStopped',
  30000: 'ReportRequest',
};

/** 让「链已结束」的事件码。 */
const CHAIN_END_CODES = new Set([10000, 10002, 10004]);
/** 标志真正开战的事件 what。 */
const BATTLE_START_WHATS = new Set(['BattleStartAll', 'BattleOfficiallyBegin']);
/** 标志「无法代理」的 what 片段：MaaCore 实际发的是 `StageQueueUnableToAgent`（还有 `UnableToAgent2`）。 */
const UNABLE_TO_AGENT_MARKER = 'UnableToAgent';
/** 关卡未解锁/不存在的 what 片段。 */
const STAGE_NOT_FOUND_MARKER = 'StageQueueStageNotFound';

/**
 * 造一个状态容器。
 * @param {{ maxEvents?: number }} [options] - 选项。
 * @returns {ReturnType<typeof createState> extends never ? never : any} 状态对象（方法见下）。
 */
export function createState(options = {}) {
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : MAX_EVENTS;
  /** @type {Array<Record<string, any>>} */
  let events = [];
  let lastSeq = 0;
  /** @type {string | null} */
  let current = null;
  /** @type {Array<{ name: string, status: string, at: string }>} */
  let chains = [];
  /** @type {number | null} */
  let stars = null;
  /** @type {{ current: number | null, max: number | null }} */
  let sanity = { current: null, max: null };
  /** @type {Record<string, number>} */
  let drops = {};
  /** @type {string | null} */
  let branch = null;
  let battleStarted = false;

  const now = () => new Date().toISOString();

  /**
   * 收一条事件。
   * @param {{ seq?: number, code?: number, name?: string, details?: Record<string, any>, ts?: string }} payload
   *   侧车推送的 maa 事件负载。
   * @returns {Record<string, any>} 收下的事件。
   */
  const pushEvent = (payload) => {
    const code = Number.isInteger(payload?.code) ? payload.code : -1;
    const name = typeof payload?.name === 'string' && payload.name !== ''
      ? payload.name
      : (MESSAGE_NAMES[code] ?? `Code${code}`);
    const details = payload?.details !== null && typeof payload?.details === 'object' ? payload.details : {};
    const what = typeof details.what === 'string' ? details.what : undefined;
    const task = typeof details.taskchain === 'string' ? details.taskchain : undefined;
    const seq = Number.isInteger(payload?.seq) ? payload.seq : lastSeq + 1;
    lastSeq = Math.max(lastSeq, seq);

    const event = {
      seq,
      code,
      name,
      task: task ?? current ?? undefined,
      what,
      ts: typeof payload?.ts === 'string' ? payload.ts : now(),
      details,
    };
    events.push(event);
    if (events.length > maxEvents) events = events.slice(events.length - maxEvents);

    // —— 任务链 ——
    if (code === 10001) {
      current = task ?? null;
      chains.push({ name: current ?? 'Unknown', status: 'running', at: event.ts });
    } else if (CHAIN_END_CODES.has(code)) {
      const status = code === 10002 ? 'completed' : code === 10004 ? 'stopped' : 'error';
      applyChainStatus(task ?? current, status, event.ts);
      current = null;
    }

    // —— 星级 / 掉落 / 理智 ——
    if (what === 'StageDrops') {
      const value = Number.parseInt(String(details.stars ?? ''), 10);
      if (Number.isFinite(value)) stars = value;
      if (Array.isArray(details.stats)) {
        for (const item of details.stats) {
          const itemName = typeof item?.itemName === 'string' ? item.itemName : '';
          const quantity = Number.parseInt(String(item?.quantity ?? ''), 10);
          if (itemName === '' || !Number.isFinite(quantity)) continue;
          drops[itemName] = (drops[itemName] ?? 0) + quantity;
        }
        pruneDrops();
      }
    }
    if (what === 'NotThreeStars') stars = stars === null ? 0 : Math.min(stars, 2);
    if (what === 'SanityBeforeStage') {
      sanity = {
        current: parseIntOrNull(details.current_sanity),
        max: parseIntOrNull(details.max_sanity),
      };
    }
    if (BATTLE_START_WHATS.has(what ?? '')) battleStarted = true;
    if (what !== undefined && what.includes(UNABLE_TO_AGENT_MARKER)) branch = what;

    return event;
  };

  /** 掉落表太大时只留数量最多的若干种。 */
  const pruneDrops = () => {
    const keys = Object.keys(drops);
    if (keys.length <= MAX_DROPS) return;
    keys
      .sort((a, b) => drops[b] - drops[a])
      .slice(MAX_DROPS)
      .forEach((key) => { delete drops[key]; });
  };

  /**
   * 把某条链标成结束态（同名的最近一条运行中优先）。
   * @param {string | null} task - 链名。
   * @param {string} status - completed/error/stopped。
   * @param {string} at - 时间。
   * @returns {void}
   */
  const applyChainStatus = (task, status, at) => {
    for (let index = chains.length - 1; index >= 0; index -= 1) {
      const chain = chains[index];
      if (chain.status !== 'running') continue;
      if (task !== null && chain.name !== task) continue;
      chain.status = status;
      chain.at = at;
      return;
    }
    if (task !== null) chains.push({ name: task, status, at });
  };

  /** 一轮动作开始前清派生状态（事件缓冲与 seq 不清）。 */
  const resetChain = () => {
    current = null;
    chains = [];
    stars = null;
    drops = {};
    branch = null;
    battleStarted = false;
  };

  /**
   * 最近事件（时间正序）。
   * @param {number} [limit] - 最多几条。
   * @param {{ withDetails?: boolean }} [options] - 是否带上 MAA 的 details。
   * @returns {Array<Record<string, any>>} 事件副本。
   */
  const recentEvents = (limit = STATUS_EVENTS, options = {}) => {
    const count = Number.isInteger(limit) && limit > 0 ? limit : STATUS_EVENTS;
    const slice = events.slice(Math.max(0, events.length - count));
    if (options.withDetails === true) return slice.map((event) => ({ ...event }));
    return slice.map(({ details, ...rest }) => ({ ...rest }));
  };

  /**
   * 最近事件里是否出现过某个 `what`。
   * @param {string} what - MAA 的 details.what。
   * @returns {boolean} 出现过为 true。
   */
  const hasWhat = (what) => events.some((event) => event.what === what);

  /**
   * 从最近事件里找「缺哪个干员」（Copilot 的干员匹配失败）。
   * @returns {string} 文本；没有就空串。
   */
  const missingOperText = () => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.what !== 'BattleFormationOperbox1Unmatched') continue;
      const name = typeof event.details?.oper_name === 'string' ? event.details.oper_name : '';
      const group = typeof event.details?.group_name === 'string' ? event.details.group_name : '';
      const label = name !== '' ? name : group;
      if (label !== '') return `缺少干员：${label}。`;
    }
    return '';
  };

  /** 供状态 JSON 用的派生快照。 */
  const snapshot = () => ({
    tasks: { running: current !== null, current, chains: chains.map((chain) => ({ ...chain })) },
    stars,
    sanity: { current: sanity.current, max: sanity.max },
    drops: { ...drops },
    branch,
    battleStarted,
    events: recentEvents(),
    lastSeq,
  });

  return {
    pushEvent,
    resetChain,
    recentEvents,
    snapshot,
    hasWhat,
    missingOperText,
    getLastSeq: () => lastSeq,
    getStars: () => stars,
    getBranch: () => branch,
    isBattleStarted: () => battleStarted,
    getDrops: () => ({ ...drops }),
    getChains: () => chains.map((chain) => ({ ...chain })),
  };
}

/**
 * 安全解析整数。
 * @param {unknown} value - 原始值。
 * @returns {number | null} 整数或 null。
 */
function parseIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

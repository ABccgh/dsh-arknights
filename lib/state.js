/**
 * 运行时状态：MAA 事件环形缓冲 + 派生状态（任务链、星级、理智、掉落、领域事件）。
 *
 * 工具、`/ark` 命令、状态路由、面板都读这一份快照，避免各写一套解析。
 * 事件来自 `lib/maa-session.js` 推送的 `event` 行（见 docs/contracts.md §2.3、§3）。
 *
 * v2 变化（契约 §3）：
 * - 环形缓冲从 300 升到 500，状态 JSON 仍只带最近 10 条（无 details）；
 * - 新增领域事件归一化：recruit / infrast / depot / operbox / copilot / stage /
 *   chainExtra / connection / routingRestart；
 * - 新增 run 快照入口 `setRun({run,lastRun})`，并入 `snapshot()`；
 * - 旧字段（tasks/stars/sanity/drops/branch/battleStarted/events/lastSeq）全部保留，
 *   现有调用方与测试可以继续用。
 *
 * @module @local/arknights/state
 */

/** 环形缓冲上限（契约 §3：500）。 */
const MAX_EVENTS = 500;
/** 状态 JSON 里最多带多少条事件。 */
const STATUS_EVENTS = 10;
/** 掉落表最多保留多少种材料。 */
const MAX_DROPS = 40;
/** 领域事件里最多保留多少条记录（防止快照无限膨胀）。 */
const MAX_DOMAIN_ITEMS = 20;
/** 单个领域字段的字符串截断长度。 */
const DOMAIN_TEXT_LIMIT = 300;

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
 * 只保留浅层可序列化字段（领域快照用；避免把 MAA 的大 details 整个塞进状态）。
 * @param {unknown} details - MAA 回调 details。
 * @returns {Record<string, any>} 归一化的小对象。
 */
function domainDetails(details) {
  const out = {};
  if (details === null || typeof details !== 'object') return out;
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      out[key] = value.length > DOMAIN_TEXT_LIMIT ? `${value.slice(0, DOMAIN_TEXT_LIMIT)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value) && value.length <= MAX_DOMAIN_ITEMS) {
      const items = value.filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
      if (items.length === value.length) out[key] = items.map((item) => (typeof item === 'string' && item.length > DOMAIN_TEXT_LIMIT ? `${item.slice(0, DOMAIN_TEXT_LIMIT)}…` : item));
    }
  }
  return out;
}

/** 深拷贝（只用于小对象/事件）。 */
function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * 把 run 信封压成状态 JSON 用的精简版（契约 §4：去掉大数组）。
 * @param {unknown} run - run 信封。
 * @returns {Record<string, any> | null} 精简 run。
 */
export function summarizeRun(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(run)) {
    if (value === undefined) continue;
    if (key === 'planned' || key === 'executed' || key === 'events' || key === 'params') continue;
    if (typeof value === 'function' || key === 'signal' || key === 'update') continue;
    if (key === 'text' && typeof value === 'string') {
      out.text = value.length > 500 ? `${value.slice(0, 500)}…` : value;
      continue;
    }
    try {
      out[key] = clone(value);
    } catch {
      // 不可序列化的字段直接丢弃（快照必须是 JSON 安全的）。
    }
  }
  return out;
}

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
  /** @type {{ current: number | null, max: number | null, at: string | null }} */
  let sanity = { current: null, max: null, at: null };
  /** @type {Record<string, number>} */
  let drops = {};
  /** @type {string | null} */
  let branch = null;
  let battleStarted = false;

  // —— v2 领域状态 ——
  /** @type {{ tags: string[], result: Record<string, any> | null, refreshCount: number, noPermit: boolean, permitReserved: boolean, at: string | null }} */
  let recruit = { tags: [], result: null, refreshCount: 0, noPermit: false, permitReserved: false, at: null };
  /** @type {{ facility: string | null, product: Record<string, any> | null, notEnoughStaff: boolean, at: string | null }} */
  let infrast = { facility: null, product: null, notEnoughStaff: false, at: null };
  /** @type {{ total: number | null, at: string | null }} */
  let depot = { total: null, at: null };
  /** @type {{ operators: number | null, at: string | null }} */
  let operbox = { operators: null, at: null };
  /** @type {{ precheck: Record<string, any> | null, at: string | null }} */
  let copilot = { precheck: null, at: null };
  /** @type {{ info: Record<string, any> | null, unsupported: Record<string, any> | null, notFound: Record<string, any> | null, at: string | null }} */
  let stage = { info: null, unsupported: null, notFound: null, at: null };
  /** @type {Array<Record<string, any>>} */
  let chainExtra = [];
  /** @type {Record<string, any> | null} */
  let connection = null;
  let routingRestart = 0;
  /** @type {Record<string, any> | null} */
  let allTasksCompleted = null;
  /** @type {Record<string, any> | null} */
  let run = null;
  /** @type {Record<string, any> | null} */
  let lastRun = null;

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
    const outer = payload?.details !== null && typeof payload?.details === 'object' && !Array.isArray(payload.details)
      ? payload.details
      : {};
    // MAA 的 SubTaskExtraInfo / SubTaskStart 回调把业务字段放在 `details` 里：
    //   {class, details:{…}, subtask, taskchain, what}
    // 早期实现把整个对象当业务 details，导致 OperBoxInfo/StageDrops 等读不到 done/stars。
    // 这里统一拆一层：`details` 给领域消费者，taskchain/what 仍从外层取。
    const details = outer.details !== null && typeof outer.details === 'object' && !Array.isArray(outer.details)
      ? outer.details
      : outer;
    const what = typeof outer.what === 'string'
      ? outer.what
      : (typeof details.what === 'string' ? details.what : undefined);
    const task = typeof outer.taskchain === 'string'
      ? outer.taskchain
      : (typeof details.taskchain === 'string' ? details.taskchain : undefined);
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
        at: event.ts,
      };
    }
    if (BATTLE_START_WHATS.has(what ?? '')) battleStarted = true;
    if (what !== undefined && what.includes(UNABLE_TO_AGENT_MARKER)) branch = what;

    // —— v2 领域事件归一化（契约 §3）——
    normalizeDomain(code, what, details, event);

    return event;
  };

  /**
   * 归一化领域事件。
   * @param {number} code - MAA 消息码。
   * @param {string | undefined} what - `details.what`。
   * @param {Record<string, any>} details - MAA 回调 details。
   * @param {Record<string, any>} event - 已收下的事件（用于时间/任务）。
   * @returns {void}
   */
  const normalizeDomain = (code, what, details, event) => {
    const at = event.ts;
    if (code === 2) {
      connection = { at, ...domainDetails(details) };
      return;
    }
    if (code === 3) {
      allTasksCompleted = { at, ...(typeof details.taskchain === 'string' ? { task: details.taskchain } : {}) };
      return;
    }
    if (code === 10003) {
      chainExtra.push({ seq: event.seq, ...(typeof details.taskchain === 'string' ? { task: details.taskchain } : {}), at, ...domainDetails(details) });
      if (chainExtra.length > MAX_DOMAIN_ITEMS) chainExtra = chainExtra.slice(chainExtra.length - MAX_DOMAIN_ITEMS);
      return;
    }
    if (what === undefined) return;
    switch (what) {
      case 'RecruitTagsDetected': {
        const tags = Array.isArray(details.tags) ? details.tags.filter((tag) => typeof tag === 'string').slice(0, MAX_DOMAIN_ITEMS) : [];
        recruit = { ...recruit, tags, at };
        break;
      }
      case 'RecruitResult':
        recruit = {
          ...recruit,
          result: {
            at,
            ...(Array.isArray(details.tags) ? { tags: details.tags.filter((tag) => typeof tag === 'string') } : {}),
            ...(Number.isFinite(Number(details.level)) ? { level: Number(details.level) } : {}),
            ...(Array.isArray(details.opers) ? { opers: details.opers.filter((item) => typeof item === 'string').slice(0, MAX_DOMAIN_ITEMS) } : {}),
          },
        };
        break;
      case 'RecruitTagsRefreshed':
        recruit = { ...recruit, refreshCount: recruit.refreshCount + 1, at };
        break;
      case 'RecruitNoPermit':
        recruit = { ...recruit, noPermit: true, at };
        break;
      case 'RecruitPermitReserved':
        recruit = { ...recruit, permitReserved: true, at };
        break;
      case 'EnterFacility':
        infrast = {
          ...infrast,
          facility: typeof details.facility === 'string' ? details.facility : infrast.facility,
          at,
        };
        break;
      case 'ProductOfFacility':
        infrast = {
          ...infrast,
          product: { at, ...domainDetails(details) },
          ...(typeof details.facility === 'string' ? { facility: details.facility } : {}),
        };
        break;
      case 'NotEnoughStaff':
        infrast = { ...infrast, notEnoughStaff: true, at };
        break;
      case 'DepotInfo': {
        // MAA 的 details 是 `{done, data:"{itemId:count,...}"}`（无物品名）。
        let total = null;
        if (typeof details.data === 'string' && details.data.trim() !== '') {
          try {
            const parsed = JSON.parse(details.data);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) total = Object.keys(parsed).length;
          } catch {
            total = null;
          }
        }
        if (total === null) {
          total = parseIntOrNull(details.size ?? details.total ?? details.count ?? (Array.isArray(details.items) ? details.items.length : null));
        }
        depot = { total, at };
        break;
      }
      case 'OperBoxInfo':
        // MAA 的 details 是 `{done, all_opers:[…], own_opers:[…]}`。
        operbox = {
          operators: parseIntOrNull(
            (Array.isArray(details.own_opers) ? details.own_opers.length : null)
            ?? (Array.isArray(details.all_opers) ? details.all_opers.length : null)
            ?? details.size
            ?? details.total
            ?? details.count,
          ),
          at,
        };
        break;
      case 'CopilotPrecheckFile':
      case 'CopilotPrecheck':
        copilot = { precheck: { at, ...domainDetails(details) }, at };
        break;
      case 'StageInfo':
        stage = {
          ...stage,
          info: { at, ...domainDetails(details) },
          at,
        };
        break;
      case 'UnsupportedLevel':
        stage = {
          ...stage,
          unsupported: { at, ...domainDetails(details) },
          at,
        };
        break;
      case 'StageQueueStageNotFound':
        stage = {
          ...stage,
          notFound: { at, ...domainDetails(details) },
          at,
        };
        break;
      case 'RoutingRestart':
        routingRestart += 1;
        break;
      default:
        break;
    }
    if (what === STAGE_NOT_FOUND_MARKER) {
      stage = { ...stage, notFound: { at, ...domainDetails(details) }, at };
    }
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

  /**
   * 一轮动作开始前清派生状态（事件缓冲与 seq 不清）。
   * 周期性的全局快照（recruit/infrast/depot/operbox/connection）保留；
   * 与「这一轮」强相关的 copilot/stage/chainExtra/routingRestart 清掉。
   * @returns {void}
   */
  const resetChain = () => {
    current = null;
    chains = [];
    stars = null;
    drops = {};
    branch = null;
    battleStarted = false;
    copilot = { precheck: null, at: null };
    stage = { info: null, unsupported: null, notFound: null, at: null };
    chainExtra = [];
    routingRestart = 0;
    allTasksCompleted = null;
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

  /**
   * 设置 run 快照（动作层每次 begin/update/finish 时调用）。
   * @param {{ run?: Record<string, any> | null, lastRun?: Record<string, any> | null } | null} [input] - 快照。
   * @returns {{ run: Record<string, any> | null, lastRun: Record<string, any> | null }} 精简后的快照。
   */
  const setRun = (input = {}) => {
    if (input === null || input === undefined || typeof input !== 'object') {
      run = null;
      lastRun = null;
      return { run: null, lastRun: null };
    }
    if (Object.prototype.hasOwnProperty.call(input, 'run')) run = summarizeRun(input.run);
    if (Object.prototype.hasOwnProperty.call(input, 'lastRun')) lastRun = summarizeRun(input.lastRun);
    return { run: run === null ? null : clone(run), lastRun: lastRun === null ? null : clone(lastRun) };
  };

  /** 供状态 JSON 用的派生快照。 */
  const snapshot = () => ({
    tasks: { running: current !== null, current, chains: chains.map((chain) => ({ ...chain })) },
    stars,
    sanity: { current: sanity.current, max: sanity.max, at: sanity.at },
    drops: { ...drops },
    branch,
    battleStarted,
    events: recentEvents(),
    lastSeq,
    // —— v2：run 快照 ——
    run: run === null ? null : clone(run),
    lastRun: lastRun === null ? null : clone(lastRun),
    // —— v2：领域事件 ——
    recruit: clone(recruit),
    infrast: clone(infrast),
    depot: clone(depot),
    operbox: clone(operbox),
    copilot: clone(copilot),
    stage: clone(stage),
    chainExtra: chainExtra.map((entry) => ({ ...entry })),
    connection: connection === null ? null : clone(connection),
    routingRestart,
    allTasksCompleted: allTasksCompleted === null ? null : clone(allTasksCompleted),
  });

  return {
    pushEvent,
    resetChain,
    recentEvents,
    snapshot,
    hasWhat,
    missingOperText,
    setRun,
    getRun: () => (run === null ? null : clone(run)),
    getLastRun: () => (lastRun === null ? null : clone(lastRun)),
    getLastSeq: () => lastSeq,
    getStars: () => stars,
    getBranch: () => branch,
    getIsBattleStarted: () => battleStarted,
    isBattleStarted: () => battleStarted,
    getDrops: () => ({ ...drops }),
    getSanity: () => ({ current: sanity.current, max: sanity.max, at: sanity.at }),
    /** 最近一次理智快照的时间（契约 §5 的 `sanity.at`）。 */
    getSanityAt: () => sanity.at,
    getChains: () => chains.map((chain) => ({ ...chain })),
    getRecruit: () => clone(recruit),
    getInfrast: () => clone(infrast),
    getDepot: () => clone(depot),
    getOperbox: () => clone(operbox),
    getCopilot: () => clone(copilot),
    getStage: () => clone(stage),
    getConnection: () => (connection === null ? null : clone(connection)),
    getRoutingRestart: () => routingRestart,
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

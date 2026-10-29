/**
 * 全插件共享的契约常量（版本、工具名、动作、状态、枚举）。
 *
 * 这里是**唯一**的版本与名字来源：config / tools / tests / docs 都从这里取；
 * 新增工具或动作时先改本文件，再改 docs/contracts.md 与对应测试。
 *
 * @module @local/arknights/contracts
 */

/** 插件版本（与 package.json 一致）。 */
export const PLUGIN_VERSION = '1.0.0';
/** 侧车线路协议版本。 */
export const PROTOCOL_VERSION = '2.0.0';
/** 账本格式版本。 */
export const LEDGER_VERSION = 2;
/** 面板/工具状态 JSON 版本。 */
export const STATUS_SCHEMA = 2;
/** 仓库/干员快照格式版本。 */
export const BOX_VERSION = 1;
/** 运行历史格式版本。 */
export const HISTORY_VERSION = 1;

/** 允许的难度取值。 */
export const DIFFICULTIES = ['auto', 'easy', 'tough'];
/** 允许的触摸模式（MaaCore InstanceOptionType.TouchMode）。 */
export const TOUCH_MODES = ['minitouch', 'maatouch', 'adb', 'macplaytools', 'MumuExtras'];
/** 肉鸽主题。 */
export const ROGUE_THEMES = ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden', 'BlackFlow'];
/** 肉鸽友好模式名（映射到 MAA 6.21 的数字 mode）。 */
export const ROGUE_MODES = [
  'Exp',
  'Invest',
  'Start',
  'DeepExploration',
  'Collapse',
  'Monthly',
  'QuickFirstLayer',
  'JieGardenNode',
  'BlackFlowStart',
  'Custom',
];
/** 肉鸽友好模式 → MAA 数字模式（MAA 6.21 集成文档）。 */
export const ROGUE_MODE_NUMBERS = {
  Exp: 0,
  Invest: 1,
  Start: 4,
  Collapse: 5,
  Monthly: 6,
  DeepExploration: 7,
  QuickFirstLayer: 10001,
  JieGardenNode: 20001,
  BlackFlowStart: 30003,
};

/** 全局工具（任何会话可见）。 */
export const GLOBAL_TOOL_NAMES = [
  'ark_status',
  'ark_fight',
  'ark_push',
  'ark_rogue',
  'ark_daily',
  'ark_recruit',
  'ark_infrast',
  'ark_mall',
  'ark_award',
  'ark_box',
  'ark_data',
  'ark_plan',
  'ark_stop',
];
/** 预设作用域工具（仅「明日方舟」会话）。 */
export const PRESET_TOOL_NAMES = ['ark_diag', 'ark_solutions'];
/** PRTS 工具（dsh-prts）。 */
export const PRTS_TOOL_NAMES = [
  'prts_status',
  'prts_search',
  'prts_titles',
  'prts_page',
  'prts_sections',
  'prts_page_info',
  'prts_links',
  'prts_category',
  'prts_recent_changes',
  'prts_operator',
];

/** 会真正执行的动作（status/stop 不是 run）。 */
export const ACTION_KINDS = [
  'fight',
  'push',
  'rogue',
  'daily',
  'recruit',
  'infrast',
  'mall',
  'award',
  'box',
];
/** 需要 `confirm=true` 的动作。recruit 仅 execute 模式需要。 */
export const CONFIRM_REQUIRED_ACTIONS = ['fight', 'push', 'rogue', 'daily', 'infrast', 'mall'];
/** run 状态。 */
export const RUN_STATUSES = ['queued', 'planned', 'running', 'completed', 'partial', 'failed', 'stopped'];
/** 数据查询种类。 */
export const DATA_KINDS = ['stage', 'item', 'operator', 'activity', 'search', 'solutions'];
/** 失败分类码。 */
export const FAILURE_CODES = [
  'no-agent',
  'stage-not-found',
  'battle-start-timeout',
  'sanity-insufficient',
  'oper-missing',
  'copilot-file',
  'connection',
  'timeout',
  'stopped',
  'unknown',
];

/** 会消耗稀缺资源的参数名（用于安全闸与测试）。 */
export const RESOURCE_PARAM_KEYS = ['medicine', 'stone', 'useSanityPotion', 'expedite', 'permitReserve'];

/**
 * 动作是否需要确认。
 * @param {string} kind - 动作名。
 * @param {{ mode?: string, confirm?: boolean }} [params] - 参数。
 * @returns {boolean} 需要确认为 true。
 */
export function actionRequiresConfirm(kind, params = {}) {
  if (kind === 'recruit') return params.mode === 'execute';
  return CONFIRM_REQUIRED_ACTIONS.includes(kind);
}

/**
 * 是否为只读动作（不占用 MAA 单飞锁、可并发）。
 * @param {string} kind - 工具/动作名。
 * @returns {boolean} 只读为 true。
 */
export function isReadOnlyKind(kind) {
  return ['status', 'data', 'plan', 'solutions'].includes(kind);
}

/**
 * 把肉鸽模式名归一成 MAA 数字；`Custom` 或数字原样返回。
 * @param {string|number|undefined} value - 友好模式名或数字。
 * @returns {number} MAA mode。
 */
export function rogueModeNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return ROGUE_MODE_NUMBERS.Exp;
  const direct = Number.parseInt(text, 10);
  if (String(direct) === text) return direct;
  for (const [name, number] of Object.entries(ROGUE_MODE_NUMBERS)) {
    if (name.toLowerCase() === text.toLowerCase()) return number;
  }
  return ROGUE_MODE_NUMBERS.Exp;
}

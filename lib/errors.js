/**
 * 错误模型：所有对外失败都走 `ArkError`，带「人话原因 + 修复建议」。
 *
 * 工具层与服务层都不抛裸异常：Node/Python/MAA 三种来源的失败在这里被收口，
 * 模型与面板看到的永远是 `{code, message, hint}` 三件套。
 *
 * @module @local/arknights/errors
 */

/** 码表：`code → 默认中文消息`。新增码必须同步 docs/contracts.md。 */
export const ERROR_CODES = {
  E_MAA_NOT_FOUND: '没有找到 MAA 的 MaaCore.dll。',
  E_PYTHON_NOT_FOUND: '没有找到可用的 Python 解释器。',
  E_MAA_LOAD: 'MaaCore 加载失败（DLL 或 resource 资源）。',
  E_NOT_INIT: 'MaaCore 尚未初始化。',
  E_NOT_SUPPORTED: '当前侧车/MAA 不支持该操作。',
  E_DIAGNOSE: '诊断操作失败。',
  E_NOT_READY: '环境尚未就绪（模拟器、adb 或 MaaCore 连接）。',
  E_BAD_OP: '侧车收到未知操作。',
  E_PROTOCOL_VERSION: '侧车协议版本不匹配。',
  E_CONNECT: '连接模拟器失败。',
  E_ADB_NOT_FOUND: '没有找到 adb。',
  E_EMULATOR_NOT_FOUND: '没有找到 MuMu 模拟器。',
  E_EMULATOR_START: '模拟器启动超时。',
  E_TASK_TYPE: 'MAA 不接受该任务类型。',
  E_TASK_REJECTED: 'MAA 拒绝了任务参数。',
  E_STAGE_UNKNOWN: '关卡代码无法识别。',
  E_NO_SOLUTION: '该关卡没有可用作业。',
  E_SOLUTION_INVALID: '作业文件不可用。',
  E_OPER_MISSING: '作业要求的干员不满足。',
  E_NO_PERMIT: '没有可用招聘许可。',
  E_BOX_TIMEOUT: '仓库/干员识别超时。',
  E_PREFLIGHT: '预检未通过。',
  E_UNSAFE_RESOURCE: '安全闸拒绝了这次资源消耗。',
  E_DATA_UNAVAILABLE: '数据源暂时不可用，且没有可用缓存。',
  E_CACHE_CORRUPT: '缓存文件损坏。',
  E_TIMEOUT: '操作超时。',
  E_PROTOCOL: '侧车线路协议错误。',
  E_SIDECAR_EXIT: '侧车进程异常退出。',
  E_BAD_ARGS: '参数不合法。',
  E_CONFIG: '配置不合法。',
  E_DRY_RUN: 'dryRun 模式下不执行。',
  E_CONFIRM_REQUIRED: '需要 confirm=true 才会真正执行。',
  E_BUSY: '上一个动作还没结束。',
  E_ACTION_UNKNOWN: '未知动作。',
  E_RUN_NOT_FOUND: '找不到对应的运行记录。',
  E_ABORTED: '操作被中止。',
  E_UNDEFINED: '未分类错误。',
};

/**
 * 带码、带提示的错误。
 */
export class ArkError extends Error {
  /**
   * @param {string} code - 码表键。
   * @param {string} [message] - 覆盖默认消息。
   * @param {{ detail?: string, hint?: string, cause?: unknown, data?: Record<string, unknown> }} [options] - 附加现场。
   */
  constructor(code, message, options = {}) {
    const text = typeof message === 'string' && message !== '' ? message : (ERROR_CODES[code] ?? ERROR_CODES.E_UNDEFINED);
    super(text);
    this.name = 'ArkError';
    this.code = typeof code === 'string' && code !== '' ? code : 'E_UNDEFINED';
    this.detail = typeof options.detail === 'string' ? options.detail : undefined;
    this.hint = typeof options.hint === 'string' ? options.hint : undefined;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.data !== null && typeof options.data === 'object') this.data = options.data;
  }
}

/**
 * 造一个 `ArkError`。
 * @param {string} code - 码表键。
 * @param {string} [message] - 覆盖默认消息。
 * @param {{ detail?: string, hint?: string, cause?: unknown, data?: Record<string, unknown> }} [options] - 附加现场。
 * @returns {ArkError} 错误。
 */
export function arkError(code, message, options) {
  return new ArkError(code, message, options);
}

/**
 * 把任意抛出物收成 `ArkError`。
 * @param {unknown} error - 原始错误。
 * @param {string} [fallbackCode] - 无码时使用的码。
 * @returns {ArkError} 归一后的错误。
 */
export function normalizeError(error, fallbackCode = 'E_UNDEFINED') {
  if (error instanceof ArkError) return error;
  if (error instanceof Error) {
    return new ArkError(fallbackCode, error.message || ERROR_CODES[fallbackCode] || ERROR_CODES.E_UNDEFINED, {
      cause: error,
    });
  }
  return new ArkError(fallbackCode, String(error), { cause: error });
}

/**
 * 把错误渲染成给人看的多行文本（含修复建议与现场）。
 * @param {unknown} error - 原始错误。
 * @returns {string} 文本。
 */
export function describeError(error) {
  const normalized = normalizeError(error);
  const lines = [`${normalized.code}: ${normalized.message}`];
  if (normalized.detail) lines.push(`现场：${normalized.detail}`);
  if (normalized.hint) lines.push(`建议：${normalized.hint}`);
  return lines.join('\n');
}

/**
 * 从侧车返回的 `error` 对象造 `ArkError`。
 * @param {{ code?: string, message?: string, detail?: string } | undefined} payload - 侧车错误体。
 * @returns {ArkError} 错误。
 */
export function fromSidecarError(payload) {
  const code = typeof payload?.code === 'string' && payload.code !== '' ? payload.code : 'E_UNDEFINED';
  return new ArkError(code, typeof payload?.message === 'string' ? payload.message : undefined, {
    detail: typeof payload?.detail === 'string' ? payload.detail : undefined,
    hint: hintForCode(code),
  });
}

/**
 * 常见码的修复建议。
 * @param {string} code - 码表键。
 * @returns {string | undefined} 建议。
 */
export function hintForCode(code) {
  switch (code) {
    case 'E_MAA_NOT_FOUND':
      return '在 cordis.patch.yml 的 arknights 行里把 maaPath 指到 MAA 安装目录（含 MaaCore.dll 的那层）。';
    case 'E_PYTHON_NOT_FOUND':
      return '把 pythonPath 指到一个可用的 python.exe（Store 版占位符不行），或用 .dsh 运行时自带的 python。';
    case 'E_MAA_LOAD':
      return '先手动启动一次 MAA 主程序确认 resource 完整，再重试。';
    case 'E_ADB_NOT_FOUND':
      return '默认用 MuMu 自带的 shell\\adb.exe；若被移动，请在配置里指定 adbPath。';
    case 'E_EMULATOR_NOT_FOUND':
      return '在配置里指定 emulator.managerPath（MuMuManager.exe）与 emulator.installPath。';
    case 'E_EMULATOR_START':
      return '手动启动一次 MuMu，确认能进桌面后再重试。';
    case 'E_CONNECT':
      return '确认模拟器已开机、adb 端口（MuMu 12 默认 16384）没被别的进程占用。';
    case 'E_NOT_READY':
      return '先用 ark_status 看链路，再用 ark_diag probe 重新探测；模拟器没开时先启动模拟器。';
    case 'E_STAGE_UNKNOWN':
      return '用 ark_data(kind=stage, q=…) 查准确的关卡代码，或直接传内部 id（如 main_05-10）。';
    case 'E_NO_SOLUTION':
      return '用 copilotId 指定一份作业、用 file 传本地作业 JSON，或自己手动打一局（不借干员满星后就能用代理刷）。';
    case 'E_SOLUTION_INVALID':
      return '换一份作业，或确认作业 JSON 是 UTF-8 且是 MAA 作业站导出的格式。';
    case 'E_OPER_MISSING':
      return '换一份不需要这些干员的作业，或先用自己队伍手动打通。';
    case 'E_UNSAFE_RESOURCE':
      return '这是有意的安全闸：确认要消耗理智药/至纯源石/招聘许可/加急许可时，显式传参并让用户同意。';
    case 'E_DATA_UNAVAILABLE':
      return '检查网络或稍后重试；打关卡不依赖在线数据，仍可用代理指挥。';
    case 'E_TIMEOUT':
      return '确认游戏画面没有卡在弹窗/公告上，必要时用 ark_diag(action=screen) 看画面再重试。';
    case 'E_BUSY':
      return '等当前动作结束（ark_status 可看进度），或先 ark_stop。';
    case 'E_BOX_TIMEOUT':
      return '仓库/干员识别耗时较长；确认游戏在前台后重试，或改用 target=operbox。';
    case 'E_PROTOCOL_VERSION':
      return '侧车与 Node 端版本不一致；重装插件或重启 DSH。';
    default:
      return undefined;
  }
}

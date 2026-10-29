/* @local/arknights — Web panel client half (six-page panel).
 *
 * Plain browser JavaScript loaded through window.__ModuleLoader__. The Harness
 * Web GUI loads this file and the factory registers a lazy client plugin whose
 * id equals the package name. React comes from the page module table through
 * require('react'); there is no JSX, no TypeScript, no bundler and no other
 * dependency.
 *
 * Registered slots:
 *   - sidebar.panellist (list, id `arknights`, order 5): inline SVG icon that
 *     inherits the sidebar row color through currentColor.
 *   - main (keyed, key `arknights`): the six-page panel body.
 *
 * Host HTTP surface (docs/contracts.md):
 *   GET  /arknights/status  status JSON, polled every 2 s (1 s while a run is
 *                           active); every request is abortable and cancelled
 *                           on unmount.
 *   GET  /arknights/query?kind=stage|item|drop|operator|activity|search|solutions|plan|box
 *   POST /arknights/action?action=...  plan envelope (confirm:false) or run
 *                           envelope (confirm:true); long actions answer at once
 *                           and are tracked through status.run.
 *
 * Visible text always goes through t(); the locale service is used when the
 * host exposes it, otherwise the embedded dictionary is the fallback. Colors
 * come only from --dsw-alias-* theme tokens (the icon uses currentColor).
 */
window.__ModuleLoader__.load({
  id: '@local/arknights',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'arknights';
    const PANEL_ID = 'arknights';
    const STATUS_URL = '/arknights/status';
    const ACTION_URL = '/arknights/action';
    const QUERY_URL = '/arknights/query';

    /** Idle poll interval (no run active). */
    const POLL_IDLE_MS = 2000;
    /** Poll interval while status.run exists. */
    const POLL_RUN_MS = 1000;
    const STATUS_TIMEOUT_MS = 8000;
    const ACTION_TIMEOUT_MS = 20000;
    const PLAN_TIMEOUT_MS = 45000;
    const RECRUIT_TIMEOUT_MS = 200000;
    const QUERY_TIMEOUT_MS = 12000;
    const EVENT_LIMIT = 5;

    /* ------------------------------------------------------------------ *
     * Contract-shaped enums. These mirror lib/contracts.js; the static test
     * reads the arrays below and compares them with the host module.
     * ------------------------------------------------------------------ */
    const DIFFICULTIES = ["auto", "easy", "tough"];
    const ROGUE_THEMES = ["Phantom", "Mizuki", "Sami", "Sarkaz", "JieGarden", "BlackFlow"];
    const ROGUE_MODES = ["Exp", "Invest", "Start", "DeepExploration", "Collapse", "Monthly", "QuickFirstLayer", "JieGardenNode", "BlackFlowStart", "Custom"];
    const PAGE_KEYS = ["overview", "battle", "daily", "data", "box", "settings"];
    const ACTION_NAMES = ["fight", "push", "rogue", "daily", "recruit", "infrast", "mall", "award", "box", "stop"];
    const CONFIRM_REQUIRED_ACTIONS = ["fight", "push", "rogue", "daily", "infrast", "mall"];
    const DAILY_TASK_KEYS = ["award", "mall", "infrast", "recruit", "box"];
    const DAILY_DEFAULT_TASKS = ["award", "mall", "infrast"];
    const AWARD_FLAGS = ["award", "mail", "dailyPull", "orundum", "mining", "specialAccess", "signInEvent"];

    /** Sidebar / panel navigation entries (label keys stay literal for i18n). */
    const NAV_ITEMS = [
      { key: "overview", labelKey: "nav.overview" },
      { key: "battle", labelKey: "nav.battle" },
      { key: "daily", labelKey: "nav.daily" },
      { key: "data", labelKey: "nav.data" },
      { key: "box", labelKey: "nav.box" },
      { key: "settings", labelKey: "nav.settings" },
    ];

    /** Run status -> locale key. */
    const RUN_STATUS_KEYS = {
      queued: "runStatus.queued",
      planned: "runStatus.planned",
      running: "runStatus.running",
      completed: "runStatus.completed",
      partial: "runStatus.partial",
      failed: "runStatus.failed",
      stopped: "runStatus.stopped",
    };

    /** Action kind -> locale key. */
    const KIND_KEYS = {
      fight: "kinds.fight",
      push: "kinds.push",
      rogue: "kinds.rogue",
      daily: "kinds.daily",
      recruit: "kinds.recruit",
      infrast: "kinds.infrast",
      mall: "kinds.mall",
      award: "kinds.award",
      box: "kinds.box",
      plan: "kinds.plan",
      stop: "kinds.stop",
      data: "kinds.data",
      status: "kinds.status",
    };

    /** Difficulty -> locale key. */
    const DIFFICULTY_KEYS = {
      auto: "labels.difficultyAuto",
      easy: "labels.difficultyEasy",
      tough: "labels.difficultyTough",
    };

    /* ------------------------------------------------------------------ *
     * Embedded dictionaries. They are byte-for-byte mirrors of
     * locale/zh.json and locale/en.json (nested JSON object literals) and are
     * the only copy available to the browser when the locale service is
     * missing. test/client.static.test.js checks the three copies agree.
     * ------------------------------------------------------------------ */
    const ZH_NESTED = {
  "meta": {
    "title": "明日方舟助手",
    "description": "用本机 MAA + MuMu 模拟器打《明日方舟》：总览、战斗、日常、资料、仓库、设置六页面板，覆盖打关卡/推关/肉鸽、日常任务、掉率与材料规划、干员盒与仓库快照。"
  },
  "panel": {
    "title": "明日方舟",
    "subtitle": "战斗 · 日常 · 资料 · 仓库",
    "loading": "读取中…",
    "offline": "Host 未响应：显示上次成功读取的状态，控件仍可用",
    "offlineShort": "Host 未响应",
    "updatedAt": "更新于 {time}",
    "refresh": "刷新",
    "dismiss": "关闭",
    "copied": "已复制",
    "copyFailed": "复制失败，请手动选择文本",
    "copyDiagnostic": "复制诊断 JSON",
    "readOnlyHint": "只读面板：不写配置、不写 profile"
  },
  "nav": {
    "overview": "总览",
    "battle": "战斗",
    "daily": "日常",
    "data": "资料",
    "box": "仓库",
    "settings": "设置"
  },
  "common": {
    "empty": "暂无数据",
    "failed": "失败",
    "needsConfirm": "需确认",
    "never": "从未",
    "ok": "正常",
    "planOnly": "计划不改动游戏",
    "readOnly": "只读",
    "running": "运行中",
    "unknown": "未知",
    "zeroCost": "零消耗"
  },
  "time": {
    "justNow": "刚刚",
    "secondsAgo": "{n} 秒前",
    "minutesAgo": "{n} 分钟前",
    "hoursAgo": "{n} 小时前",
    "daysAgo": "{n} 天前"
  },
  "labels": {
    "alive": "存活",
    "at": "时间",
    "chapter": "章节",
    "connected": "已连接",
    "coreVersion": "MaaCore",
    "detail": "明细",
    "difficultyAuto": "自动（优先简单）",
    "difficultyEasy": "标准 / 普通",
    "difficultyTough": "磨难 / 险地",
    "disconnected": "未连接",
    "emulatorRunning": "已开机",
    "emulatorStopped": "未开机",
    "endedAt": "结束",
    "from": "起点",
    "fullStar": "满星",
    "id": "ID",
    "idle": "空闲",
    "items": "材料",
    "maaVersion": "MAA",
    "maxStages": "最多推几关",
    "missing": "未满星",
    "offline": "离线",
    "online": "在线",
    "operators": "干员",
    "phase": "阶段",
    "prime": "已领源石",
    "protocol": "协议",
    "result": "结果",
    "running": "运行中",
    "stars": "星数",
    "started": "已启动",
    "startedAt": "开始",
    "stopped": "未启动",
    "task": "任务"
  },
  "runStatus": {
    "queued": "排队中",
    "planned": "计划中",
    "running": "运行中",
    "completed": "已完成",
    "partial": "部分完成",
    "failed": "失败",
    "stopped": "已停止"
  },
  "kinds": {
    "fight": "打关卡",
    "push": "推关",
    "rogue": "肉鸽",
    "daily": "日常",
    "recruit": "公招",
    "infrast": "基建",
    "mall": "信用",
    "award": "签到",
    "box": "仓库",
    "plan": "材料规划",
    "data": "数据",
    "status": "状态",
    "stop": "停止"
  },
  "actions": {
    "analyze": "分析",
    "award": "领取每日奖励",
    "confirmExecute": "确认执行",
    "loadActivity": "加载活动",
    "planRun": "生成计划",
    "previewPlan": "计划预览",
    "refreshBox": "刷新快照",
    "search": "搜索",
    "stop": "停止"
  },
  "overview": {
    "adb": "adb",
    "android": "Android",
    "boxSummary": "干员 / 仓库",
    "config": "配置",
    "connection": "连接与环境",
    "connectionLine": "连接",
    "current": "当前",
    "daily": "今日日常",
    "date": "日期",
    "emulator": "模拟器",
    "errors": "最近错误",
    "events": "最近事件",
    "gotoBattle": "去战斗",
    "gotoBox": "去仓库",
    "gotoDaily": "去日常",
    "gotoData": "去资料",
    "last": "最近",
    "lastReason": "原因",
    "lastSeen": "最后识别",
    "lastStopped": "上次停在",
    "ledger": "关卡账本",
    "nextStage": "下一关",
    "noRun": "还没有 run 记录",
    "push": "推关进度",
    "quick": "快捷动作",
    "run": "当前 / 最近 run",
    "sanity": "理智",
    "sidecar": "MAA 侧车"
  },
  "battle": {
    "activityBadge": "活动",
    "apChip": "理智 {n}",
    "armedHint": "计划已生成：再点「确认执行」才会真正开打",
    "confirmHint": "先点「计划预览」（零消耗），再点「确认执行」才会真正开打",
    "copilotId": "作业 ID",
    "difficulty": "难度",
    "file": "本地作业 JSON",
    "filePlaceholder": "可选：绝对路径",
    "medicine": "理智药",
    "noStage": "请先填写关卡代码",
    "planned": "计划",
    "plannedTotal": "计划合计理智 {n}",
    "pushFromPlaceholder": "留空 = 用账本进度",
    "resourceLocked": "安全闸默认拒绝：保持 0；在配置 safety 里开启后才能改",
    "resourceZero": "默认 0：不使用稀缺资源",
    "rogueHint": "肉鸽为长任务：默认后台运行，看总览的 run 状态，用停止结束",
    "rogueMode": "模式",
    "rogueStarts": "开始次数上限",
    "rogueTheme": "主题",
    "sanityChip": "理智 {n}",
    "stage": "关卡",
    "stageHint": "支持 5-10 或 5-10,6-5；输入时给出补全",
    "stagePlaceholder": "例如 5-10 或 5-10,6-5",
    "stone": "至纯源石",
    "suggestEmpty": "没有匹配的关卡",
    "suggestLoading": "正在补全…",
    "suggestUnavailable": "补全不可用（查询路由未实现）",
    "tabFight": "打关卡",
    "tabPush": "推关",
    "tabRogue": "肉鸽",
    "times": "次数",
    "title": "战斗",
    "useSanityPotion": "抄作业时用理智药",
    "video": "本地录像",
    "videoPlaceholder": "可选：绝对路径"
  },
  "daily": {
    "award": "每日签到",
    "awardTitle": "签到项目（按面板勾选）",
    "box": "仓库快照",
    "combos": "标签组合",
    "combosEmpty": "分析后显示保底组合（等 Host 返回）",
    "combosHint": "组合来自 recruit 分析的 result.recruit.combos",
    "confirmLevels": "确认等级（如 4,5）",
    "executeLocked": "执行会消耗招聘许可，安全闸默认拒绝",
    "executeUnlocked": "招聘许可已允许",
    "expedite": "加急许可",
    "expediteLocked": "安全闸默认拒绝",
    "flagAward": "每日签到",
    "flagDailyPull": "每日单抽",
    "flagMail": "邮件",
    "flagMining": "挖矿",
    "flagOrundum": "合成玉",
    "firstTags": "首批标签",
    "firstTagsHint": "逗号分隔，可留空",
    "flagSignInEvent": "签到活动",
    "flagSpecialAccess": "限时访问",
    "infrast": "基建换班",
    "infrastHint": "基建参数由配置 daily.infrast 决定（面板暂不覆盖）",
    "level": "{n} 星",
    "levelsHint": "可留空",
    "levelsPlaceholder": "例如 4,5",
    "mall": "信用购物",
    "mallBlacklist": "黑名单",
    "mallBlacklistHint": "逗号分隔",
    "mallBuyFirst": "优先购买",
    "mallBuyFirstHint": "逗号分隔",
    "mallForceWhenFull": "信用满时强制购物",
    "mallOnlyDiscount": "只买折扣",
    "mallReserveMax": "信用低于 300 时停买",
    "mallShopping": "购物",
    "mallTitle": "信用购物参数（按面板勾选）",
    "mallVisitFriends": "访问好友",
    "noTasks": "至少选一项日常任务",
    "permitReserve": "招聘许可预留",
    "planned": "计划",
    "preserveTags": "保留标签",
    "recruit": "公招分析",
    "recruitTimes": "分析次数",
    "recruitTitle": "公招分析与标签组合",
    "refresh": "刷新标签",
    "results": "逐项结果",
    "selectLevels": "关注等级（如 4,5）",
    "skipDone": "跳过今天已完成",
    "slots": "标签位 {n}",
    "tags": "公招标签",
    "tagsEmpty": "分析后显示识别到的标签",
    "taskFail": "失败",
    "taskOk": "完成",
    "taskSkipped": "未做",
    "tasks": "任务",
    "title": "日常",
    "waitHint": "公招分析用 wait:true，可能需要 10–60 秒；执行招募受安全闸限制",
    "zeroSanity": "零理智"
  },
  "data": {
    "active": "进行中",
    "activity": "活动日历",
    "activityBadge": "活动关",
    "activityEmpty": "没有活动数据",
    "activityEnd": "结束",
    "activityStart": "开始",
    "activityUnavailable": "活动查询路由未实现",
    "apCost": "理智消耗",
    "bestStage": "最佳关卡",
    "dropEmpty": "没有掉率数据",
    "dropTable": "掉率",
    "dropUnavailable": "掉率查询路由未实现",
    "empty": "没有匹配结果",
    "expectedSanity": "期望理智",
    "expired": "已结束",
    "item": "材料",
    "kind": "查询种类",
    "kindItem": "材料",
    "kindSearch": "混合",
    "kindStage": "关卡",
    "lowSample": "样本少",
    "planner": "材料规划器",
    "plannerHint": "只读规划：GET query?kind=plan，不改配置、不消耗",
    "plannerTarget": "目标材料",
    "plannerTargetsPlaceholder": "例如 固源岩:10,聚酸酯组:5",
    "plannerUnavailable": "规划路由未实现（kind=plan）",
    "query": "关键词",
    "rate": "掉率",
    "searchPlaceholder": "关卡代码 / 材料名，例如 5-10 / 固源岩",
    "searchTitle": "关卡 / 材料搜索",
    "searching": "查询中…",
    "stage": "关卡",
    "totalExpected": "总期望理智",
    "unavailable": "查询路由未实现：输入仍可用，结果为空"
  },
  "box": {
    "depotEmpty": "没有仓库物品数据",
    "depotTitle": "仓库物品 Top",
    "detailUnavailable": "明细未落地：只显示计数（等 Host 返回 query kind=box 明细）",
    "elite": "精",
    "empty": "还没有干员盒快照",
    "level": "Lv",
    "potential": "潜",
    "loading": "读取快照中…",
    "notOwned": "未拥有",
    "operatorsTitle": "干员盒",
    "partial": "部分识别：快照可能不完整",
    "refreshing": "正在刷新快照…",
    "snapshotTitle": "快照",
    "starsLabel": "{n} 星",
    "updatedAt": "更新时间"
  },
  "errors": {
    "badResponse": "Host 返回了无法解析的响应",
    "code": "错误码",
    "detail": "详情",
    "hint": "建议",
    "message": "消息",
    "network": "网络请求失败（Host 未响应或连接中断）",
    "timeout": "请求超时（Host 未响应或操作太久）",
    "title": "错误",
    "unknown": "未知错误"
  },
  "hints": {
    "actionStarted": "已开始：{kind}",
    "emptyPlan": "计划为空（可能没有可执行的项）",
    "planReady": "计划已生成，确认后执行",
    "planTitle": "计划",
    "stopSent": "已发送停止指令"
  },
  "settings": {
    "activityCache": "活动缓存",
    "adbPath": "adb",
    "allowExpedite": "允许加急许可",
    "allowOriginitePrime": "允许至纯源石",
    "allowRecruitPermits": "允许招聘许可",
    "allowSanityPotion": "允许理智药",
    "arkrecCache": "ArkRec 缓存",
    "boxFile": "仓库快照",
    "configTitle": "生效配置",
    "confirmRequired": "强制确认",
    "dataTitle": "数据缓存",
    "defaultDifficulty": "默认难度",
    "disabled": "关",
    "dryRun": "dryRun（只计划）",
    "editHint": "修改配置请编辑 cordis.patch.yml，然后重启（改 lib/）或重载插件（只改配置）",
    "enabled": "开",
    "historyFile": "运行历史",
    "itemsData": "材料数据",
    "ledgerFile": "关卡账本",
    "maaPath": "MAA 目录",
    "noWarnings": "没有告警",
    "pathsTitle": "路径",
    "penguinCache": "penguin-stats 缓存",
    "pythonPath": "Python",
    "safetyTitle": "安全开关",
    "stagesData": "关卡数据",
    "userDir": "MAA userDir",
    "warnings": "数据告警"
  }
};
    const EN_NESTED = {
  "meta": {
    "title": "Arknights Assistant",
    "description": "Play Arknights through the local MAA core and MuMu emulator: a six-page panel (overview, battle, daily, data, box, settings) covering stage runs, main-story pushing, Integrated Strategies, dailies, drop rates and material planning, operator box and depot snapshots."
  },
  "panel": {
    "title": "Arknights",
    "subtitle": "Battle · Daily · Data · Box",
    "loading": "Loading…",
    "offline": "Host not responding: showing the last status; controls stay usable",
    "offlineShort": "Host not responding",
    "updatedAt": "Updated {time}",
    "refresh": "Refresh",
    "dismiss": "Dismiss",
    "copied": "Copied",
    "copyFailed": "Copy failed, please select the text manually",
    "copyDiagnostic": "Copy diagnostic JSON",
    "readOnlyHint": "Read-only panel: does not write config or profile"
  },
  "nav": {
    "overview": "Overview",
    "battle": "Battle",
    "daily": "Daily",
    "data": "Data",
    "box": "Box",
    "settings": "Settings"
  },
  "common": {
    "empty": "No data",
    "failed": "Failed",
    "needsConfirm": "Confirm",
    "never": "Never",
    "ok": "OK",
    "planOnly": "Plan only, game untouched",
    "readOnly": "Read-only",
    "running": "Running",
    "unknown": "Unknown",
    "zeroCost": "Zero cost"
  },
  "time": {
    "justNow": "just now",
    "secondsAgo": "{n}s ago",
    "minutesAgo": "{n}m ago",
    "hoursAgo": "{n}h ago",
    "daysAgo": "{n}d ago"
  },
  "labels": {
    "alive": "Alive",
    "at": "Time",
    "chapter": "Chapter",
    "connected": "Connected",
    "coreVersion": "MaaCore",
    "detail": "Details",
    "difficultyAuto": "Auto (prefer easy)",
    "difficultyEasy": "Standard / Normal",
    "difficultyTough": "Tough / Hazard",
    "disconnected": "Disconnected",
    "emulatorRunning": "Started",
    "emulatorStopped": "Stopped",
    "endedAt": "Ended",
    "from": "From",
    "fullStar": "Full star",
    "id": "ID",
    "idle": "Idle",
    "items": "Items",
    "maaVersion": "MAA",
    "maxStages": "Max stages",
    "missing": "Not full star",
    "offline": "Offline",
    "online": "Online",
    "operators": "Operators",
    "phase": "Phase",
    "prime": "Prime claimed",
    "protocol": "Protocol",
    "result": "Result",
    "running": "Running",
    "stars": "Stars",
    "started": "Started",
    "startedAt": "Started",
    "stopped": "Stopped",
    "task": "Task"
  },
  "runStatus": {
    "queued": "Queued",
    "planned": "Planned",
    "running": "Running",
    "completed": "Completed",
    "partial": "Partial",
    "failed": "Failed",
    "stopped": "Stopped"
  },
  "kinds": {
    "fight": "Fight",
    "push": "Push",
    "rogue": "Roguelike",
    "daily": "Daily",
    "recruit": "Recruitment",
    "infrast": "Infrastructure",
    "mall": "Credit store",
    "award": "Award",
    "box": "Box",
    "plan": "Material plan",
    "data": "Data",
    "status": "Status",
    "stop": "Stop"
  },
  "actions": {
    "analyze": "Analyze",
    "award": "Claim daily rewards",
    "confirmExecute": "Confirm run",
    "loadActivity": "Load events",
    "planRun": "Generate plan",
    "previewPlan": "Preview plan",
    "refreshBox": "Refresh snapshot",
    "search": "Search",
    "stop": "Stop"
  },
  "overview": {
    "adb": "adb",
    "android": "Android",
    "boxSummary": "Operators / Box",
    "config": "Config",
    "connection": "Connection & environment",
    "connectionLine": "Connection",
    "current": "Current",
    "daily": "Today's dailies",
    "date": "Date",
    "emulator": "Emulator",
    "errors": "Last error",
    "events": "Recent events",
    "gotoBattle": "Open battle",
    "gotoBox": "Open box",
    "gotoDaily": "Open daily",
    "gotoData": "Open data",
    "last": "Last",
    "lastReason": "Reason",
    "lastSeen": "Last seen",
    "lastStopped": "Stopped at",
    "ledger": "Stage ledger",
    "nextStage": "Next stage",
    "noRun": "No runs yet",
    "push": "Push progress",
    "quick": "Quick actions",
    "run": "Current / last run",
    "sanity": "Sanity",
    "sidecar": "MAA sidecar"
  },
  "battle": {
    "activityBadge": "Event",
    "apChip": "{n} sanity",
    "armedHint": "Plan ready: press Confirm run to actually start",
    "confirmHint": "Press Preview plan first (zero cost), then Confirm run to start",
    "copilotId": "Copilot ID",
    "difficulty": "Difficulty",
    "file": "Local copilot JSON",
    "filePlaceholder": "Optional: absolute path",
    "medicine": "Sanity potion",
    "noStage": "Enter a stage code first",
    "planned": "Plan",
    "plannedTotal": "Planned total {n} sanity",
    "pushFromPlaceholder": "Empty = ledger progress",
    "resourceLocked": "Blocked by the safety gate: stays 0 unless enabled in config safety",
    "resourceZero": "Default 0: no scarce resource",
    "rogueHint": "Roguelike is a long task: it runs in the background; watch the run on overview and stop it there",
    "rogueMode": "Mode",
    "rogueStarts": "Max starts",
    "rogueTheme": "Theme",
    "sanityChip": "{n} sanity",
    "stage": "Stage",
    "stageHint": "Accepts 5-10 or 5-10,6-5; shows completions while typing",
    "stagePlaceholder": "e.g. 5-10 or 5-10,6-5",
    "stone": "Originite Prime",
    "suggestEmpty": "No matching stage",
    "suggestLoading": "Completing…",
    "suggestUnavailable": "Completion unavailable (query route not implemented)",
    "tabFight": "Fight",
    "tabPush": "Push",
    "tabRogue": "Roguelike",
    "times": "Runs",
    "title": "Battle",
    "useSanityPotion": "Use sanity potion for copilot runs",
    "video": "Local recording",
    "videoPlaceholder": "Optional: absolute path"
  },
  "daily": {
    "award": "Daily award",
    "awardTitle": "Award items (as ticked)",
    "box": "Box snapshot",
    "combos": "Tag combos",
    "combosEmpty": "Combos appear after analysis (waiting for the host)",
    "combosHint": "Combos come from result.recruit.combos of the recruit action",
    "confirmLevels": "Confirm levels (e.g. 4,5)",
    "executeLocked": "Execution spends recruit permits; blocked by the safety gate",
    "executeUnlocked": "Recruit permits allowed",
    "expedite": "Expedite permits",
    "expediteLocked": "Blocked by the safety gate",
    "flagAward": "Daily sign-in",
    "flagDailyPull": "Daily pull",
    "flagMail": "Mail",
    "flagMining": "Mining",
    "flagOrundum": "Orundum",
    "firstTags": "First tags",
    "firstTagsHint": "Comma separated, may be empty",
    "flagSignInEvent": "Sign-in event",
    "flagSpecialAccess": "Limited access",
    "infrast": "Infrastructure shift",
    "infrastHint": "Infrastructure parameters come from config daily.infrast (not editable here)",
    "level": "{n} stars",
    "levelsHint": "Can be empty",
    "levelsPlaceholder": "e.g. 4,5",
    "mall": "Credit store",
    "mallBlacklist": "Blacklist",
    "mallBlacklistHint": "Comma separated",
    "mallBuyFirst": "Buy first",
    "mallBuyFirstHint": "Comma separated",
    "mallForceWhenFull": "Force when credit full",
    "mallOnlyDiscount": "Only discounts",
    "mallReserveMax": "Stop when credit is low (300)",
    "mallShopping": "Shopping",
    "mallTitle": "Credit store parameters (as ticked)",
    "mallVisitFriends": "Visit friends",
    "noTasks": "Tick at least one daily task",
    "permitReserve": "Permit reserve",
    "planned": "Plan",
    "preserveTags": "Preserve tags",
    "recruit": "Recruitment analysis",
    "recruitTimes": "Analysis runs",
    "recruitTitle": "Recruitment analysis & tag combos",
    "refresh": "Refresh tags",
    "results": "Per-task results",
    "selectLevels": "Select levels (e.g. 4,5)",
    "skipDone": "Skip tasks already done today",
    "slots": "Slots {n}",
    "tags": "Recruitment tags",
    "tagsEmpty": "Tags appear after analysis",
    "taskFail": "Failed",
    "taskOk": "Done",
    "taskSkipped": "Not done",
    "tasks": "Tasks",
    "title": "Daily",
    "waitHint": "Recruitment analysis uses wait:true and may take 10–60 s; execution is gated by safety",
    "zeroSanity": "Zero sanity"
  },
  "data": {
    "active": "Active",
    "activity": "Activity calendar",
    "activityBadge": "Event stage",
    "activityEmpty": "No activity data",
    "activityEnd": "Ends",
    "activityStart": "Starts",
    "activityUnavailable": "Activity query route not implemented",
    "apCost": "AP cost",
    "bestStage": "Best stage",
    "dropEmpty": "No drop data",
    "dropTable": "Drop rates",
    "dropUnavailable": "Drop query route not implemented",
    "empty": "No matching results",
    "expectedSanity": "Expected sanity",
    "expired": "Ended",
    "item": "Item",
    "kind": "Query kind",
    "kindItem": "Items",
    "kindSearch": "Mixed",
    "kindStage": "Stages",
    "lowSample": "Low sample",
    "planner": "Material planner",
    "plannerHint": "Read-only planning: GET query?kind=plan; no config writes, no consumption",
    "plannerTarget": "Target materials",
    "plannerTargetsPlaceholder": "e.g. 固源岩:10,聚酸酯组:5",
    "plannerUnavailable": "Plan route not implemented (kind=plan)",
    "query": "Keywords",
    "rate": "Drop rate",
    "searchPlaceholder": "Stage code or item name, e.g. 5-10 / 固源岩",
    "searchTitle": "Stage / item search",
    "searching": "Searching…",
    "stage": "Stage",
    "totalExpected": "Total expected sanity",
    "unavailable": "Query route not implemented: input still works, results are empty"
  },
  "box": {
    "depotEmpty": "No depot items",
    "depotTitle": "Depot top items",
    "detailUnavailable": "Details not available yet: counts only (waiting for query kind=box)",
    "elite": "E",
    "empty": "No box snapshot yet",
    "level": "Lv",
    "potential": "P",
    "loading": "Loading snapshot…",
    "notOwned": "Not owned",
    "operatorsTitle": "Operator box",
    "partial": "Partial snapshot: may be incomplete",
    "refreshing": "Refreshing snapshot…",
    "snapshotTitle": "Snapshot",
    "starsLabel": "{n} stars",
    "updatedAt": "Updated"
  },
  "errors": {
    "badResponse": "Host returned an unparseable response",
    "code": "Code",
    "detail": "Detail",
    "hint": "Hint",
    "message": "Message",
    "network": "Network request failed (host not responding or connection lost)",
    "timeout": "Request timed out (host not responding or the action took too long)",
    "title": "Error",
    "unknown": "Unknown error"
  },
  "hints": {
    "actionStarted": "Started: {kind}",
    "emptyPlan": "The plan is empty (nothing to do)",
    "planReady": "Plan ready; confirm to execute",
    "planTitle": "Plan",
    "stopSent": "Stop requested"
  },
  "settings": {
    "activityCache": "Activity cache",
    "adbPath": "adb",
    "allowExpedite": "Allow expedite permits",
    "allowOriginitePrime": "Allow Originite Prime",
    "allowRecruitPermits": "Allow recruit permits",
    "allowSanityPotion": "Allow sanity potions",
    "arkrecCache": "ArkRec cache",
    "boxFile": "Box snapshot",
    "configTitle": "Effective config",
    "confirmRequired": "Require confirmation",
    "dataTitle": "Data caches",
    "defaultDifficulty": "Default difficulty",
    "disabled": "Off",
    "dryRun": "dryRun (plan only)",
    "editHint": "Edit cordis.patch.yml, then restart (lib/ changes) or reload the plugin (config only)",
    "enabled": "On",
    "historyFile": "Run history",
    "itemsData": "Item data",
    "ledgerFile": "Stage ledger",
    "maaPath": "MAA directory",
    "noWarnings": "No warnings",
    "pathsTitle": "Paths",
    "penguinCache": "penguin-stats cache",
    "pythonPath": "Python",
    "safetyTitle": "Safety switches",
    "stagesData": "Stage data",
    "userDir": "MAA userDir",
    "warnings": "Data warnings"
  }
};

    /** Flatten `{ a: { b: 'x' } }` into `{ 'a.b': 'x' }`. */
    function flattenDictionary(source, prefix, out) {
      const target = out || {};
      if (source === null || typeof source !== 'object') return target;
      for (const key of Object.keys(source)) {
        const value = source[key];
        const path = prefix === '' ? key : prefix + '.' + key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          flattenDictionary(value, path, target);
        } else if (typeof value === 'string') {
          target[path] = value;
        }
      }
      return target;
    }

    const ZH = flattenDictionary(ZH_NESTED, '', {});
    const EN = flattenDictionary(EN_NESTED, '', {});

    /** Browser-derived fallback language; zh* -> zh, everything else -> en. */
    function detectLanguage() {
      try {
        let tag = '';
        if (typeof navigator !== 'undefined' && navigator) {
          tag = String(navigator.language || (navigator.languages && navigator.languages[0]) || '');
        }
        return tag.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (err) {
        return 'en';
      }
    }

    const FALLBACK_DICTIONARY = detectLanguage() === 'zh' ? ZH : EN;

    /** Translate without the locale service (only when `locale` is missing). */
    function fallbackTranslate(key, params) {
      let template = FALLBACK_DICTIONARY[key];
      if (typeof template !== 'string') return String(key);
      if (params !== null && typeof params === 'object') {
        template = template.replace(/\{(\w+)\}/g, function (match, name) {
          return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
        });
      }
      return template;
    }

    /** Live translation state: replaced by the locale service bound `t` in apply. */
    const i18n = { t: fallbackTranslate, namespace: null };

    /**
     * Register the `arknights` dictionaries with the client locale service and
     * bind a live translator. The documented form is `register(ns, { zh, en })`;
     * the shipped built-in locale ids are `zh`/`en`. Falls back to the embedded
     * dictionary if the service is unavailable. Never throws.
     */
    function registerDictionaries(ctx) {
      let locale = null;
      try {
        locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
      } catch (err) {
        locale = null;
      }
      if (locale === null || locale === undefined) return;
      if (typeof locale.register !== 'function' || typeof locale.bind !== 'function') return;

      const effect = typeof ctx.effect === 'function'
        ? ctx.effect.bind(ctx)
        : function (callback) { return callback(); };

      // Dictionary lifetime rides the plugin fiber (HMR / unload safe).
      effect(function () {
        const disposers = [];
        const keep = function (disposer) {
          if (typeof disposer === 'function') disposers.push(disposer);
        };
        try {
          keep(locale.register(NS, { zh: ZH, en: EN }));
        } catch (err) {
          // Older/simpler shape: one locale at a time.
          try {
            keep(locale.register(NS, 'zh', ZH));
          } catch (zhError) {
            /* another owner already registered it — binding below still works */
          }
          try {
            keep(locale.register(NS, 'en', EN));
          } catch (enError) {
            /* same */
          }
        }
        return function () {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (err) {
              /* disposing a dictionary must never break unmount */
            }
          }
        };
      }, 'arknights: locale dictionaries');

      try {
        const bound = locale.bind(NS);
        if (typeof bound === 'function') {
          const probe = bound('panel.title');
          if (typeof probe === 'string' && probe !== '' && probe !== 'panel.title') {
            i18n.t = function (key, params) {
              return bound(key, params);
            };
            i18n.namespace = NS;
          }
        }
      } catch (err) {
        // Keep the embedded dictionary; never fail activation over i18n.
      }
    }

    /* ------------------------------------------------------------------ *
     * Safe-access helpers. The status JSON and every response may be partial
     * while the host boots, so all reads are guarded.
     * ------------------------------------------------------------------ */
    function asRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asString(value, fallback) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && isFinite(value)) return String(value);
      return typeof fallback === 'string' ? fallback : '';
    }

    function asCount(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    function pickString(source, keys) {
      const record = asRecord(source);
      if (record === null) return '';
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value !== '') return value;
        if (typeof value === 'number' && isFinite(value)) return String(value);
      }
      return '';
    }

    function pickNumber(source, keys) {
      const record = asRecord(source);
      if (record === null) return null;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && isFinite(value)) return value;
        if (typeof value === 'string' && value !== '' && isFinite(Number(value))) return Number(value);
      }
      return null;
    }

    function pickArray(source, keys) {
      const record = asRecord(source);
      if (record === null) return [];
      for (const key of keys) {
        if (Array.isArray(record[key])) return record[key];
      }
      return [];
    }

    /* ------------------------------------------------------------------ *
     * Formatting helpers.
     * ------------------------------------------------------------------ */
    function formatClock(value) {
      if (typeof value === 'number' && isFinite(value)) {
        try {
          return new Date(value).toLocaleString(undefined, { hour12: false });
        } catch (err) {
          return String(value);
        }
      }
      if (typeof value !== 'string' || value === '') return '—';
      const parsed = new Date(value);
      if (!isFinite(parsed.getTime())) return value;
      try {
        return parsed.toLocaleString(undefined, { hour12: false });
      } catch (err) {
        return value;
      }
    }

    function parseTimeMs(value) {
      if (typeof value === 'number' && isFinite(value)) return value;
      if (typeof value === 'string' && value !== '') {
        const parsed = new Date(value).getTime();
        return isFinite(parsed) ? parsed : 0;
      }
      return 0;
    }

    function formatAge(ms, t) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return t('common.unknown');
      if (ms < 10000) return t('time.justNow');
      if (ms < 60000) return t('time.secondsAgo', { n: Math.round(ms / 1000) });
      if (ms < 3600000) return t('time.minutesAgo', { n: Math.round(ms / 60000) });
      if (ms < 86400000) return t('time.hoursAgo', { n: Math.round(ms / 3600000) });
      return t('time.daysAgo', { n: Math.round(ms / 86400000) });
    }

    /** Relative "last seen" text for an ISO timestamp (or empty). */
    function relativeTime(value, t) {
      const ms = parseTimeMs(value);
      if (ms === 0) return t('common.never');
      return formatAge(Date.now() - ms, t);
    }

    function formatElapsed(startedAt, endedAt, t) {
      const start = parseTimeMs(startedAt);
      if (start === 0) return '—';
      const end = parseTimeMs(endedAt);
      return formatAge((end === 0 ? Date.now() : end) - start, t);
    }

    function queryUrl(kind, params) {
      const parts = ['kind=' + encodeURIComponent(String(kind))];
      const record = asRecord(params);
      if (record !== null) {
        for (const key of Object.keys(record)) {
          const value = record[key];
          if (value === undefined || value === null || value === '') continue;
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value)));
        }
      }
      return QUERY_URL + '?' + parts.join('&');
    }

    /** JSON signature of an action body (always built with a fixed key order). */
    function signatureOf(payload) {
      try {
        return JSON.stringify(payload);
      } catch (err) {
        return '';
      }
    }

    function splitList(text) {
      return String(text === undefined || text === null ? '' : text)
        .split(/[,，、\s]+/)
        .map(function (part) { return part.trim(); })
        .filter(function (part) { return part !== ''; });
    }

    function parsePositiveInt(text) {
      const parsed = Number.parseInt(String(text === undefined || text === null ? '' : text), 10);
      return isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function parseNonNegativeInt(text) {
      const parsed = Number.parseInt(String(text === undefined || text === null ? '' : text), 10);
      return isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    /* ------------------------------------------------------------------ *
     * Contract-shaped extraction helpers. Each one tolerates missing fields
     * (the host may land routes gradually); they never throw.
     * ------------------------------------------------------------------ */

    function runKindLabel(t, kind) {
      const key = KIND_KEYS[kind];
      return key === undefined ? asString(kind) : t(key);
    }

    function runStatusLabel(t, status) {
      const key = RUN_STATUS_KEYS[status];
      return key === undefined ? asString(status) : t(key);
    }

    function difficultyLabel(t, difficulty) {
      const key = DIFFICULTY_KEYS[difficulty];
      return key === undefined ? asString(difficulty) : t(key);
    }

    /** Planned rows from a plan envelope (`plannedItems` is the v1.0 field). */
    function extractPlanned(payload) {
      const record = asRecord(payload);
      if (record === null) return [];
      if (Array.isArray(record.plannedItems)) return record.plannedItems;
      if (Array.isArray(record.planned)) return record.planned;
      const result = asRecord(record.result);
      if (result !== null && Array.isArray(result.planned)) return result.planned;
      return [];
    }

    function extractPlannedTotal(payload) {
      const record = asRecord(payload);
      if (record === null) return null;
      const direct = pickNumber(record, ['plannedTotalSanity']);
      if (direct !== null) return direct;
      const result = asRecord(record.result);
      if (result !== null) {
        const nested = pickNumber(result, ['plannedTotalSanity']);
        if (nested !== null) return nested;
      }
      return null;
    }

    function extractResult(payload) {
      const record = asRecord(payload);
      if (record === null) return null;
      return asRecord(record.result);
    }

    /** `result.recruit` from a recruit response or from status.lastRun. */
    function extractRecruit(status, actionResult) {
      const candidates = [];
      const result = asRecord(actionResult);
      if (result !== null && result.action === 'recruit') {
        const data = asRecord(result.data);
        if (data !== null) {
          const responseResult = asRecord(data.result);
          if (responseResult !== null) candidates.push(asRecord(responseResult.recruit));
          candidates.push(asRecord(data.recruit));
        }
      }
      const root = asRecord(status);
      if (root !== null) {
        const lastRun = asRecord(root.lastRun);
        if (lastRun !== null && lastRun.kind === 'recruit') {
          const lastResult = asRecord(lastRun.result);
          if (lastResult !== null) candidates.push(asRecord(lastResult.recruit));
        }
      }
      for (const candidate of candidates) {
        if (candidate !== null) return candidate;
      }
      return null;
    }

    /** Per-task completion record from status.daily / status.lastRun.result.daily. */
    function dailyTaskInfo(status, key) {
      const root = asRecord(status);
      if (root === null) return null;
      const daily = asRecord(root.daily);
      const statusTasks = daily === null ? null : asRecord(daily.tasks);
      const fromStatus = statusTasks === null ? null : asRecord(statusTasks[key]);
      const lastRun = asRecord(root.lastRun);
      if (lastRun !== null && lastRun.kind === 'daily') {
        const result = asRecord(lastRun.result);
        const dailyResult = result === null ? null : asRecord(result.daily);
        const resultTasks = dailyResult === null ? null : asRecord(dailyResult.tasks);
        const fromResult = resultTasks === null ? null : asRecord(resultTasks[key]);
        if (fromResult !== null) return fromResult;
      }
      return fromStatus;
    }

    /** Operator rows for the box grid from a box query payload. */
    function extractBoxDetail(payload) {
      const record = asRecord(payload);
      if (record === null) return null;
      const resultNode = asRecord(record.result);
      const box = resultNode !== null ? (asRecord(resultNode.box) || resultNode) : record;
      const operatorsNode = asRecord(box.operators);
      const own = operatorsNode === null ? [] : asArray(operatorsNode.own);
      const all = operatorsNode === null ? [] : asArray(operatorsNode.all);
      const depotNode = asRecord(box.depot);
      const items = depotNode === null ? [] : asArray(depotNode.items);
      const updatedAt = pickString(box, ['updatedAt', 'at']);
      if (own.length === 0 && all.length === 0 && items.length === 0 && updatedAt === '') return null;
      return { own: own, all: all, items: items, updatedAt: updatedAt, partial: box.partial === true };
    }

    /** Flatten the box snapshot into grid rows (own flag resolved). */
    function operatorRows(detail) {
      const box = asRecord(detail);
      if (box === null) return [];
      const rows = [];
      const seen = {};
      const push = function (operator, forceOwn) {
        const record = asRecord(operator);
        if (record === null) return;
        const id = pickString(record, ['id', 'name']);
        if (id === '') return;
        if (seen[id] === true) return;
        seen[id] = true;
        rows.push({
          id: id,
          name: pickString(record, ['name', 'id']),
          rarity: pickNumber(record, ['rarity']) === null ? 1 : pickNumber(record, ['rarity']),
          own: forceOwn === true || record.own === true,
          elite: pickNumber(record, ['elite']),
          level: pickNumber(record, ['level']),
          potential: pickNumber(record, ['potential']),
        });
      };
      const ownIds = {};
      for (const operator of asArray(box.own)) {
        const id = pickString(operator, ['id', 'name']);
        if (id !== '') ownIds[id] = true;
      }
      for (const operator of asArray(box.all)) {
        const id = pickString(operator, ['id', 'name']);
        push(operator, ownIds[id] === true || asRecord(operator) !== null && asRecord(operator).own === true);
      }
      for (const operator of asArray(box.own)) push(operator, true);
      return rows;
    }

    /** Depot rows sorted by count (descending). */
    function depotRows(detail) {
      const box = asRecord(detail);
      if (box === null) return [];
      const rows = [];
      for (const item of asArray(box.items)) {
        const record = asRecord(item);
        if (record === null) continue;
        rows.push({
          id: pickString(record, ['id', 'itemId']),
          name: pickString(record, ['name', 'itemName', 'id']),
          count: pickNumber(record, ['count', 'quantity']) === null ? 0 : pickNumber(record, ['count', 'quantity']),
        });
      }
      rows.sort(function (left, right) { return right.count - left.count; });
      return rows;
    }

    /** `items` array of a query response. */
    function queryItems(payload) {
      const record = asRecord(payload);
      if (record === null) return [];
      return asArray(record.items);
    }

    /** Drop rows of a stage item (kind=stage returns drops inline). */
    function stageDropRows(stage) {
      const record = asRecord(stage);
      if (record === null) return [];
      return pickArray(record, ['drops', 'dropInfos']);
    }

    /** Planner payload rows (kind=plan). */
    function planTargets(payload) {
      const record = asRecord(payload);
      if (record === null) return [];
      return pickArray(record, ['targets']);
    }

    /* ------------------------------------------------------------------ *
     * Run helpers shared by the status cards and the pages.
     * ------------------------------------------------------------------ */
    function readStatus(status) {
      const root = asRecord(status) || {};
      const daily = asRecord(root.daily);
      return {
        sidecar: asRecord(root.sidecar),
        paths: asRecord(root.paths),
        emulator: asRecord(root.emulator),
        connection: asRecord(root.connection),
        tasks: asRecord(root.tasks),
        sanity: asRecord(root.sanity),
        drops: asRecord(root.drops),
        run: asRecord(root.run),
        lastRun: asRecord(root.lastRun),
        ledger: asRecord(root.ledger),
        push: asRecord(root.push),
        daily: daily,
        dailyTasks: daily === null ? null : asRecord(daily.tasks),
        box: asRecord(root.box),
        data: asRecord(root.data),
        errors: asRecord(root.errors),
        safety: asRecord(root.safety),
        config: asRecord(root.config),
        events: asArray(root.events),
      };
    }

    /* ------------------------------------------------------------------ *
     * HTTP layer. One small wrapper around fetch that owns its AbortController
     * per request (cancelled on unmount / timeout) and never rejects, so the
     * React tree only ever sees plain result objects.
     * ------------------------------------------------------------------ */
    function createApi() {
      const controllers = new Set();

      function cleanup(controller, timer) {
        if (timer !== null) {
          try { clearTimeout(timer); } catch (err) { /* ignore */ }
        }
        if (controller !== null) {
          try { controllers.delete(controller); } catch (err) { /* ignore */ }
        }
      }

      function request(url, options, timeoutMs) {
        const settings = asRecord(options) || {};
        let controller = null;
        try {
          controller = typeof AbortController === 'function' ? new AbortController() : null;
        } catch (err) {
          controller = null;
        }
        let timer = null;
        let timedOut = false;
        if (controller !== null) {
          controllers.add(controller);
          try {
            timer = setTimeout(function () {
              timedOut = true;
              try { controller.abort(); } catch (err) { /* ignore */ }
            }, Math.max(1000, Number(timeoutMs) || QUERY_TIMEOUT_MS));
          } catch (err) {
            timer = null;
          }
        }
        const finish = function (result) {
          cleanup(controller, timer);
          return result;
        };
        let pending;
        try {
          const headers = { accept: 'application/json' };
          const init = { method: settings.method === 'POST' ? 'POST' : 'GET', headers: headers, cache: 'no-store' };
          if (init.method === 'POST') {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(asRecord(settings.body) || {});
          }
          if (controller !== null) init.signal = controller.signal;
          pending = fetch(url, init).then(function (response) {
            const status = response && typeof response.status === 'number' ? response.status : 0;
            const ok = !!(response && response.ok);
            const parsed = response && typeof response.json === 'function'
              ? Promise.resolve(response.json()).then(function (value) { return value; }, function () { return null; })
              : Promise.resolve(null);
            return parsed.then(function (data) {
              return { ok: ok, status: status, data: data, network: false, timeout: false, aborted: false, error: null };
            });
          }).catch(function (error) {
            const aborted = !!(error && error.name === 'AbortError');
            return { ok: false, status: 0, data: null, network: true, timeout: timedOut, aborted: aborted, error: error || null };
          });
        } catch (error) {
          pending = Promise.resolve({ ok: false, status: 0, data: null, network: true, timeout: false, aborted: false, error: error || null });
        }
        return Promise.resolve(pending).then(finish, function (error) {
          return finish({ ok: false, status: 0, data: null, network: true, timeout: timedOut, aborted: false, error: error || null });
        });
      }

      return {
        request: request,
        /**
         * Abort every request still in flight (unmount / effect re-run). The
         * wrapper stays usable: only the outstanding requests are cancelled,
         * so a StrictMode double-mount does not poison later polling.
         */
        dispose: function () {
          for (const controller of Array.from(controllers)) {
            try { controller.abort(); } catch (err) { /* ignore */ }
          }
          controllers.clear();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Status polling. First read on mount, then 2 s idle / 1 s while a run is
     * active. Only one request is in flight at a time; unmount stops the timer
     * and the API wrapper aborts anything still pending.
     * ------------------------------------------------------------------ */
    function useArknightsStatus(api) {
      const [state, setState] = React.useState({ status: null, loading: true, offline: false, lastAt: 0, error: null });
      const stateRef = React.useRef(state);
      stateRef.current = state;
      const mountedRef = React.useRef(true);
      const inFlightRef = React.useRef(false);

      const applyStatus = React.useCallback(function (payload) {
        const data = asRecord(payload);
        if (data === null) return;
        setState({ status: data, loading: false, offline: false, lastAt: Date.now(), error: null });
      }, []);

      const refresh = React.useCallback(function () {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        api.request(STATUS_URL, { method: 'GET' }, STATUS_TIMEOUT_MS).then(function (response) {
          inFlightRef.current = false;
          if (!mountedRef.current) return;
          const data = asRecord(response.data);
          if (response.ok === true && data !== null && data.ok !== false) {
            setState({ status: data, loading: false, offline: false, lastAt: Date.now(), error: null });
            return;
          }
          const error = data === null ? null : asRecord(data.error);
          setState(function (previous) {
            return { status: previous.status, loading: false, offline: true, lastAt: previous.lastAt, error: error };
          });
        });
      }, [api]);

      React.useEffect(function () {
        mountedRef.current = true;
        refresh();
        return function () {
          mountedRef.current = false;
        };
      }, [refresh]);

      const runActive = state.status !== null && asRecord(state.status.run) !== null;
      React.useEffect(function () {
        let timer = null;
        try {
          timer = setInterval(refresh, runActive ? POLL_RUN_MS : POLL_IDLE_MS);
        } catch (err) {
          timer = null;
        }
        return function () {
          if (timer !== null) {
            try { clearInterval(timer); } catch (err) { /* ignore */ }
          }
        };
      }, [refresh, runActive]);

      return {
        status: state.status,
        loading: state.loading,
        offline: state.offline,
        lastAt: state.lastAt,
        error: state.error,
        refresh: refresh,
        applyStatus: applyStatus,
        statusRef: stateRef,
      };
    }

    /* ------------------------------------------------------------------ *
     * Action runner.
     *
     * Confirmable actions are two-step: `plan()` posts `confirm:false` and
     * stores the planned envelope; `execute()` posts `confirm:true` only while
     * the stored signature still matches the current parameters (so changing a
     * parameter silently invalidates the plan). Everything else is one-shot.
     * ------------------------------------------------------------------ */
    function useActionRunner(input) {
      const api = input.api;
      const t = input.t;
      const applyStatus = input.applyStatus;
      const refreshStatus = input.refreshStatus;

      const [inflight, setInflight] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [plans, setPlans] = React.useState({});
      const mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      const rememberStatus = function (data) {
        const record = asRecord(data);
        if (record === null) return;
        const snapshot = asRecord(record.status);
        if (snapshot !== null && typeof applyStatus === 'function') applyStatus(snapshot);
      };

      const post = function (payload, timeoutMs) {
        return api.request(ACTION_URL, { method: 'POST', body: payload }, timeoutMs).then(function (response) {
          if (response.network === true) {
            const timedOut = response.timeout === true;
            return {
              ok: false,
              network: true,
              error: {
                code: timedOut ? 'E_TIMEOUT' : 'E_NETWORK',
                message: timedOut ? t('errors.timeout') : t('errors.network'),
              },
            };
          }
          const data = asRecord(response.data);
          if (data === null) {
            return { ok: false, error: { code: 'E_BAD_RESPONSE', message: t('errors.badResponse') } };
          }
          if (data.ok === true) rememberStatus(data);
          return data;
        });
      };

      const makeResult = function (kind, payload, data) {
        const record = asRecord(data) || {};
        if (record.ok === true) {
          return {
            tone: 'ok',
            action: kind,
            payload: payload,
            text: asString(record.text, t('common.ok')),
            data: record,
            runId: pickString(record, ['runId']),
            started: record.started === true,
            at: Date.now(),
          };
        }
        const error = asRecord(record.error) || { code: 'E_UNKNOWN', message: t('errors.unknown') };
        return {
          tone: 'error',
          action: kind,
          payload: payload,
          text: asString(error.message, t('errors.unknown')),
          error: error,
          data: record,
          at: Date.now(),
        };
      };

      const plan = function (kind, payload, signature) {
        const body = Object.assign({}, payload, { action: kind, confirm: false });
        setInflight(kind);
        return post(body, PLAN_TIMEOUT_MS).then(function (data) {
          if (!mountedRef.current) return null;
          setInflight(null);
          const record = asRecord(data) || {};
          if (record.ok === true) {
            const plannedItems = extractPlanned(record);
            const totalSanity = extractPlannedTotal(record);
            setPlans(function (previous) {
              const next = Object.assign({}, previous);
              next[kind] = { signature: signature, plannedItems: plannedItems, totalSanity: totalSanity, text: asString(record.text), at: Date.now() };
              return next;
            });
            setResult({
              tone: 'plan',
              action: kind,
              payload: payload,
              text: asString(record.text, t('hints.planReady')),
              plannedItems: plannedItems,
              totalSanity: totalSanity,
              data: record,
              at: Date.now(),
            });
          } else {
            setPlans(function (previous) {
              const next = Object.assign({}, previous);
              delete next[kind];
              return next;
            });
            setResult(makeResult(kind, payload, record));
          }
          return record;
        });
      };

      const execute = function (kind, payload, signature) {
        const stored = plans[kind];
        if (stored === undefined || stored.signature !== signature) return plan(kind, payload, signature);
        const body = Object.assign({}, payload, { action: kind, confirm: true });
        setInflight(kind);
        return post(body, ACTION_TIMEOUT_MS).then(function (data) {
          if (!mountedRef.current) return null;
          setInflight(null);
          const record = asRecord(data) || {};
          if (record.ok === true) {
            setPlans(function (previous) {
              const next = Object.assign({}, previous);
              delete next[kind];
              return next;
            });
            setResult({
              tone: 'ok',
              action: kind,
              payload: payload,
              text: asString(record.text, t('hints.actionStarted', { kind: runKindLabel(t, kind) })),
              data: record,
              runId: pickString(record, ['runId']),
              started: record.started === true,
              at: Date.now(),
            });
            if (typeof refreshStatus === 'function') refreshStatus();
          } else {
            setResult(makeResult(kind, payload, record));
          }
          return record;
        });
      };

      const run = function (kind, payload, timeoutMs) {
        const body = Object.assign({}, payload, { action: kind });
        setInflight(kind);
        return post(body, timeoutMs || ACTION_TIMEOUT_MS).then(function (data) {
          if (!mountedRef.current) return null;
          setInflight(null);
          const record = asRecord(data);
          setResult(makeResult(kind, payload, record));
          if (record !== null && record.ok === true && typeof refreshStatus === 'function') refreshStatus();
          return record;
        });
      };

      const stop = function () {
        setInflight('stop');
        return post({ action: 'stop' }, ACTION_TIMEOUT_MS).then(function (data) {
          if (!mountedRef.current) return null;
          setInflight(null);
          const record = asRecord(data) || {};
          if (record.ok === true) {
            setResult({
              tone: 'info',
              action: 'stop',
              payload: {},
              text: asString(record.text, t('hints.stopSent')),
              data: record,
              at: Date.now(),
            });
            if (typeof refreshStatus === 'function') refreshStatus();
          } else {
            setResult(makeResult('stop', {}, record));
          }
          return record;
        });
      };

      const dismiss = function () {
        setResult(null);
      };

      const armedPlan = function (kind, signature) {
        const stored = plans[kind];
        if (stored === undefined || stored.signature !== signature) return null;
        return stored;
      };

      const ensure = function (kind, payload, signature) {
        return armedPlan(kind, signature) === null ? plan(kind, payload, signature) : execute(kind, payload, signature);
      };

      return {
        inflight: inflight,
        result: result,
        plans: plans,
        plan: plan,
        execute: execute,
        ensure: ensure,
        run: run,
        stop: stop,
        dismiss: dismiss,
        armedPlan: armedPlan,
        isArmed: function (kind, signature) { return armedPlan(kind, signature) !== null; },
      };
    }

    /* ------------------------------------------------------------------ *
     * Sidebar icon: inline SVG sized by the owner props `{ size, active }`,
     * tinted with `currentColor`, so the sidebar row theme color (including
     * its active state) is inherited. No hard-coded color.
     * ------------------------------------------------------------------ */
    function ArknightsIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color: 'inherit' },
        },
        h('path', {
          d: 'M12 2.4 20.2 6v5.3c0 4.7-3.3 8.6-8.2 10.3-4.9-1.7-8.2-5.6-8.2-10.3V6z',
          fill: active ? 'currentColor' : 'none',
          fillOpacity: active ? 0.18 : 0,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.4 15.6V8.5l3.6 3.7 3.6-3.7v7.1',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /* Daily task / award flag label keys (used by the overview and daily pages). */
    const DAILY_TASK_LABEL_KEYS = {
      award: "daily.award",
      mall: "daily.mall",
      infrast: "daily.infrast",
      recruit: "daily.recruit",
      box: "daily.box",
    };

    const AWARD_FLAG_KEYS = {
      award: "daily.flagAward",
      mail: "daily.flagMail",
      dailyPull: "daily.flagDailyPull",
      orundum: "daily.flagOrundum",
      mining: "daily.flagMining",
      specialAccess: "daily.flagSpecialAccess",
      signInEvent: "daily.flagSignInEvent",
    };

    const BATTLE_TAB_KEYS = {
      fight: "battle.tabFight",
      push: "battle.tabPush",
      rogue: "battle.tabRogue",
    };

    /* ------------------------------------------------------------------ *
     * Clipboard helper (diagnostics). Never throws; clipboard API first,
     * hidden textarea fallback for older webviews.
     * ------------------------------------------------------------------ */
    function copyText(text) {
      const value = String(text === undefined || text === null ? '' : text);
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return Promise.resolve(navigator.clipboard.writeText(value)).then(
            function () { return true; },
            function () { return fallbackCopy(value); },
          );
        }
      } catch (err) {
        /* fall through */
      }
      return Promise.resolve(fallbackCopy(value));
    }

    function fallbackCopy(value) {
      try {
        if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return false;
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '0';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return ok === true;
      } catch (err) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Small visual primitives. Every color comes from --dsw-alias-* tokens;
     * the spinner and the icon use currentColor only.
     * ------------------------------------------------------------------ */
    function Spinner() {
      return h('span', { className: 'ark-spinner', 'aria-hidden': 'true' });
    }

    function Badge(props) {
      const tone = typeof props.tone === 'string' ? props.tone : 'idle';
      return h('span', { className: 'ark-badge ark-badge-' + tone }, props.children);
    }

    function Dot(props) {
      const tone = typeof props.tone === 'string' ? props.tone : '';
      return h('span', { className: 'ark-dot' + (tone === '' ? '' : ' ark-dot-' + tone), 'aria-hidden': 'true' });
    }

    function EmptyState(props) {
      return h('div', { className: 'ark-empty' }, props.text);
    }

    function Card(props) {
      const children = [];
      if (props.title !== undefined || props.actions !== undefined) {
        const head = [h('div', { key: 'title', className: 'ark-card-title' }, props.title)];
        if (props.actions !== undefined && props.actions !== null) {
          head.push(h('div', { key: 'actions', className: 'ark-card-actions' }, props.actions));
        }
        children.push(h('div', { key: 'head', className: 'ark-card-head' }, head));
      }
      children.push(h('div', { key: 'body', className: 'ark-card-body' }, props.children));
      return h('section', { className: 'ark-card' + (props.wide === true ? ' ark-card-wide' : '') }, children);
    }

    function Field(props) {
      return h(
        'label',
        { className: 'ark-field' + (props.grow === true ? ' ark-field-grow' : '') },
        h('span', { className: 'ark-field-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'ark-field-hint' }, props.hint) : null,
      );
    }

    function TextInput(props) {
      return h('input', {
        className: 'ark-input' + (props.mono === true ? ' ark-mono' : ''),
        type: 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        disabled: props.disabled === true,
        spellCheck: false,
        autoComplete: 'off',
        'aria-label': props.ariaLabel || props.placeholder || '',
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(String(event && event.target ? event.target.value : ''));
        },
        onKeyDown: function (event) {
          if (event && event.key === 'Enter' && typeof props.onEnter === 'function') {
            event.preventDefault();
            props.onEnter();
          }
        },
      });
    }

    function NumberInput(props) {
      return h('input', {
        className: 'ark-input ark-input-num',
        type: 'number',
        min: props.min === undefined || props.min === null ? 0 : props.min,
        step: props.step === undefined || props.step === null ? 1 : props.step,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        disabled: props.disabled === true,
        'aria-label': props.ariaLabel || '',
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(String(event && event.target ? event.target.value : ''));
        },
      });
    }

    function SelectInput(props) {
      const options = asArray(props.options);
      return h(
        'select',
        {
          className: 'ark-select',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          disabled: props.disabled === true,
          'aria-label': props.ariaLabel || '',
          onChange: function (event) {
            if (typeof props.onChange === 'function') props.onChange(String(event && event.target ? event.target.value : ''));
          },
        },
        options.map(function (option) {
          const item = asRecord(option) || {};
          const value = pickString(item, ['value']);
          const label = pickString(item, ['label']);
          return h('option', { key: value, value: value }, label === '' ? value : label);
        }),
      );
    }

    function Checkbox(props) {
      return h(
        'label',
        { className: 'ark-check' + (props.disabled === true ? ' ark-check-disabled' : '') },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: function (event) {
            if (typeof props.onChange === 'function') props.onChange(!!(event && event.target && event.target.checked));
          },
        }),
        h('span', { className: 'ark-check-label' }, props.label),
        props.hint ? h('span', { className: 'ark-field-hint' }, props.hint) : null,
      );
    }

    function Button(props) {
      const variant = typeof props.variant === 'string' ? props.variant : 'secondary';
      const disabled = props.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          className: 'ark-btn ark-btn-' + variant + (props.small === true ? ' ark-btn-sm' : ''),
          disabled: disabled,
          title: props.title || '',
          onClick: function () {
            if (disabled) return;
            if (typeof props.onClick === 'function') props.onClick();
          },
        },
        props.busy === true ? h(Spinner) : null,
        h('span', null, props.children),
      );
    }

    function Stat(props) {
      return h(
        'span',
        { className: 'ark-stat' },
        h('span', { className: 'ark-stat-num' }, props.value),
        h('span', { className: 'ark-stat-label' }, props.label),
      );
    }

    function KeyValue(props) {
      return h(
        'div',
        { className: 'ark-kv' },
        h('span', { className: 'ark-kv-key' }, props.label),
        h('span', { className: 'ark-kv-value' }, props.value === undefined || props.value === null || props.value === '' ? '—' : props.value),
      );
    }

    function Banner(props) {
      const tone = typeof props.tone === 'string' ? props.tone : 'warn';
      return h('div', { className: 'ark-banner ark-banner-' + tone }, props.children);
    }

    function JsonDetails(props) {
      let text = '';
      try {
        text = JSON.stringify(props.json, null, 2);
      } catch (err) {
        text = String(props.json);
      }
      if (typeof text !== 'string' || text === '') text = '{}';
      return h(
        'details',
        { className: 'ark-details' },
        h('summary', null, props.label),
        h('pre', { className: 'ark-pre' }, text),
      );
    }

    function CopyButton(props) {
      const t = props.t;
      const [feedback, setFeedback] = React.useState('');
      const timerRef = React.useRef(null);
      React.useEffect(function () {
        return function () {
          if (timerRef.current !== null) {
            try { clearTimeout(timerRef.current); } catch (err) { /* ignore */ }
          }
        };
      }, []);
      const onClick = function () {
        copyText(props.text).then(function (ok) {
          setFeedback(ok ? t('panel.copied') : t('panel.copyFailed'));
          if (timerRef.current !== null) {
            try { clearTimeout(timerRef.current); } catch (err) { /* ignore */ }
          }
          timerRef.current = setTimeout(function () { setFeedback(''); }, 2400);
        });
      };
      return h(
        'button',
        { type: 'button', className: 'ark-btn ark-btn-ghost ark-btn-sm', onClick: onClick },
        feedback === '' ? (props.label || t('panel.copyDiagnostic')) : feedback,
      );
    }

    /** Planned rows renderer (battle / daily / planner all share it). */
    function PlannedRows(props) {
      const t = props.t;
      const rows = asArray(props.items);
      if (rows.length === 0) {
        return props.emptyText ? h(EmptyState, { text: props.emptyText }) : null;
      }
      const nodes = rows.map(function (row, index) {
        const record = asRecord(row) || {};
        const stage = pickString(record, ['stage', 'code', 'target', 'name', 'item', 'title']);
        const task = pickString(record, ['task', 'kind']);
        const taskLabel = KIND_KEYS[task] === undefined ? '' : t(KIND_KEYS[task]);
        const label = stage !== '' ? stage : (taskLabel !== '' ? taskLabel : t('common.unknown'));
        const cnName = pickString(record, ['cnName']);
        const difficulty = pickString(record, ['difficulty']);
        const times = pickNumber(record, ['times', 'count']);
        const sanity = pickNumber(record, ['sanity', 'cost']);
        const note = pickString(record, ['note', 'reason', 'hint', 'text']);
        const tier = pickString(record, ['tier']);
        const activity = record.activity === true;
        const chips = [];
        if (difficulty !== '') chips.push(h('span', { key: 'difficulty', className: 'ark-chip' }, difficultyLabel(t, difficulty)));
        if (times !== null) chips.push(h('span', { key: 'times', className: 'ark-chip' }, '×' + times));
        if (sanity !== null) chips.push(h('span', { key: 'sanity', className: 'ark-chip' }, t('battle.sanityChip', { n: sanity })));
        if (tier !== '') chips.push(h('span', { key: 'tier', className: 'ark-chip' }, tier));
        if (activity) chips.push(h('span', { key: 'activity', className: 'ark-chip ark-chip-ok' }, t('battle.activityBadge')));
        return h(
          'li',
          { key: index, className: 'ark-planned-row' },
          h('span', { className: 'ark-planned-label' }, label),
          cnName !== '' && cnName !== label ? h('span', { className: 'ark-planned-sub' }, cnName) : null,
          chips,
          note !== '' ? h('span', { className: 'ark-planned-note' }, note) : null,
        );
      });
      const total = props.totalSanity;
      return h(
        'div',
        { className: 'ark-planned' },
        h('ul', { className: 'ark-planned-list' }, nodes),
        typeof total === 'number' && isFinite(total) ? h('div', { className: 'ark-planned-total' }, t('battle.plannedTotal', { n: total })) : null,
      );
    }

    /** Plan box shown under the form once a plan envelope is stored. */
    function PlanBox(props) {
      const t = props.t;
      const plan = props.plan;
      if (plan === null || plan === undefined) return null;
      return h(
        'div',
        { className: 'ark-plan-box' },
        h(
          'div',
          { className: 'ark-plan-head' },
          h('span', null, props.title || t('battle.planned')),
          props.zeroText ? h(Badge, { tone: 'success' }, props.zeroText) : null,
        ),
        h(PlannedRows, { t: t, items: plan.plannedItems, totalSanity: plan.totalSanity, emptyText: t('hints.emptyPlan') }),
      );
    }

    /** Build a copyable diagnostic string for the last action result. */
    function buildDiagnostic(result, status) {
      const root = asRecord(status) || {};
      let text = '';
      try {
        text = JSON.stringify(
          {
            diagnostic: {
              action: result.action,
              params: result.payload || null,
              at: result.at,
              error: result.error || null,
            },
            status: {
              run: asRecord(root.run),
              lastRun: asRecord(root.lastRun),
              sidecar: asRecord(root.sidecar),
              connection: asRecord(root.connection),
              tasks: asRecord(root.tasks),
              errors: asRecord(root.errors),
            },
          },
          null,
          2,
        );
      } catch (err) {
        text = '';
      }
      return text;
    }

    /** Global result card: ok text, plan rows or error code/message/hint. */
    function ActionResult(props) {
      const t = props.t;
      const result = props.result;
      if (result === null || result === undefined) return null;
      const error = asRecord(result.error);
      const isPlan = result.tone === 'plan';
      const isError = result.tone === 'error';
      const title = isError ? t('errors.title') : isPlan ? t('hints.planTitle') : t('labels.result');
      let chip = t('common.ok');
      let tone = 'success';
      if (isError) {
        chip = t('common.failed');
        tone = 'danger';
      } else if (isPlan) {
        chip = t('common.planOnly');
        tone = 'business';
      } else if (result.started === true) {
        chip = t('common.running');
        tone = 'business';
      }
      const diagnostic = buildDiagnostic(result, props.status);
      return h(
        'section',
        { className: 'ark-card ark-result-card' },
        h(
          'div',
          { className: 'ark-card-head' },
          h('div', { className: 'ark-card-title' }, title),
          h(
            'div',
            { className: 'ark-card-actions' },
            h(Badge, { tone: tone }, chip),
            h(CopyButton, { t: t, text: diagnostic, label: t('panel.copyDiagnostic') }),
            h(Button, { variant: 'ghost', small: true, onClick: props.onDismiss }, t('panel.dismiss')),
          ),
        ),
        h(
          'div',
          { className: 'ark-card-body' },
          h('div', { className: 'ark-result-text' }, result.text),
          asString(result.runId) !== ''
            ? h(KeyValue, { label: t('labels.id'), value: asString(result.runId) })
            : null,
          error !== null
            ? h(
                'div',
                { className: 'ark-kv-list' },
                h(KeyValue, { label: t('errors.code'), value: asString(error.code, '—') }),
                h(KeyValue, { label: t('errors.message'), value: asString(error.message, '—') }),
                asString(error.hint) !== '' ? h(KeyValue, { label: t('errors.hint'), value: asString(error.hint) }) : null,
                asString(error.detail) !== '' ? h(KeyValue, { label: t('errors.detail'), value: asString(error.detail) }) : null,
              )
            : null,
          Array.isArray(result.plannedItems) && result.plannedItems.length > 0
            ? h(PlannedRows, { t: t, items: result.plannedItems, totalSanity: result.totalSanity })
            : null,
          result.data !== undefined && result.data !== null
            ? h(JsonDetails, { label: t('labels.detail'), json: result.data })
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page 1: overview. Connection + sanity + current/last run + ledger +
     * today's dailies + quick actions + push/errors/events.
     * ------------------------------------------------------------------ */
    function OverviewPage(props) {
      const t = props.t;
      const status = props.status;
      const actions = props.actions;
      const info = readStatus(status);
      const sidecar = info.sidecar;
      const emulator = info.emulator;
      const connection = info.connection;
      const sanity = info.sanity;
      const run = info.run;
      const lastRun = info.lastRun;
      const ledger = info.ledger;
      const daily = info.daily;
      const box = info.box;
      const push = info.push;
      const errors = info.errors;
      const dataInfo = info.data;
      const events = info.events.slice(-EVENT_LIMIT).reverse();

      const sidecarAlive = sidecar !== null && sidecar.alive === true;
      const connected = connection !== null && connection.connected === true;
      const emulatorRunning = emulator !== null && emulator.running === true;
      const androidStarted = emulator !== null && emulator.androidStarted === true;
      const adbOnline = emulator !== null && emulator.adbOnline === true;

      const ledgerEntries = asArray(ledger !== null ? ledger.entries : []).slice(0, 6);
      const warnings = asArray(dataInfo !== null ? dataInfo.warnings : []);

      return h(
        'div',
        { className: 'ark-page-grid' },

        h(
          Card,
          { title: t('overview.connection') },
          h(
            'div',
            { className: 'ark-kv-list' },
            h(
              'div',
              { className: 'ark-kv' },
              h('span', { className: 'ark-kv-key' }, t('overview.sidecar')),
              h(
                'span',
                { className: 'ark-kv-value' },
                h(Dot, { tone: sidecarAlive ? 'success' : 'error' }),
                ' ',
                sidecarAlive ? t('labels.alive') : t('labels.stopped'),
              ),
            ),
            h(KeyValue, { label: t('labels.coreVersion'), value: sidecar !== null ? asString(sidecar.coreVersion, '—') : '—' }),
            h(KeyValue, { label: t('labels.protocol'), value: sidecar !== null ? asString(sidecar.protocolVersion, '—') : '—' }),
            h(KeyValue, { label: t('overview.emulator'), value: emulatorRunning ? t('labels.emulatorRunning') : t('labels.emulatorStopped') }),
            h(KeyValue, { label: t('overview.android'), value: androidStarted ? t('labels.started') : t('labels.stopped') }),
            h(KeyValue, { label: t('overview.adb'), value: adbOnline ? t('labels.online') : t('labels.offline') }),
            h(
              KeyValue,
              {
                label: t('overview.connectionLine'),
                value: (connected ? t('labels.connected') : t('labels.disconnected'))
                  + (connection !== null && asString(connection.address) !== '' ? ' · ' + asString(connection.address) : ''),
              },
            ),
            h(KeyValue, { label: t('overview.config'), value: connection !== null ? asString(connection.config, '—') : '—' }),
          ),
        ),

        h(
          Card,
          { title: t('overview.sanity') },
          h(
            'div',
            { className: 'ark-big-stat' },
            h('span', { className: 'ark-big-num' }, sanity !== null ? asCount(sanity.current) : '—'),
            h('span', { className: 'ark-big-max' }, '/ ' + (sanity !== null ? asCount(sanity.max) : '—')),
          ),
          h(
            'div',
            { className: 'ark-kv-list' },
            h(KeyValue, {
              label: t('overview.lastSeen'),
              value: sanity !== null && asString(sanity.at) !== ''
                ? formatClock(asString(sanity.at)) + ' · ' + relativeTime(asString(sanity.at), t)
                : '—',
            }),
          ),
        ),

        h(
          Card,
          {
            title: t('overview.run'),
            actions: run !== null
              ? h(Badge, { tone: 'business' }, h(Spinner), ' ', runStatusLabel(t, asString(run.status)))
              : null,
          },
          run !== null
            ? h(
                'div',
                { className: 'ark-kv-list' },
                h(
                  KeyValue,
                  {
                    label: t('overview.current'),
                    value: h(
                      'span',
                      { className: 'ark-inline' },
                      h(Badge, { tone: 'business' }, runKindLabel(t, asString(run.kind))),
                      ' ',
                      h(Badge, { tone: asString(run.status) === 'running' ? 'business' : 'idle' }, runStatusLabel(t, asString(run.status))),
                    ),
                  },
                ),
                h(KeyValue, {
                  label: t('labels.startedAt'),
                  value: formatClock(asString(run.startedAt)) + ' · ' + formatElapsed(run.startedAt, run.updatedAt, t),
                }),
                asString(run.phase) !== '' ? h(KeyValue, { label: t('labels.phase'), value: asString(run.phase) }) : null,
                asString(run.id) !== '' ? h(KeyValue, { label: t('labels.id'), value: asString(run.id) }) : null,
              )
            : lastRun !== null
              ? h(
                  'div',
                  { className: 'ark-kv-list' },
                  h(
                    KeyValue,
                    {
                      label: t('overview.last'),
                      value: h(
                        'span',
                        { className: 'ark-inline' },
                        h(
                          Badge,
                          {
                            tone: asString(lastRun.status) === 'completed'
                              ? 'success'
                              : asString(lastRun.status) === 'failed' ? 'danger' : 'idle',
                          },
                          runKindLabel(t, asString(lastRun.kind)) + ' · ' + runStatusLabel(t, asString(lastRun.status)),
                        ),
                      ),
                    },
                  ),
                  h(KeyValue, {
                    label: t('labels.endedAt'),
                    value: formatClock(asString(lastRun.endedAt)) + ' · ' + relativeTime(asString(lastRun.endedAt), t),
                  }),
                  asRecord(lastRun.error) !== null
                    ? h(KeyValue, {
                        label: t('errors.code'),
                        value: asString(asRecord(lastRun.error).code, '—') + ' · ' + asString(asRecord(lastRun.error).message),
                      })
                    : null,
                )
              : h(EmptyState, { text: t('overview.noRun') }),
        ),

        h(
          Card,
          { title: t('overview.ledger') },
          h(
            'div',
            { className: 'ark-stats' },
            h(Stat, { value: ledger !== null ? asCount(ledger.fullStar) : 0, label: t('labels.fullStar') }),
            h(Stat, { value: ledger !== null ? asCount(ledger.missing) : 0, label: t('labels.missing') }),
            h(Stat, { value: ledger !== null ? asCount(ledger.primeClaimed) : 0, label: t('labels.prime') }),
          ),
          ledgerEntries.length > 0
            ? h(
                'ul',
                { className: 'ark-list' },
                ledgerEntries.map(function (entry, index) {
                  const record = asRecord(entry) || {};
                  const stars = pickNumber(record, ['stars']);
                  return h(
                    'li',
                    { key: index, className: 'ark-list-row' },
                    h('span', { className: 'ark-list-main' }, asString(record.code, '—')),
                    h('span', { className: 'ark-list-meta' }, record.fullStar === true ? t('labels.fullStar') : t('labels.missing')),
                    h('span', { className: 'ark-list-meta' }, t('labels.stars') + ' ' + (stars === null ? '—' : stars)),
                  );
                }),
              )
            : null,
        ),

        h(
          Card,
          { title: t('overview.daily') },
          h(KeyValue, { label: t('overview.date'), value: daily !== null ? asString(daily.date, '—') : '—' }),
          h(
            'ul',
            { className: 'ark-list' },
            DAILY_TASK_KEYS.map(function (key) {
              const task = dailyTaskInfo(status, key);
              const ok = task !== null && task.ok === true;
              const failed = task !== null && task.ok === false;
              return h(
                'li',
                { key: key, className: 'ark-list-row' },
                h('span', { className: 'ark-list-main' }, t(DAILY_TASK_LABEL_KEYS[key])),
                h(Badge, { tone: ok ? 'success' : failed ? 'danger' : 'idle' }, ok ? t('daily.taskOk') : failed ? t('daily.taskFail') : t('daily.taskSkipped')),
                task !== null && asString(task.at) !== '' ? h('span', { className: 'ark-list-meta' }, formatClock(asString(task.at))) : null,
              );
            }),
          ),
        ),

        h(
          Card,
          { title: t('overview.quick') },
          h(
            'div',
            { className: 'ark-btn-row' },
            h(
              Button,
              {
                variant: 'primary',
                disabled: actions.inflight !== null,
                busy: actions.inflight === 'award',
                onClick: function () { actions.run('award', {}); },
              },
              t('actions.award'),
            ),
            h(
              Button,
              {
                variant: 'danger',
                disabled: actions.inflight !== null,
                busy: actions.inflight === 'stop',
                onClick: function () { actions.stop(); },
              },
              t('actions.stop'),
            ),
            h(Button, { variant: 'ghost', onClick: function () { props.setPage('battle'); } }, t('overview.gotoBattle')),
            h(Button, { variant: 'ghost', onClick: function () { props.setPage('daily'); } }, t('overview.gotoDaily')),
            h(Button, { variant: 'ghost', onClick: function () { props.setPage('data'); } }, t('overview.gotoData')),
            h(Button, { variant: 'ghost', onClick: function () { props.setPage('box'); } }, t('overview.gotoBox')),
          ),
        ),

        push !== null && (asString(push.nextStage) !== '' || asString(push.lastStopped) !== '')
          ? h(
              Card,
              { title: t('overview.push') },
              asString(push.nextStage) !== '' ? h(KeyValue, { label: t('overview.nextStage'), value: asString(push.nextStage) }) : null,
              asString(push.lastStopped) !== '' ? h(KeyValue, { label: t('overview.lastStopped'), value: asString(push.lastStopped) }) : null,
              asString(push.lastReason) !== '' ? h(KeyValue, { label: t('overview.lastReason'), value: asString(push.lastReason) }) : null,
            )
          : null,

        h(
          Card,
          { title: t('overview.boxSummary') },
          h(
            'div',
            { className: 'ark-stats' },
            h(Stat, { value: box !== null ? asCount(box.operators) : 0, label: t('labels.operators') }),
            h(Stat, { value: box !== null ? asCount(box.depotItems) : 0, label: t('labels.items') }),
          ),
          h(KeyValue, {
            label: t('box.updatedAt'),
            value: box !== null && asString(box.updatedAt) !== '' ? formatClock(asString(box.updatedAt)) + ' · ' + relativeTime(asString(box.updatedAt), t) : '—',
          }),
          box !== null && box.partial === true ? h(Badge, { tone: 'warn' }, t('box.partial')) : null,
        ),

        h(
          Card,
          { title: t('overview.errors') },
          errors !== null && asString(errors.lastCode) !== ''
            ? h(
                'div',
                { className: 'ark-kv-list' },
                h(KeyValue, { label: t('errors.code'), value: asString(errors.lastCode) }),
                h(KeyValue, { label: t('errors.message'), value: asString(errors.lastMessage) }),
                h(KeyValue, { label: t('labels.at'), value: formatClock(asString(errors.at)) }),
              )
            : h(EmptyState, { text: t('common.empty') }),
          warnings.length > 0
            ? h(
                'ul',
                { className: 'ark-list' },
                warnings.slice(0, 5).map(function (warning, index) {
                  return h('li', { key: index, className: 'ark-list-row' }, h('span', { className: 'ark-list-main' }, asString(warning)));
                }),
              )
            : null,
        ),

        h(
          Card,
          { title: t('overview.events') },
          events.length === 0
            ? h(EmptyState, { text: t('common.empty') })
            : h(
                'ul',
                { className: 'ark-list' },
                events.map(function (event, index) {
                  const record = asRecord(event) || {};
                  const name = asString(record.name, '—');
                  const task = asString(record.task);
                  return h(
                    'li',
                    { key: index, className: 'ark-list-row' },
                    h('span', { className: 'ark-list-main', title: name }, name),
                    task !== '' ? h('span', { className: 'ark-list-meta' }, task) : null,
                  );
                }),
              ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page 2: battle. Fight / push / rogue sub-tabs, stage completion,
     * resource inputs (locked at 0 by default), plan -> confirm, stop.
     * ------------------------------------------------------------------ */
    function BattlePage(props) {
      const t = props.t;
      const actions = props.actions;
      const api = props.api;
      const status = props.status;
      const info = readStatus(status);
      const safety = asRecord(info.safety) || {};
      const allowMedicine = safety.allowSanityPotion === true;
      const allowStone = safety.allowOriginitePrime === true;
      const allowPotion = safety.allowSanityPotion === true;

      const [tab, setTab] = React.useState('fight');
      const [stage, setStage] = React.useState('');
      const [times, setTimes] = React.useState('1');
      const [difficulty, setDifficulty] = React.useState('auto');
      const [medicine, setMedicine] = React.useState('0');
      const [stone, setStone] = React.useState('0');
      const [useSanityPotion, setUseSanityPotion] = React.useState(false);
      const [copilotId, setCopilotId] = React.useState('');
      const [file, setFile] = React.useState('');
      const [video, setVideo] = React.useState('');
      const [pushFrom, setPushFrom] = React.useState('');
      const [pushChapter, setPushChapter] = React.useState('');
      const [pushMax, setPushMax] = React.useState('');
      const [rogueTheme, setRogueTheme] = React.useState('Sarkaz');
      const [rogueMode, setRogueMode] = React.useState('Exp');
      const [rogueStarts, setRogueStarts] = React.useState('');
      const [formError, setFormError] = React.useState('');
      const [suggest, setSuggest] = React.useState({ items: [], loading: false, unavailable: false, q: '' });
      const skipSuggestRef = React.useRef('');

      /* Stage completion: debounced, abort-safe, degrades to a hint when the
       * query route is not available yet. */
      React.useEffect(function () {
        const query = String(stage || '').trim();
        if (query === '' || skipSuggestRef.current === query) {
          skipSuggestRef.current = '';
          setSuggest({ items: [], loading: false, unavailable: false, q: query });
          return undefined;
        }
        let cancelled = false;
        let timer = null;
        try {
          timer = setTimeout(function () {
            setSuggest({ items: [], loading: true, unavailable: false, q: query });
            api.request(queryUrl('stage', { q: query, limit: 8 }), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
              if (cancelled) return;
              const data = asRecord(response.data);
              if (response.ok !== true || data === null || data.ok === false) {
                setSuggest({ items: [], loading: false, unavailable: true, q: query });
                return;
              }
              setSuggest({ items: queryItems(data).slice(0, 8), loading: false, unavailable: false, q: query });
            });
          }, 250);
        } catch (err) {
          timer = null;
        }
        return function () {
          cancelled = true;
          if (timer !== null) {
            try { clearTimeout(timer); } catch (err) { /* ignore */ }
          }
        };
      }, [stage, api]);

      const fightBase = function () {
        const body = {
          stages: String(stage || '').trim(),
          times: parsePositiveInt(times) === null ? 1 : parsePositiveInt(times),
          difficulty: DIFFICULTIES.indexOf(difficulty) >= 0 ? difficulty : 'auto',
        };
        if (allowMedicine) {
          const value = parseNonNegativeInt(medicine);
          if (value !== null && value > 0) body.medicine = value;
        }
        if (allowStone) {
          const value = parseNonNegativeInt(stone);
          if (value !== null && value > 0) body.stone = value;
        }
        if (allowPotion && useSanityPotion === true) body.useSanityPotion = true;
        const copilot = parsePositiveInt(copilotId);
        if (copilot !== null) body.copilotId = copilot;
        if (String(file || '').trim() !== '') body.file = String(file).trim();
        if (String(video || '').trim() !== '') body.video = String(video).trim();
        return body;
      };

      const pushBase = function () {
        const body = {};
        const from = String(pushFrom || '').trim();
        if (from !== '') body.from = from;
        const chapter = parsePositiveInt(pushChapter);
        if (chapter !== null) body.chapter = chapter;
        const maxStages = parsePositiveInt(pushMax);
        if (maxStages !== null) body.maxStages = maxStages;
        return body;
      };

      const rogueBase = function () {
        const body = {
          theme: ROGUE_THEMES.indexOf(rogueTheme) >= 0 ? rogueTheme : ROGUE_THEMES[3],
          mode: ROGUE_MODES.indexOf(rogueMode) >= 0 ? rogueMode : ROGUE_MODES[0],
        };
        const starts = parsePositiveInt(rogueStarts);
        if (starts !== null) body.startsCount = starts;
        return body;
      };

      const fightSignature = signatureOf(fightBase());
      const pushSignature = signatureOf(pushBase());
      const rogueSignature = signatureOf(rogueBase());
      const fightPlan = actions.armedPlan('fight', fightSignature);
      const pushPlan = actions.armedPlan('push', pushSignature);
      const roguePlan = actions.armedPlan('rogue', rogueSignature);

      const onFight = function () {
        const base = fightBase();
        if (base.stages === '') {
          setFormError(t('battle.noStage'));
          return;
        }
        setFormError('');
        actions.ensure('fight', base, signatureOf(base));
      };

      const onPush = function () {
        setFormError('');
        const base = pushBase();
        actions.ensure('push', base, signatureOf(base));
      };

      const onRogue = function () {
        setFormError('');
        const base = rogueBase();
        actions.ensure('rogue', base, signatureOf(base));
      };

      const tabButtons = ['fight', 'push', 'rogue'].map(function (key) {
        return h(
          'button',
          {
            key: key,
            type: 'button',
            className: 'ark-tab' + (tab === key ? ' ark-tab-active' : ''),
            onClick: function () { setTab(key); },
          },
          t(BATTLE_TAB_KEYS[key]),
        );
      });

      const suggestNode = (function () {
        const query = String(stage || '').trim();
        if (query === '' || tab !== 'fight') return null;
        if (suggest.q !== query) return null;
        if (suggest.loading) return h('div', { className: 'ark-suggest' }, h('div', { className: 'ark-suggest-hint' }, t('battle.suggestLoading')));
        if (suggest.unavailable) return h('div', { className: 'ark-suggest' }, h('div', { className: 'ark-suggest-hint' }, t('battle.suggestUnavailable')));
        if (suggest.items.length === 0) return h('div', { className: 'ark-suggest' }, h('div', { className: 'ark-suggest-hint' }, t('battle.suggestEmpty')));
        return h(
          'div',
          { className: 'ark-suggest' },
          suggest.items.map(function (item, index) {
            const record = asRecord(item) || {};
            const code = pickString(record, ['code', 'stageId', 'name']);
            const name = pickString(record, ['name']);
            const apCost = pickNumber(record, ['apCost']);
            return h(
              'button',
              {
                key: code + '-' + index,
                type: 'button',
                className: 'ark-suggest-item',
                onClick: function () {
                  skipSuggestRef.current = code;
                  setStage(code);
                },
              },
              h('span', { className: 'ark-suggest-code' }, code),
              name !== '' && name !== code ? h('span', { className: 'ark-suggest-name' }, name) : null,
              apCost !== null ? h('span', { className: 'ark-suggest-meta' }, t('battle.apChip', { n: apCost })) : null,
            );
          }),
        );
      })();

      const fightSection = h(
        'div',
        { className: 'ark-form' },
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            'div',
            { className: 'ark-field ark-field-grow ark-suggest-wrap' },
            h('span', { className: 'ark-field-label' }, t('battle.stage')),
            h(TextInput, {
              value: stage,
              placeholder: t('battle.stagePlaceholder'),
              ariaLabel: t('battle.stage'),
              onChange: function (value) { setStage(value); },
            }),
            suggestNode,
            h('span', { className: 'ark-field-hint' }, t('battle.stageHint')),
          ),
          h(Field, { label: t('battle.times') }, h(NumberInput, { value: times, min: 1, ariaLabel: t('battle.times'), onChange: setTimes })),
          h(
            Field,
            { label: t('battle.difficulty') },
            h(SelectInput, {
              value: difficulty,
              ariaLabel: t('battle.difficulty'),
              options: DIFFICULTIES.map(function (item) { return { value: item, label: difficultyLabel(t, item) }; }),
              onChange: setDifficulty,
            }),
          ),
        ),
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            Field,
            { label: t('battle.medicine'), hint: allowMedicine ? t('battle.resourceZero') : t('battle.resourceLocked') },
            h(NumberInput, { value: allowMedicine ? medicine : '0', min: 0, disabled: !allowMedicine, ariaLabel: t('battle.medicine'), onChange: setMedicine }),
          ),
          h(
            Field,
            { label: t('battle.stone'), hint: allowStone ? t('battle.resourceZero') : t('battle.resourceLocked') },
            h(NumberInput, { value: allowStone ? stone : '0', min: 0, disabled: !allowStone, ariaLabel: t('battle.stone'), onChange: setStone }),
          ),
          h(
            'div',
            { className: 'ark-field' },
            h(
              Checkbox,
              {
                label: t('battle.useSanityPotion'),
                checked: allowPotion && useSanityPotion === true,
                disabled: !allowPotion,
                hint: allowPotion ? '' : t('battle.resourceLocked'),
                onChange: setUseSanityPotion,
              },
            ),
          ),
        ),
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            Field,
            { label: t('battle.copilotId') },
            h(NumberInput, { value: copilotId, min: 0, ariaLabel: t('battle.copilotId'), onChange: setCopilotId }),
          ),
          h(
            Field,
            { label: t('battle.file'), grow: false },
            h(TextInput, { value: file, placeholder: t('battle.filePlaceholder'), ariaLabel: t('battle.file'), onChange: setFile }),
          ),
          h(
            Field,
            { label: t('battle.video') },
            h(TextInput, { value: video, placeholder: t('battle.videoPlaceholder'), ariaLabel: t('battle.video'), onChange: setVideo }),
          ),
        ),
        h(
          'div',
          { className: 'ark-btn-row' },
          h(
            Button,
            {
              variant: 'primary',
              busy: actions.inflight === 'fight',
              disabled: actions.inflight !== null,
              onClick: onFight,
            },
            fightPlan === null ? t('actions.previewPlan') : t('actions.confirmExecute'),
          ),
          h(
            Button,
            {
              variant: 'danger',
              busy: actions.inflight === 'stop',
              disabled: actions.inflight !== null,
              onClick: function () { actions.stop(); },
            },
            t('actions.stop'),
          ),
          h(Badge, { tone: 'success' }, t('common.zeroCost')),
          h(Badge, { tone: 'warn' }, t('common.needsConfirm')),
        ),
        fightPlan === null
          ? h('div', { className: 'ark-field-hint' }, t('battle.confirmHint'))
          : h(Badge, { tone: 'business' }, t('battle.armedHint')),
        h(PlanBox, { t: t, plan: fightPlan, zeroText: t('common.zeroCost') }),
      );

      const pushSection = h(
        'div',
        { className: 'ark-form' },
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            Field,
            { label: t('labels.from') },
            h(TextInput, { value: pushFrom, placeholder: t('battle.pushFromPlaceholder'), ariaLabel: t('labels.from'), onChange: setPushFrom }),
          ),
          h(
            Field,
            { label: t('labels.chapter') },
            h(NumberInput, { value: pushChapter, min: 1, ariaLabel: t('labels.chapter'), onChange: setPushChapter }),
          ),
          h(
            Field,
            { label: t('labels.maxStages') },
            h(NumberInput, { value: pushMax, min: 1, ariaLabel: t('labels.maxStages'), onChange: setPushMax }),
          ),
        ),
        h(
          'div',
          { className: 'ark-btn-row' },
          h(
            Button,
            { variant: 'primary', busy: actions.inflight === 'push', disabled: actions.inflight !== null, onClick: onPush },
            pushPlan === null ? t('actions.previewPlan') : t('actions.confirmExecute'),
          ),
          h(
            Button,
            { variant: 'danger', busy: actions.inflight === 'stop', disabled: actions.inflight !== null, onClick: function () { actions.stop(); } },
            t('actions.stop'),
          ),
          h(Badge, { tone: 'success' }, t('common.zeroCost')),
          h(Badge, { tone: 'warn' }, t('common.needsConfirm')),
        ),
        pushPlan === null
          ? h('div', { className: 'ark-field-hint' }, t('battle.confirmHint'))
          : h(Badge, { tone: 'business' }, t('battle.armedHint')),
        h(PlanBox, { t: t, plan: pushPlan, zeroText: t('common.zeroCost') }),
      );

      const rogueSection = h(
        'div',
        { className: 'ark-form' },
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            Field,
            { label: t('battle.rogueTheme') },
            h(SelectInput, {
              value: rogueTheme,
              ariaLabel: t('battle.rogueTheme'),
              options: ROGUE_THEMES.map(function (item) { return { value: item, label: item }; }),
              onChange: setRogueTheme,
            }),
          ),
          h(
            Field,
            { label: t('battle.rogueMode') },
            h(SelectInput, {
              value: rogueMode,
              ariaLabel: t('battle.rogueMode'),
              options: ROGUE_MODES.map(function (item) { return { value: item, label: item }; }),
              onChange: setRogueMode,
            }),
          ),
          h(
            Field,
            { label: t('battle.rogueStarts') },
            h(NumberInput, { value: rogueStarts, min: 1, ariaLabel: t('battle.rogueStarts'), onChange: setRogueStarts }),
          ),
        ),
        h('div', { className: 'ark-field-hint' }, t('battle.rogueHint')),
        h(
          'div',
          { className: 'ark-btn-row' },
          h(
            Button,
            { variant: 'primary', busy: actions.inflight === 'rogue', disabled: actions.inflight !== null, onClick: onRogue },
            roguePlan === null ? t('actions.previewPlan') : t('actions.confirmExecute'),
          ),
          h(
            Button,
            { variant: 'danger', busy: actions.inflight === 'stop', disabled: actions.inflight !== null, onClick: function () { actions.stop(); } },
            t('actions.stop'),
          ),
          h(Badge, { tone: 'success' }, t('common.zeroCost')),
          h(Badge, { tone: 'warn' }, t('common.needsConfirm')),
        ),
        roguePlan === null
          ? h('div', { className: 'ark-field-hint' }, t('battle.confirmHint'))
          : h(Badge, { tone: 'business' }, t('battle.armedHint')),
        h(PlanBox, { t: t, plan: roguePlan, zeroText: t('common.zeroCost') }),
      );

      return h(
        'div',
        { className: 'ark-page-grid' },
        h(
          Card,
          { wide: true, title: t('battle.title'), actions: h('div', { className: 'ark-tabs-inline' }, tabButtons) },
          formError !== '' ? h(Banner, { tone: 'warn' }, formError) : null,
          tab === 'fight' ? fightSection : tab === 'push' ? pushSection : rogueSection,
        ),
      );
    }

    /** Percentage formatting for drop rates (input is 0..1). */
    function formatRate(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—';
      const percent = Math.round(value * 1000) / 10;
      return String(percent) + '%';
    }

    /** One-decimal sanity formatting (expected sanity averages are fractional). */
    function formatSanity(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—';
      return String(Math.round(value * 10) / 10);
    }

    /* ------------------------------------------------------------------ *
     * Page 3: daily. Task toggles + award / mall parameters, plan -> confirm,
     * per-task results, recruitment tag table.
     * ------------------------------------------------------------------ */
    function DailyPage(props) {
      const t = props.t;
      const actions = props.actions;
      const status = props.status;
      const info = readStatus(status);
      const safety = asRecord(info.safety) || {};
      const allowRecruitPermits = safety.allowRecruitPermits === true;
      const allowExpedite = safety.allowExpedite === true;

      const [selected, setSelected] = React.useState(function () {
        const initial = {};
        for (const key of DAILY_TASK_KEYS) initial[key] = DAILY_DEFAULT_TASKS.indexOf(key) >= 0;
        return initial;
      });
      const [skipDone, setSkipDone] = React.useState(true);
      const [awardFlags, setAwardFlags] = React.useState({ award: true });
      const [mallVisitFriends, setMallVisitFriends] = React.useState(true);
      const [mallShopping, setMallShopping] = React.useState(true);
      const [mallOnlyDiscount, setMallOnlyDiscount] = React.useState(false);
      const [mallForceWhenFull, setMallForceWhenFull] = React.useState(false);
      const [mallReserveMax, setMallReserveMax] = React.useState(false);
      const [mallBuyFirst, setMallBuyFirst] = React.useState('');
      const [mallBlacklist, setMallBlacklist] = React.useState('');
      const [recruitTimes, setRecruitTimes] = React.useState('');
      const [recruitSelectLevels, setRecruitSelectLevels] = React.useState('');
      const [recruitConfirmLevels, setRecruitConfirmLevels] = React.useState('');
      const [recruitExpedite, setRecruitExpedite] = React.useState(false);
      const [recruitRefresh, setRecruitRefresh] = React.useState(false);
      const [recruitPreserveTags, setRecruitPreserveTags] = React.useState('');
      const [recruitFirstTags, setRecruitFirstTags] = React.useState('');
      const [recruitPermitReserve, setRecruitPermitReserve] = React.useState('');
      const [formError, setFormError] = React.useState('');

      const dailyBase = function () {
        const tasks = DAILY_TASK_KEYS.filter(function (key) { return selected[key] === true; });
        const body = { tasks: tasks, skipDone: skipDone === true };
        // Send the full switch set explicitly: the panel checkboxes are the
        // source of truth for this run (host config only fills what we omit).
        const award = {};
        for (const flag of AWARD_FLAGS) award[flag] = awardFlags[flag] === true;
        body.award = award;
        const mall = {
          visitFriends: mallVisitFriends === true,
          shopping: mallShopping === true,
          onlyDiscount: mallOnlyDiscount === true,
          forceWhenFull: mallForceWhenFull === true,
          reserveMaxCredit: mallReserveMax === true,
        };
        const buyFirst = splitList(mallBuyFirst);
        if (buyFirst.length > 0) mall.buyFirst = buyFirst;
        const blacklist = splitList(mallBlacklist);
        if (blacklist.length > 0) mall.blacklist = blacklist;
        body.mall = mall;
        return body;
      };

      const recruitBase = function (mode) {
        // Only the tag analysis blocks (it returns tags/combos directly). The
        // execute mode must answer at once and be tracked through status.run.
        const body = mode === 'analyze' ? { mode: mode, wait: true } : { mode: mode };
        const times = parsePositiveInt(recruitTimes);
        if (times !== null) body.times = times;
        const selectedLevels = splitList(recruitSelectLevels)
          .map(function (part) { return Number.parseInt(part, 10); })
          .filter(function (value) { return isFinite(value) && value >= 1 && value <= 6; });
        if (selectedLevels.length > 0) body.selectLevels = selectedLevels;
        const confirmLevels = splitList(recruitConfirmLevels)
          .map(function (part) { return Number.parseInt(part, 10); })
          .filter(function (value) { return isFinite(value) && value >= 1 && value <= 6; });
        if (confirmLevels.length > 0) body.confirmLevels = confirmLevels;
        if (allowExpedite && recruitExpedite === true) body.expedite = true;
        if (recruitRefresh === true) body.refresh = true;
        const preserveTags = splitList(recruitPreserveTags);
        if (preserveTags.length > 0) body.preserveTags = preserveTags;
        const firstTags = splitList(recruitFirstTags);
        if (firstTags.length > 0) body.firstTags = firstTags;
        const permitReserve = parseNonNegativeInt(recruitPermitReserve);
        if (permitReserve !== null) body.permitReserve = permitReserve;
        return body;
      };

      const dailySignature = signatureOf(dailyBase());
      const dailyPlan = actions.armedPlan('daily', dailySignature);
      const recruitBasePayload = recruitBase('execute');
      const recruitSignature = signatureOf(recruitBasePayload);
      const recruitPlan = actions.armedPlan('recruit', recruitSignature);

      const onDaily = function () {
        const base = dailyBase();
        if (base.tasks.length === 0) {
          setFormError(t('daily.noTasks'));
          return;
        }
        setFormError('');
        actions.ensure('daily', base, signatureOf(base));
      };

      const onAnalyze = function () {
        setFormError('');
        actions.run('recruit', recruitBase('analyze'), RECRUIT_TIMEOUT_MS);
      };

      const onExecute = function () {
        if (!allowRecruitPermits) return;
        setFormError('');
        actions.ensure('recruit', recruitBasePayload, recruitSignature);
      };

      const recruit = extractRecruit(status, actions.result);
      const tags = recruit !== null ? asArray(recruit.tags) : [];
      const combos = recruit !== null ? asArray(recruit.combos) : [];
      const recruitLevel = recruit !== null ? pickNumber(recruit, ['level']) : null;
      const recruitSlots = recruit !== null ? pickNumber(recruit, ['slots']) : null;

      const taskRows = DAILY_TASK_KEYS.map(function (key) {
        const task = dailyTaskInfo(status, key);
        const ok = task !== null && task.ok === true;
        const failed = task !== null && task.ok === false;
        return h(
          'li',
          { key: key, className: 'ark-list-row' },
          h('span', { className: 'ark-list-main' }, t(DAILY_TASK_LABEL_KEYS[key])),
          h(Badge, { tone: ok ? 'success' : failed ? 'danger' : 'idle' }, ok ? t('daily.taskOk') : failed ? t('daily.taskFail') : t('daily.taskSkipped')),
          task !== null && asString(task.at) !== '' ? h('span', { className: 'ark-list-meta' }, formatClock(asString(task.at))) : null,
          task !== null && asString(task.text) !== '' ? h('span', { className: 'ark-list-meta' }, asString(task.text)) : null,
        );
      });

      const tagsNode = h(
        'div',
        { className: 'ark-chip-wrap' },
        h(Badge, { tone: 'idle' }, t('daily.slots', { n: recruitSlots === null ? '—' : recruitSlots })),
        recruitLevel !== null ? h(Badge, { tone: 'business' }, t('daily.level', { n: recruitLevel })) : null,
        tags.length === 0
          ? h(EmptyState, { text: t('daily.tagsEmpty') })
          : tags.map(function (tag, index) {
              return h('span', { key: index, className: 'ark-chip' }, asString(tag));
            }),
      );

      const combosNode = combos.length === 0
        ? h(EmptyState, { text: t('daily.combosEmpty') })
        : h(
            'ul',
            { className: 'ark-list' },
            combos.map(function (combo, index) {
              const record = asRecord(combo) || {};
              const comboLevel = pickNumber(record, ['level']);
              const comboOperators = asArray(record.operators);
              return h(
                'li',
                { key: index, className: 'ark-combo-row' },
                h(
                  'span',
                  { className: 'ark-chip-wrap' },
                  asArray(record.tags).map(function (tag, tagIndex) {
                    return h('span', { key: tagIndex, className: 'ark-chip' }, asString(tag));
                  }),
                ),
                comboLevel !== null ? h(Badge, { tone: 'business' }, t('daily.level', { n: comboLevel })) : null,
                h(
                  'span',
                  { className: 'ark-combo-opers' },
                  comboOperators.length === 0
                    ? '—'
                    : comboOperators.map(function (operator, operatorIndex) {
                        const row = asRecord(operator) || {};
                        const name = pickString(row, ['name', 'id']);
                        const rarity = pickNumber(row, ['rarity']);
                        return h(
                          'span',
                          { key: operatorIndex, className: 'ark-chip' },
                          name + (rarity === null ? '' : ' · ' + rarity),
                        );
                      }),
                ),
              );
            }),
          );

      return h(
        'div',
        { className: 'ark-page-grid' },
        h(
          Card,
          { wide: true, title: t('daily.title'), actions: h('div', { className: 'ark-badge-row' }, h(Badge, { tone: 'success' }, t('daily.zeroSanity'))) },
          formError !== '' ? h(Banner, { tone: 'warn' }, formError) : null,
          h(
            'div',
            { className: 'ark-row ark-row-wrap' },
            h(
              'div',
              { className: 'ark-field ark-field-grow' },
              h('span', { className: 'ark-field-label' }, t('daily.tasks')),
              h(
                'div',
                { className: 'ark-chip-wrap' },
                DAILY_TASK_KEYS.map(function (key) {
                  return h(Checkbox, {
                    key: key,
                    label: t(DAILY_TASK_LABEL_KEYS[key]),
                    checked: selected[key] === true,
                    onChange: function (checked) {
                      setSelected(function (previous) {
                        const next = Object.assign({}, previous);
                        next[key] = checked;
                        return next;
                      });
                    },
                  });
                }),
              ),
            ),
            h(Checkbox, { label: t('daily.skipDone'), checked: skipDone, onChange: setSkipDone }),
          ),
          h(
            'div',
            { className: 'ark-row ark-row-wrap' },
            h(
              'div',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('daily.awardTitle')),
              h(
                'div',
                { className: 'ark-chip-wrap' },
                AWARD_FLAGS.map(function (flag) {
                  return h(Checkbox, {
                    key: flag,
                    label: t(AWARD_FLAG_KEYS[flag]),
                    checked: awardFlags[flag] === true,
                    onChange: function (checked) {
                      setAwardFlags(function (previous) {
                        const next = Object.assign({}, previous);
                        next[flag] = checked;
                        return next;
                      });
                    },
                  });
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ark-row ark-row-wrap' },
            h(
              'div',
              { className: 'ark-field ark-field-grow' },
              h('span', { className: 'ark-field-label' }, t('daily.mallTitle')),
              h(
                'div',
                { className: 'ark-chip-wrap' },
                h(Checkbox, { label: t('daily.mallVisitFriends'), checked: mallVisitFriends, onChange: setMallVisitFriends }),
                h(Checkbox, { label: t('daily.mallShopping'), checked: mallShopping, onChange: setMallShopping }),
                h(Checkbox, { label: t('daily.mallOnlyDiscount'), checked: mallOnlyDiscount, onChange: setMallOnlyDiscount }),
                h(Checkbox, { label: t('daily.mallForceWhenFull'), checked: mallForceWhenFull, onChange: setMallForceWhenFull }),
                h(Checkbox, { label: t('daily.mallReserveMax'), checked: mallReserveMax, onChange: setMallReserveMax }),
              ),
              h(
                'div',
                { className: 'ark-row ark-row-wrap' },
                h(Field, { label: t('daily.mallBuyFirst') }, h(TextInput, { value: mallBuyFirst, placeholder: t('daily.mallBuyFirstHint'), ariaLabel: t('daily.mallBuyFirst'), onChange: setMallBuyFirst })),
                h(Field, { label: t('daily.mallBlacklist') }, h(TextInput, { value: mallBlacklist, placeholder: t('daily.mallBlacklistHint'), ariaLabel: t('daily.mallBlacklist'), onChange: setMallBlacklist })),
              ),
            ),
          ),
          h('div', { className: 'ark-field-hint' }, t('daily.infrastHint')),
          h(
            'div',
            { className: 'ark-btn-row' },
            h(
              Button,
              { variant: 'primary', busy: actions.inflight === 'daily', disabled: actions.inflight !== null, onClick: onDaily },
              dailyPlan === null ? t('actions.previewPlan') : t('actions.confirmExecute'),
            ),
            h(
              Button,
              { variant: 'danger', busy: actions.inflight === 'stop', disabled: actions.inflight !== null, onClick: function () { actions.stop(); } },
              t('actions.stop'),
            ),
            h(Badge, { tone: 'success' }, t('common.zeroCost')),
            h(Badge, { tone: 'warn' }, t('common.needsConfirm')),
          ),
          dailyPlan === null
            ? h('div', { className: 'ark-field-hint' }, t('battle.confirmHint'))
            : h(Badge, { tone: 'business' }, t('battle.armedHint')),
          h(PlanBox, { t: t, plan: dailyPlan, title: t('daily.planned'), zeroText: t('common.zeroCost') }),
          h(
            'div',
            { className: 'ark-divider' },
            h('span', { className: 'ark-field-label' }, t('daily.results')),
          ),
          h('ul', { className: 'ark-list' }, taskRows),
        ),

        h(
          Card,
          { title: t('daily.recruitTitle'), actions: h(Badge, { tone: allowRecruitPermits ? 'warn' : 'idle' }, allowRecruitPermits ? t('daily.executeUnlocked') : t('daily.executeLocked')) },
          h(
            'div',
            { className: 'ark-row ark-row-wrap' },
            h(Field, { label: t('daily.recruitTimes') }, h(NumberInput, { value: recruitTimes, min: 1, ariaLabel: t('daily.recruitTimes'), onChange: setRecruitTimes })),
            h(Field, { label: t('daily.selectLevels'), hint: t('daily.levelsHint') }, h(TextInput, { value: recruitSelectLevels, placeholder: t('daily.levelsPlaceholder'), ariaLabel: t('daily.selectLevels'), onChange: setRecruitSelectLevels })),
            h(Field, { label: t('daily.confirmLevels') }, h(TextInput, { value: recruitConfirmLevels, placeholder: t('daily.levelsPlaceholder'), ariaLabel: t('daily.confirmLevels'), onChange: setRecruitConfirmLevels })),
            h(Field, { label: t('daily.firstTags') }, h(TextInput, { value: recruitFirstTags, placeholder: t('daily.firstTagsHint'), ariaLabel: t('daily.firstTags'), onChange: setRecruitFirstTags })),
            h(Field, { label: t('daily.permitReserve') }, h(NumberInput, { value: recruitPermitReserve, min: 0, ariaLabel: t('daily.permitReserve'), onChange: setRecruitPermitReserve })),
          ),
          h(
            'div',
            { className: 'ark-chip-wrap' },
            h(
              Checkbox,
              {
                label: t('daily.expedite'),
                checked: allowExpedite && recruitExpedite === true,
                disabled: !allowExpedite,
                hint: allowExpedite ? '' : t('daily.expediteLocked'),
                onChange: setRecruitExpedite,
              },
            ),
            h(Checkbox, { label: t('daily.refresh'), checked: recruitRefresh, onChange: setRecruitRefresh }),
            h(Field, { label: t('daily.preserveTags') }, h(TextInput, { value: recruitPreserveTags, placeholder: t('daily.firstTagsHint'), ariaLabel: t('daily.preserveTags'), onChange: setRecruitPreserveTags })),
          ),
          h(
            'div',
            { className: 'ark-btn-row' },
            h(
              Button,
              { variant: 'secondary', busy: actions.inflight === 'recruit', disabled: actions.inflight !== null, onClick: onAnalyze },
              t('actions.analyze'),
            ),
            h(
              Button,
              { variant: 'primary', disabled: actions.inflight !== null || !allowRecruitPermits, onClick: onExecute },
              recruitPlan === null ? t('actions.previewPlan') : t('actions.confirmExecute'),
            ),
            h(Badge, { tone: 'success' }, t('daily.zeroSanity')),
          ),
          h('div', { className: 'ark-field-hint' }, t('daily.waitHint')),
          h(PlanBox, { t: t, plan: recruitPlan, title: t('daily.planned'), zeroText: t('daily.zeroSanity') }),
          h('div', { className: 'ark-divider' }, h('span', { className: 'ark-field-label' }, t('daily.tags'))),
          tagsNode,
          h('div', { className: 'ark-divider' }, h('span', { className: 'ark-field-label' }, t('daily.combos'))),
          combosNode,
          h('div', { className: 'ark-field-hint' }, t('daily.combosHint')),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page 4: data. Stage / item search, drop table, activity calendar and
     * the read-only material planner (GET query kind=plan).
     * ------------------------------------------------------------------ */
    function DataPage(props) {
      const t = props.t;
      const api = props.api;

      const [kind, setKind] = React.useState('stage');
      const [query, setQuery] = React.useState('');
      const [search, setSearch] = React.useState({ status: 'idle', items: [], unavailable: false, error: null, kind: 'stage', q: '', data: null });
      const [drop, setDrop] = React.useState({ item: null, rows: [], loading: false, unavailable: false });
      const [activity, setActivity] = React.useState({ loading: false, loaded: false, items: [], unavailable: false });
      const [plannerTargets, setPlannerTargets] = React.useState('');
      const [planner, setPlanner] = React.useState({ loading: false, data: null, unavailable: false, error: null });

      function doSearch() {
        const text = String(query || '').trim();
        if (text === '') return;
        const activeKind = kind;
        setSearch({ status: 'loading', items: [], unavailable: false, error: null, kind: activeKind, q: text, data: null });
        setDrop({ item: null, rows: [], loading: false, unavailable: false });
        api.request(queryUrl(activeKind, { q: text, limit: 30 }), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
          const data = asRecord(response.data);
          if (response.ok !== true || data === null || data.ok === false) {
            setSearch({ status: 'error', items: [], unavailable: true, error: data !== null ? asRecord(data.error) : null, kind: activeKind, q: text, data: null });
            return;
          }
          setSearch({ status: 'ok', items: queryItems(data), unavailable: false, error: null, kind: activeKind, q: text, data: data });
        });
      }

      function loadDrop(item) {
        const name = pickString(item, ['name', 'itemName', 'id']);
        if (name === '') return;
        setDrop({ item: item, rows: [], loading: true, unavailable: false });
        api.request(queryUrl('drop', { q: name }), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
          const data = asRecord(response.data);
          if (response.ok !== true || data === null || data.ok === false) {
            setDrop({ item: item, rows: [], loading: false, unavailable: true });
            return;
          }
          setDrop({ item: item, rows: queryItems(data), loading: false, unavailable: false });
        });
      }

      function loadActivity() {
        setActivity(function (previous) { return Object.assign({}, previous, { loading: true }); });
        api.request(queryUrl('activity', {}), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
          const data = asRecord(response.data);
          if (response.ok !== true || data === null || data.ok === false) {
            setActivity({ loading: false, loaded: true, items: [], unavailable: true });
            return;
          }
          setActivity({ loading: false, loaded: true, items: queryItems(data), unavailable: false });
        });
      }

      function runPlanner() {
        const targets = String(plannerTargets || '').trim();
        if (targets === '') return;
        setPlanner({ loading: true, data: null, unavailable: false, error: null });
        api.request(queryUrl('plan', { targets: targets }), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
          const data = asRecord(response.data);
          if (response.ok !== true || data === null || data.ok === false) {
            setPlanner({ loading: false, data: null, unavailable: true, error: data !== null ? asRecord(data.error) : null });
            return;
          }
          setPlanner({ loading: false, data: data, unavailable: false, error: null });
        });
      }

      React.useEffect(function () {
        if (props.active === true && activity.loaded === false && activity.loading === false) loadActivity();
      }, [props.active, activity.loaded, activity.loading]);

      /** kind=item 的响应会额外带 top-level `stages` 掉率候选，直接显示成掉率表。 */
      const itemStageRows = search.kind === 'item' && asRecord(search.data) !== null
        ? asArray(asRecord(search.data).stages)
        : [];
      const itemStageNode = itemStageRows.length === 0
        ? null
        : h(
            'div',
            { className: 'ark-table' },
            h(
              'div',
              { className: 'ark-table-head' },
              h('span', null, t('data.stage')),
              h('span', null, t('data.apCost')),
              h('span', null, t('data.rate')),
              h('span', null, t('data.expectedSanity')),
            ),
            itemStageRows.map(function (row, index) {
              const record = asRecord(row) || {};
              return h(
                'div',
                { key: index, className: 'ark-table-row' },
                h('span', null, asString(pickString(record, ['code', 'name']), '—')),
                h('span', null, pickNumber(record, ['apCost']) === null ? '—' : pickNumber(record, ['apCost'])),
                h('span', null, formatRate(pickNumber(record, ['dropRate', 'rate']))),
                h('span', null, formatSanity(pickNumber(record, ['expectedSanity', 'expectSanity']))),
                record.lowSample === true ? h('span', { className: 'ark-list-meta' }, t('data.lowSample')) : null,
              );
            }),
          );

      const searchResultNodes = search.items.map(function (item, index) {
        const record = asRecord(item) || {};
        const itemType = pickString(record, ['type']);
        if (search.kind === 'stage' || itemType === 'stage') {
          const code = pickString(record, ['code', 'stageId', 'name']);
          const name = pickString(record, ['name']);
          const apCost = pickNumber(record, ['apCost']);
          const drops = stageDropRows(record);
          return h(
            'li',
            { key: index, className: 'ark-data-row' },
            h(
              'div',
              { className: 'ark-data-head' },
              h('span', { className: 'ark-data-name' }, code),
              name !== '' && name !== code ? h('span', { className: 'ark-data-sub' }, name) : null,
              apCost !== null ? h(Badge, { tone: 'idle' }, t('data.apCost') + ' ' + apCost) : null,
              record.activity === true ? h(Badge, { tone: 'business' }, t('data.activityBadge')) : null,
            ),
            drops.length > 0
              ? h(
                  'div',
                  { className: 'ark-table' },
                  h(
                    'div',
                    { className: 'ark-table-head' },
                    h('span', null, t('data.item')),
                    h('span', null, t('data.rate')),
                    h('span', null, t('data.expectedSanity')),
                  ),
                  drops.map(function (dropRow, dropIndex) {
                    const row = asRecord(dropRow) || {};
                    return h(
                      'div',
                      { key: dropIndex, className: 'ark-table-row' },
                      h('span', null, asString(pickString(row, ['itemName', 'name', 'itemId']), '—')),
                      h('span', null, formatRate(pickNumber(row, ['rate', 'dropRate']))),
                      h('span', null, formatSanity(pickNumber(row, ['expectedSanity', 'expectSanity']))),
                    );
                  }),
                )
              : null,
          );
        }
        if (search.kind === 'item' || itemType === 'item') {
          const name = pickString(record, ['name', 'id']);
          const id = pickString(record, ['id']);
          const usage = pickString(record, ['usage']);
          return h(
            'li',
            { key: index, className: 'ark-data-row' },
            h(
              'div',
              { className: 'ark-data-head' },
              h('span', { className: 'ark-data-name' }, name),
              id !== '' && id !== name ? h('span', { className: 'ark-data-sub' }, id) : null,
              h(Button, { variant: 'ghost', small: true, onClick: function () { loadDrop(item); } }, t('data.dropTable')),
            ),
            usage !== '' ? h('span', { className: 'ark-data-sub' }, usage) : null,
          );
        }
        return h(
          'li',
          { key: index, className: 'ark-data-row' },
          h('div', { className: 'ark-data-head' }, h('span', { className: 'ark-data-name' }, pickString(record, ['name', 'code', 'id'])), h('span', { className: 'ark-data-sub' }, itemType)),
        );
      });

      const dropNode = drop.loading
        ? h(Card, { title: t('data.dropTable'), wide: true }, h('div', { className: 'ark-inline' }, h(Spinner), ' ', t('data.searching')))
        : drop.unavailable
          ? h(Card, { title: t('data.dropTable'), wide: true }, h(Banner, { tone: 'warn' }, t('data.dropUnavailable')))
          : drop.item !== null
            ? h(
                Card,
                { title: t('data.dropTable') + ' · ' + pickString(drop.item, ['name', 'itemName', 'id']), wide: true },
                drop.rows.length === 0
                  ? h(EmptyState, { text: t('data.dropEmpty') })
                  : h(
                      'div',
                      { className: 'ark-table' },
                      h(
                        'div',
                        { className: 'ark-table-head' },
                        h('span', null, t('data.stage')),
                        h('span', null, t('data.apCost')),
                        h('span', null, t('data.rate')),
                        h('span', null, t('data.expectedSanity')),
                      ),
                      drop.rows.map(function (row, index) {
                        const record = asRecord(row) || {};
                        return h(
                          'div',
                          { key: index, className: 'ark-table-row' },
                          h('span', null, asString(pickString(record, ['code', 'name']), '—')),
                          h('span', null, pickNumber(record, ['apCost']) === null ? '—' : pickNumber(record, ['apCost'])),
                          h('span', null, formatRate(pickNumber(record, ['dropRate', 'rate']))),
                          h('span', null, formatSanity(pickNumber(record, ['expectedSanity', 'expectSanity']))),
                          record.lowSample === true ? h('span', { className: 'ark-list-meta' }, t('data.lowSample')) : null,
                        );
                      }),
                    ),
              )
            : null;

      const activityNode = !activity.loaded && activity.loading
        ? h('div', { className: 'ark-inline' }, h(Spinner), ' ', t('data.searching'))
        : activity.unavailable
          ? h(Banner, { tone: 'warn' }, t('data.activityUnavailable'))
          : activity.items.length === 0
            ? h(EmptyState, { text: t('data.activityEmpty') })
            : h(
                'ul',
                { className: 'ark-list' },
                activity.items.map(function (item, index) {
                  const record = asRecord(item) || {};
                  const stages = asArray(record.stages);
                  return h(
                    'li',
                    { key: index, className: 'ark-data-row' },
                    h(
                      'div',
                      { className: 'ark-data-head' },
                      h('span', { className: 'ark-data-name' }, pickString(record, ['name'])),
                      record.expired === true ? h(Badge, { tone: 'idle' }, t('data.expired')) : h(Badge, { tone: 'success' }, t('data.active')),
                      h('span', { className: 'ark-data-sub' }, t('data.activityStart') + ' ' + formatClock(asString(record.start))),
                      h('span', { className: 'ark-data-sub' }, t('data.activityEnd') + ' ' + formatClock(asString(record.end))),
                    ),
                    asString(record.tip) !== '' ? h('span', { className: 'ark-data-sub' }, asString(record.tip)) : null,
                    stages.length > 0
                      ? h(
                          'div',
                          { className: 'ark-chip-wrap' },
                          stages.map(function (stage, stageIndex) {
                            const row = asRecord(stage) || {};
                            const display = pickString(row, ['display', 'value']);
                            const value = pickString(row, ['value']);
                            return h('span', { key: stageIndex, className: 'ark-chip', title: value }, display === '' ? value : display);
                          }),
                        )
                      : null,
                  );
                }),
              );

      const plannerRows = planner.data !== null ? planTargets(planner.data) : [];
      const plannerTotal = planner.data !== null ? pickNumber(planner.data, ['totalExpectedSanity']) : null;
      const plannerWarnings = planner.data !== null ? asArray(planner.data.warnings) : [];

      const plannerNode = h(
        Card,
        { wide: true, title: t('data.planner') },
        h(
          'div',
          { className: 'ark-row ark-row-wrap' },
          h(
            Field,
            { label: t('data.plannerTarget'), grow: true },
            h(TextInput, {
              value: plannerTargets,
              placeholder: t('data.plannerTargetsPlaceholder'),
              ariaLabel: t('data.plannerTarget'),
              onChange: setPlannerTargets,
              onEnter: runPlanner,
            }),
          ),
          h(Button, { variant: 'primary', busy: planner.loading, disabled: planner.loading, onClick: runPlanner }, t('actions.planRun')),
        ),
        h('div', { className: 'ark-field-hint' }, t('data.plannerHint')),
        planner.unavailable ? h(Banner, { tone: 'warn' }, t('data.plannerUnavailable')) : null,
        plannerRows.length > 0
          ? h(
              'ul',
              { className: 'ark-list' },
              plannerRows.map(function (target, index) {
                const record = asRecord(target) || {};
                const best = asRecord(record.best) || {};
                const alternatives = asArray(record.alternatives);
                return h(
                  'li',
                  { key: index, className: 'ark-data-row' },
                  h(
                    'div',
                    { className: 'ark-data-head' },
                    h('span', { className: 'ark-data-name' }, pickString(record, ['itemName', 'itemId'])),
                    h(Badge, { tone: 'idle' }, '×' + (pickNumber(record, ['count']) === null ? 0 : pickNumber(record, ['count']))),
                    h('span', { className: 'ark-data-sub' }, t('data.bestStage') + ' ' + asString(pickString(best, ['code', 'name']), '—')),
                    h('span', { className: 'ark-data-sub' }, t('data.apCost') + ' ' + asString(pickNumber(best, ['apCost']))),
                    h('span', { className: 'ark-data-sub' }, t('data.rate') + ' ' + formatRate(pickNumber(best, ['dropRate', 'rate']))),
                    h('span', { className: 'ark-data-sub' }, t('data.expectedSanity') + ' ' + formatSanity(pickNumber(best, ['expectedSanity']))),
                  ),
                  alternatives.length > 0
                    ? h(
                        'div',
                        { className: 'ark-chip-wrap' },
                        alternatives.slice(0, 4).map(function (alternative, alternativeIndex) {
                          const row = asRecord(alternative) || {};
                          return h(
                            'span',
                            { key: alternativeIndex, className: 'ark-chip' },
                            asString(pickString(row, ['code', 'name']), '—') + ' · ' + formatSanity(pickNumber(row, ['expectedSanity'])),
                          );
                        }),
                      )
                    : null,
                );
              }),
            )
          : null,
        plannerTotal !== null ? h('div', { className: 'ark-planned-total' }, t('data.totalExpected', { n: formatSanity(plannerTotal) })) : null,
        plannerWarnings.length > 0
          ? h('ul', { className: 'ark-list' }, plannerWarnings.map(function (warning, index) {
              return h('li', { key: index, className: 'ark-list-row' }, h('span', { className: 'ark-list-main' }, asString(warning)));
            }))
          : null,
        planner.error !== null ? h(JsonDetails, { label: t('labels.detail'), json: planner.error }) : null,
      );

      return h(
        'div',
        { className: 'ark-page-grid' },
        h(
          Card,
          { wide: true, title: t('data.searchTitle') },
          h(
            'div',
            { className: 'ark-row ark-row-wrap' },
            h(
              Field,
              { label: t('data.kind') },
              h(SelectInput, {
                value: kind,
                ariaLabel: t('data.kind'),
                options: [
                  { value: 'stage', label: t('data.kindStage') },
                  { value: 'item', label: t('data.kindItem') },
                  { value: 'search', label: t('data.kindSearch') },
                ],
                onChange: setKind,
              }),
            ),
            h(
              Field,
              { label: t('data.query'), grow: true },
              h(TextInput, {
                value: query,
                placeholder: t('data.searchPlaceholder'),
                ariaLabel: t('data.query'),
                onChange: setQuery,
                onEnter: doSearch,
              }),
            ),
            h(Button, { variant: 'primary', busy: search.status === 'loading', disabled: search.status === 'loading', onClick: doSearch }, t('actions.search')),
          ),
          search.status === 'loading' ? h('div', { className: 'ark-inline' }, h(Spinner), ' ', t('data.searching')) : null,
          search.unavailable ? h(Banner, { tone: 'warn' }, t('data.unavailable')) : null,
          search.status === 'ok' && search.items.length === 0 ? h(EmptyState, { text: t('data.empty') }) : null,
          search.items.length > 0 ? h('ul', { className: 'ark-list' }, searchResultNodes) : null,
          itemStageNode,
          search.status === 'error' && search.error !== null ? h(JsonDetails, { label: t('labels.detail'), json: search.error }) : null,
        ),
        dropNode,
        h(
          Card,
          { title: t('data.activity'), actions: h(Button, { variant: 'ghost', small: true, busy: activity.loading, disabled: activity.loading, onClick: loadActivity }, t('actions.loadActivity')) },
          activityNode,
        ),
        plannerNode,
      );
    }

    /* ------------------------------------------------------------------ *
     * Page 5: box. Operator grid by rarity + depot top items from
     * GET query?kind=box; manual refresh runs action=box and reloads when the
     * run finishes.
     * ------------------------------------------------------------------ */
    function BoxPage(props) {
      const t = props.t;
      const api = props.api;
      const actions = props.actions;
      const info = readStatus(props.status);
      const statusBox = info.box;

      const [state, setState] = React.useState({ loading: false, loaded: false, data: null, unavailable: false, error: null });
      const [pending, setPending] = React.useState(false);
      const seenRunRef = React.useRef(false);
      const pendingAtRef = React.useRef(0);

      function loadBox() {
        setState(function (previous) { return Object.assign({}, previous, { loading: true, error: null }); });
        api.request(queryUrl('box', { target: 'both', limit: 400 }), { method: 'GET' }, QUERY_TIMEOUT_MS).then(function (response) {
          const data = asRecord(response.data);
          if (response.ok !== true || data === null || data.ok === false) {
            setState({ loading: false, loaded: true, data: null, unavailable: true, error: data !== null ? asRecord(data.error) : null });
            return;
          }
          setState({ loading: false, loaded: true, data: data, unavailable: false, error: null });
        });
      }

      React.useEffect(function () {
        if (props.active === true && state.loaded === false && state.loading === false) loadBox();
      }, [props.active, state.loaded, state.loading]);

      React.useEffect(function () {
        if (pending === false) return undefined;
        pendingAtRef.current = Date.now();
        seenRunRef.current = false;
        const timer = setInterval(function () {
          const root = asRecord(props.statusRef && props.statusRef.current ? props.statusRef.current.status : null);
          const runActive = root !== null && asRecord(root.run) !== null;
          if (runActive === true) {
            seenRunRef.current = true;
            return;
          }
          const elapsed = Date.now() - pendingAtRef.current;
          if (seenRunRef.current === true || elapsed > 8000) {
            setPending(false);
            loadBox();
          }
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, [pending]);

      const detail = state.data !== null ? extractBoxDetail(state.data) : null;
      const operators = operatorRows(detail);
      const depot = depotRows(detail);
      const maxCount = depot.length > 0 ? depot[0].count : 0;
      const counts = {
        operators: statusBox !== null ? asCount(statusBox.operators) : 0,
        depotItems: statusBox !== null ? asCount(statusBox.depotItems) : 0,
        updatedAt: statusBox !== null ? asString(statusBox.updatedAt) : '',
        partial: statusBox !== null && statusBox.partial === true,
      };
      if (detail !== null && detail.updatedAt !== '') counts.updatedAt = detail.updatedAt;
      if (detail !== null && detail.partial === true) counts.partial = true;

      const rarityGroups = [];
      for (let rarity = 6; rarity >= 1; rarity -= 1) {
        const list = operators.filter(function (row) { return row.rarity === rarity; });
        if (list.length > 0) rarityGroups.push({ rarity: rarity, list: list });
      }

      const onRefresh = function () {
        setPending(true);
        actions.run('box', { target: 'both', refresh: true }).then(function (record) {
          if (record === null || record.ok !== true) setPending(false);
        });
      };

      return h(
        'div',
        { className: 'ark-page-grid' },
        h(
          Card,
          { title: t('box.snapshotTitle') },
          h(
            'div',
            { className: 'ark-stats' },
            h(Stat, { value: counts.operators, label: t('labels.operators') }),
            h(Stat, { value: counts.depotItems, label: t('labels.items') }),
          ),
          h(KeyValue, { label: t('box.updatedAt'), value: counts.updatedAt === '' ? '—' : formatClock(counts.updatedAt) + ' · ' + relativeTime(counts.updatedAt, t) }),
          counts.partial ? h(Badge, { tone: 'warn' }, t('box.partial')) : null,
          h(
            'div',
            { className: 'ark-btn-row' },
            h(Button, { variant: 'secondary', busy: pending || actions.inflight === 'box', disabled: pending || actions.inflight !== null, onClick: onRefresh }, t('actions.refreshBox')),
            pending ? h('span', { className: 'ark-inline' }, h(Spinner), ' ', t('box.refreshing')) : null,
          ),
        ),
        h(
          Card,
          { wide: true, title: t('box.operatorsTitle') },
          state.loading ? h('div', { className: 'ark-inline' }, h(Spinner), ' ', t('box.loading')) : null,
          state.unavailable ? h(Banner, { tone: 'warn' }, t('box.detailUnavailable')) : null,
          rarityGroups.length === 0
            ? h(EmptyState, { text: operators.length === 0 && counts.operators > 0 ? t('box.detailUnavailable') : t('box.empty') })
            : rarityGroups.map(function (group) {
                return h(
                  'div',
                  { key: group.rarity, className: 'ark-rarity-group' },
                  h('div', { className: 'ark-rarity-title' }, t('box.starsLabel', { n: group.rarity })),
                  h(
                    'div',
                    { className: 'ark-op-grid' },
                    group.list.map(function (row) {
                      const meta = [];
                      if (row.elite !== null) meta.push(t('box.elite') + row.elite);
                      if (row.level !== null) meta.push(t('box.level') + row.level);
                      if (row.potential !== null) meta.push(t('box.potential') + row.potential);
                      return h(
                        'div',
                        { key: row.id, className: 'ark-op' + (row.own === true ? '' : ' ark-op-off') },
                        h('span', { className: 'ark-op-name' }, row.name),
                        h('span', { className: 'ark-op-stars' }, '★'.repeat(Math.max(1, Math.min(6, row.rarity)))),
                        h('span', { className: 'ark-op-meta' }, meta.join(' ')),
                        row.own === true ? null : h(Badge, { tone: 'idle' }, t('box.notOwned')),
                      );
                    }),
                  ),
                );
              }),
        ),
        h(
          Card,
          { wide: true, title: t('box.depotTitle') },
          depot.length === 0
            ? h(EmptyState, { text: t('box.depotEmpty') })
            : h(
                'ul',
                { className: 'ark-list' },
                depot.slice(0, 12).map(function (row, index) {
                  const width = maxCount > 0 ? Math.max(2, Math.round((row.count / maxCount) * 100)) : 0;
                  return h(
                    'li',
                    { key: row.id === '' ? index : row.id, className: 'ark-depot-row' },
                    h('span', { className: 'ark-depot-name' }, row.name),
                    h('span', { className: 'ark-depot-bar' }, h('span', { className: 'ark-depot-fill', style: { width: String(width) + '%' } })),
                    h('span', { className: 'ark-depot-count' }, row.count),
                  );
                }),
              ),
          state.error !== null ? h(JsonDetails, { label: t('labels.detail'), json: state.error }) : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page 6: settings. Read-only view of the effective config, paths, data
     * cache ages and safety switches. It never writes the profile/config.
     * ------------------------------------------------------------------ */
    function SettingsPage(props) {
      const t = props.t;
      const info = readStatus(props.status);
      const config = info.config;
      const safety = info.safety;
      const paths = info.paths;
      const data = info.data;
      const warnings = asArray(data !== null ? data.warnings : []);

      const flag = function (value) {
        return value === true ? t('settings.enabled') : t('settings.disabled');
      };
      const age = function (node, key) {
        const record = asRecord(node);
        if (record === null) return '—';
        const ms = pickNumber(record, [key, 'ageMs']);
        return ms === null ? '—' : formatAge(ms, t);
      };
      const pathValue = function (key) {
        return paths !== null && asString(paths[key]) !== '' ? asString(paths[key]) : '—';
      };

      return h(
        'div',
        { className: 'ark-page-grid' },
        h(
          Card,
          { title: t('settings.configTitle'), actions: h(Badge, { tone: 'idle' }, t('common.readOnly')) },
          h(KeyValue, { label: t('settings.defaultDifficulty'), value: config !== null ? difficultyLabel(t, asString(config.defaultDifficulty)) : '—' }),
          h(KeyValue, { label: t('settings.confirmRequired'), value: config !== null ? flag(config.confirmRequired) : '—' }),
          h(KeyValue, { label: t('settings.dryRun'), value: config !== null ? flag(config.dryRun) : '—' }),
          safety !== null ? h(KeyValue, { label: t('settings.confirmRequired'), value: flag(safety.confirmRequired) }) : null,
        ),
        h(
          Card,
          { title: t('settings.safetyTitle') },
          h(KeyValue, { label: t('settings.allowSanityPotion'), value: safety !== null ? flag(safety.allowSanityPotion) : '—' }),
          h(KeyValue, { label: t('settings.allowOriginitePrime'), value: safety !== null ? flag(safety.allowOriginitePrime) : '—' }),
          h(KeyValue, { label: t('settings.allowRecruitPermits'), value: safety !== null ? flag(safety.allowRecruitPermits) : '—' }),
          h(KeyValue, { label: t('settings.allowExpedite'), value: safety !== null ? flag(safety.allowExpedite) : '—' }),
        ),
        h(
          Card,
          { wide: true, title: t('settings.pathsTitle') },
          h(KeyValue, { label: t('settings.maaPath'), value: pathValue('maaPath') }),
          h(KeyValue, { label: t('settings.pythonPath'), value: pathValue('pythonPath') }),
          h(KeyValue, { label: t('settings.adbPath'), value: pathValue('adbPath') }),
          h(KeyValue, { label: t('settings.userDir'), value: pathValue('userDir') }),
          h(KeyValue, { label: t('settings.ledgerFile'), value: pathValue('ledgerFile') }),
          h(KeyValue, { label: t('settings.boxFile'), value: pathValue('boxFile') }),
          h(KeyValue, { label: t('settings.historyFile'), value: pathValue('historyFile') }),
        ),
        h(
          Card,
          { wide: true, title: t('settings.dataTitle') },
          h(
            'div',
            { className: 'ark-kv-list' },
            h(KeyValue, { label: t('settings.stagesData'), value: data !== null ? asCount(data.stages) : '—' }),
            h(KeyValue, { label: t('settings.itemsData'), value: data !== null ? asCount(data.items) : '—' }),
            h(KeyValue, { label: t('settings.arkrecCache'), value: data !== null ? age(data.arkrec, 'ageMs') : '—' }),
            h(KeyValue, { label: t('settings.penguinCache'), value: data !== null ? age(data.penguin, 'ageMs') : '—' }),
            h(KeyValue, { label: t('settings.activityCache'), value: data !== null ? age(data.activity, 'ageMs') : '—' }),
          ),
          h('div', { className: 'ark-divider' }, h('span', { className: 'ark-field-label' }, t('settings.warnings'))),
          warnings.length === 0
            ? h(EmptyState, { text: t('settings.noWarnings') })
            : h('ul', { className: 'ark-list' }, warnings.map(function (warning, index) {
                return h('li', { key: index, className: 'ark-list-row' }, h('span', { className: 'ark-list-main' }, asString(warning)));
              })),
          h('div', { className: 'ark-field-hint' }, t('settings.editHint')),
        ),
      );
    }

    /** One-line header summary (dot color is decided by the caller). */
    function buildHeaderSummary(t, status, loading, offline) {
      if (loading === true && status === null) return t('panel.loading');
      if (status === null || offline === true) return t('panel.offlineShort');
      const info = readStatus(status);
      const parts = [];
      const core = info.sidecar !== null ? asString(info.sidecar.coreVersion) : '';
      parts.push(t('labels.maaVersion') + ' ' + (core === '' ? '—' : core));
      parts.push(t('overview.emulator') + ' ' + (info.emulator !== null && info.emulator.running === true ? t('labels.emulatorRunning') : t('labels.emulatorStopped')));
      parts.push(t('overview.connectionLine') + ' ' + (info.connection !== null && info.connection.connected === true ? t('labels.connected') : t('labels.disconnected')));
      const taskRunning = info.tasks !== null && info.tasks.running === true;
      parts.push(t('labels.task') + ' ' + (taskRunning ? t('labels.running') : t('labels.idle')));
      return parts.join(' · ');
    }

    /* ------------------------------------------------------------------ *
     * Panel body: header + status pill + six page tabs + global result card
     * + pages + footer. Pages stay mounted (hidden) so form state survives tab
     * switches; each page gates its own network side-effects on `active`.
     * ------------------------------------------------------------------ */
    function ArknightsPanel(props) {
      const providedT = props && typeof props.t === 'function' ? props.t : null;
      const t = providedT || i18n.t;

      const apiRef = React.useRef(null);
      if (apiRef.current === null) apiRef.current = createApi();
      const api = apiRef.current;
      React.useEffect(function () {
        return function () {
          apiRef.current.dispose();
        };
      }, []);

      const polling = useArknightsStatus(api);
      const actions = useActionRunner({
        api: api,
        t: t,
        applyStatus: polling.applyStatus,
        refreshStatus: polling.refresh,
      });
      const [page, setPage] = React.useState('overview');

      const status = polling.status;
      const info = readStatus(status);
      const run = info.run;
      const sidecar = info.sidecar;
      const connection = info.connection;
      const sidecarAlive = sidecar !== null && sidecar.alive === true;
      const connected = connection !== null && connection.connected === true;

      let dotTone = 'idle';
      if (polling.offline === true) dotTone = 'error';
      else if (status !== null) dotTone = connected ? 'success' : sidecarAlive ? 'warn' : 'error';
      else dotTone = 'idle';

      const summary = buildHeaderSummary(t, status, polling.loading, polling.offline);

      const pageProps = {
        t: t,
        status: status,
        actions: actions,
        api: api,
        setPage: setPage,
        statusRef: polling.statusRef,
      };

      return h(
        'div',
        { className: 'ark-panel' },
        h('style', { key: 'arknights-style' }, PANEL_CSS),

        h(
          'header',
          { className: 'ark-head' },
          h(
            'div',
            { className: 'ark-titles' },
            h('div', { className: 'ark-title' }, t('panel.title')),
            h('div', { className: 'ark-subtitle' }, t('panel.subtitle')),
          ),
          h(
            'div',
            { className: 'ark-head-side' },
            h(
              'div',
              { className: 'ark-pill' },
              h(Dot, { tone: dotTone }),
              h('span', { className: 'ark-pill-text', title: summary }, summary),
              run !== null ? h(Spinner) : null,
            ),
            h(
              Button,
              { variant: 'ghost', small: true, busy: polling.loading, onClick: polling.refresh },
              t('panel.refresh'),
            ),
          ),
        ),

        h(
          'nav',
          { className: 'ark-tabs', role: 'tablist' },
          NAV_ITEMS.map(function (item) {
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                role: 'tab',
                'aria-selected': page === item.key,
                className: 'ark-tab' + (page === item.key ? ' ark-tab-active' : ''),
                onClick: function () { setPage(item.key); },
              },
              t(item.labelKey),
            );
          }),
        ),

        polling.offline === true ? h(Banner, { tone: 'warn' }, t('panel.offline')) : null,
        polling.error !== null && polling.offline === true
          ? h(
              'div',
              { className: 'ark-footer-text' },
              asString(polling.error.code) + (asString(polling.error.message) !== '' ? ' · ' + asString(polling.error.message) : ''),
            )
          : null,

        h(ActionResult, { t: t, result: actions.result, status: status, onDismiss: actions.dismiss }),

        h(
          'div',
          { className: 'ark-pages' },
          h('div', { className: 'ark-page', hidden: page !== 'overview' }, h(OverviewPage, pageProps)),
          h('div', { className: 'ark-page', hidden: page !== 'battle' }, h(BattlePage, Object.assign({}, pageProps, { active: page === 'battle' }))),
          h('div', { className: 'ark-page', hidden: page !== 'daily' }, h(DailyPage, Object.assign({}, pageProps, { active: page === 'daily' }))),
          h('div', { className: 'ark-page', hidden: page !== 'data' }, h(DataPage, Object.assign({}, pageProps, { active: page === 'data' }))),
          h('div', { className: 'ark-page', hidden: page !== 'box' }, h(BoxPage, Object.assign({}, pageProps, { active: page === 'box' }))),
          h('div', { className: 'ark-page', hidden: page !== 'settings' }, h(SettingsPage, pageProps)),
        ),

        h(
          'footer',
          { className: 'ark-footer' },
          h('span', { className: 'ark-footer-text' }, t('panel.updatedAt', { time: polling.lastAt === 0 ? '—' : formatClock(polling.lastAt) })),
          h('span', { className: 'ark-footer-text' }, t('panel.readOnlyHint')),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Panel styles. Colors come only from --dsw-alias-* theme tokens; the
     * inline SVG and the spinner use currentColor. Rendered as a React style
     * element so it disappears with the panel on unmount.
     * ------------------------------------------------------------------ */
    const PANEL_CSS = [
      '.ark-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;overflow-y:auto;padding:16px 20px 28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px}',
      '.ark-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.ark-titles{min-width:0}',
      '.ark-title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.ark-subtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-head-side{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.ark-pill{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:4px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-pill-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ark-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ark-tab{display:inline-flex;align-items:center;justify-content:center;min-width:64px;height:28px;padding:0 14px;border:.5px solid transparent;border-radius:7px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.ark-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ark-tab-active{background:var(--dsw-alias-fill-l2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.ark-tabs-inline{display:flex;flex-wrap:wrap;gap:4px}',
      '.ark-banner{padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px}',
      '.ark-banner-warn{border-left-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.ark-banner-error{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ark-banner-info{border-left-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-secondary)}',
      '.ark-banner-success{border-left-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-secondary)}',
      '.ark-pages{display:block;min-height:0}',
      '.ark-page[hidden]{display:none!important}',
      '.ark-page-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}',
      '.ark-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ark-card-wide{grid-column:1/-1}',
      '.ark-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.ark-card-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.ark-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.ark-row{display:flex;align-items:flex-end;gap:10px;min-width:0}',
      '.ark-row-wrap{flex-wrap:wrap}',
      '.ark-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ark-field-grow{flex:1 1 220px}',
      '.ark-field-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-field-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}',
      '.ark-input,.ark-select{box-sizing:border-box;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ark-input{width:220px;max-width:100%}',
      '.ark-input-num{width:88px}',
      '.ark-select{max-width:220px}',
      '.ark-input::placeholder{color:var(--dsw-alias-label-caption)}',
      '.ark-input:focus,.ark-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ark-input:disabled,.ark-select:disabled{opacity:.55}',
      '.ark-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.ark-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.ark-check input{accent-color:var(--dsw-alias-state-business-primary)}',
      '.ark-check-label{white-space:nowrap}',
      '.ark-check-disabled{opacity:.55;cursor:default}',
      '.ark-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:.5px solid transparent;border-radius:6px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary);background:0 0}',
      '.ark-btn:disabled{opacity:.5;cursor:default}',
      '.ark-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.ark-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.ark-btn-secondary{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.ark-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ark-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ark-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.ark-btn-ghost{color:var(--dsw-alias-label-secondary)}',
      '.ark-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ark-btn-sm{height:24px;padding:0 8px;font-size:12px}',
      '.ark-btn-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.ark-badge-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.ark-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.ark-badge-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ark-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.ark-badge-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ark-badge-business{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.ark-badge-idle{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}',
      '.ark-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.ark-dot-success{background:var(--dsw-alias-state-success-primary)}',
      '.ark-dot-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.ark-dot-error{background:var(--dsw-alias-state-error-primary)}',
      '.ark-dot-business{background:var(--dsw-alias-state-business-primary)}',
      '.ark-dot-idle{background:var(--dsw-alias-state-idle-primary)}',
      '.ark-spinner{display:inline-block;flex:none;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ark-spin .8s linear infinite}',
      '@keyframes ark-spin{to{transform:rotate(360deg)}}',
      '.ark-inline{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
      '.ark-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
      '.ark-stats{display:flex;flex-wrap:wrap;gap:18px}',
      '.ark-stat{display:inline-flex;align-items:baseline;gap:6px}',
      '.ark-stat-num{font-size:16px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.ark-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-big-stat{display:flex;align-items:baseline;gap:6px}',
      '.ark-big-num{font-size:28px;font-weight:600;line-height:36px;color:var(--dsw-alias-state-business-primary);font-variant-numeric:tabular-nums}',
      '.ark-big-max{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-kv-list{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ark-kv{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;font-size:12px;line-height:18px}',
      '.ark-kv-key{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ark-kv-value{min-width:0;color:var(--dsw-alias-label-primary);text-align:right;word-break:break-word}',
      '.ark-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.ark-list-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px}',
      '.ark-list-main{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
      '.ark-list-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.ark-chip-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.ark-chip{display:inline-flex;align-items:center;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.ark-chip-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ark-plan-box{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.ark-plan-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-planned{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ark-planned-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.ark-planned-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}',
      '.ark-planned-label{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ark-planned-sub{color:var(--dsw-alias-label-tertiary)}',
      '.ark-planned-note{min-width:0;color:var(--dsw-alias-label-secondary)}',
      '.ark-planned-total{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-suggest-wrap{position:relative}',
      '.ark-suggest{display:flex;flex-direction:column;gap:2px;position:absolute;z-index:5;top:100%;left:0;right:0;margin-top:2px;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 12px var(--dsw-alias-border-l2);max-height:220px;overflow-y:auto}',
      '.ark-suggest-hint{padding:4px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '.ark-suggest-item{display:flex;align-items:baseline;gap:8px;padding:3px 6px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}',
      '.ark-suggest-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ark-suggest-code{font-weight:600}',
      '.ark-suggest-name{color:var(--dsw-alias-label-secondary)}',
      '.ark-suggest-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.ark-form{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.ark-divider{display:flex;align-items:center;gap:8px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.ark-result-card{border-color:var(--dsw-alias-state-business-primary)}',
      '.ark-result-text{font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:180px;overflow-y:auto}',
      '.ark-details{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-details summary{cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
      '.ark-pre{max-height:220px;overflow:auto;margin:6px 0 0;padding:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}',
      '.ark-data-row{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.ark-data-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}',
      '.ark-data-name{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.ark-data-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-table{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px}',
      '.ark-table-head,.ark-table-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}',
      '.ark-table-head{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.ark-table-row{border-top:.5px solid var(--dsw-alias-border-l2);padding:3px 0;color:var(--dsw-alias-label-secondary)}',
      '.ark-table-head span,.ark-table-row span{flex:1 1 80px;min-width:60px;word-break:break-word}',
      '.ark-rarity-group{display:flex;flex-direction:column;gap:6px}',
      '.ark-rarity-title{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-op-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}',
      '.ark-op{display:flex;flex-direction:column;gap:2px;min-width:0;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.ark-op-off{opacity:.55}',
      '.ark-op-name{font-size:12px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ark-op-stars{font-size:11px;line-height:15px;color:var(--dsw-alias-state-warn-primary);letter-spacing:1px}',
      '.ark-op-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-depot-row{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(60px,2fr) minmax(48px,auto);gap:8px;align-items:center;font-size:12px;line-height:18px}',
      '.ark-depot-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.ark-depot-bar{height:6px;border-radius:999px;background:var(--dsw-alias-fill-l2);overflow:hidden}',
      '.ark-depot-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary)}',
      '.ark-depot-count{text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ark-combo-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px}',
      '.ark-combo-opers{display:flex;flex-wrap:wrap;gap:4px}',
      '.ark-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:4px}',
      '.ark-footer-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '@media (max-width:720px){.ark-panel{padding:12px 12px 20px}.ark-head{flex-direction:column}.ark-input{width:100%}.ark-head-side{width:100%}}',
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Client plugin body
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply: function apply(ctx) {
        registerDictionaries(ctx);

        // `locale` on a registration injects a live `t` prop and re-renders the
        // entry on a language switch; omit it when the service is unavailable.
        const localeOption = i18n.namespace === null ? {} : { locale: i18n.namespace };

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            Object.assign(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 5,
                label: function () {
                  return i18n.t('panel.title');
                },
              },
              localeOption,
            ),
            ArknightsIcon,
          );
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            Object.assign({ name: 'main', key: PANEL_ID }, localeOption),
            ArknightsPanel,
          );
        });
      },
    };
  },
});

# dsh-arknights —— 明日方舟助手（v1.0）

给 DeepSeek Harness 用的《明日方舟》助手：**打关/推关/肉鸽**、**日常一条龙**（签到/信用/公招/基建）、
**仓库与干员盒快照**、**关卡/材料/掉率资料与刷材料规划**，并带六页 Web 面板与关卡账本。
执行后端是本机 [MAA](https://maa.plus/)（MaaCore）+ MuMu 模拟器。

- 仓库：<https://github.com/ABccgh/dsh-arknights>（v1.0.0）
- 包名：`@local/arknights`，插件行 id：`arknights`；另导出预设入口 `./preset`
- 平台：**仅 Windows x64**；运行时零第三方依赖（`lib/**/*.js` 只用 `node:*` 与包内模块，
  Python 侧车只用标准库 ctypes/json）
- 工具：**13 个全局 `ark_*`** + **2 个预设作用域工具**（`ark_diag` / `ark_solutions`）
- 配套：预设 bundle [`dsh-arknights-agent`](https://github.com/ABccgh/dsh-arknights-agent)、
  PRTS 查询 [`dsh-prts`](https://github.com/ABccgh/dsh-prts)、skill `arknights`

## 功能

- **打指定关卡**：`ark_fight stages=5-10 times=2`。严格按给定关卡与次数执行，不猜关、不换关。
  能代理指挥就按次数刷；没有代理指挥就自动抄作业打一次满星；支持 `series` 连战倍率、
  `drops` 刷到指定材料数量、`difficulty=tough` 磨难/险地/突袭。
- **推关**：`ark_push from=5-3` 或 `chapter=5`。已满星跳过，未解锁停下并回报进度。
- **肉鸽**：`ark_rogue theme=Sarkaz mode=Exp`。映射到 MAA 6.21 数字模式，默认后台跑。
- **日常**：`ark_daily` 串起签到/信用/基建/公招分析（可选仓库），每项独立结果；
  `ark_recruit` 单独分析或执行公招；`ark_infrast` / `ark_mall` / `ark_award` 可单项执行。
- **仓库与干员盒**：`ark_box target=operbox|depot|both` 识别并落 `box.json`；面板按稀有度展示。
- **资料/规划**：`ark_data kind=stage|item|drop|operator|activity|search` 查关卡/材料/掉率/活动；
  `ark_plan targets="固源岩:10,聚酸酯组:5"` 按期望理智排出最佳关卡。
- **状态与账本**：`ark_status` 看 MAA/模拟器/连接/任务/理智（最后识别）/账本/日常/数据缓存；
  `ark_stop` 随时中止。
- **Web 面板**：侧栏「明日方舟」，六页：总览 / 战斗 / 日常 / 资料 / 仓库 / 设置。

## 为什么有「代理指挥 vs 抄作业」两条路

MAA 的 `Fight` 只能**代理指挥**（游戏内自动战斗录像）。没有代理指挥（从没三星通过、或借过助战干员）时，
MAA 会在开战前收到 `StageQueueUnableToAgent` 并直接 Stop —— **零理智消耗**。所以 `ark_fight` 的策略是：

1. 先 `append Fight` 试代理；
2. 收到 `UnableToAgent*` → 去作业站（prts.maa.plus）按难度取**完整作业**（`/copilot/get/<id>`）→ `append Copilot` 打一次；
3. 抄作业满星后这一关就有代理，后续次数可直接刷；多份作业失败会逐份尝试并记录诊断。

没有作业时不会盲目开打：报 `E_NO_SOLUTION` 并给三条出路（`copilotId=` / 本地 `file=` / 手动打一局）。

## 安全模型（重要）

- **两步确认**：`fight/push/rogue/daily/infrast/mall` 默认只返回计划（零消耗），必须再传 `confirm=true` 才执行；
  `confirmRequired=false` 可关闭。`dryRun=true` 时永远只出计划。
- **资源硬闸**：理智药、至纯源石、招聘许可、加急许可默认**全部拒绝**（`E_UNSAFE_RESOURCE`）；
  用户明确同意后，在 `cordis.patch.yml` 的 `safety` 段打开对应开关，并在调用里显式传参。
- **单飞**：同一时间只允许一个会动 MAA 的动作；第二个 `E_BUSY`，先 `ark_stop`。
- **审计**：每次 run 写 `history.jsonl`（最近 200 条）；失败写 `lastFailure` + 截图路径。
- **只读路由**：`/arknights/status` 与 `/arknights/query` 绝不拉起侧车/模拟器。

## 安装

本插件是 Harness 的 profile bundle（`link:` 安装，代码不在 DSH 安装作用域内）：

```powershell
# 1. 复制到长期保留的目录
robocopy "<仓库路径>" "$env:USERPROFILE\dsh-bundles\arknights" /MIR /XD .git test node_modules

# 2. 首次安装（profile 级操作；已安装过则跳过，直接重启 DSH）
#    在 Harness 里执行 plugin_manager install_bundle，target 指向上面的目录
```

依赖：Windows x64、本机 MAA（`MaaCore.dll` + `resource/`）、MuMu 模拟器 12、可用的 `python.exe`。
**改 `lib/` 代码必须重启 DSH**；只改 `cordis.patch.yml` 配置值时把插件关开一次即可。

配套预设：安装 `dsh-arknights-agent` 后，新会话选「明日方舟」即可获得 `ark_diag` / `ark_solutions`
并隐藏无关工具。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `maaPath` / `pythonPath` / `adbPath` / `address` | `''` | 空串=自动探测；adb 默认 `127.0.0.1:16384` |
| `userDir` / `ledgerFile` / `cacheDir` | `''` | 空串=`%LOCALAPPDATA%\dsh-arknights\…` |
| `connectionConfig` / `clientType` / `touchMode` | `MuMuEmulator12` / `Official` / `minitouch` | MAA 连接参数 |
| `defaultDifficulty` | `auto` | `auto` / `easy` / `tough` |
| `confirmRequired` / `dryRun` / `webStatus` | `true` / `false` / `true` | 确认、只读演练、面板端点 |
| `safety.allowSanityPotion` | `false` | 理智药硬闸 |
| `safety.allowOriginitePrime` | `false` | 至纯源石硬闸 |
| `safety.allowRecruitPermits` | `false` | 公招执行硬闸 |
| `safety.allowExpedite` | `false` | 加急许可硬闸 |
| `copilot.*` | 作业站 | `enabled/api/timeoutMs/maxSolutionsPerStage/allowBorrowedOper/ignoreRequirements` |
| `arkrec.*` | ArkRec | 中文名/突袭条件；失败只降级 |
| `penguin.*` | penguin-stats | 掉率矩阵；失败只用缓存 |
| `activity.*` | MAA 活动 API | 活动/复刻日历 |
| `rogue.*` | `Sarkaz`/`Exp`/9999 | 主题/模式/次数/squad/roles/coreChars/difficulty |
| `push.*` | 10 关 / 连续 2 次失败停 | 推关上限与停止条件 |
| `daily.*` | `award,mall,infrast` | 日常默认项、跳过已完成、各项参数 |
| `box.*` / `history.*` | 各自路径 | 快照与历史 |

## 工具一览

### 全局（13）

`ark_status`、`ark_fight`、`ark_push`、`ark_rogue`、`ark_daily`、`ark_recruit`、`ark_infrast`、
`ark_mall`、`ark_award`、`ark_box`、`ark_data`、`ark_plan`、`ark_stop`。

### 预设作用域（2）

`ark_diag`（`action=screen|logs|device|emulator|game|probe`）、`ark_solutions`（作业站浏览）。

### PRTS（另一个插件，10）

`prts_status/search/titles/page/sections/page_info/links/category/recent_changes/operator`。

## HTTP 端点（面板用，仅本机）

- `GET /arknights/status` → 状态 JSON（契约 §5），绝不拉起侧车/模拟器。
- `GET /arknights/query?kind=stage|item|drop|operator|activity|search|solutions|plan|box&q=&limit=&refresh=&target=` → 只读查询。
- `POST /arknights/action` → `{action, …, confirm?, wait?}`；默认立即返回 `{runId,status}`，
  `wait:true` 等到结束；`confirm:false` 只回计划。

## 账本、快照与历史

- `progress.json` v2：每关 `stars/fullStar/primeClaimed/difficulty/attempts/lastFailure`、
  日常完成标记、推关进度；v1 自动迁移（先写 `.v1.bak`，损坏写 `.corrupt-<ts>` 后从空账本开始）。
- `box.json`：仓库/干员快照；部分识别不覆盖完整快照。
- `history.jsonl`：最近 200 次 run 的审计记录。
- 账本只做提示，**绝不覆盖用户指令**：账本说已满星，用户要求再打就再打。

## 磨难 / 险地与理智不足

- 难度靠 MAA 关卡名后缀：`-NORMAL`/`-HARD`；10–14 章 = 标准/磨难，15 章及以后 = 常规/险地。
  抄作业同时带 `nav_name_override` 与 `is_raid`。`auto/easy` 不会用险地作业。
- 理智不足时游戏弹窗会挡住开始行动；插件用 adb BACK 清弹窗，并在诊断里写“可能理智不足”。
  **不会自己用药/碎石**。

## 失败诊断

失败不再只报“作业执行失败”，而是分类：

| code | 含义 |
|---|---|
| `no-agent` | 没有代理指挥（零理智）→ 自动抄作业 |
| `stage-not-found` | 未解锁/代码不对/活动关不在资源里 |
| `battle-start-timeout` | 没进关卡详情（难度未开放/未解锁/导航失败），附 MAA 截图 |
| `sanity-insufficient` | 可能理智不足，不会自动用药 |
| `oper-missing` | 作业缺干员 |
| `copilot-file` | 作业文件预检失败 |
| `connection` / `timeout` / `stopped` / `unknown` | 设备、超时、手动停止、未识别 |

诊断同时写入账本 `lastFailure` 与 `history.jsonl`。

## 测试

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 全量离线（单元 + 工具 + 假侧车）
& $node --test "test/*.test.js" "test/*.test.mjs"

# 侧车 + 真实 MaaCore（跑不到就自动 skip）
& $node --test test/sidecar.test.mjs

# 侧车自检
& $node test/run-selftest.mjs

# 真机零理智验收（默认只读；--free 才跑免费动作）
& $node test/live-device.mjs
```

测试需要 Node ≥ 24（`node:test` 的 expectFailure），用 DSH 自带运行时即可。
`test/fixtures/` 是离线夹具；`test/fake-sidecar.mjs` 是可脚本化的假侧车。

## 已知限制

- 只支持 Windows + MAA + MuMu 12（其它模拟器要手改 adb/连接配置）。
- 抄作业会 `ignore_requirements`（配置可关）；失败会列缺哪些干员。
- 作业站/ArkRec/penguin/活动 API 都是第三方；不可用时降级，不影响代理打关卡。
- 仓库/干员识别耗时较长（分钟级），面板显示运行态。
- 面板视觉在重启 DSH 后验收；跨分辨率/主题的观感未逐一验证。
- 关卡数据来自 MAA `resource/stages.json`；新关卡要等 MAA 更新资源。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

# dsh-arknights —— 明日方舟「打关卡」插件

给 DeepSeek Harness 用的明日方舟自动化插件：**指定关卡就打那关**、**按主线顺序推关**、**跑集成战略（肉鸽）**，
并带一个 Web 面板与一份本地关卡账本。执行后端是本机的 [MAA](https://maa.plus/)（MaaCore.dll）+ MuMu 模拟器。

- 仓库：<https://github.com/ABccgh/dsh-arknights>（0.2.0，2026-10-28 发布）
- 包名：`@local/arknights`，插件行 id：`arknights`；另导出预设作用域入口 `./preset`（`lib/preset/`）
- 工具：**5 个全局 `ark_*`**（打关卡/推关/肉鸽/停止/状态）+ **7 个预设作用域辅助工具**（见 §「智能体预设与 7 个辅助工具」）
- 平台：**仅 Windows x64**（MaaCore 是 Windows 版），需要本机 MAA + MuMu 模拟器 12 + 一个可用的 Python
- 运行时零第三方依赖：`lib/**/*.js` 只 import `node:*` 与包内模块；Python 侧车只用标准库（ctypes/json）

## 功能

- **打指定关卡**：`ark_fight stages=5-10 times=2`。严格按你给的关卡与次数执行，不猜关、不自动换关。
  能代理指挥就按次数刷；没有代理指挥就自动抄一份作业打一次满星。
- **推关**：`ark_push from=5-3`（或 `chapter=5`）。按主线关卡顺序一关接一关打，已满星的自动跳过，
  遇到尚未解锁的关就停下并回报「推到哪里、下次从哪继续」。
- **肉鸽**：`ark_rogue theme=Sarkaz mode=Exp`。启动 MAA 的 Roguelike 任务，默认立即返回、后台继续。
- **状态与账本**：`ark_status` 查看 MAA/Python/adb/模拟器/连接/任务/理智/账本统计/推关进度，只读不启动东西。
- **Web 面板**：侧边栏「明日方舟」面板，3 秒轮询状态，提供打关卡/推关/肉鸽/停止/预览按钮。

## 为什么有「代理指挥 vs 抄作业」两条路

MAA 的 `Fight` 任务只能**代理指挥**（游戏里的自动战斗录像）。如果你这一关没有代理指挥
（从没三星通过，或上次借了助战干员），MAA 会在开战前收到 `StageQueueUnableToAgent` 事件并直接 Stop
——**这一下不消耗理智**。所以本插件的单关策略是：

1. 先 `append Fight` 试代理指挥；
2. 如果收到 `UnableToAgent*`，改去作业站（prts.maa.plus）按关卡难度筛一份作业，`append Copilot` 打一次；
3. 抄作业满星后，这一关就有代理指挥了，之后的次数可以直接刷。

作业站查询失败**不会阻塞打关卡**，只会降级成「没有可用作业」并给出三条出路：
指定 `copilotId`、用 `file=` 传本地作业 JSON、或自己手动打一局。

## 安装

本插件是 Harness 的 profile bundle（仓库通过 `link:` 安装，代码不在 DSH 安装作用域内）：

```powershell
# 1. 把仓库复制到 bundle 目录（安装副本才是运行时真正加载的那一份）
robocopy "<仓库路径>" "$env:USERPROFILE\dsh-bundles\arknights" /MIR /XD .git test node_modules

# 2. 让 Harness 安装/刷新 bundle（profile 级操作，装完在插件页把 arknights 打开）
#    在 Harness 里执行 plugin_manager install_bundle 指向 %USERPROFILE%\dsh-bundles\arknights
```

依赖：Windows x64、本机 MAA（含 `MaaCore.dll` 与 `resource/`）、MuMu 模拟器 12、以及一个可用的 python.exe。
**只改 `cordis.patch.yml` 里的配置值**时，插件页把 arknights 关开一次（或重载插件）即可；
**改了 `lib/` 下的代码必须重启 DSH**。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `maaPath` | `''` | MAA 安装根（含 `MaaCore.dll` 的那层）。空串=自动探测 |
| `pythonPath` | `''` | 跑 sidecar 的 python.exe。空串=自动探测（优先 .dsh 运行时自带） |
| `adbPath` / `address` | `''` | adb 路径与模拟器 adb 端口。空串=自动探测 / `127.0.0.1:16384` |
| `userDir` | `''` | MAA 的 user 目录（日志/debug 图）。空串=`%LOCALAPPDATA%\dsh-arknights\maa` |
| `ledgerFile` | `''` | 关卡账本文件。空串=`%LOCALAPPDATA%\dsh-arknights\progress.json` |
| `touchMode` | `minitouch` | `minitouch` / `maatouch` / `adb` / `macplaytools` |
| `deploymentWithPause` | `false` | 部署时暂停（MAA 实例选项） |
| `clientType` / `connectionConfig` | `Official` / `MuMuEmulator12` | MAA 连接参数 |
| `defaultDifficulty` | `auto` | `auto`（优先简单/普通）/ `easy` / `tough`（磨难，直接抄作业） |
| `confirmRequired` | `true` | true 时打关卡/推关先返回计划，必须再调一次 confirm 才执行 |
| `dryRun` | `false` | true 时只回计划，绝不 append/start 任何任务 |
| `webStatus` | `true` | 是否注册面板用的两个 HTTP 端点 |
| `copilot.enabled` | `true` | 关掉后完全不联网查作业，只能用 `file=` 本地作业 |
| `arkrec.enabled` | `true` | ArkRec（关卡中文名/突袭条件/少人纪录）辅助，失败自动降级 |
| `rogue.theme` / `rogue.mode` | `Sarkaz` / `Exp` | 肉鸽默认主题与模式 |
| `push.maxStages` | `10` | 单次推关上限 |
| `push.stopOnNoSolution` | `true` | 推关遇到无作业是停下（false=跳过继续） |
| `push.maxConsecutiveFailures` | `2` | 连续失败/未满星多少关后停下 |

## 确认流程

`confirmRequired=true`（默认）时，`ark_fight` / `ark_push` **第一次调用只返回计划**（零理智消耗）：

1. 第一调用（`confirm` 不传）→ 返回「打哪几关、什么难度、预计理智、会不会抄作业」；
2. 确认无误后带 `confirm=true` 再调一次 → 才真正 `ensureReady`（必要时拉起模拟器）并开打。

`dryRun=true` 时无论如何都只回计划。`/ark fight 5-10 --yes` 等价于直接带 confirm。

## HTTP 端点（面板用，仅 127.0.0.1）

- `GET /arknights/status` → docs/contracts.md §5 的状态 JSON。**该接口绝不拉起 sidecar、不启动模拟器、
  不执行任何 MAA 调用**（只读内存状态 + 已有探测缓存）。
- `POST /arknights/action`，body 形如 `{"action":"fight","stages":"5-10","times":1,"confirm":true}` /
  `{"action":"push","from":"5-3","chapter":null,"confirm":true}` /
  `{"action":"rogue","theme":"Sarkaz","mode":"Exp"}` / `{"action":"stop"}`；
  返回 `{ok:true,text}` 或 `{ok:false,error:{code,message}}`。面板只能通过这两个端点与 Host 交互。

## 关卡账本

`%LOCALAPPDATA%\dsh-arknights\progress.json`（可用 `ledgerFile` 改）。记录每关的
`stars / fullStar / primeClaimed / method / solutionId / lastRunAt / failures[]`，以及推关进度
`push.nextStage`（`ark_push` 的缺省起点）。写入是「临时文件 + rename」的原子替换，失败只告警不影响主流程。
账本只做提示，**绝不覆盖你的指令**：账本说已满星，你要求再打就再打。

## 磨难 / 险地 / 突袭难度

`ark_fight` 的 `difficulty=tough` 会把关卡名加上 MAA 的 **`-HARD`** 后缀再导航
（MAA 集成文档：10-14 章对应标准/磨难，**15 章及以后对应常规/险地**，见 `stage` 参数说明）。
抄作业时同时给 `nav_name_override: "<关卡>-HARD"` 与 `is_raid: true`，由 MAA 在选关后切换难度。
`auto`/`easy` 只用常规作业，`tough` 才会用磨难/险地作业。

## 理智不足怎么办

关卡需要 24 理智而当前只有 13 时，点「开始行动」会弹「理智不足」对话框，MAA 的 Fight 会停在那里，
抄作业也会因为弹窗挡住「开始行动」而失败。插件会：用 adb BACK 关掉弹窗、在错误里写明「关卡需要多少理智、
可能是理智不足」。需要消耗道具时必须显式传参：

```text
ark_fight stages=16-16 difficulty=tough medicine=1          # Fight 允许用 1 个理智药
ark_fight stages=16-16 difficulty=tough useSanityPotion=true  # 抄作业时自动用理智药
```

插件**不会自己**决定用理智药或源石。

## 视频兜底（`ark_fight video=<录屏>`）

没有作业站作业时，可以把一段**作战录屏**交给 MAA 的视频识别：

```text
ark_fight stages=16-16 difficulty=tough video=D:\videos\16-16.mp4 confirm=true
```

流程：`VideoRecognition{filename}` → 等识别结束 → 插件按两条路拾取它生成的作业
（回调事件里的 `{stage_name, actions}`，或 `<userDir>/copilot|debug` 与视频同目录下新出现的 JSON）→ 拿到就直接执行，
拿不到就报 `E_NO_SOLUTION` 并提示「在 MAA GUI 里做视频识别并另存 JSON，再用 `file=` 传」。

⚠️ 这是 **best-effort**：MAA 文档只写了 `filename` 入参，没写作业交付方式，本机也没有合适的录屏可做真机验证。
**日常首选仍是 `copilotId=` 与 `file=`**。

## 智能体预设与 7 个辅助工具

同仓库还导出预设作用域入口 `lib/preset/index.js`（`./preset`），由另一个 bundle
[`dsh-arknights-agent`](https://github.com/ABccgh/dsh-arknights-agent) 的「明日方舟」预设以 `file://` 挂载，
注册 7 个只在方舟会话可见的辅助工具：

| 工具 | 用途 | 副作用 |
|---|---|---|
| `ark_stages` | 关卡代码↔中文名/理智/掉落材料/账本状态；按材料名反查关卡 | 无（可离线） |
| `ark_solutions` | 作业站浏览：id/评分/干员需求/是否险地，并给出 `ark_fight … copilotId=…` 调用串 | 无（只查询） |
| `ark_screen` | adb 抓**游戏画面**存 PNG，配合 `read_image` 看「卡在哪」 | 写环形截图 |
| `ark_device` | adb/分辨率/机型/前台包名/模拟器三态自检 | 无 |
| `ark_game` | 启动/关闭游戏本体（包名从 MAA `resource/config.json` 读） | 动游戏进程 |
| `ark_emulator` | MuMu 状态/启动/关闭 | 动模拟器 |
| `ark_log` | MAA 日志尾（可按 `error`/`warn` 过滤） | 无 |

全局的 5 个打关卡工具、侧栏面板、`/ark` 命令、两个 HTTP 路由**都不受影响**，任何会话都能用；
预设会话只是额外多这 7 个、并隐藏与方舟无关的插件工具（保留 `prts_*` / `input_*`）。

## 已知限制 / 注意

- 只支持 Windows（MaaCore 是 Windows 版），且需要 MuMu 模拟器 12（其它模拟器要手动改 adb/连接配置）。
- 同一时间只允许一个动作在跑；第二条命令直接 `E_BUSY`，需要先 `ark_stop`。
- 抄作业会 `ignore_requirements=true`（避免干员不满足时直接失败），失败时会报缺哪些干员。
- 作业站/ArkRec 都是第三方站点，不可用时只降级显示与候选，不影响代理指挥打关卡。
- 面板的视觉与交互已在本机真机截图核对（侧栏入口、状态轮询、按钮与提示文案、`POST /arknights/action` 联动）；
  跨机器/跨主题的观感未逐一验证，仍以逻辑与接口测试为主。
- 关卡数据取自 MAA `resource/stages.json`；MAA 升级后如出现新关卡，需重启 DSH 或清缓存重读。

## 测试

共 **273 例**，全部离线：不联网、不起 MAA、不需要模拟器（Python sidecar 的测试会自动跳过缺失的运行环境）。

```powershell
# 需要 Node ≥ 24（测试用了 node:test 的 expectFailure）；本机 PATH 没有 node，
# 用 .dsh 运行时自带的那个（v24.21）即可，换成你自己满足版本要求的 node 也行
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 全量：单元 + 预设工具 + 视频兜底 + 侧车协议（= package.json 的 npm test）
& $node --test "test/*.test.js" "test/*.test.mjs"

# 只跑单元（不含需要 Python/MaaCore 的侧车测试）
& $node --test "test/*.unit.test.js"

# Python sidecar + 真实 MaaCore 的集成测试（跑不到就自动 skip）
& $node --test test/sidecar.test.mjs

# 侧车自检（不需要 DSH，不需要模拟器）
& $node test/run-selftest.mjs
```

`test/fixtures/` 是离线夹具（关卡表/材料表/作业站响应/ArkRec 关卡树），`test/fake-sidecar.mjs` 是
用 Node 写的假侧车（按 docs/contracts.md §2 的 NDJSON 协议应答，可脚本化事件）。
侧车测试可用 `DSH_ARKNIGHTS_PYTHON` / `DSH_ARKNIGHTS_MAA_PATH` 指定解释器与 MAA 目录；不指定时自动探测。

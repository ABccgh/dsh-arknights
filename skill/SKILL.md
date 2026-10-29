---
name: arknights
description: |
  Use for Arknights automation in the DSH workspace: fighting a requested stage, pushing main-story
  stages, running Integrated Strategies, daily routines (award/credit store/recruitment/base),
  warehouse & operator-box snapshots, stage/material/drop-rate lookups and farming plans, through
  the local MAA core + MuMu 12 emulator; diagnosing why a stage did not start (insufficient sanity,
  no auto-deploy, no copilot solution, battle-start timeout such as 16-16); handling 磨难/险地
  difficulty; reading the stage ledger. Load this before calling ark_fight / ark_push / ark_rogue.
metadata:
  author: "local workspace"
  version: "2.0.0"
---

# 明日方舟助手 v1.0 —— 代理指挥操作手册

## 0. 适用场景

用户要做以下任一件事时加载本 skill：打指定关卡 / 刷材料 / 满星某关、按主线推关、跑集成战略（肉鸽）、
日常一条龙（签到、信用商店、公招、基建）、查仓库与干员盒、查关卡/材料/掉率、做刷图规划、
排查「为什么没开打」。涉及磨难 / 险地 / 突袭难度、理智不足、作业站作业时尤其要先读完本手册。

## 1. 工具地图（13 全局 + 2 预设 + 10 PRTS）

### 全局（所有会话可见，`@local/arknights`）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `ark_status` | 链路诊断：MAA 版本/资源、Python、adb、模拟器三态、连接、当前任务链、理智、账本、面板状态 | 无 |
| `ark_fight` | 打指定关卡；`confirm=false` 只出计划（零理智），`confirm=true` 才开打 | `stages` `times` `difficulty` `medicine` `stone` `useSanityPotion` `copilotId` `file` `video` |
| `ark_push` | 按主线顺序推关：账本已满星自动跳过，遇到未解锁的关停下 | `from` `chapter` `maxStages` |
| `ark_rogue` | 集成战略（默认后台跑，用 `ark_status` 看进度） | `theme` `mode` `startsCount` |
| `ark_daily` | 日常一条龙：领奖 / 信用商店 / 基建 / 公招 / 仓库 | `tasks` `skipDone` `award` `mall` `infrast` `recruit` `box` |
| `ark_recruit` | 公招：`analyze` 只给标签组合，`execute` 才真的招募 | `mode` `times` `confirmLevels` `refresh` `expedite` `permitReserve` |
| `ark_infrast` | 基建换班 / 无人机 / 自定排班 | `mode` `facility` `drones` `threshold` `customFile` `planIndex` |
| `ark_mall` | 信用商店购买 | `visitFriends` `shopping` `buyFirst` `blacklist` `onlyDiscount` `reserveMaxCredit` |
| `ark_award` | 领取奖励：日常/周常、邮件、每日单抽、合成玉、挖矿、签到活动 | `award` `mail` `dailyPull` `orundum` `mining` `specialAccess` `signInEvent` |
| `ark_box` | 仓库 / 干员盒快照（耗时 5–20 分钟，见 §9） | `target=operators|depot|both` `refresh` |
| `ark_data` | 只读资料：关卡/材料/干员/活动/搜索/作业列表 | `kind` `q` `limit` `refresh` |
| `ark_plan` | 刷材料规划：给定目标数量，按掉率与期望理智排最优关卡 | `targets="固源岩:10, 聚酯:5"` |
| `ark_stop` | 立即中止当前任务链（战斗中也有效） | 无 |

### 预设「明日方舟」作用域（只有该预设会话可见，`lib/preset/`）

| 工具 | 用途 |
|---|---|
| `ark_diag` | 现场排查六动作：`action=screen`（adb 抓游戏画面存 PNG，返回路径+尺寸）/ `logs`（MAA 日志尾，`level=all/warn/error`）/ `device`（adb/分辨率/机型/前台包名）/ `emulator`（MuMu `status/start/stop`）/ `game`（`start/stop` 游戏本体）/ `probe`（重探 MAA/Python/MuMu/adb 路径） |
| `ark_solutions` | 只读作业站浏览：某关的作业 id、评分、干员需求、`is_raid`、难度，并给出可复制的 `ark_fight … copilotId=…` 调用串 |

### PRTS Wiki（`dsh-prts`，10 个只读工具）

| 工具 | 用途 |
|---|---|
| `prts_status` | 连通性与站点概况；任何 prts 工具报错先调它 |
| `prts_search` | 全文检索（MediaWiki 内置搜索，没有 CirrusSearch 语法） |
| `prts_titles` | 按前缀对准标题，返回规范 URL |
| `prts_page` | 读正文：`format=text/wikitext`，`section=N` 读单节 |
| `prts_sections` | 章节目录（section 索引 + 每节字符数） |
| `prts_page_info` | 页面元数据：pageid、大小、最后编辑、分类、重定向 |
| `prts_links` | 页面出链 / 反向链接 |
| `prts_category` | 分类成员 |
| `prts_recent_changes` | 最近改动 |
| `prts_operator` | 干员档案：从 wikitext 的 `{{CharinfoV2}}` / `{{干员获得方式}}` / `{{属性}}` 解析稀有度、职业、分支、位置、标签、特性、获得方式、上线时间、阵营、画师、CV |

另有：侧栏面板「明日方舟」、命令 `/ark status|fight|push|rogue|daily|stop`（可加 `--yes` / `--dry`）、
HTTP `GET /arknights/status`、`GET /arknights/query`、`POST /arknights/action`。

## 2. 意图决策树

1. **打某一关**：`ark_status` →（可选）`ark_data(kind=stage)` 核对关卡 → `ark_fight(confirm=false)` 出计划 → 用户确认 → `ark_fight(confirm=true)`。
2. **推主线**：`ark_status` 看推关进度 → `ark_push`（先出计划）→ 确认后执行；停下就汇报「已推到哪里、为什么停」。
3. **肉鸽**：确认主题/模式/次数 → `ark_rogue`（后台跑）→ 用 `ark_status` 看进度，别重复启动。
4. **日常**：`ark_status` 看今日任务 → `ark_daily(tasks=…)` 先出计划 → 确认后执行；`skipDone=true` 避免重复。
5. **查资料**：关卡/材料/掉率用 `ark_data` / `ark_plan`；干员档案优先 `prts_operator`，其余 wiki 内容用 `prts_search` → `prts_titles` → `prts_page`。
6. **规划刷图**：`ark_plan(targets=…)` 看最优关卡与期望理智 → 确认后用 `ark_fight` 按计划打。
7. **排查**：`ark_status` → `ark_diag(action=device)` → `ark_diag(action=logs)` → `ark_diag(action=screen)` → `ark_diag(action=probe)`；不要靠猜。

## 3. 确认矩阵与资源安全

| 动作 | 需要确认 | 说明 |
|---|---|---|
| `ark_fight` / `ark_push` / `ark_rogue` | 是 | 先 `confirm=false` 出计划，用户点头后 `confirm=true` |
| `ark_daily` / `ark_infrast` / `ark_mall` | 是 | 同上，两步确认 |
| `ark_recruit` | 仅 `mode=execute` | `analyze` 只读，随时可调 |
| `ark_status` / `ark_award` / `ark_box` / `ark_data` / `ark_plan` / `ark_stop` | 否 | 只读或停止 |
| `ark_solutions` | 否 | 只查作业站 |
| `ark_diag` | 否（`emulator start/stop`、`game start/stop` 会改状态） | 只读动作随时可调；动模拟器/游戏前先说明 |

**资源硬闸（默认全部拒绝）**：`medicine>0`、`stone>0`、`useSanityPotion=true`、`expedite=true`、
`ark_recruit(mode=execute)`。要消耗理智药 / 至纯源石 / 招聘许可 / 加急许可时：先讲清代价，
等用户明确同意，再由用户自己打开 `safety.allowSanityPotion` / `allowOriginitePrime` /
`allowRecruitPermits` / `allowExpedite` 或显式传参。**绝不擅自消耗**，也不能拿「反正不贵」代替确认。

## 4. 难度规则：磨难 / 险地 / 突袭

- MAA 用关卡名后缀切难度：`-NORMAL` / `-HARD`；**10–14 章 = 标准/磨难，15 章及以后 = 常规/险地**。
- 「险地作战」「磨难」「突袭」一律传 `difficulty=tough`；`auto`/`easy` 只用标准/常规，且**不会**用 `tough_` 作业。
- 拿不准难度就先问；不要默认往上加难度，也不要自己把 tough 降成 auto。
- 显示代码 ↔ 内部 id 不恒等：`16-16` → `main_16-15`（章号偏移），以 MAA `stages.json` 为准；`ark_data` 可核对。

## 5. 代理指挥 vs 抄作业

代理指挥（自动部署）**只在「满星且未借干员通关」后可用**。`ark_fight` 内部先试 Fight，
没有代理指挥或失败时自动改走 Copilot 抄作业（真正部署干员），能刷新记录拿满星。
对外你只需要给对关卡与难度；不要手工把作业站列表里的截断 `content` 当作业用——
完整作业必须按 id 走 `/copilot/get/<id>`（插件已内置）。作业站不可达时降级为 `file=` / 手动打，不阻塞。

## 6. 理智不足（最常见的「没开打」原因）

现象：点「开始行动」后弹「理智不足」对话框，Fight 链失败，Copilot 也被弹窗挡住；全程**不消耗理智**。
处理顺序：① `ark_status` 看理智、`ark_data(kind=stage)` 看关卡理智；② `ark_diag(action=screen)` 确认弹窗；
③ 让用户决定：等自然恢复 / 用理智药 / 用源石；④ 用户同意后才传 `medicine=N` 或 `useSanityPotion=true`。
链失败后插件会用 adb BACK 关闭挡住的弹窗，不要因此反复重试消耗时间。

## 7. 公招：analyze vs execute

- `ark_recruit(mode=analyze)`：只读，返回标签组合与可能的干员、星级；可反复调用，不消耗许可。
- `ark_recruit(mode=execute)`：真正招募，消耗招聘许可；属于需要确认的动作，且受 `safety.allowRecruitPermits` 硬闸。
- 看见高星组合先 `analyze` 给用户看，用户确认要招募后再 `execute`；`expedite=true`（加急许可）同理。

## 8. 基建 / 信用 / 领取

- 基建：`ark_infrast` 换班/无人机；`NotEnoughStaff` 表示可用干员不足，别硬跑，减设施或换心情够的干员。
- 信用：`ark_mall` 购买，`reserveMaxCredit` 保底、`onlyDiscount` 只买打折；先出计划再确认。
- 领取：`ark_award` 只读/低风险，可直接执行日常、邮件、每日单抽等；`ark_daily(tasks=award)` 也走两步确认。
- 以上都属于会改变账号状态的动作：先计划、后确认，失败如实报告，不要静默重试消耗资源。

## 9. 仓库与干员盒（耗时）

`ark_box` 通过 MAA 识别仓库 / 干员盒，单次可能 **5–20 分钟**（配置项 `box.operboxTimeoutMs` /
`depotTimeoutMs` 默认 120 万毫秒）。不要并发跑其他会动 MAA 的动作；部分识别（`partial=true`）
不会覆盖完整快照。日常里 `daily.box.enabled` 默认关闭，别擅自动它。

## 10. 数据来源与掉率公式

| 来源 | 用途 |
|---|---|
| MAA `resource/stages.json`、`item_index.json`、`recruitment.json`、`config.json`、`version.json` | 关卡/材料/公招/包名/版本（离线、权威） |
| ArkRec `wiki.arkrec.com` | 关卡中文名、章节、突袭条件、少人纪录（失败只影响显示） |
| penguin-stats | 材料掉率矩阵（7 天缓存） |
| MAA StageActivityV2 | 活动/复刻关卡时间窗（6 小时缓存） |
| PRTS | 干员档案、机制资料（5 分钟缓存） |

掉率口径：`dropRate = quantity / times`；`expectedSanity = apCost * times / quantity`。
只统计长期开放或已开始的阶段；`times < 阈值`（默认 50）标 `lowSample=true`，规划时提示但不排除。
期望理智是长期平均，不是保底；活动关卡可能没有 `apCost`，此时 `expectedSanity=null`。

## 11. 错误码表

| 码 | 含义 | 第一反应 |
|---|---|---|
| `E_STAGE_UNKNOWN` | 关卡代码不认识 / 未解锁 | `ark_data(kind=stage)` 核对；推关时它＝到达进度边界 |
| `E_NO_SOLUTION` | 该关没有可抄作业 | `ark_solutions` 换 id、`file=` 本地作业、或用户手动打一局 |
| `E_OPER_MISSING` | 作业要求干员不满足 | 换作业或手动打；不要硬跑 |
| `E_CONNECT` | adb/模拟器/MaaCore 连不上 | `ark_diag(action=device)` → `emulator start` → 重试 |
| `E_TIMEOUT` | 卡住 / 超时 | `ark_diag(action=screen)` 看画面，`ark_stop` 后重试 |
| `E_BUSY` | 已有动作在跑 | 等结束或 `ark_stop`，不要并发硬打 |
| `E_PYTHON_NOT_FOUND` | 全局插件找不到 Python | 检查 `.dsh` 运行时或 `pythonPath` |
| `E_MAA_NOT_FOUND` | 没有 MaaCore.dll | `ark_diag(action=probe)` 看试过路径，配置 `maaPath` |
| `E_NOT_READY` | 环境未就绪 | `ark_status` + `ark_diag(action=probe)` |
| `E_UNSAFE_RESOURCE` | 安全闸拒绝资源消耗 | 这是有意的：先取得用户明确同意再开开关/传参 |
| `E_PREFLIGHT` | 预检未通过 | 看返回的 planned/notes，别绕过 |
| `E_BOX_TIMEOUT` | 仓库/干员识别超时 | 确认游戏在前台，或改用 `target=operbox` |
| `E_NO_PERMIT` | 没有招聘许可 | 停手，告诉用户；不要用源石换许可 |
| `E_DATA_UNAVAILABLE` | 在线数据不可用且无缓存 | 打关卡不依赖在线数据，可继续 |
| `E_PROTOCOL_VERSION` | 侧车协议版本不匹配 | 重装插件或重启 DSH |
| `E_SOLUTION_INVALID` | 作业文件不可用 | 换 copilotId / file，确认 UTF-8 无 BOM |

## 12. battle-start 失败诊断（16-16 这类）

现象：`ark_fight` 返回 `diagnosis.code=battle-start-timeout`，message 类似「没有进入关卡详情，
卡在『开始行动』之前」；任务链停在 `BattleStartAll` / `BattleStartPre` / `StartButton1/2`。

为什么拿 `16-16` 举例：它的显示代码与内部 id 有章号偏移（`main_16-15`），又常被要求用磨难/险地
（`tough` + `-HARD`）。难度未开放、关卡未解锁、导航名不对、画面被公告/弹窗挡住时，MAA 都会停在
「开始行动」之前——**这时候不是重试能解决的**，按下面顺序取证据：

1. `ark_status`：看 `lastRun.diagnosis` 的 `code/evidence/screenshot`；
2. `ark_data(kind=stage, q="16-16")`：核对代码、难度是否开放、账号是否解锁；
3. `ark_diag(action=logs, level=warn, lines=120)`：找 `BattleStartAll` / `StageQueueStageNotFound` / `UnsupportedLevel`；
4. `ark_diag(action=screen)`：看画面到底是关卡详情、公告、还是活动入口；
5. `ark_diag(action=device)`：adb 在线、16:9、游戏在前台。

处理：`stage-not-found`/`UnsupportedLevel` → 换对代码或确认未解锁，推关时这就是边界；难度未开放 →
先 `difficulty=easy/auto` 验证；`sanity-insufficient` → 按 §6 处理；`oper-missing`/`copilot-file` → 换作业；
`connection` → 修链路。若画面停在不该点的弹窗上，先向用户说明，再用 `input_*` 或让用户手动点到主界面，
**不要盲目连点或反复开打**。诊断里给了 screenshot 路径就保留，别删现场。

## 13. 配置位置与重启

- 打关/日常配置：`%USERPROFILE%\dsh-bundles\arknights\cordis.patch.yml`（安装副本；改仓库同一路径的文件不会被读取）。
- 预设/白名单/persona：`%USERPROFILE%\dsh-bundles\arknights-agent\cordis.patch.yml`；预设工具入口是
  `file:///…/dsh-bundles/arknights/lib/preset/index.js?v=3`，改代码后要 bump `?v=N`。
- skill：仓库源文件 `dsh-arknights/skill/SKILL.md`，安装副本 `%USERPROFILE%\.agents\skills\arknights\SKILL.md`。
- 改配置：插件页把对应 bundle 关开一次（或重载）即可；**改 lib/ 代码、改 preset、改 agent persona 必须重启 DSH**
  （Host 缓存 ESM，只重载会继续用旧模块）。预设激活现场：`%TEMP%\arknights-preset-activation.json`。
- 只改这三处 bundle patch；不要改 Profile、不要改 MAA 自身配置、不要动游戏安装目录。

## 14. 汇报与硬规则

- 每次行动汇报三件套：做了什么、结果（stars / 掉落 / 理智 / 耗时）、下一步建议。
- **只有拿到 `stars=3` 才能说「满星 / 已通关」**；没到 3 星就照实说差几星、缺什么，不许美化或推断。
- 严格按用户给的关卡与次数执行：不猜关、不自动换关、不擅自加次数；用户没说清就先问。
- 结论只来自工具返回与事件（`StageDrops.stars`、`TaskChainError` 等）；不确定就说不确定。
- 同一时间只允许一个会动 MAA 的动作；遇到 `E_BUSY` 先 `ark_status` 或 `ark_stop`。
- 排查顺序固定：`ark_diag(screen)` → `ark_diag(logs)` → `ark_diag(device)` → `ark_diag(probe)`。

## 15. 不做的事

- 不猜关、不自动换关、不擅自加次数、不把「大概」的关卡拿来开打。
- 不擅自使用理智药、至纯源石、招聘许可、加急许可；不在用户没点头时 `confirm=true`。
- 不并发跑多个会动 MAA 的动作；不在 `E_BUSY` 时强行再来一次。
- 不手工拼作业站列表里的截断 `content`，不把列表内容直接交给 MAA。
- 不自动更新 MAA 资源、不修改 MAA 配置、不改 DSH Profile、不动游戏安装目录与游戏文件。
- 不编造掉落/星级/掉率；在线数据不可用就如实说「缓存/降级」，打关卡照常进行。
- 不代替用户做资源消耗的决定；不承诺超出工具能力的效果（AI 视觉代打、自动过图、破解等）。

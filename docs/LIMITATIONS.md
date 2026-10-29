# 已知限制与取舍（`@local/arknights` v1.0）

本文记录「为什么只能这样做」以及「什么情况下会失败」，避免以后把限制当 bug 排查。

## 1. 代理指挥与抄作业

- **代理指挥只在「满星 且 未借干员通关」之后可用**（游戏规则，非插件限制）。
- 没有代理时 MAA 会在点击开始行动前 Stop（`StageQueueUnableToAgent*`），**零理智消耗**；
  插件据此自动改走 Copilot。抄作业是让未满星关变满星的唯一手段，插件不自带战斗 AI。
- 多份作业会逐份尝试；全部失败时给 `E_NO_SOLUTION` 与诊断，不盲目反复打。

## 2. 作业站与难度

- 作业站 `document=<关卡代码>` 查询会混返多难度；插件按基础关卡匹配，难度靠 MAA 导航参数强制：
  `Fight` 用 `-NORMAL/-HARD`，`Copilot` 用 `nav_name_override` + `is_raid`。
- 列表接口的 `content` 是截断版（没有 actions），必须 `/copilot/get/<id>` 取完整作业；插件已内置。
- 作业文件必须 UTF-8 无 BOM；`ignore_requirements` 默认 true，干员不满足时由游戏内编队决定成败。
- 作业站不可达/限流：用缓存或报三条人工出路（`copilotId` / `file` / 手动打一局），不会阻塞代理刷关。

## 3. 关卡数据

- 代码 ↔ 内部 id 来自 MAA `resource/stages.json`；MAA 更新资源后才有新关卡。
- 活动/复刻关（`SSReopen-XX`、当期 SS 后三关、剿灭）可能不在关卡表里，按 MAA 活动 API 的值导航；
  计划里会标 `activity=true`。
- 中文名/突袭条件来自 ArkRec，不可用时只影响显示。
- 至纯源石每关跨难度只发一颗；账本按关卡代码去重。账本说已满星仍可按用户要求再打。

## 4. 理智不足

- 关卡理智 > 当前理智时，点开始行动会弹「理智不足」，Fight 失败并把界面留在弹窗；
  插件用 adb BACK 清弹窗，并在诊断里写「可能理智不足」。
- 插件**不会自己**决定用理智药/至纯源石；`safety.*` 默认全 false，显式传参也会被拒，必须用户同意后开配置。
- 理智只能从 MAA 的 `SanityBeforeStage` 事件拿到；没打过关时显示「未知」。

## 5. 日常与仓库

- `ark_daily` 每项用独立链：一项失败不会中断后续；结果逐项记录，`skipDone` 默认按本地日期跳过已完成项。
- 公招 `analyze` 用 `times=0, confirm=[], select=[]`，只识别当前槽位，不消耗招聘许可；
  多槽位识别/刷新需要 `mode=execute` 并显式确认。
- 仓库/干员识别（Depot/OperBox）是逐屏 OCR，耗时分钟级；面板显示运行态，超时报 `E_BOX_TIMEOUT`。
- 基建自定义排班（mode=10000）只透传 MAA 的 `filename`/`plan_index`，不内置排班编辑器。

## 6. 数据与网络

- ArkRec/penguin/活动/作业站都是第三方；失败只降级，不阻塞本地动作。
- Penguin 掉率是玩家上报统计，不是官方概率；期望理智是长期平均，不是保底。
- 活动关卡的 `apCost` 可能缺失，规划时 `expectedSanity` 为 null。

## 7. 环境

- 只在 Windows + MAA 6.21 + MuMu 12 验证；其它模拟器要手改 `connectionConfig`/`adbPath`。
- Python 用 `.dsh` 运行时自带的解释器；Store 版 `python.exe` 占位符会被跳过。
- MAA GUI 同时跑可能竞争 adb/资源；插件只告警，不杀进程。
- 改 `lib/` 代码后**必须重启 DSH**（Host 缓存 ESM）；只改配置可关开插件一次。

## 8. 未做 / 非目标

- 生息演算、保全派驻、悖论模拟、小游戏、账号切换、多开模拟器、AI 视觉代打、MAA 资源自动更新、基建排班编辑器。
- 不修改 profile 配置、MAA 自身配置、游戏文件。
- PRTS 只读、无编辑/登录；干员详情用 `prts_operator`/`prts_page`，不在本插件内嵌 Wiki 浏览器。

## 9. 面板

- 视觉与交互在重启 DSH 后验收；跨分辨率、窄宽度、其它主题的观感未逐一验证。
- 面板只通过 `/arknights/status`、`/arknights/query`、`/arknights/action` 与 Host 交互，不直接读文件/调 MAA。

# 已知限制与取舍（`@local/arknights`）

本文记录「为什么只能这样做」以及「什么情况下会失败」，避免以后把限制当 bug 排查。

## 1. 代理指挥与抄作业

- **代理指挥（自动部署）只在「满星 且 未借干员通关」之后可用**（游戏规则，非插件限制）。
- MAA 的 Fight 任务在没有代理指挥时会识别到「无法代理」，并在**点击开始行动之前**直接 Stop
  （`resource/tasks/tasks.json` 里 `ResourceStageLevel* → ["UnableToAgent","UnableToAgent2","Stop"]`）。
  所以：
  - 对未满星的关，`Fight` 打不了，插件会自动改走 **Copilot 抄作业**（真正部署干员）；
  - 这个「被拦下」发生在开战前，所以**零理智消耗**，可以放心用来判断某关能否代理。
- 抄作业是唯一能让未满星关变成满星的手段；插件不自带任何战斗 AI。

## 2. 作业站（prts.maa.plus）

- 作业站的 `document=<关卡代码>` 查询会**混返多个难度**（`main_` / `easy_` / `tough_`，或干脆只写关卡代码）；
  插件按「基础关卡」匹配（显示代码 / 内部 id / 后缀三者之一），难度靠 MAA 的导航参数强制：
  - `Fight`：关卡名加 **`-NORMAL` / `-HARD`** 后缀（MAA 集成文档：10-14 章 = 标准/磨难，**15 章及以后 = 常规/险地**）；
  - `Copilot`：同样给 `nav_name_override: "<关卡>-HARD"` 并置 `is_raid: true`。
- 只有 `difficulty=tough` 才会用 `tough_*` 作业；`auto`/`easy` 一律排除，避免跑错难度。
- 作业要求写入本地时必须是 **UTF-8 无 BOM**，否则 MAA 解析失败。
- 作业站不可达、限流或接口变更时：插件会缓存已下载的作业，并在错误里给人工出路
  （`copilotId=` / `file=` / 自己手动打一局 / ArkRec 参考链接），**不会盲目开打**。
- `ignore_requirements` 默认 `true`：干员不满足时由游戏内实际编队决定成败；
  失败会报 `E_NO_SOLUTION` 并尽量指出缺哪个干员。

## 3. 关卡数据

- 关卡代码 ↔ 内部 id 的映射来自 MAA 的 `resource/stages.json`；MAA 更新资源后才会出现新关卡。
  缺新关时先启动一次 MAA 主程序更新数据，或直接传内部 id（如 `main_05-10`）。
- `stages.json` 里同一个代码可能对应多个难度（`main_` / `easy_` / `tough_`）；
  `difficulty=auto` 优先简单/普通，`tough` 会直接走抄作业。
- 中文关卡名、章节、突袭条件来自 ArkRec（少人WIKI）。它不可用时只影响显示，不影响打关卡。
- 至纯源石：**每个关卡代码跨难度只发一颗**，账本按关卡代码去重，所以账本说「已满星」时
  仍会按你的指令再打，只是不会重复推荐。

## 4. 理智不足

- 关卡需要 24 理智而当前只有 13 时，点「开始行动」会弹出「理智不足」对话框；
  MAA 的 Fight 在 `medicine:0 / stone:0` 下不会替你做选择，链会失败，**界面停在弹窗上**。
- 插件现在的处理：
  - `ark_fight` 支持 `medicine=<N>`（Fight 的理智药数）与 `useSanityPotion=true`（抄作业时自动用理智药）；
  - 任何 Fight/抄作业链失败后都会用 adb BACK 关掉挡住的弹窗，再继续下一份作业；
  - 错误里会写明「关卡需要多少理智、可能是理智不足」。
- **插件不会自己决定消耗理智药/源石**：这两种都要显式传参。

## 5. 环境

- 只在 Windows + MuMu 12（本机默认 adb 端口 16384、1920×1080）验证。
- Python 用 `.dsh` 运行时自带的解释器（本机 3.12.14）；Microsoft Store 的 `python.exe`
  是占位符，探测阶段会被跳过。
- MAA 与 MAA GUI 同时跑时资源/adb 可能竞争，插件只告警、不杀进程。
- 模拟器冷启动 + 游戏登录可能要 1–3 分钟，`connectTimeoutMs`（默认 120s）与
  `emulator.launchTimeoutMs`（默认 120s）不够时请调大。
- `lib/sidecar/selftest.py` 不再内置机器路径：用 `--maa-path` 或 `DSH_ARKNIGHTS_MAA_PATH`
  指定；`test/run-selftest.mjs` 会自动探测后传参。

## 6. 未验证 / 已知取舍

- **面板**：已在本机真机截图核对（侧栏入口、状态轮询、按钮/提示文案、`POST /arknights/action`
  四类动作联动），跨机器/跨主题的观感未逐一验证。
- **视频兜底（`ark_fight video=`）**：已实现（`lib/video.js` + `runner.js` + `tools/fight.js`），
  但属 **best-effort** —— MAA 文档只写了 `VideoRecognition{filename}` 入参，没写作业 JSON 的交付方式，
  插件按「回调事件 / 新出现的作业 JSON」两条路拾取；本机没有合适的作战录屏，**未做真机端到端验证**。
  拿不到作业会报 `E_NO_SOLUTION` 并提示改用 `file=`。
- 未实现：日常一条龙、基建/公招/信用/领奖、关卡扫描、AI 视觉代打、资源自动更新。
- 预设作用域 7 个工具（`ark_stages` 等）不持有 MaaCore 会话，只走 adb/MuMuManager/本地文件；
  需要 MAA 的动作仍由全局 5 个工具负责。

# v1.0 验收清单（重启 DSH 后执行）

> 本轮代码、离线测试与真机零理智动作在重启前完成；页面视觉与新工具注册必须在**重启 DSH** 后验证。
> 证据统一放到 `.admin/verify-2026-10-29/`（截图、命令输出、`ark_status` JSON）。

## 0. 前置

- 安装副本已同步：`%USERPROFILE%\dsh-bundles\{arknights,arknights-agent,prts}`；
- skill 已复制：`%USERPROFILE%\.agents\skills\arknights\SKILL.md`；
- 已重启 DSH（关闭窗口再打开，或退出应用重进）；
- 模拟器已开机、游戏已登录。

## 1. 工具与预设

1. 新开普通会话：`ark_` 工具应为 **13** 个（status/fight/push/rogue/daily/recruit/infrast/mall/award/box/data/plan/stop），`prts_` 为 **10** 个。
2. 新开会话选「明日方舟」预设：额外出现 `ark_diag` / `ark_solutions`，共 **15** 个 `ark_*`；无关工具被屏蔽。
3. `ark_status` 应显示 MAA 版本（6.21）、协议 2.0.0、模拟器/连接、账本与日常；**不**应拉起侧车/模拟器（侧车未启动时显示“未启动侧车”）。

## 2. 零理智动作（不消耗理智/源石/招聘许可）

逐项记录工具调用与结果：

| # | 动作 | 期望 |
|---|---|---|
| 1 | `ark_status` | 链路信息完整；无副作用 |
| 2 | `ark_diag action=probe` | 重新探测 MAA/Python/MuMu/adb 路径 |
| 3 | `ark_diag action=screen` | 返回 PNG 路径；`read_image` 能看到游戏画面 |
| 4 | `ark_diag action=device` | adb 设备、分辨率、机型、前台包名 |
| 5 | `ark_box target=operbox` | 识别完成，`box.json` 有干员；可能耗时数分钟 |
| 6 | `ark_box target=depot` | 识别完成，`box.json` 有物品 |
| 7 | `ark_recruit mode=analyze` | 返回当前槽位 tags + 组合；**不**消耗招聘许可 |
| 8 | `ark_award` | 领取免费奖励；不需要 confirm |
| 9 | `ark_mall` | 先 confirm=false 看计划；确认后访问好友/购物（花信用点） |
| 10 | `ark_infrast` | 先 confirm=false 看计划；确认后换班 |
| 11 | `ark_data kind=stage q=1-7` | 关卡/理智/掉落/掉率（缓存可用） |
| 12 | `ark_data kind=activity` | 活动/复刻时间窗 |
| 13 | `ark_plan targets="固源岩:10"` | 最佳关卡 + 期望理智 |
| 14 | `ark_fight stages=16-16 difficulty=tough confirm=false` | 只出计划 + 预检；**不执行**；若引用上次失败，应给分类诊断 |
| 15 | `ark_stop` | 在 `ark_box` 中途调用能中止；状态回到空闲 |

**判失败**：任何一项消耗理智、至纯源石、招聘许可；或工具报未捕获异常。

## 3. 面板

1. 侧栏「明日方舟」入口可见；点击打开六页：总览 / 战斗 / 日常 / 资料 / 仓库 / 设置。
2. 总览显示连接、理智（最后识别时间）、当前/最近 run、账本、今日日常。
3. 战斗页：输入关卡 → 「预览」出计划（零消耗标）→ 「确认执行」按钮出现；`ark_fight` 计划不实际开打。
4. 日常页：签到/信用/基建/公招开关；公招分析显示 tags/组合；运行中显示 spinner + 停止。
5. 资料页：关卡/材料搜索、掉率表、活动、材料规划器。
6. 仓库页：干员稀有度网格 + 仓库 Top（`GET /arknights/query?kind=box`）。
7. 设置页：路径/缓存年龄/安全开关只读。
8. 截图保存到 `.admin/verify-2026-10-29/panel-*.png`；明暗主题各一张（若可切换）。

## 4. 迁移与安全

1. 备份并复制真实 `progress.json` 到临时目录，运行迁移测试：`v1 → v2`，生成 `.v1.bak`，数据不丢。
2. 未 `confirm` 的 fight/push/rogue/daily/infrast/mall 不产生 MAA `append/start`（看 `history.jsonl` 与 MAA 任务链）。
3. `medicine=1` / `stone=1` / `recruit mode=execute` 在 safety 默认 false 时被拒（`E_UNSAFE_RESOURCE`）。
4. `/arknights/status` 与 `/arknights/query` 不拉起侧车/模拟器（侧车未启动时调用仍返回）。

## 5. 证据

- 工具输出/错误：文本追加到 `.admin/redevelop-record-2026-10-29.md`；
- 面板与游戏截图：`.admin/verify-2026-10-29/`；
- 失败项：记录工具/参数/错误码/截图路径，修复后重跑本清单。

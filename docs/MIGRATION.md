# 从 0.2.0 迁移到 1.0.0

v1.0 是**产品级重开发**：保留 `ark_` / `prts_` 前缀与已发布的三个仓库，但工具面、面板、账本与配置有变化。
本文给出「旧 → 新」对照与回滚方式。

## 1. 工具改名 / 合并

| 0.2.0 | 1.0.0 | 说明 |
|---|---|---|
| `ark_stages`（预设） | `ark_data`（全局） | `kind=stage/item/operator/activity/search`，离线优先 |
| `ark_screen`（预设） | `ark_diag`（预设） | `action=screen` |
| `ark_device`（预设） | `ark_diag`（预设） | `action=device` |
| `ark_game`（预设） | `ark_diag`（预设） | `action=game`（start/stop） |
| `ark_emulator`（预设） | `ark_diag`（预设） | `action=emulator`（status/start/stop） |
| `ark_log`（预设） | `ark_diag`（预设） | `action=logs` |
| `ark_solutions`（预设） | `ark_solutions`（预设） | 保留，输出更结构化 |
| `ark_fight` | `ark_fight` | 参数保留并扩展 `series` / `drops` / `stone` |
| `ark_push` / `ark_rogue` / `ark_status` / `ark_stop` | 同名 | 行为加固 |
| — | `ark_daily` / `ark_recruit` / `ark_infrast` / `ark_mall` / `ark_award` / `ark_box` / `ark_plan` | 新增日常与资料 |

预设会话：全局 13 个 + `ark_diag` / `ark_solutions` 2 个 = 15 个；PRTS 10 个。

## 2. 账本

`%LOCALAPPDATA%\dsh-arknights\progress.json` 首次读取时自动 `v1 → v2`：

- 备份 `progress.json.v1.bak`（只写一次；已存在不覆盖）；
- 原有 `stages/push` 字段保留；新增 `difficulty/lastFailure/attempts/daily`；
- 解析失败 → 原文件改名 `progress.json.corrupt-<时间戳>`，从空账本开始并告警；
- 旧字段 `failures[]` 保留为历史数组；新失败同时写 `lastFailure`。

新增 `box.json`（仓库/干员快照）与 `history.jsonl`（最近 200 次 run）。两者都可以删；删了只丢历史，不影响打关卡。

## 3. 配置

v1 的 `cordis.patch.yml` 键全部保留。新增（默认值见文件）：

- `safety.*`：理智药/至纯源石/招聘许可/加急许可的硬闸，**默认全 false**。旧行为里 `medicine=N` 会直接用；现在必须先打开 `safety.allowSanityPotion`，否则 `E_UNSAFE_RESOURCE`。
- `daily.*`、`box.*`、`history.*`、`penguin.*`、`activity.*`、`startup.*`。
- `copilot.ignoreRequirements`（默认 true）、`rogue.squad/roles/coreChars/difficulty/params`。

配置写错只会回退默认值，不会让插件装不上。

## 4. 预设与 skill

- 预设 `preset-arknights` 升 1.0.0，工具行 URL 的 `?v=2` 改为 `?v=3`；旧会话保留旧插件 revision，**新会话**才看到新工具。
- `~/.agents/skills/arknights/SKILL.md` 全量替换为 v2；仓库源文件 `dsh-arknights/skill/SKILL.md`。
- 预设激活现场仍是 `%TEMP%\arknights-preset-activation.json`。

## 5. 面板

`client.js` 重写为六页（总览/战斗/日常/资料/仓库/设置）；HTTP 增加 `GET /arknights/query`，`POST /arknights/action` 改为长任务立即返回 `runId`（面板轮询），响应带 `status` 快照。旧面板与 0.2.0 Host 不兼容，必须一起升级。

## 6. 升级步骤

1. 备份安装副本（见 `%USERPROFILE%\dsh-bundles\.backup-2026-10-29\`）；
2. 仓库 → 安装副本：`robocopy <repo> %USERPROFILE%\dsh-bundles\arknights /MIR /XD .git test node_modules`（agent / prts 同理）；
3. 复制 skill 源到 `%USERPROFILE%\.agents\skills\arknights\SKILL.md`；
4. **重启 DSH**（Host 缓存 ESM；只重载插件不会读新代码）；
5. 新会话运行 `ark_status` 与 `ark_diag action=probe`，确认工具数与链路；
6. 需要时在 `cordis.patch.yml` 打开 safety 开关（默认保持关闭）。

## 7. 回滚

- 三仓基线 tag：`dsh-arknights v0.2.0`、`dsh-arknights-agent v0.1.0`、`dsh-prts v0.1.0`；
- 安装副本备份：`%USERPROFILE%\dsh-bundles\.backup-2026-10-29\{arknights,arknights-agent,prts}`；
- 回滚：`git reset --hard <tag>` + 恢复对应备份目录 + 重启 DSH；
- 账本迁移不删数据；回滚到 0.2.0 时它会忽略 v2 新字段（`version` 仍可读）。

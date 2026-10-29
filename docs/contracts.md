# `@local/arknights` 内部契约 v2（1.0.0）

本文件是 Plugin（Node）、Sidecar（Python）、面板（Client）三者之间的**唯一接口约定**。
任何一侧改字段，必须同时改这里、`lib/contracts.js` 与对应测试。

版本：2.0.0 ｜ 最后更新：2026-10-29

---

## 1. 进程拓扑

```
DSH Host（Electron/Node, ESM）
  ├─ lib/index.js ── tools / commands / webServer
  ├─ lib/actions/** ── run store（单飞）──► lib/maa-session.js
  │                                              └─ spawn python.exe -u lib/sidecar/maa_sidecar.py
  │                                                     stdin/stdout = NDJSON；stderr = 自由日志
  │                                                     └─ ctypes ──► MaaCore.dll
  ├─ lib/state.js ── 事件环形缓冲 + 派生状态
  ├─ lib/ledger.js / box / history ── 本地数据
  └─ lib/data/** ── MAA resource / ArkRec / penguin-stats / StageActivityV2（只读缓存）
```

- 常驻**一个** sidecar；MaaCore 是进程级单例。
- 同一时间只允许**一个**会动 MAA 的 run（`E_BUSY`）；`status/data/plan/solutions` 只读可并发。
- sidecar 退出 → 下次调用透明重启；`stop` 请求优先于普通请求。

## 2. Sidecar 线路协议 2.0（NDJSON，UTF-8，`\n` 分隔）

### 2.1 启动握手

sidecar 启动后立刻输出一行：

```json
{"event":"ready","sidecarVersion":"2.0.0","protocolVersion":"2.0.0","python":"3.12.14","platform":"win32"}
```

Node 校验 `protocolVersion` 主版本一致；不一致报 `E_PROTOCOL_VERSION`。

### 2.2 请求 / 响应

```json
{"id":1,"op":"init","args":{"maaPath":"D:\\MAA","userDir":"C:\\...\\maa","touchMode":"minitouch","deploymentWithPause":false}}
{"id":1,"ok":true,"result":{"coreVersion":"v6.21.0-beta.2","resourceLoaded":true,"protocolVersion":"2.0.0"}}
{"id":1,"ok":false,"error":{"code":"E_MAA_LOAD","message":"MaaCore.dll 加载失败","detail":"..."}}
```

- `id` 原样回传；未知 op → `E_BAD_OP`。
- stdout 只允许协议行；所有 `print` 写 stderr。
- 行长度上限 8 MiB；超限报 `E_PROTOCOL` 并重启。

### 2.3 异步事件

```json
{"event":"maa","seq":42,"code":10002,"name":"TaskChainCompleted","details":{"taskchain":"Fight"},"ts":"2026-10-29T11:00:00.123Z"}
```

- `seq` 单调递增；`details` 是 MAA 回调 JSON 的解析结果（失败时 `{}` + `detailsRaw`）。
- 事件与响应可无序交错。

### 2.4 操作一览

| op | args | result | 备注 |
|---|---|---|---|
| `init` | `maaPath,userDir,touchMode,deploymentWithPause,gpuOcr?` | `{coreVersion,resourceLoaded,protocolVersion}` | 幂等 |
| `connect` | `adbPath,address,config,clientType` | `{connected:true}` | 阻塞，可能 10s+ |
| `append` | `type,params` | `{taskId}` | `taskId<=0` → `E_TASK_TYPE` |
| `setParams` | `taskId,params` | `{ok:true}` | `AsstSetTaskParams` |
| `start` | — | `{running:true}` | |
| `stop` | — | `{running:false}` | 清空任务链 |
| `running` | — | `{running:bool}` | |
| `connected` | — | `{connected:bool\|null}` | 无符号时 `null` |
| `version` | — | `{coreVersion}` | |
| `ping` | — | `{pong:true,inited}` | 不碰 MAA |
| `screenshot` | `format?:"png"` | `{path,width,height,bytes}` | `AsstGetImage`；不可用 → `E_NOT_SUPPORTED` |
| `backHome` | — | `{ok:true}` | `AsstBackToHome` |
| `tasks` | — | `{taskIds:number[]}` | `AsstGetTasksList`（可选） |
| `destroy` | — | `{destroyed:true}` | |

生命周期：`init` 前其它 op → `E_NOT_INIT`；stdin EOF → `AsstDestroy` → 退出码 0。

## 3. 事件归一化（`lib/state.js`）

MAA `code` 映射见 §6 表。派生状态：

- `tasks.current` / `chains[]`：最近 `TaskChainStart` 且未结束的链。
- `sanity {current,max}`：最近 `SanityBeforeStage`。
- `stars`：最近 `StageDrops.stars`；`drops`：`StageDrops.stats[]` 累计。
- `branch`：最近 `UnableToAgent*`。
- 领域事件：`recruit.tags/result/refreshed/noPermit`、`infrast.*`、`depot`、`operbox`、`copilot.precheck`、`stage.info/unsupported`、`chain.extra`、`connection.*`。
- 环形缓冲 500；状态 JSON 只带 10 条（无 `details`）。

## 4. Run 信封

所有会动 MAA 的动作返回：

```json
{
  "runId": "run-...",
  "kind": "fight",
  "status": "planned|running|completed|partial|failed|stopped",
  "planned": [{"stage":"16-16","difficulty":"tough","times":1,"sanity":21,"note":"..."}],
  "executed": [{"stage":"16-16","stars":3,"sanity":21,"drops":[{"itemId":"30061","itemName":"…","quantity":2}],"method":"copilot","solutionId":108079}],
  "totals": {"sanity":21,"stages":1},
  "events": [{"seq":1,"name":"TaskChainCompleted","task":"Fight"}],
  "diagnosis": {"code":"battle-start-timeout","message":"…","evidence":["…"],"screenshot":"…"},
  "text": "给人看的总结"
}
```

- `planned` 只在计划/预检时出现；`executed` 只在真正执行后出现。
- 工具返回 `text`；HTTP 返回完整 JSON。
- `ark_status` 的 `run/lastRun` 是同一信封的精简版（去掉大数组）。

## 5. 状态 JSON（`GET /arknights/status`）

```json
{
  "ok": true, "schema": 2, "ts": "…",
  "sidecar": {"alive":true,"inited":true,"pid":1,"coreVersion":"…","resourceLoaded":true,"protocolVersion":"2.0.0"},
  "paths": {"maaPath":"…","pythonPath":"…","adbPath":"…","userDir":"…","ledgerFile":"…","boxFile":"…","historyFile":"…"},
  "emulator": {"managerFound":true,"running":true,"androidStarted":true,"adbOnline":true,"vmIndex":0,"name":"…"},
  "connection": {"connected":true,"address":"127.0.0.1:16384","config":"MuMuEmulator12","clientType":"Official"},
  "tasks": {"running":false,"current":null,"chains":[]},
  "sanity": {"current":100,"max":135,"at":"…"},
  "drops": {"固源岩":12},
  "run": {"id":"…","kind":"fight","status":"running","startedAt":"…","updatedAt":"…","phase":"battle"},
  "lastRun": {"id":"…","kind":"daily","status":"completed","startedAt":"…","endedAt":"…","result":{}},
  "ledger": {"fullStar":3,"missing":2,"primeClaimed":3,"entries":[]},
  "push": {"nextStage":"5-11","lastStopped":"5-11","lastReason":"…"},
  "daily": {"date":"2026-10-29","tasks":{"award":{"ok":true,"at":"…"},"mall":{},"infrast":{},"recruit":{}}},
  "box": {"operators":0,"depotItems":0,"updatedAt":"…","partial":false},
  "data": {"stages":608,"items":482,"arkrec":{"ok":true,"ageMs":0},"penguin":{"ageMs":0},"activity":{"ageMs":0},"warnings":[]},
  "errors": {"lastCode":null,"lastMessage":null,"at":null},
  "safety": {"confirmRequired":true,"dryRun":false,"allowSanityPotion":false,"allowOriginitePrime":false,"allowRecruitPermits":false,"allowExpedite":false},
  "events": [], "config": {"defaultDifficulty":"auto","dryRun":false,"confirmRequired":true}
}
```

硬约束：无凭据；`events` 最多 10；`ledger.entries` 最多 30；生成过程**绝不**拉起 sidecar/模拟器/执行 MAA 调用。

## 6. MAA 消息码表

| code | name |
|---|---|
| 0/1/2/3/4/5 | InternalError / InitFailed / ConnectionInfo / AllTasksCompleted / AsyncCallInfo / Destroyed |
| 10000/10001/10002/10003/10004 | TaskChainError / Start / Completed / ExtraInfo / Stopped |
| 20000/20001/20002/20003/20004 | SubTaskError / Start / Completed / ExtraInfo / Stopped |
| 30000 | ReportRequest |

常用 `details.what`：`StageDrops`、`NotThreeStars`、`SanityBeforeStage`、`StageQueueUnableToAgent*`、`StageQueueStageNotFound`、`CopilotPrecheckFile`、`BattleFormationOperbox1Unmatched`、`RecruitTagsDetected`、`RecruitResult`、`RecruitTagsRefreshed`、`RecruitNoPermit`、`RecruitPermitReserved`、`EnterFacility`、`ProductOfFacility`、`NotEnoughStaff`、`DepotInfo`、`OperBoxInfo`、`UnsupportedLevel`、`RoutingRestart`。

## 7. 账本 v2 / 快照 / 历史

### 7.1 `progress.json`

```json
{"version":2,"updatedAt":"…","stages":{"5-10":{"code":"5-10","stars":3,"fullStar":true,"primeClaimed":true,
"difficulty":{"easy":{"stars":3,"at":"…"},"tough":{"stars":null,"at":null}},
"method":"copilot","solutionId":104178,"attempts":1,"lastRunAt":"…",
"lastFailure":null}},"daily":{"date":"2026-10-29","tasks":{}},"push":{}}
```

- 失败记录最多 20 条：`{at,code,message,detail?,screenshot?}`。
- 写入：临时文件 + rename；失败只告警。
- v1 → v2 迁移：先写 `progress.json.v1.bak`；解析失败 → `.corrupt-<ts>` 后从空账本开始。

### 7.2 `box.json`

```json
{"version":1,"updatedAt":"…","partial":false,
 "operators":{"all":[{"id":"char_103_angel","name":"能天使","rarity":6,"own":true}],"own":[{"id":"…","name":"…","elite":2,"level":90,"potential":1,"rarity":6}]},
 "depot":{"items":{"30061":{"name":"固源岩","count":12}}}}
```

部分识别（`done:false`）不覆盖完整快照。

### 7.3 `history.jsonl`

每行一个 run 信封精简版，最多 `history.maxEntries` 条（写满后重写保留最近 N 条）。

## 8. 配置 v2

见 `cordis.patch.yml`。要点：v1 键全保留；新增 `safety/daily/box/history/penguin/activity/startup`；`safety.*` 默认 false 是硬闸；`confirmRequired` 只影响需要确认的动作。

## 9. 工具面与确认矩阵

13 全局：`ark_status/fight/push/rogue/daily/recruit/infrast/mall/award/box/data/plan/stop`。
2 预设：`ark_diag/ark_solutions`。
10 PRTS：见 `dsh-prts`。

需要确认：`fight/push/rogue/daily/infrast/mall`；`recruit` 仅 `mode=execute`。无需确认：`status/award/box/data/plan/stop/solutions`。

资源消耗硬闸（默认拒绝）：`medicine>0`、`stone>0`、`useSanityPotion=true`、`expedite=true`、`recruit mode=execute`。

## 10. HTTP 与命令

- `GET /arknights/status`：§5。
- `GET /arknights/query?kind=…&q=&limit=&refresh=&targets=`：只读；默认只用缓存。统一形状
  `{ok:true, kind, items:[…], total?, truncated?, source?, ageMs?}`（`kind=drop/plan/box` 用专用字段，见下）。
  - `kind=stage`：`{code,name?,stageId?,chapter?,apCost?,activity?,drops:[{itemId,itemName,rate,expectedSanity,lowSample?}]}`
  - `kind=item`：`{id,name,usage?,rarity?,icon?}`
  - `kind=drop`：`q=<材料名/id>` → `{ok:true,kind:'drop',item:{id,name},items:[{code,name?,apCost,dropRate,expectedSanity,lowSample?}]}`
  - `kind=operator`：`{id,name,rarity,own?,tags?}`
  - `kind=activity`：`{name,start,end,expired,tip?,stages:[{display,value,drop?}]}`
  - `kind=search`：混排，每项带 `type:'stage'|'item'|'operator'`
  - `kind=solutions`：`{id,stage,title?,uploader?,rating?,opers?,isRaid?,difficulty?,available?}`
  - `kind=plan`：`targets="固源岩:10, 聚酸酯组:5"` → `{ok:true,kind:'plan',targets:[{itemId,itemName,count,best:{code,name?,apCost,dropRate,expectedSanity},alternatives:[…]}],totalExpectedSanity,warnings:[]}`
  - `kind=box`：`{ok:true,kind:'box',updatedAt,partial,operators:{own:[{id,name,rarity,elite,level,potential}],all?:[…]},depot:{items:[{id,name,count}]}}`；`target=operators|depot|both&limit=`。
- `POST /arknights/action`：`{action, …, confirm?, wait?}`。
  - 默认立即返回 `{ok:true,runId,started:true,text,status,result?}`；`wait:true` 等到 run 结束并把动作结果放进 `result`。
  - `confirm:false` 只回计划：`{ok:true,planned:true,plannedItems:[{stage,code?,difficulty,times,sanity,note?,cnName?,tier?,activity?}],plannedTotalSanity,text,status}`（无 runId）。
  - `stop` 回 `{ok:true,stopped:boolean,text,status}`；失败 `{ok:false,error:{code,message,hint?}}`。
  - 动作参数：`fight{stages,times,difficulty,medicine,stone,useSanityPotion,copilotId,file,video}`、`push{from,chapter,maxStages}`、`rogue{theme,mode,startsCount,squad,roles,coreChars,difficulty}`、`daily{tasks,skipDone,award,mall,infrast,recruit,box}`、`recruit{mode,times,confirmLevels,selectLevels,refresh,expedite,permitReserve,firstTags,preserveTags}`、`infrast{mode,facility,drones,threshold,customFile,planIndex}`、`mall{visitFriends,shopping,buyFirst,blacklist,onlyDiscount,forceWhenFull,reserveMaxCredit}`、`award{award,mail,dailyPull,orundum,mining,specialAccess,signInEvent}`、`box{target,refresh}`。
  - `result` 形状：`fight{planned,executed,totals}`、`recruit{tags,level,combos:[{tags,level,operators:[{id,name,rarity}]}]}`、`box{operators,depot,updatedAt,partial}`、`daily{tasks:{…}}`，其余动作 likewise 在各自 result 内给结构化结果。
- 只读路由绝不启动 sidecar/模拟器。
- `/ark status|fight|push|rogue|daily|recruit|infrast|mall|award|box|data|plan|stop`，`--yes`/`--dry`。

## 11. 错误码

见 `lib/errors.js`。新增关键码：`E_NOT_READY`、`E_UNSAFE_RESOURCE`、`E_DATA_UNAVAILABLE`、`E_PREFLIGHT`、`E_BOX_TIMEOUT`、`E_NO_PERMIT`、`E_TASK_REJECTED`、`E_PROTOCOL_VERSION`、`E_CACHE_CORRUPT`、`E_ACTION_UNKNOWN`。

失败分类码（`diagnosis.code`）：`no-agent | stage-not-found | battle-start-timeout | sanity-insufficient | oper-missing | copilot-file | connection | timeout | stopped | unknown`。

## 12. 数据层

- MAA `resource/stages.json`：`code/stageId/apCost/dropInfos[]`；按 `code` 与 `stageId` 双索引。
- `item_index.json`：`itemId → {name,icon,usage}`。
- `recruitment.json`：`operators[name] → {id,name,rarity,tags[]}`。
- ArkRec：`GET {api}/api/menu`（章节/中文名/突袭条件）、`/api/hard-operations`；缓存 7 天。
- penguin-stats：`GET {api}/PenguinStats/api/v2/result/matrix?server=CN&itemFilter=<id>`；掉率 = `quantity/times`，期望理智 = `apCost * times / quantity`；只统计 `end=null` 或已开始的阶段。
- StageActivityV2：活动/复刻关卡与时间窗；活动关卡允许不在 `stages.json` 里也能导航。
- 缓存目录：`cache/`、`cache/penguin/`、`arkrec/`、`copilot/`；失败降级，不阻塞本地动作。

## 13. 预设与 skill

- 预设 `preset-arknights`：工具行 `file:///…/dsh-bundles/arknights/lib/preset/index.js?v=3`；白名单 `ark_/prts_/input_`；激活现场 `%TEMP%\arknights-preset-activation.json`。
- skill：`~/.agents/skills/arknights/SKILL.md`，源文件在 `dsh-arknights/skill/SKILL.md`。

## 14. 测试接缝

- `test/fake-sidecar.mjs`：可脚本化任意任务链事件，断言 append 参数。
- `test/helpers.mjs`：临时目录、假 logger、工具调用器。
- `test/live-device.mjs`：真机零理智验收；默认只读，`--free` 才跑免费动作；临时数据目录。

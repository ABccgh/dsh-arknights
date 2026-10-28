# `@local/arknights` 内部契约（实现依据，改动必须同步本文件）

版本：1.0.0 ｜ 最后更新：2026-10-28

本文件是 Plugin（Node）与 Sidecar（Python）之间、Host 与 Client（面板）之间的**唯一接口约定**。
任何一侧改动字段，必须同时改这里与对应实现，否则 `test/contract.test.js` 会失败。

---

## 1. 进程拓扑

```
DSH Host（Electron/Node, ESM）
  └─ lib/maa-session.js ──spawn──► python.exe -u lib/sidecar/maa_sidecar.py
         stdin/stdout = NDJSON 协议；stderr = 自由日志（只用于诊断，不解析）
                                            │
                                            └─ ctypes ──► MaaCore.dll
```

- 常驻**一个** sidecar 子进程；`MaaCore` 是进程级单例。
- 同一时间**只允许一个请求在途**（Node 侧串行队列，上限 8）。
- sidecar 退出（stdin EOF / 进程崩溃）→ 下次调用透明重启。

## 2. Sidecar 线路协议（NDJSON，UTF-8，`\n` 分隔）

### 2.1 启动握手

sidecar 启动后立刻（不等待任何请求）输出一行：

```json
{"event":"ready","sidecarVersion":"1.0.0","python":"3.12.14","platform":"win32"}
```

Node 侧把这一行当作「进程存活但尚未 init」的证据；**不阻塞**等待。

### 2.2 请求 / 响应

请求（Node → sidecar）：

```json
{"id":1,"op":"init","args":{"maaPath":"D:\\MAA","userDir":"C:\\...\\maa","touchMode":"minitouch","deploymentWithPause":false}}
```

响应（sidecar → Node），二选一：

```json
{"id":1,"ok":true,"result":{"coreVersion":"v6.21.0-beta.2","resourceLoaded":true}}
{"id":1,"ok":false,"error":{"code":"E_MAA_LOAD","message":"MaaCore.dll 加载失败","detail":"..."}}
```

- `id` 必须原样回传，且与请求的 `id` 相等。
- `code` 用大写下划线码，Node 侧映射成中文提示（见 §7）。
- 未知 `op` → `ok:false, code:"E_BAD_OP"`。

### 2.3 异步事件（MAA 回调）

MAA 的回调（原生线程）转成事件行，**随时**可插入，与响应无序交错：

```json
{"event":"maa","seq":42,"code":10002,"name":"TaskChainCompleted","details":{"taskchain":"Fight"},"ts":"2026-10-28T14:00:00.123Z"}
```

- `seq`：sidecar 内单调递增（从 1 开始），Node 用它做增量游标。
- `code/name`：见 §6 的 MAA 消息码表。
- `details`：MAA 回调的 JSON 解析结果（解析失败时给 `{}` 并在 `detailsRaw` 放原始串）。

### 2.4 操作一览

| op | args | result | 备注 |
|---|---|---|---|
| `init` | `maaPath`(string,必填)、`userDir`(string)、`touchMode`(“minitouch”/“maatouch”/“adb”/“macplaytools”)、`deploymentWithPause`(bool) | `{coreVersion,resourceLoaded,maaPath,userDir}` | 幂等：已 init 再调只回当前状态。创建唯一实例并设置实例级选项 |
| `connect` | `adbPath`(string,必填)、`address`(string,必填,如 `127.0.0.1:16384`)、`config`(string,默认 `General`)、`clientType`(string,默认 `Official`) | `{connected:true}` | 阻塞（可能 10s+）；内部先设 `client_type` 再 `AsstConnect` |
| `append` | `type`(string,必填)、`params`(object,默认 `{}`) | `{taskId:int}` | `type` 非法或 `taskId<=0` → `ok:false, code:"E_TASK_TYPE"` |
| `start` | — | `{running:true}` | `AsstStart` |
| `stop` | — | `{running:false}` | `AsstStop`，清空任务链 |
| `running` | — | `{running:bool}` | `AsstRunning` |
| `connected` | — | `{connected:bool}` | `AsstConnected`（若 DLL 无此符号则退回 `AsstRunning` 语义：`{connected:null}`） |
| `version` | — | `{coreVersion:string}` | `AsstGetVersion` |
| `ping` | — | `{pong:true,inited:bool}` | 健康检查，不碰 MAA |
| `destroy` | — | `{destroyed:true}` | `AsstDestroy`；之后 `inited=false` |

### 2.5 生命周期约束

- `init` 之前调用其它 op → `ok:false, code:"E_NOT_INIT"`。
- `init` 失败（DLL 缺失/资源加载失败）→ `ok:false`，Node 侧不重试同参数。
- 收到 stdin EOF → `AsstDestroy` → 退出码 0。
- sidecar 不得向 stdout 打印任何非协议内容（`print()` 一律写 stderr）。

## 3. MAA 的 C ABI（sidecar 内部使用）

```text
AsstSetUserDir(c_char_p) -> bool
AsstLoadResource(c_char_p) -> bool              # 传**安装根目录**（含 resource/ 的那层）
AsstCreate() -> void*                            # 本插件用 AsstCreateEx 带回调
AsstCreateEx(CFUNCTYPE(None,c_int,c_char_p,c_void_p), void*) -> void*
AsstDestroy(void*)
AsstSetInstanceOption(void*, c_int, c_char_p) -> bool
    # 2=touch_type 3=deployment_with_pause 4=adblite_enabled 5=kill_on_adb_exit 6=client_type
AsstConnect(void*, adbPath, address, config) -> bool
AsstAppendTask(void*, type, paramsJson) -> int    # <=0 表示失败
AsstStart(void*) -> bool
AsstStop(void*) -> bool
AsstRunning(void*) -> bool
AsstConnected(void*) -> bool
AsstGetVersion() -> c_char_p
```

实测要点（本机 MAA v6.21.0-beta.2）：`AsstLoadResource` 必须传安装根（传 `resource/` 子目录返回 False，耗时 0.01s 即失败）；`AsstSetUserDir` 的目录必须先存在；`AsstAppendTask("Bogus", {})` 返回 0。

## 4. Node 侧事件模型

- `lib/state.js` 维护 `events` 环形缓冲（上限 300），元素 `{seq,code,name,task,ts,details}`。
- `task` 从 `details.taskchain` 提取（TaskChain* 事件）。
- 派生状态：`current`（最近 TaskChainStart 且未结束的链）、`chains[]`（本轮所有链的 `{name,status,at}`）、
  `stars`（最近 `StageDrops.details.stars`）、`sanity`（最近 `SanityBeforeStage.details.current_sanity/max_sanity`）、
  `drops`（`StageDrops.details.stats[]` 累计 `{itemName: quantity}`）、`branch`（最近一次 `UnableToAgent*` 记录）。
- `resetChain()`：每轮动作（fight/push/rogue）开始前清 `chains/current/drops/stars/branch`，事件缓冲不清（`seq` 全局递增）。

## 5. 状态 JSON（`GET /arknights/status`，工具 `ark_status` 与面板共用）

```json
{
  "ok": true,
  "ts": "2026-10-28T14:00:00.000Z",
  "sidecar": {"alive": true, "inited": true, "pid": 1234, "coreVersion": "v6.21.0-beta.2", "resourceLoaded": true},
  "paths": {"maaPath": "...", "pythonPath": "...", "adbPath": "...", "userDir": "...", "managerPath": "...", "mmuInstallPath": "..."},
  "emulator": {"managerFound": true, "running": true, "androidStarted": true, "adbOnline": true, "vmIndex": 0, "name": "明日方舟-MuMu模拟器12"},
  "connection": {"connected": true, "address": "127.0.0.1:16384", "config": "MuMuEmulator12", "clientType": "Official"},
  "tasks": {"running": false, "current": null, "chains": [{"name": "Fight", "status": "completed", "at": "..."}]},
  "sanity": {"current": 100, "max": 135},
  "drops": {"固源岩": 12},
  "ledger": {"fullStar": 3, "missing": 2, "primeClaimed": 3, "entries": [{"code": "5-10", "stars": 3, "fullStar": true, "primeClaimed": true, "lastRunAt": "...", "method": "copilot"}]},
  "push": {"nextStage": "5-11", "lastStopped": "5-11", "lastReason": "stage-not-found"},
  "events": [{"seq": 12, "code": 10002, "name": "TaskChainCompleted", "task": "Fight", "ts": "..."}],
  "config": {"dryRun": false, "confirmRequired": true, "clientType": "Official", "defaultDifficulty": "auto"}
}
```

**硬约束**：该 JSON 里不得出现任何凭据、绝对路径以外无敏感信息；`events` 最多 10 条；`ledger.entries` 最多 30 条。
**硬约束 2**：生成该 JSON 的过程**绝不允许**拉起 sidecar、启动模拟器、或执行任何 MAA 调用（只读内存里的状态 + 探测进程/文件）。

## 6. MAA 消息码表（回调 `code`）

| code | name |
|---|---|
| 0 | InternalError |
| 1 | InitFailed |
| 2 | ConnectionInfo |
| 3 | AllTasksCompleted |
| 4 | AsyncCallInfo |
| 5 | Destroyed |
| 10000 | TaskChainError |
| 10001 | TaskChainStart |
| 10002 | TaskChainCompleted |
| 10003 | TaskChainExtraInfo |
| 10004 | TaskChainStopped |
| 20000 | SubTaskError |
| 20001 | SubTaskStart |
| 20002 | SubTaskCompleted |
| 20003 | SubTaskExtraInfo |
| 20004 | SubTaskStopped |
| 30000 | ReportRequest |

本插件依赖的 `details.what` / 字段：

- `StageDrops`: `stars`(int)、`cur_times`、`stageCode`、`stats[]`(`itemName`,`quantity`)
- `NotThreeStars`：非三星结束（推/打关卡据此判断「打通但未满星」）
- `SanityBeforeStage`: `current_sanity`、`max_sanity`
- `BattleStartAll` / `BattleOfficiallyBegin`：真正开战
- `StageQueueUnableToAgent` / `StageQueueUnableToAgent2`：没有代理指挥 → MAA 直接 Stop（**零理智**）
- `StageQueueStageNotFound`：关卡不存在/未解锁
- `CopilotPrecheckFile`：作业文件预检失败
- `BattleFormationOperbox1Unmatched` / `may_borrow_oper`：干员不满足

## 7. 错误码（Node 侧 `lib/errors.js`）

| code | 含义 | 中文提示要点 |
|---|---|---|
| `E_MAA_NOT_FOUND` | 没找到 MaaCore.dll | 给出探测过的路径与 `maaPath` 配置方法 |
| `E_PYTHON_NOT_FOUND` | 没找到可用 Python | 给出候选与探测命令 |
| `E_MAA_LOAD` | DLL 加载/资源加载失败 | 提示先跑一次 MAA GUI 确保资源完整 |
| `E_NOT_INIT` | 未 init 就调用 | 内部错误，提示重开插件 |
| `E_BAD_OP` | 未知 op | 内部错误 |
| `E_CONNECT` | 连接失败 | 检查模拟器是否启动、adb 端口 |
| `E_ADB_NOT_FOUND` | 没找到 adb | 给出 MuMu `shell\adb.exe` 路径 |
| `E_EMULATOR_NOT_FOUND` | 没找到 MuMu | 给 `emulator.managerPath` 配置方法 |
| `E_EMULATOR_START` | 模拟器启动超时 | 提示手动启动一次 |
| `E_TASK_TYPE` | 任务类型不被 MAA 接受 | 内部错误 |
| `E_STAGE_UNKNOWN` | 关卡代码不在 stages.json | 给候选（ArkRec 中文名辅助） |
| `E_NO_SOLUTION` | 该关没有可用作业 | 三条出路：`copilotId`/`file`/自己打 |
| `E_SOLUTION_INVALID` | 作业文件预检失败 | 换作业或换来源 |
| `E_OPER_MISSING` | 作业要求的干员不满足 | 报缺哪些干员 |
| `E_TIMEOUT` | 单关/连接超时 | 报最后事件与当前链 |
| `E_PROTOCOL` | 线路协议错误 | 已杀进程，下次透明重启 |
| `E_SIDECAR_EXIT` | sidecar 崩溃 | 下次透明重启 |
| `E_BAD_ARGS` | 参数非法 | 指名哪个参数 |
| `E_DRY_RUN` | dryRun 下不执行 | 只回计划 |
| `E_CONFIRM_REQUIRED` | 需要 `confirm=true` | 回计划 + 提示再加一次 |

## 8. `/ark` 命令语法

| 命令 | 作用 |
|---|---|
| `/ark status` | 同 `ark_status` 的文本 |
| `/ark fight <stages> [times]` | 打关卡（`confirmRequired` 时先出计划） |
| `/ark fight <stages> [times] --yes` | 跳过确认直接打 |
| `/ark push [from] [--chapter=5]` | 推关 |
| `/ark rogue [theme]` | 肉鸽 |
| `/ark stop` | 停止 |

命令返回 `{kind:'success', text}`；失败 `{kind:'error', text}`。

## 9. 面板 ↔ Host 契约

- **只读状态**：`GET /arknights/status` → §5 的 JSON（同源 fetch）。
- **动作**：`POST /arknights/action`，body：

```json
{"action": "fight", "stages": "5-10", "times": 1, "confirm": true}
{"action": "push", "from": "5-3", "chapter": null, "confirm": true}
{"action": "rogue", "theme": "Sarkaz", "mode": "Exp"}
{"action": "stop"}
```

  响应：`{"ok": true, "text": "给人看的文本", "status": {…可选，最新状态…}}` 或 `{"ok": false, "error": {"code": "...", "message": "..."} }`。
- 面板**只能**通过这两个端点与 Host 交互；不得直接调用 MAA、不得读文件。
- 两个端点都只在 `127.0.0.1` 上暴露，且不返回任何凭据。
- 面板轮询间隔 3000ms，仅在挂载期间；卸载必须清定时器。

## 10. 账本（`%LOCALAPPDATA%\dsh-arknights\progress.json`）

```json
{
  "version": 1,
  "updatedAt": "2026-10-28T14:00:00.000Z",
  "stages": {
    "5-10": {"code":"5-10","stars":3,"fullStar":true,"primeClaimed":true,"method":"copilot","solutionId":104178,"lastRunAt":"...","failures":[]},
    "5-11": {"code":"5-11","stars":2,"fullStar":false,"primeClaimed":false,"method":"fight","solutionId":null,"lastRunAt":"...","failures":[{"at":"...","reason":"not-three-stars"}]}
  },
  "push": {"nextStage":"5-11","lastStopped":"5-11","lastReason":"not-three-stars"}
}
```

- 写入必须是「读-改-写 + 原子替换」（临时文件 + rename），失败只告警。
- `push.nextStage` 供 `ark_push` 的 `from` 缺省值与面板「继续推」使用。

## 11. 预设作用域工具插件（`lib/preset/`，v0.2.0 起）

由 `dsh-arknights-agent` bundle 的「明日方舟」预设以 `file:///…/dsh-bundles/arknights/lib/preset/index.js?v=N` 挂载，
**只在预设会话可见**；全局插件那 5 个工具 + 面板 + `/ark` 命令 + 状态路由不受影响。

| 工具 | 数据来源 | 副作用 |
|---|---|---|
| `ark_stages` | MAA `resource/stages.json` + `item_index.json`（离线）+ ArkRec 中文名（降级可缺） | 无 |
| `ark_solutions` | `prts.maa.plus` 作业站查询（`/copilot/query`，不含 actions） | 无 |
| `ark_screen` | `adb exec-out screencap -p` → PNG 落盘 | 写环形截图 |
| `ark_device` | `adb`（`wm size` / `getprop` / `dumpsys activity`） | 无 |
| `ark_game` | MAA `resource/config.json` 的包名与 `am start` 模板 + adb | 动游戏进程 |
| `ark_emulator` | `MuMuManager info/control` | 动模拟器 |
| `ark_log` | `<userDir>/debug/asst.log` | 无 |

- **激活现场**：`apply()` 结束（成功或失败）都会写 `%TEMP%\arknights-preset-activation.json`
  `{presetVersion, ok, at, tools[], allowGlobalToolPrefixes[], maskedGlobals[], error?}`；
  预设激活失败时客户端只显示 `broken`，这个文件是唯一可外部读取的现场。
- **全局工具屏蔽**：读 `ctx.tools.schemas()` 求差集后 `ctx.tools.restrict({deny})`，2s 后再补一次；
  `allowGlobalToolPrefixes` 为空数组时跳过屏蔽。**不要用 `ctx.setTimeout`**（未 inject timer 会抛）。
- **工具名不重叠**：全局 5 + 预设 7 = 12，测试会断言两组集合不相交。
- **`?v=` 规则**：Node 按完整 URL 缓存 ESM。改 `lib/preset/` 后若不重启 Host，必须把预设 patch 里的
  `?v=N` 加一，否则新会话仍复用旧模块。
- `lib/video.js`（全局）：`ark_fight video=<录屏>` 走 MAA `VideoRecognition`，按「回调事件 / 新出现的
  作业 JSON」两条路拾取产物；拿不到时报 `E_NO_SOLUTION` 并提示改用 `file=`（best-effort，未真机验证）。

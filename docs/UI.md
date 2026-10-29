# 面板 UI（`client.js`）

浏览器侧纯 JS 单文件：`window.__ModuleLoader__.load({ id: '@local/arknights', factory(require) { ... } })`；
React 只从页面模块表取（`require('react')`），用 `React.createElement`，无 JSX / TS / 打包，不引用任何外部包、外部图片或外部字体。

## 1. 插槽与图标

- `sidebar.panellist`（list）：`{ name, id: 'arknights', order: 5, label: () => t('panel.title') }`。
  图标是内联 SVG，尺寸取 owner 传入的 `{ size }`（展开 16 / 收起 18），`active` 时描边加粗；颜色只用
  `currentColor`，完整继承侧栏行主题色与选中色。
- `main`（keyed）：`{ name: 'main', key: 'arknights' }`，同一 id 让侧栏按钮自动寻址到本面板。
- 两者都走 `ctx.slots.inject(slot, () => ctx.slots.register(options, Component))`，生命周期跟随插件；
  面板样式是组件内渲染的 `<style>`，卸载即移除。

## 2. 六个页面

页面以 tab 切换（总览 / 战斗 / 日常 / 资料 / 仓库 / 设置）。六个页面在面板挂载后常驻（非当前页 `hidden`），
因此切换 tab 不丢表单状态；每页自身的网络副作用用 `active` 门控，切走不会继续拉数据。

| 页面 | 内容 | 数据来源 |
|---|---|---|
| 总览 | 连接与环境（侧车/coreVersion/协议/模拟器/Android/adb/连接）、理智与最后识别时间、当前或最近 run、账本统计与最近条目、今日日常完成标记、快捷动作（领奖/停止/跳页）、推关进度、干员盒/仓库计数、最近错误与数据告警、最近事件 | `GET /arknights/status` §5 |
| 战斗 | 打关卡（关卡 + 补全、次数、难度、理智药/源石/抄作业用理智药、作业 ID、本地作业、本地录像）、计划 → 确认执行、停止；推关（起点/章节/最多推几关）；肉鸽（主题/模式/开始次数上限）子区 | 补全 `GET query?kind=stage&q=`；`POST action=fight/push/rogue` |
| 日常 | 任务开关（签到/信用/基建/公招分析/仓库快照）、跳过已完成、签到项目、信用购物参数、基建提示、公招分析参数与标签/组合表、逐项结果 | `POST action=daily`、`POST action=recruit`、`status.daily`、`status.lastRun.result.daily` |
| 资料 | 关卡/材料/混合搜索、关卡掉率表（掉率 + 期望理智）、材料掉率表、活动日历、材料规划器（目标 → 总期望理智 / 最佳关卡 / 备选） | `GET query?kind=stage|item|search|drop|activity|plan` |
| 仓库 | 干员盒按稀有度网格（已拥有/未拥有、精英/等级/潜能）、仓库物品 Top、快照时间与 partial 提示、刷新快照 | `GET query?kind=box&target=both&limit=400`；`POST action=box` |
| 设置 | 只读生效配置、安全开关、路径、数据缓存年龄与告警；不写 profile/配置 | `status.config/safety/paths/data` |

## 3. 与 Host 的 HTTP 契约

### 3.1 `GET /arknights/status`

- 挂载立即读一次；无 `status.run` 时每 **2000ms** 轮询，存在 `status.run` 时每 **1000ms**（run 出现/结束时
  自动切换间隔）。
- 同一时刻只有一个状态请求在途；每次请求都有 `AbortController`，超时（8s）与卸载都会 abort；
  卸载时清 `setInterval` 并 `dispose()` 掉在途请求。
- 请求失败不丢上一次状态：显示「Host 未响应」横幅，控件保持可交互，恢复后自动继续刷新。
- 面板只读 §5 字段：`sidecar/paths/emulator/connection/tasks/sanity/run/lastRun/ledger/push/daily/box/data/errors/safety/config/events`。

### 3.2 `GET /arknights/query?kind=...`

统一响应 `{ ok, kind, items, total?, truncated?, source?, ageMs? }`。面板用到的种类：

- `stage&q=`：战斗页关卡补全（`code`、`name`、`apCost`）；资料页关卡搜索结果与内联 `drops[]`。
- `item&q=`：资料页材料搜索；响应 top-level `stages` 有帮助时直接渲染成掉率候选表；点「掉率」再查
  `kind=drop`（带期望理智）。
- `search&q=`：资料页混合搜索（按 `item.type` 分派渲染）。
- `drop&q=<材料名或 id>`：材料掉率表（`code/name/apCost/dropRate/expectedSanity/lowSample`）。
- `activity`：活动日历（`name/start/end/expired/tip/stages[{display,value}]`），首次进入资料页自动加载。
- `plan&targets=固源岩:10,聚酸酯组:5`：材料规划器（`targets[{itemName,count,best,alternatives}]`、`totalExpectedSanity`、`warnings`）。
- `box&target=both&limit=400`：仓库页明细（`updatedAt/partial/operators{own,all}/depot{items}`）。

查询路由未实现（404/错误）时对应区域显示「路由未实现」提示，输入框仍可用，不影响其它页面。

### 3.3 `POST /arknights/action`

请求体 `{ action, ...参数, confirm? }`，动作名只使用 contracts 里的
`fight / push / rogue / daily / recruit / infrast / mall / award / box / stop`（规划器是只读 GET，不是 action）。

- 响应：`{ ok: true, runId?, started?, planned?, plannedItems?, text, status?, result? }`（`status` 快照会立即
  应用到界面，省一次轮询）；错误：`{ ok:false, error:{ code, message, hint? } }`。
- **确认流**：需要确认的动作第一次发 `confirm:false`，只存计划（`plannedItems` / `plannedTotalSanity`），按钮变成
  「确认执行」；第二次才发 `confirm:true`。计划以参数 JSON 签名绑定，**改任何参数都会让确认态失效**（按钮回到
  「计划预览」）。`recruit` 只有 `mode=execute` 走确认；`mode=analyze`、`award`、`box`、`stop` 单击即发。
- **长任务默认不等待**：执行后拿 `runId/started` 立即返回，后续进度靠 `status.run` 轮询。唯一带 `wait:true` 的
  是公招分析（`action=recruit, mode=analyze`，最长等 200s（Host 侧上限 180s）拿 `result.recruit`；拿不到就回退读
  `status.lastRun.result.recruit`）。
- **动作参数**（与 `docs/contracts.md` §10 对齐）：`fight{stages,times,difficulty,medicine,stone,useSanityPotion,copilotId,file,video}`、
  `push{from,chapter,maxStages}`、`rogue{theme,mode,startsCount}`、`daily{tasks,skipDone,award?,mall?}`、
  `recruit{mode,times,selectLevels,confirmLevels,refresh,expedite,permitReserve,firstTags,preserveTags}`（`firstTags` /
  `preserveTags` 是逗号分隔的标签数组）、`award{award?,mail?,dailyPull?,orundum?,mining?,specialAccess?,signInEvent?}`、
  `box{target:'both',refresh?}`、`stop{}`。面板只发用户显式改过的可选字段；空值/0 不发送。
- **停止**：战斗/日常/肉鸽/仓库各页与总览快捷动作都会发 `POST {action:'stop'}`，响应文本进结果区。
- **资源硬闸**：`medicine` / `stone` / `useSanityPotion` 默认 0 / false；`status.safety` 未开启时输入框置灰并
  说明「安全闸默认拒绝」。`recruit mode=execute`、`expedite` 同理；日常任务默认零理智（界面挂「零理智」标）。
- 计划/结果区展示 `plannedItems`（`stage/code/difficulty/times/sanity/note/cnName/tier/activity`）与
  `plannedTotalSanity`，并带「零消耗」徽章。

### 3.4 逐项结果（日常 / 公招）

- 日常逐项结果优先取 `status.lastRun.result.daily.tasks[key]`（`ok/at/text`），其次 `status.daily.tasks`；
  **不从 planned 推断执行结果**。
- 公招标签/组合取 `result.recruit = { tags, level, combos:[{tags,level,operators[]}], slots }`；字段缺失时只显示
  「分析后显示…」占位。

## 4. 错误与诊断

- 业务错误显示 `code / message / hint / detail`，并提供「复制诊断 JSON」；复制内容包含动作、参数、时间、
  错误对象与状态快照（run/lastRun/sidecar/connection/tasks/errors）。
- 网络/超时错误显示本地化的网络/超时文案；状态轮询失败显示离线横幅，不抛异常、不禁用控件。
- 所有事件处理器与 Promise 都有兜底：单个请求异常不会炸掉插槽；响应不是 JSON 时按「无法解析的响应」处理。

## 5. 文案、主题与响应式

- 文案：`ctx.get('locale')` 可用时 `register('arknights', { zh, en })` + `bind('arknights')`，注册项声明
  `locale: 'arknights'`；locale 服务缺失时使用内嵌字典（按 `navigator.language` 选 zh/en）。
  所有可见文本走 `t()`，占位符形如 `{n}` / `{time}` / `{kind}`。
- 内嵌字典是 `locale/zh.json`、`locale/en.json` 的**JSON 对象字面量镜像**；三份必须一致，
  `test/client.static.test.js` 会逐键比对并检查「代码里出现的 key 都存在」。当前 zh/en 各 **309** 个键
  （含 `meta.*` 元数据，键完全对齐）。
- 主题：颜色只用 `--dsw-alias-*` token（label/bg/fill/border/state/button/interactive），无十六进制 / rgb /
  外部色值；图标与 spinner 只用 `currentColor`。窄宽度下卡片 `auto-fit` 网格、表单与按钮 `flex-wrap`，
  `max-width:720px` 时收紧内边距并让状态胶囊换行。

## 6. 自测

```powershell
$node = "$env:USERPROFILE\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"
cd <repo>
& $node --check client.js
& $node --test test/client.static.test.js
```

`test/client.static.test.js` 覆盖：模块包装（`window.__ModuleLoader__` / 只 `require('react')` / 无 JSX / 无
ESM / 无外链 / 无硬编码颜色 / 全部 `var()` 都是 `--dsw-alias-*`）、轮询间隔与 abort、确认流字面量、contract
枚举对齐（`lib/contracts.js`）、6 个页面组件、locale 三份字典逐键一致、VM 加载后插槽恰为
`sidebar.panellist` + `main`（有/无 locale 服务两条路径）、`node --check`，以及用 stub React + fixture status
对整块面板做的浅渲染冒烟（含计划预览、错误结果、空状态、图标 SVG），并把渲染树里所有 `onClick` 在「Host 全挂」
的桩环境下逐个点一遍，断言会发出 `/arknights/action` 与 `/arknights/query` 请求且不抛异常。共 14 个用例。

## 7. 已知限制 / 待 Host 落地

- **视觉验收未在本环境完成**：本轮只做静态/浅渲染验证；真机 GUI 观感（明暗主题、窄宽度、高 DPI）需同步安装副本
  并重启 DSH 后由 Lead 验收。
- 资料页/仓库页明细依赖 `GET /arknights/query` 的 `stage|drop|activity|plan|box` 分支；未实现前对应卡片显示
  「路由未实现」提示而不是空白。
- 仓库页刷新按钮依赖 `action=box` 真的起 run：面板在 `action` 返回成功后轮询 `status.run`，run 结束（或 8s 内
  没看到 run）后重新 `query kind=box`；若 Host 改成同步返回 `result.box`，面板仍会回退到查询。
- 补全、掉率、活动、规划、仓库明细的字段名按 `docs/contracts.md` §5/§10 与 Lead 的 HTTP 约定实现；Host 改字段
  时需同步改 `client.js` 里的提取函数（`extractBoxDetail` / `stageDropRows` / `planTargets` 等）与本文件。
- 肉鸽只暴露主题/模式/开始次数上限；`squad/roles/coreChars/difficulty` 等高级参数仍走配置或工具调用，面板暂不提供。
- 签到项目、信用购物开关以面板勾选为准（每次显式发全套布尔值，覆盖配置默认），避免「界面没勾但按配置跑了」的歧义。
- 肉鸽主题/模式沿用 MAA 固定枚举，不本地化；「最近事件」取 `status.events` 末 5 条倒序。
- 内嵌字典与 locale 文件是两份物理拷贝：改文案要同时改三处（`client.js` 两段 JSON + `locale/*.json`），静态测试
  会挡住不一致。

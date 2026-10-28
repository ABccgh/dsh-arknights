# 面板 UI（`client.js`）

浏览器侧纯 JS 单文件：`window.__ModuleLoader__.load({ id: '@local/arknights', factory(require) { ... } })`；React 只从页面模块表取（`require('react')`），用 `React.createElement`，无 JSX / TS / 打包，不引用任何外部包。

## 插槽
- `sidebar.panellist`（list）：`{ id: 'arknights', order: 5, label: () => t('panel.title') }`。组件收到 `{ size, active }`（展开 16 / 收起 18，`active` 为选中态），渲染内联 SVG 图标；图标用 `currentColor`，颜色完全继承侧栏行主题色与选中色。
- `main`（keyed）：`{ key: 'arknights' }`，面板主体；同一个 id 让侧栏按钮自动寻址到本面板。
- 两者都经 `ctx.slots.inject(slot, () => ctx.slots.register(options, Component))` 注册，生命周期跟随插件；面板样式是组件内渲染的 `<style>`，卸载即移除。

## 与 Host 的交互
- `GET /arknights/status`：仅面板挂载期间轮询，间隔 3000ms，首次立即；用 `AbortController` 取消在途请求，卸载时清 `setInterval` 并 abort。失败显示 `panel.offline`，其余控件保持可交互。
- `POST /arknights/action`：请求体严格按 `docs/contracts.md` §9 —— `fight` `{action,stages,times,confirm}`、`push` `{action,from,chapter,confirm}`（空串归一为 `null`）、`rogue` `{action,theme,mode}`、`stop` `{action}`。成功把响应 `text` 显示在结果区（有 `status` 时顺带刷新界面），失败显示 `error.message`；所有事件处理器都有 try/catch 兜底，不会因异常炸掉插槽。

## 确认流
打关卡与推关都是两步：第一次点击发 `confirm:false` 展示计划，按钮切到 `actions.confirm`（确认执行）；再点一次才发 `confirm:true`。改关卡输入会复位确认态（推关改起点/章节同样复位）。「预览」等价于 `confirm:false`，并让同区按钮进入待确认状态。

## 文案与主题
- 文案：`ctx.get('locale')` 可用时 `register('arknights', { zh, en })` 再 `bind('arknights')`；注册项声明 `locale: 'arknights'`，渲染器注入随语言切换更新的 `t` prop。locale 服务缺失时退回内嵌字典（`navigator.language` 以 `zh` 开头取中文，否则英文）。可见文本全走 `t()`，key 只用 `locale/*.json` 已有的。
- 主题 token（只用 `--dsw-alias-*`，无硬编码颜色）：`label-primary/-secondary/-tertiary/-caption`、`bg-base`、`bg-layer-1/-2`、`fill-l2`、`border-l2/-l3`、`state-success/-warn/-error/-idle/-business-primary`、`button-primary-fill/-hover`、`label-primary-foreground`、`interactive-bg-hover(-danger)`。

## 已知限制
- 已在本机真机 GUI 截图核对（侧栏入口/图标、状态区、按钮与提示文案、明暗主题基础观感）；
  跨分辨率、窄宽度换行与其它主题下的观感未逐一验证。
- Host 侧两个端点已与真实 Host 联调（`GET /arknights/status` 轮询、`POST /arknights/action`
  的 fight/push/rogue/stop 四类动作），结论记录在本机 `.admin` 安装记录里（不随仓库发布）。
- 肉鸽主题/模式沿用 MAA 固定枚举，不本地化；「最近事件」取 `status.events` 末 5 条倒序，缺失 `name` 时显示占位符。
- 内嵌字典是 `locale/zh.json`、`locale/en.json` 的 JS 对象字面量镜像（内容一致、非字节级相同）；
  改 locale 文件时必须同步 `client.js` 内嵌副本。

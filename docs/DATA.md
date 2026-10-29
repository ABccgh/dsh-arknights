# 数据来源、缓存与掉率口径

`ark_data` / `ark_plan` 与面板「资料」页共用同一套只读数据层。所有在线源失败都只降级，不阻塞打关卡/日常。

## 1. 来源

| 来源 | 用途 | 默认地址 | 缓存 |
|---|---|---|---|
| MAA `resource/stages.json` | 关卡代码/内部 id/apCost/dropInfos | 本机 MAA `resource/` | 按文件 mtime |
| MAA `resource/item_index.json` | 材料 id→名称/用途 | 同上 | 按文件 mtime |
| MAA `resource/recruitment.json` | 公招干员索引（160） | 同上 | 按文件 mtime |
| MAA `resource/config.json` | 包名/连接配置 | 同上 | 按文件 mtime |
| MAA `resource/version.json` | 资源/活动/卡池时间 | 同上 | 按文件 mtime |
| ArkRec | 关卡中文名/章节/突袭条件/少人纪录 | `https://wiki.arkrec.com/v1`（`/api/menu`、`/api/hard-operations`） | 7 天 |
| penguin-stats | 材料掉率矩阵 | `https://penguin-stats.cn/PenguinStats/api/v2/result/matrix` | 7 天（按材料） |
| MAA StageActivityV2 | 活动/复刻关卡与时间窗 | `https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json` | 6 小时 |
| PRTS（另一个插件） | 干员档案等人工资料 | `https://prts.wiki` | 5 分钟（PRTS 插件自己的缓存） |

## 2. 掉率口径

Penguin 的 matrix 每行是某关卡某材料的累计统计：

```
dropRate        = quantity / times
expectedSanity  = apCost * times / quantity
```

- 只统计 `end` 为空（长期开放）或已到 `start` 的区间；过期活动不参与规划。
- `times` 小于阈值（默认 50）标 `lowSample=true`，规划时给提示但不排除。
- `apCost` 来自 MAA `stages.json`；活动关卡可能没有 `apCost`，此时 `expectedSanity` 为 `null`。
- 期望理智是**长期平均**，不是保底；实际以游戏内为准。

## 3. 关卡解析

- 显示代码 ↔ 内部 id 不恒等：`16-16` → `main_16-15`（章号偏移），以 MAA 表为准。
- 难度：`main_`（普通/标准）、`easy_`（简单/标准）、`tough_`（磨难/险地/突袭）；10–14 章 = 标准/磨难，15 章及以后 = 常规/险地；MAA 用 `-HARD` 后缀导航。
- 活动关卡（`SSReopen-XX`、当期 SS 后三关、剿灭值）可能不在 `stages.json` 里；`ark_fight` 允许按 MAA 活动 API 的值导航，计划里标 `activity=true` 并提示。
- 中文名/突袭条件来自 ArkRec；缺失只影响展示。

## 4. 缓存与降级

- 缓存目录：`%LOCALAPPDATA%\dsh-arknights\cache\`（`penguin/`、`activity.json`）、`arkrec/`、`copilot/`。
- 写入用临时文件 + rename；损坏文件当缓存未命中，不抛错。
- 在线源超时/限流/证书错误 → 返回空结果 + `warnings`，面板显示「缓存/降级」，不会启动 MAA 或消耗资源。
- `refresh=true` 强制刷新；面板默认只用缓存，刷新按钮才发网络请求。

## 5. 边界

- 不含 PRTS 全量干员/技能/模组数据；干员详情用 `prts_operator` / `prts_page`。
- 不含企鹅全量 1 MB 矩阵的长期缓存；按材料 `itemFilter` 按需拉取。
- 掉率是玩家上报统计，不是官方概率；不同服/不同时期可能偏差。

---
name: cocos-resource
description: 资源与界面的「唯一来源」约定：resources 引用怎么审计（代码字符串引用、无 uuid 场景引用）、资源目录 14 域平铺、Tiled 对象组与坐标口径（地图权威在服务端，客户端只显示）、布局/图片/尺寸集中到 configs/layout/*、NO_BORDER 铺满策略与 HUD 贴边。触发场景：改名资源怕漏引用 / 多余资源能不能删 / 改了地图为什么不生效 / 布局写死在组件里 / 窗口变形 HUD 被切 / getVisibleSize 不准。
agent_created: true
---

# 资源与地图：资源引用审计 / 目录约定 / Tiled 对象组 / 布局配置 / 屏幕适配

> 这是一个**索引技能**：17 个 `cocos-*` 技能已按主题合并成 5 个（render / input / resource /
> gameplay / build-test）。原文档**一字未改**，全在 `references/` 下，按下面这张表跳过去读。
> 好处：平时只加载这几十行，需要细节时才读那一份（原文档单篇 50~470 行）。

## 什么时候读哪一份

| 原文 | 一句话 |
|---|---|
| [`cocos-asset-usage-audit`](./references/cocos-asset-usage-audit.md) | 在 Cocos Creator 3.x 工程里做「资源引用审计」——把 assets/resources 下的资源按引用来源分组，找出没有任何引用的静态资源并安全归档到一个目录… |
| [`cocos-asset-refactor`](./references/cocos-asset-refactor.md) | 在 Cocos Creator 3.x 项目里安全地对 assets 下脚本做文件级重构（移动/重命名/分目录、批量改引用），并规避「编辑器回写覆盖」这个高频事故 |
| [`cocos-tiledmap-objectgroup`](./references/cocos-tiledmap-objectgroup.md) | Cocos Creator 3.x 中把 Tiled（.tmx）对象组在游戏内实例化的正确做法，含四个必踩的引擎坑（对象「类」被解析器丢弃、object.y 被 _init 原… |
| [`cocos-ui-layout-config`](./references/cocos-ui-layout-config.md) | Cocos Creator 3.x 游戏项目里「把散落的可配置项收敛进 configs」的重构做法：UI 位置/尺寸/图片地址的单一入口 barrel（hudLayout.ts… |
| [`cocos-screen-adapt-hud`](./references/cocos-screen-adapt-hud.md) | Cocos Creator 3.x 里做「铺满窗口（NO_BORDER）的屏幕适配 + 常驻 HUD 贴边布局」，兼容任意窗口尺寸/宽高比 |

## 三条跨篇的硬纪律（不用翻 references 也要记住）

1. **表现层不写测试断言**：位置/尺寸/帧率/层级/对齐一律人眼看；自动化只留「素材存在性、执行顺序、结构接线」。
2. **配置与代码的边界**：组件里只允许「由配置派生的计算」与玩法数学，绝对坐标/尺寸/图片路径一律来自 `configs/layout/*`。
3. **改完 `client/assets` 必须复检**：编辑器会周期性把上一代内容回写覆盖，改完要 Read 磁盘实际内容，延时几秒再复检一次。

---
name: cocos-build-test
description: 构建与验证侧：Xcode/mac 原生包构建失败的常见原因、用 Node 沙箱跑配置与纯函数的单测手法（cc 桩）、Cocos 编辑器周期性回写覆盖外部修改的复检纪律。触发场景：打包报错 / 真机闪退 / 想给配置层写单测 / 改完文件被编辑器覆盖 / tsc 行号对不上。
agent_created: true
---

# 构建与排障：原生打包 / 沙箱单测 / 编辑器回写

> 这是一个**索引技能**：17 个 `cocos-*` 技能已按主题合并成 5 个（render / input / resource /
> gameplay / build-test）。原文档**一字未改**，全在 `references/` 下，按下面这张表跳过去读。
> 好处：平时只加载这几十行，需要细节时才读那一份（原文档单篇 50~470 行）。

## 什么时候读哪一份

| 原文 | 一句话 |
|---|---|
| [`cocos-native-build-xcode-fix`](./references/cocos-native-build-xcode-fix.md) | 排查并修复 Cocos Creator 3.x 原生（macOS/iOS）打包在 Xcode 命令行阶段的失败，尤其是新版本 Xcode（16/26/27+）下报 "run c… |
| [`cocos-node-sandbox-test`](./references/cocos-node-sandbox-test.md) | 在 node 里跑 Cocos Creator 3.x 项目的**核心代码**（管理器 / 存储层 / 战斗结算这类 import 了 UI 与引擎的类）做单测的成套做法：把真… |

## 三条跨篇的硬纪律（不用翻 references 也要记住）

1. **表现层不写测试断言**：位置/尺寸/帧率/层级/对齐一律人眼看；自动化只留「素材存在性、执行顺序、结构接线」。
2. **配置与代码的边界**：组件里只允许「由配置派生的计算」与玩法数学，绝对坐标/尺寸/图片路径一律来自 `configs/layout/*`。
3. **改完 `client/assets` 必须复检**：编辑器会周期性把上一代内容回写覆盖，改完要 Read 磁盘实际内容，延时几秒再复检一次。

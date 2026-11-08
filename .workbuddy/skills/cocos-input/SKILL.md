---
name: cocos-input
description: 鼠标与触屏在本项目的统一处理：getLocation 与 getUILocation 的口径差别、点 UI 不该穿透到世界、按住走 / 右键跑 / 键盘优先的三来源优先级、全局 input 监听与节点销毁、碰撞体范围可视化。触发场景：点了没反应 / 点 UI 角色跟着走 / 窗口越大命中越偏 / 按钮与拖拽冲突 / 想看碰撞范围。
agent_created: true
---

# 交互：指针 / 键盘 / 点击穿透 / 碰撞调试可视化

> 这是一个**索引技能**：17 个 `cocos-*` 技能已按主题合并成 5 个（render / input / resource /
> gameplay / build-test）。原文档**一字未改**，全在 `references/` 下，按下面这张表跳过去读。
> 好处：平时只加载这几十行，需要细节时才读那一份（原文档单篇 50~470 行）。

## 什么时候读哪一份

| 原文 | 一句话 |
|---|---|
| [`cocos-mouse-button-input`](./references/cocos-mouse-button-input.md) | Cocos Creator 3.x 中处理「鼠标左右键 + 触屏点击」的交互：为什么不能同时监听 MOUSE_* 与 TOUCH_*（引擎把鼠标事件无条件模拟成 touch）、… |
| [`cocos-collider-debug-overlay`](./references/cocos-collider-debug-overlay.md) | 在 Cocos Creator 3.x 游戏里把碰撞体的碰撞范围可视化（范围框 + 名称/尺寸），并规避「动态给已有节点加 UI 子元素」的三个高频坑：子节点被 Layout … |

## 三条跨篇的硬纪律（不用翻 references 也要记住）

1. **表现层不写测试断言**：位置/尺寸/帧率/层级/对齐一律人眼看；自动化只留「素材存在性、执行顺序、结构接线」。
2. **配置与代码的边界**：组件里只允许「由配置派生的计算」与玩法数学，绝对坐标/尺寸/图片路径一律来自 `configs/layout/*`。
3. **改完 `client/assets` 必须复检**：编辑器会周期性把上一代内容回写覆盖，改完要 Read 磁盘实际内容，延时几秒再复检一次。

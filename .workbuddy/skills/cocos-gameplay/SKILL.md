---
name: cocos-gameplay
description: 客户端在「服务端已定结果」的前提下怎么演：A* 寻路与点击寻路（障碍从 TMX 与动态障碍来）、自动战斗 tick 顺序、怪物行为全在服务端而客户端只趋近与播动作、背包格子拖拽与一键整理的排序规则。触发场景：自动挂机卡住 / 点地不走 / 怪物瞬移或贴脸 / 动画永远第一帧 / 背包拖不动 / 整理顺序不对。
agent_created: true
---

# 玩法表现层：自动战斗与寻路 / 怪物 AI 演出 / 背包拖拽整理

> 这是一个**索引技能**：17 个 `cocos-*` 技能已按主题合并成 5 个（render / input / resource /
> gameplay / build-test）。原文档**一字未改**，全在 `references/` 下，按下面这张表跳过去读。
> 好处：平时只加载这几十行，需要细节时才读那一份（原文档单篇 50~470 行）。

## 什么时候读哪一份

| 原文 | 一句话 |
|---|---|
| [`cocos-auto-battle-a-star`](./references/cocos-auto-battle-a-star.md) | Cocos Creator 3.x 里给角色做「自动战斗 + A* 寻路走位」的成套做法：快速攻击（按 canAuto 技能无目标/超距时自动选最近怪、走位到技能范围连续出手、… |
| [`cocos-monster-ai`](./references/cocos-monster-ai.md) | 怪物 / NPC 行为（待机游走、追击、普攻、技能、击退）在这个项目里的做法：**行为全部在服务端模拟**（server/src/modules/realtime/monste… |
| [`cocos-bag-tidy`](./references/cocos-bag-tidy.md) | 给 Cocos Creator 3.x 游戏做「背包 / 仓库一键整理」与「一键回收 / 批量出售」这类**批量背包操作**的成套做法：搬运（合并同类可叠加物 → 按等级/类型… |

## 三条跨篇的硬纪律（不用翻 references 也要记住）

1. **表现层不写测试断言**：位置/尺寸/帧率/层级/对齐一律人眼看；自动化只留「素材存在性、执行顺序、结构接线」。
2. **配置与代码的边界**：组件里只允许「由配置派生的计算」与玩法数学，绝对坐标/尺寸/图片路径一律来自 `configs/layout/*`。
3. **改完 `client/assets` 必须复检**：编辑器会周期性把上一代内容回写覆盖，改完要 Read 磁盘实际内容，延时几秒再复检一次。

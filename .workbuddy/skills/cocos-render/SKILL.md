---
name: cocos-render
description: Cocos Creator 3.8.7 里「把东西画对」的全部约定：帧动画唯一入口 AnimationHelper 与按目录缓存、图集分页合并、特效去黑底（additive）、spine/帧图集的 plist 打包、装备与外观的像素级对齐、节点销毁与视图失效判定。触发场景：动画不播 / 卡第一帧 / 外观没加载 / 特效带黑边 / 换装错位 / 切场景后弹窗白屏 / 帧率与时长算错 / 图集要打包。
agent_created: true
---

# 渲染：动画 / 特效 / 图集 / 挂件对齐 / 生命周期

> 这是一个**索引技能**：17 个 `cocos-*` 技能已按主题合并成 5 个（render / input / resource /
> gameplay / build-test）。原文档**一字未改**，全在 `references/` 下，按下面这张表跳过去读。
> 好处：平时只加载这几十行，需要细节时才读那一份（原文档单篇 50~470 行）。

## 什么时候读哪一份

| 原文 | 一句话 |
|---|---|
| [`cocos-frame-animation-preload`](./references/cocos-frame-animation-preload.md) | Cocos Creator 3.x 里给「帧动画驱动」的游戏做资源预加载、缓存与播放，解决几类典型症状：进图/切场景卡顿（几十上百个节点各自 resources.loadDir… |
| [`cocos-additive-effect-deblack`](./references/cocos-additive-effect-deblack.md) | 处理 Cocos Creator 项目里「特效图集带黑色背景」的素材——判断是否为加法混合（Additive）黑底素材、把亮度反推成 alpha 并反预乘还原颜色的批处理做法、… |
| [`sprite-plist-packer`](./references/sprite-plist-packer.md) | 将逐帧动画（已对齐的 PNG/BMP 帧目录）打包成 Cocos Creator 可用的图集——每个动画一张 PNG + 一个同名 plist（cocos2d-v3 / Tex… |
| [`sprite-placement-align`](./references/sprite-placement-align.md) | 游戏帧动画偏移对齐 |
| [`cocos-view-lifecycle`](./references/cocos-view-lifecycle.md) | Cocos Creator 3.x 里「随数据出现的动态视图」（选中目标的光圈/信息面板、跟随型特效、指示器）的生命周期做法与必踩坑：引擎 isValid(value, str… |

## 附带的脚本（合并时一起搬过来，命名 `<原技能>__<文件名>`）

| 脚本 | 用途 |
|---|---|
| [`scripts/sprite-plist-packer__plist_packer.py`](./scripts/sprite-plist-packer__plist_packer.py) | 帧目录 → 一张 PNG + 同名 plist（cocos2d-v3） |
| [`scripts/sprite-plist-packer__verify_plist.py`](./scripts/sprite-plist-packer__verify_plist.py) | 校验生成的 plist 与图集是否自洽 |
| [`scripts/sprite-placement-align__align_frames.py`](./scripts/sprite-placement-align__align_frames.py) | 批量量取并计算装备/外观的对齐偏移 |
| [`references/cocos-additive-effect-deblack__deblack.py`](./references/cocos-additive-effect-deblack__deblack.py) | 加法混合黑底素材 → 反预乘还原 alpha |
| [`references/cocos-additive-effect-deblack__compare.py`](./references/cocos-additive-effect-deblack__compare.py) | 处理前后对比出图 |
| [`references/sprite-plist-packer__pitfalls.md`](./references/sprite-plist-packer__pitfalls.md) | 打包踩坑清单（独立于主文） |

## 三条跨篇的硬纪律（不用翻 references 也要记住）

1. **表现层不写测试断言**：位置/尺寸/帧率/层级/对齐一律人眼看；自动化只留「素材存在性、执行顺序、结构接线」。
2. **配置与代码的边界**：组件里只允许「由配置派生的计算」与玩法数学，绝对坐标/尺寸/图片路径一律来自 `configs/layout/*`。
3. **改完 `client/assets` 必须复检**：编辑器会周期性把上一代内容回写覆盖，改完要 Read 磁盘实际内容，延时几秒再复检一次。

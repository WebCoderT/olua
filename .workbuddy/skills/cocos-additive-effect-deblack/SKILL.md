---
name: cocos-additive-effect-deblack
description: 处理 Cocos Creator 项目里「特效图集带黑色背景」的素材——判断是否为加法混合（Additive）黑底素材、把亮度反推成 alpha 并反预乘还原颜色的批处理做法、哪些图绝不能碰（UI 图标/描边/按键底色）、备份与还原。触发场景：用户说"特效有黑色背景/黑块/黑边"、"技能特效不透明"、"图集黑底"、"加法混合"、"additive"、"素材发黑"等。
---

# Cocos 加法混合特效图集去黑底

## 先诊断，别急着改代码

特效"有黑色背景"几乎都不是渲染问题，而是**素材本身**：这批图原本按加法混合设计（黑 = 不发光），
转 png 时黑底没抠（alpha 全 255 或二值 0/255）。用 PIL 检查三件事：

1. mode 是否 RGBA、有没有 alpha 通道；
2. alpha 是否二值（只有 0 和 255，中间值≈0）→ 典型黑底特征；
3. **不透明像素里纯黑（a>250 且 max(R,G,B)<8）的占比** —— 这是决定性指标。

## 判据与禁区（关键，别误伤）

- 纯黑占比 > 5%（实际项目里黑底图都在 30%+，正常图是 0%）→ 处理；
- **UI 图标里的黑色是设计的一部分，绝不能动**：`slots/*`（25% 是按键底）、`bottom-nav-bar/bg`、
  `small-map/*`、`main/ui/*`、`item/*`、`skill/icon/*`、`common/*` 等的黑色是描边/半透明底。
  这些特征是软边 alpha + 纯黑占比 5%~27%，和特效图（二值 alpha + 30%+）明显分层；
- 范围限定在特效目录（本项目是 `resources/effect/**`），**先全量扫描再按目录圈定**，
  不要拿一个全局阈值去扫整包 resources。

## 处理算法（亮度 → alpha + 反预乘）

```python
lum = rgb.max(axis=2)                      # 亮度取 max(R,G,B)
t = (lum/255) ** 0.8                       # gamma <1 让光效更实
new_a = clip(a * t, 0, 255)                # 亮度反推 alpha
scale = 255 / max(lum, 12)                 # 反预乘还原颜色（FLOOR=12 防噪声放大）
new_rgb = clip(rgb * scale, 0, 255)
new_a = where(new_a < 3, 0, new_a)         # 低 alpha 归零去噪
```

数学上这正是「加法混合 → 普通 alpha 混合」的还原：纯黑 → 全透明，
暗色 → 半透明高饱和色，亮色 → 不透明。黑底消失、光晕形状颜色不变、边缘不产生黑边。

脚本（诊断 + 批处理一体）：`references/deblack.py`；对比图脚本：`references/compare.py`
（从 plist 取未旋转帧，贴彩色斜纹背景左右对比，能直观看出黑块消失）。

## 流程与注意

1. **先备份原图**（放 assets 之外，避免被编辑器导入）：
   `rsync -a --include='*/' --include='*.png' --exclude='*' assets/resources/effect/ .backup/effect-png-originals/`
2. 批处理 → 生成前后对比图给用户确认；
3. 只改 png 像素内容，**.meta 不动（uuid 不变）**，编辑器会自动重新导入；
4. 还原：`cp .backup/effect-png-originals/skill/*.png assets/resources/effect/skill/`（按子目录对应拷回）；
5. 若用户之后想要"叠加增亮"的发光感，可再给特效 Sprite 挂加法混合材质（自定义 .effect，blend ONE/ONE），
   那是锦上添花，不是修黑底的必要条件。

## 本项目（olua）已处理记录

2026-10-01 处理 22 张（effect/skill 19、effect/plist/select_monster@0、effect/status/s_2004@0），
跳过 19 张正常图；备份在 `.backup/effect-png-originals/`（27M）。

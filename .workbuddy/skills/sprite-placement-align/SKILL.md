---
name: sprite-placement-align
description: 游戏帧动画偏移对齐。当文件夹内包含逐帧导出的 PNG 序列（000000.png…）和 Placements 文件夹（每帧一个同名 txt，内含 x、y 两个偏移值）时使用此技能，将各帧按偏移合成到统一画布上生成对齐后的帧序列。触发场景：用户提到"帧动画"、"Placements 偏移"、"动画帧对齐"、"按偏移重新生成帧"等。
agent_created: true
---

# Sprite Placement Align（游戏帧动画偏移对齐）

## 概述

将游戏导出的逐帧动画 PNG（每帧尺寸不同）+ Placements 偏移数据，合成为统一画布尺寸、按偏移正确落位的对齐帧序列，并生成 GIF 预览。

## 坐标约定（已验证）

txt 中的两个数值 = 该帧图片**左上角**相对统一锚点的绘制坐标，屏幕坐标系（y 向下为正，负值表示在锚点上方/左侧）。

判定方法（若遇到新数据不确定时）：对 18 种解释组合（y 符号 × x 锚点 left/center/right × y 锚点 top/center/bottom）计算相邻帧 alpha 掩码 IoU 与质心轨迹加速度平滑度，取综合最优；同时结合该类 Placements 导出格式的标准约定验证。

## 工作流程

1. **盘点数据**：列出根目录 PNG 与 `Placements/*.txt`，确认配对关系；读取全部偏移，检查是否全为整数、数值范围；查看 PNG 尺寸与内容包围盒。
2. **识别占位空帧**：宽或高 ≤5px 的帧为占位空帧。默认原样复制到输出目录；用户要求"移除空帧"时加 `--drop-empty`（输出目录中不含这些帧，编号保留跳号）。
3. **计算统一画布**：对真实帧计算 `min(x), min(y)` 与 `max(x+w), max(y+h)`，得到画布尺寸与锚点在画布内的位置。
4. **逐帧合成**：每帧贴到透明 RGBA 画布的 `(x - min_x, y - min_y)` 处。
5. **生成预览**：输出 GIF 动图（必要时半尺寸）供用户确认对齐效果。

## 直接执行脚本

多数情况可直接运行打包脚本（依赖 Pillow）。目录定位规则：目录自带帧文件（无论偏移 txt 在 `Placements/` 子文件夹还是**与图片同级**）则处理该目录；否则**自动批量递归遍历**所有含帧文件的子目录（任意深度）逐个处理（输出写入各自子目录内）：

```bash
/Users/tz/.workbuddy/binaries/python/envs/default/bin/python3 \
  ~/.workbuddy/skills/sprite-placement-align/scripts/align_frames.py \
  <目录> --out 已对齐帧 --gif 预览.gif --fps 10 --half
```

参数：`--out` 输出文件夹名（默认"已对齐帧"）；`--gif` 预览文件名（传空字符串跳过）；`--fps` 帧率；`--half` GIF 半尺寸；`--stride` GIF 抽帧间隔；`--drop-empty` 移除占位空帧而不复制。脚本自动完成配对、画布计算、合成与预览。

## 注意事项

- **合成必须用 `alpha_composite`，绝不能用 `canvas.paste(im, box, im)`**：PIL 把 RGBA 掩码当逐通道混合因子，会把 alpha 平方（128→64、1~15→0），软边像素被静默腐蚀。实测某帧 29909 个半透明像素处理后只剩 20771 个。正确写法 `canvas.alpha_composite(im, (x-x0, y-y0))`（偏移为 0 时结果与原始逐像素完全一致）。
- **8 位调色板 BMP**：游戏导出的 BMP 通常无 alpha 通道，调色板**索引 0 为键色**（多为黑色背景，占大面积且位于四角）。脚本自动将索引 0 置为透明（与游戏引擎颜色键渲染一致）；图形内部被包围的索引 0 黑色区域也会透明，属正常行为。
- 帧编号可能与 txt 不连续（如 PNG 只有 8 张但 txt 有 1002 个）：只处理配对成功的帧；若怀疑数据未拷贝完整，先与用户确认。
- 若用户反馈动画上下颠倒，将粘贴纵坐标改为 `-(y + h)` 后重算画布再生成。
- 预览 GIF 用 `disposal=2` 避免残影；帧数多时用 `--stride 2/3` 抽帧减小体积。
- 运行环境：managed venv `/Users/tz/.workbuddy/binaries/python/envs/default/bin/python3`（含 Pillow、numpy）。

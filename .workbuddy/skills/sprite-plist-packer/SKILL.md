---
name: sprite-plist-packer
description: 将逐帧动画（已对齐的 PNG/BMP 帧目录）打包成 Cocos Creator 可用的图集——每个动画一张 PNG + 一个同名 plist（cocos2d-v3 / TexturePacker format 3）。触发词：打包成 plist、图集、atlas、cocos creator、一张图和一个 plist、合成雪碧图给 cocos。当用户要把帧动画转成引擎可用的精灵图集、或要求"处理完后搞成 plist 形式"时使用本技能。依赖 PIL + numpy。
agent_created: true
---

# Sprite Plist Packer

## 概述

把"一个目录 = 一个动画"的逐帧图片，按 alpha 裁剪后紧密打包进 2 的幂图集，输出
`<动画名>.png + <动画名>.plist`（cocos2d-v3 / TexturePacker format 3，Cocos Creator 2.x 直接识别）。
帧位置信息通过 `spriteOffset` / `spriteSourceSize` 保留，播放时不会错位。

## 快速开始

### 1. 打包

```bash
PYTHONPATH=<venv site-packages> <python> -S scripts/plist_packer.py <动画根目录> <输出目录> --max 4096
```

- 动画根目录下**每个含图片文件的目录视为一个动画**（递归扫描，`.png`/`.bmp`，自动跳过
  `Placements`、`_预览`、隐藏目录）。输出镜像相对路径：`<输出>/<相对路径>/<目录名>.png+.plist`。
- 常用参数：`--max 4096` 图集边长上限（2 的幂）、`--pad 2` 图块间隙、`--force` 强制重建、
  `--only 前缀` 只处理匹配的相对路径、`--jobs N` 多进程并行（I/O 密集时收益有限）。
- 已存在同名输出时默认跳过（断点续跑），加 `--force` 覆盖。
- 结束后在输出根写 `_汇总.json`（可读可删，交付前一般清理掉）。

### 2. 校验（交付前必做）

```bash
PYTHONPATH=<venv site-packages> <python> -S scripts/verify_plist.py <输出根> <源根> \
  [--map 组名=源子目录,...] [--skip-dir _高清8192]
```

校验内容：帧数与源目录一致、无越界、无重叠、按 plist 还原每帧后与原图**逐像素一致**
（只比 alpha>0 区域）。scale<1 的缩放图集允许重采样差异，会单独标注。

### 3. 高清兜底

帧太多塞不进 `--max` 时，打包器会等比缩小（结果里 `scale<1.0`）。对这批动画另跑一次
`--max 8192` 得到原始分辨率版本，放进输出下的独立目录（如 `_高清8192/`），按需选用。

## 关键规则与坑（务必遵守，详见 references/pitfalls.md）

1. **校验比像素，不比文件字节**——PNG 重编码后字节必不同，逐字节比较永远"不一致"。
2. **spriteOffset 必须是整数**：裁剪框宽/高要与原图宽/高**同奇偶**（打包器已处理，改动裁剪
   逻辑时不可破坏），否则半像素错位，表现为还原校验大量 1px 差异。
3. **managed venv 环境钩子极慢**：每次文件 `open` 多约 350ms。批量 I/O 一律用
   `PYTHONPATH=<venv 的 site-packages> python -S script.py`，600 帧动画 86s → 0.4s。
   venv site-packages 路径示例：`~/.workbuddy/binaries/python/envs/default/lib/python3.13/site-packages`。
4. **合成用 alpha_composite，不用 paste(im, box, im)**（后者 alpha 平方腐蚀软边——这是
   sprite-placement-align 技能的教训，本技能裁剪后 paste 不带 mask，无此问题）。
5. **1×1 占位帧**：保留为 1×1 图块维持帧序（用户要求"移除空帧"时除外）。
6. **长进程可能被 SIGTERM 随机杀**：用 `run_in_background` 跑批量，脚本支持断点续跑。
7. **POT 画布选择**：脚本按"面积 × 长宽比惩罚"选最小画布，避免 512×4096 长条。

## plist 格式要点（cocos2d-v3 / TP format 3）

- `metadata.format = 3`，`textureFileName` 与 png 同名同目录。
- 每帧：`textureRect` `{{x,y},{w,h}}`（图集内位置）、`spriteSourceSize` `{sw,sh}`（原始画布
  尺寸）、`spriteOffset` `{ox,oy}`（裁剪块中心相对原画布中心，y 向下为正）。
- 还原公式：`paste 位置 = (sw/2 + ox - w/2, sh/2 - oy - h/2)`。
- Creator 2.x 直接拖入即识别；**3.x 已改用 .pac 格式**——用户用 3.x 时需先转换，勿直接交付。

## 交付惯例（沿用本项目约定）

- 输出到 `<原分类>_已对齐` 同级的独立目录（如 `帧动画_plist/`），按来源分组建子目录；
- 附 `汇总.csv`（分组/子路径/动画名/帧数/图集尺寸/体积/plist 相对路径）与 `使用说明.md`
  （导入步骤 + 播放代码示例）；
- 图集预览：抽几组贴一张联系表给用户目检；
- 原始帧目录一律不动。

## Resources

### scripts/
- `plist_packer.py` — 打包主脚本（shelf 打包 + alpha 裁剪 + POT 选画布 + 缩放兜底）。
- `verify_plist.py` — 全量校验脚本（帧数/越界/重叠/逐像素还原）。

### references/
- `pitfalls.md` — 完整踩坑记录（奇偶对齐推导、-S 加速原理、缩放判定、校验方法），改动
  脚本前先读。

# -*- coding: utf-8 -*-
"""把「加法混合素材」的黑底转成透明：按亮度反推 alpha + 反预乘还原颜色。
   只处理指定目录下纯黑占比 > 5% 的图（UI 图标里的黑色描边不动）。
   用法: python deblack.py <resources特效目录>   （如 assets/resources/effect）"""
import os, sys, glob, numpy as np
from PIL import Image

GAMMA = 0.8          # 亮度曲线（<1 让光效更实一些）
CUT   = 3.0          # 处理后 alpha 低于此值直接归零（去噪）
FLOOR = 12.0         # 反预乘时的亮度下限（防止把噪声放大）

def black_ratio(im):
    a = np.asarray(im, dtype=np.int16)
    al, lum = a[...,3], a[...,:3].max(axis=2)
    op = al > 250
    n = int(op.sum())
    if n < 200: return 0.0, 0
    return float((op & (lum < 8)).sum())/n*100, n

def convert(im):
    arr = np.asarray(im).astype(np.float32)
    rgb, al = arr[...,:3], arr[...,3]
    lum = rgb.max(axis=2)
    t = (lum/255.0) ** GAMMA
    new_a = np.clip(al * t, 0, 255)
    scale = np.where(lum > 0, 255.0/np.maximum(lum, FLOOR), 0.0)
    new_rgb = np.clip(rgb * scale[..., None], 0, 255)
    new_a = np.where(new_a < CUT, 0.0, new_a)
    return Image.fromarray(np.dstack([new_rgb, new_a]).astype(np.uint8), "RGBA")

root = sys.argv[1] if len(sys.argv) > 1 else "assets/resources/effect"
done, skip = [], []
for p in sorted(glob.glob(os.path.join(root, "**", "*.png"), recursive=True)):
    im = Image.open(p).convert("RGBA")
    r, n = black_ratio(im)
    rel = os.path.relpath(p, root)
    if r <= 5:
        skip.append((rel, r)); continue
    convert(im).save(p, "PNG", optimize=True)
    after, _ = black_ratio(Image.open(p).convert("RGBA"))
    done.append((rel, r, after, os.path.getsize(p)))

print(f"已处理 {len(done)} 张｜跳过（本来就正常）{len(skip)} 张\n")
for rel, b, a, sz in done:
    print(f"  {rel:34s} 纯黑 {b:5.1f}% -> {a:4.1f}%   大小 {sz/1024:6.0f} KB")
if skip:
    print("\n跳过：", ", ".join(os.path.basename(r) for r, _ in skip))

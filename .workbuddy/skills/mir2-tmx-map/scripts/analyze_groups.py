#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析每个分组：主色调分类 + 自身平铺无缝度评分"""
import os
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = "jpg"

def analyze_tile(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im, dtype=np.float32)
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    total = h * w
    green = float(((g > r * 1.05) & (g > b * 1.05)).sum()) / total
    brown = float(((r > g * 1.05) & (g > b * 1.1) & (r > 90)).sum()) / total
    blue = float(((b > r * 1.1) & (b > 60)).sum()) / total
    gray = float(((abs(r - g) < 18) & (abs(g - b) < 18)).sum()) / total
    mean = a.reshape(-1, 3).mean(axis=0)
    # 无缝度：比较左右边缘 / 上下边缘的连续性（把图平铺后检查接缝两侧差异 vs 内部差异）
    left_right = float(np.abs(a[:, 0] - a[:, w - 1]).mean())
    top_bottom = float(np.abs(a[0, :] - a[h - 1, :]).mean())
    inner = float(np.abs(a[:, :-1] - a[:, 1:]).mean())
    seam = (left_right + top_bottom) / 2 / (inner + 1e-6)  # 越接近1越无缝
    return dict(mean=mean, green=green, brown=brown, blue=blue, gray=gray,
                seam=seam, size=(w, h))

def classify(m):
    if m["green"] > 0.45: return "草地"
    if m["blue"] > 0.40: return "水面"
    if m["brown"] > 0.45: return "泥土/沙"
    if m["gray"] > 0.55: return "石头/路"
    if m["mean"][0] > 200 and m["mean"][1] > 200 and m["mean"][2] > 200: return "雪/亮色"
    if m["mean"].mean() < 55: return "暗色/木"
    return "混合"

rows = []
for name in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, name)
    if not os.path.isdir(d) or name == "_预览":
        continue
    files = sorted(f for f in os.listdir(d) if f.lower().endswith(".jpg"))
    if not files:
        continue
    # 用中间瓦片 + 全组平均
    res = [analyze_tile(os.path.join(d, f)) for f in files[:: max(1, len(files)//6)]]
    seam = float(np.mean([r["seam"] for r in res]))
    mean = np.mean([r["mean"] for r in res], axis=0)
    mid = analyze_tile(os.path.join(d, files[len(files)//2]))
    agg = dict(green=float(np.mean([r["green"] for r in res])),
               brown=float(np.mean([r["brown"] for r in res])),
               blue=float(np.mean([r["blue"] for r in res])),
               gray=float(np.mean([r["gray"] for r in res])))
    cls = classify({**agg, "mean": mean})
    rows.append((name, len(files), cls, seam, mean))

print(f"{'分组':>10} {'张数':>4}  {'分类':<8} {'无缝度':>6}   平均RGB")
for name, n, cls, seam, mean in rows:
    flag = "★" if seam < 1.35 else " "
    print(f"{name:>10} {n:>4}  {cls:<8} {seam:>6.2f} {flag}  "
          f"({mean[0]:.0f},{mean[1]:.0f},{mean[2]:.0f})")

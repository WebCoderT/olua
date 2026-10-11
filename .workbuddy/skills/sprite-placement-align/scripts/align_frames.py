#!/usr/bin/env python3
"""
游戏帧动画偏移对齐：将逐帧 PNG + Placements/*.txt 偏移数据合成为统一画布的对齐帧。

约定：txt 中两行数值为该帧图片"左上角"相对锚点的绘制坐标（屏幕坐标系，y 向下为正）。
用法：
    python align_frames.py <帧目录> [--out 输出目录名] [--gif 预览.gif] [--fps 10] [--half]
默认在帧目录下生成"已对齐帧"文件夹和 预览.gif。
依赖：Pillow（venv: /Users/tz/.workbuddy/binaries/python/envs/default/bin/python3）
"""
import argparse
import glob
import os
import shutil
import sys

from PIL import Image
import numpy as np


def find_pairs(root):
    """匹配帧 PNG 与偏移 txt。txt 优先取 Placements/<同名>.txt，若无 Placements 则取同目录 <同名>.txt。"""
    placement_dir = os.path.join(root, "Placements")
    pairs = []
    frames = [f for f in os.listdir(root)
              if f.lower().endswith((".png", ".bmp"))]
    for name in sorted(frames):
        p = os.path.join(root, name)
        idx = os.path.splitext(os.path.basename(p))[0]
        txt = os.path.join(placement_dir, idx + ".txt")
        if not os.path.exists(txt):
            txt = os.path.join(root, idx + ".txt")
        if os.path.exists(txt):
            pairs.append((idx, p, txt))
    if not pairs:
        sys.exit("错误: 未找到任何 PNG 与 txt 的配对")
    return pairs


def find_roots(root, out_name="已对齐帧"):
    """确定待处理目录：优先 root 自身；否则递归遍历子目录，收集含帧文件的目录（批量模式，支持任意深度）。"""
    if os.path.isdir(os.path.join(root, "Placements")) or _has_pairs(root):
        return [root]
    subs = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".") and d != out_name]
        if dirpath != root and filenames and any(
                f.lower().endswith((".png", ".bmp")) for f in filenames):
            subs.append(dirpath)
            dirnames[:] = []  # 已是处理单元，不再深入
    if not subs:
        sys.exit(f"错误: {root} 及其子目录下均未找到帧与偏移数据")
    return subs


def _has_pairs(d):
    """目录中是否存在帧文件（有帧即认为有配对可能，具体在 find_pairs 校验）。"""
    return any(f.lower().endswith((".png", ".bmp")) for f in os.listdir(d))


def to_rgba(im):
    """转 RGBA；8 位调色板 BMP 无透明信息时，将调色板索引 0 作为键色置为透明（游戏引擎惯例）。"""
    if im.mode == "P" and "transparency" not in im.info:
        rgba = im.convert("RGBA")
        a = np.array(im)
        alpha = np.where(a == 0, 0, 255).astype("uint8")
        arr = np.array(rgba)
        arr[:, :, 3] = alpha
        return Image.fromarray(arr)
    return im.convert("RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="帧 PNG 与 Placements 所在目录（含 Placements 则处理该目录，否则批量处理所有含 Placements 的子目录）")
    ap.add_argument("--out", default="已对齐帧", help="输出文件夹名（默认: 已对齐帧）")
    ap.add_argument("--gif", default="预览.gif", help="预览 GIF 文件名（空字符串跳过）")
    ap.add_argument("--fps", type=float, default=10.0, help="预览 GIF 帧率")
    ap.add_argument("--half", action="store_true", help="GIF 用半尺寸")
    ap.add_argument("--stride", type=int, default=1, help="GIF 每隔几帧取一帧（大帧数用 2/3 减小体积）")
    ap.add_argument("--drop-empty", action="store_true", help="移除占位空帧（≤5px）而不复制到输出目录")
    args = ap.parse_args()

    for root in find_roots(args.root, args.out):
        print(f"=== 处理 {root}")
        process_one(root, args)


def process_one(root, args):
    pairs = find_pairs(root)

    # Pass 1: 读取偏移与尺寸，计算统一画布（仅统计真实帧）
    metas = []
    x0 = y0 = 10**9
    x1 = y1 = -10**9
    for idx, png, txt in pairs:
        vals = [int(float(v)) for v in open(txt).read().split()]
        if len(vals) < 2:
            sys.exit(f"错误: {txt} 数值不足两个")
        im = Image.open(png)
        metas.append((idx, vals[0], vals[1], to_rgba(im), png))
        w, h = im.size
        if w > 5 and h > 5:  # 跳过占位空帧
            x0 = min(x0, vals[0]); y0 = min(y0, vals[1])
            x1 = max(x1, vals[0] + w); y1 = max(y1, vals[1] + h)
    W, H = x1 - x0, y1 - y0
    print(f"画布 {W}x{H}，锚点位于 ({-x0},{-y0})，共 {len(metas)} 帧")

    # Pass 2: 合成
    out_dir = os.path.join(root, args.out)
    os.makedirs(out_dir, exist_ok=True)
    out_frames = []
    for idx, x, y, im, src_path in metas:
        w, h = im.size
        if w <= 5 or h <= 5:  # 占位空帧：复制或按选项移除
            if args.drop_empty:
                print(f"{idx}: 占位空帧，已移除")
            else:
                shutil.copyfile(src_path, os.path.join(out_dir, idx + ".png"))
                print(f"{idx}: 占位空帧，直接复制")
            continue
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        # 必须用 alpha_composite（正确的 source-over）。
        # 不可用 canvas.paste(im, box, im)：PIL 会把 RGBA 掩码当逐通道混合因子，
        # 导致 alpha 被平方（如 128→64、1~15→0），软边像素被腐蚀。
        canvas.alpha_composite(im, (x - x0, y - y0))
        canvas.save(os.path.join(out_dir, idx + ".png"))
        out_frames.append(canvas)
        print(f"{idx}: offset=({x},{y}) -> ({x-x0},{y-y0})")

    # Pass 3: 预览 GIF
    if args.gif and out_frames:
        frames = out_frames
        if args.stride > 1:
            frames = frames[::args.stride]
        if args.half:
            frames = [f.resize((f.width // 2, f.height // 2)) for f in frames]
        frames[0].save(
            os.path.join(root, args.gif),
            save_all=True, append_images=frames[1:],
            duration=int(1000 / args.fps), loop=0, disposal=2,
        )
        print(f"预览已生成: {args.gif}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
校验 plist 图集输出：帧数一致、无越界、无重叠、逐像素还原（scale=1.0 时必须完全一致）。

用法:
    python3 verify_plist.py <输出根目录> <源根目录> [--map 组名=源子目录,组名=源子目录]

规则:
    输出根目录下每个含 .plist 的目录视为一个动画，其相对路径去掉第一层"组名"后，
    在 源根目录/<组名映射或组名>/ 下找到同名原始帧目录。
    例: 输出 帧动画_plist/npc/npc_2109/npc_2109.plist
        --map npc=npc_已对齐  →  源帧目录 <源根>/npc_已对齐/npc_2109/
    未在 --map 中的组名直接作为源根目录下的子目录名。

只比较 alpha>0 的像素（原始完全透明处不要求一致）；scale<1 的图集允许重采样差异，
脚本会按 spriteSourceSize/原图尺寸 推断 scale 并标注"缩放图集差异"。
"""
import argparse
import os
import plistlib

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def rect(s):
    s = s.strip("{}")
    a, b = s.split("},{")
    x, y = map(int, a.split(","))
    w, h = map(int, b.split(","))
    return x, y, w, h


def pt(s):
    x, y = map(float, s.strip("{}").split(","))
    return x, y


def find_plists(out_root):
    for dirpath, dirnames, filenames in os.walk(out_root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.endswith(".plist"):
                yield dirpath, f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_root")
    ap.add_argument("src_root")
    ap.add_argument("--map", default="",
                    help="组名=源子目录 逗号分隔，如 npc=npc_已对齐,光柱=光柱_已对齐")
    ap.add_argument("--skip-dir", default="", help="输出目录中跳过的目录名（如 _高清8192）")
    args = ap.parse_args()

    mapping = {}
    if args.map:
        for pair in args.map.split(","):
            k, v = pair.split("=", 1)
            mapping[k.strip()] = v.strip()
    skip = {args.skip_dir} if args.skip_dir else set()

    bad = []
    total_anim = total_frames = 0
    for dirpath, plf in find_plists(args.out_root):
        rel = os.path.relpath(dirpath, args.out_root)
        parts = rel.split(os.sep)
        if any(p in skip for p in parts):
            continue
        group = parts[0]
        sub = parts[1:]
        src = os.path.join(args.src_root, mapping.get(group, group), *sub)
        name = os.path.splitext(plf)[0]
        pl = plistlib.load(open(os.path.join(dirpath, plf), "rb"))
        frames = pl["frames"]
        W, H = map(int, pl["metadata"]["size"].strip("{}").split(","))
        total_anim += 1
        total_frames += len(frames)
        problems = []

        # 1) 帧数与源目录一致
        src_files = sorted(f for f in os.listdir(src)
                           if f.lower().endswith((".png", ".bmp")))
        if len(src_files) != len(frames):
            problems.append(f"帧数不符 {len(frames)} vs {len(src_files)}")

        # 2) 越界 + 重叠
        rects = []
        for nm, info in frames.items():
            x, y, w, h = rect(info["textureRect"])
            if x < 0 or y < 0 or x + w > W or y + h > H:
                problems.append(f"{nm} 越界")
            rects.append((x, y, w, h))
        rects.sort()
        for i in range(len(rects) - 1):
            x1, y1, w1, h1 = rects[i]
            x2, y2, w2, h2 = rects[i + 1]
            if x2 < x1 + w1 and y1 < y2 + h2 and y2 < y1 + h1:
                problems.append("图块重叠")
                break

        # 3) 逐像素还原（只比 alpha>0 区域）
        atlas = Image.open(os.path.join(dirpath,
                           pl["metadata"]["textureFileName"])).convert("RGBA")
        hi = 0
        scale = 1.0
        for nm in src_files:
            if nm not in frames:
                continue
            info = frames[nm]
            x, y, w, h = rect(info["textureRect"])
            ox, oy = pt(info["spriteOffset"])
            sw, sh = map(int, info["spriteSourceSize"].strip("{}").split(","))
            cv = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
            cv.alpha_composite(atlas.crop((x, y, x + w, y + h)),
                               (int(sw / 2 + ox - w / 2), int(sh / 2 - oy - h / 2)))
            o = Image.open(os.path.join(src, nm)).convert("RGBA")
            if o.size != (sw, sh):
                scale = sw / o.size[0]
                o = o.resize((sw, sh), Image.LANCZOS)
            a = np.array(cv)
            b = np.array(o)
            if a.shape == b.shape:
                m = b[:, :, 3] > 0
                if not np.array_equal(a[m], b[m]):
                    hi += 1
            else:
                hi += 1
        if hi:
            if scale != 1.0:
                problems.append(f"缩放图集差异 {hi} 帧 (scale={scale:.2f}，重采样属预期)")
            else:
                problems.append(f"还原异常 {hi} 帧")
        if problems:
            bad.append((rel, problems[:3]))
            print("BAD", rel, problems[:3], flush=True)

    print(f"校验完成: {total_anim} 个动画, {total_frames} 帧, 异常 {len(bad)} 个", flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())

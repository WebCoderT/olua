#!/usr/bin/env python3
"""
把逐帧动画打包成 Cocos Creator 可用的图集：一张 PNG + 一个 plist（cocos2d-v3 / TexturePacker format 3）。

用法:
    python3 plist_packer.py <动画根目录> <输出根目录> [--max 4096] [--pad 2] [--force] [--only 子路径前缀]

目录约定:
    动画根目录下每个"含图片文件的目录"视为一个动画（不递归进入子动画）。
    输出: <输出根目录>/<相对路径>/<目录名>.png + .plist
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SKIP_DIRS = {"_预览", "Placements", ".git"}


# ---------- 扫描 ----------
def find_animations(root, only=None):
    anims = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
        imgs = [f for f in filenames if f.lower().endswith((".png", ".bmp"))]
        if imgs:
            rel = os.path.relpath(dirpath, root)
            if only and not rel.startswith(only):
                dirnames[:] = []
                continue
            anims.append((dirpath, rel, sorted(imgs)))
            dirnames[:] = []
    return anims


# ---------- 打包 ----------
def shelf_pack(items, bin_w, pad):
    """items: [(w,h,idx)] 已按 h 降序。返回 {idx:(x,y)} 与所需高度。"""
    x = y = rowh = 0
    pos = {}
    for w, h, idx in items:
        if x + w > bin_w:
            x = 0
            y += rowh + pad
            rowh = 0
        pos[idx] = (x, y)
        x += w + pad
        rowh = max(rowh, h)
    return pos, y + rowh


def choose_layout(items, max_side, pad):
    """在 max_side 内找面积最小的 2 次幂画布。返回 (W,H,pos) 或 None。"""
    best = None
    min_w = max(w for w, _, _ in items) + pad
    w = 256
    while w < min_w:
        w *= 2
    while w <= max_side:
        pos, need_h = shelf_pack(items, w, pad)
        h = 1
        while h < need_h:
            h *= 2
        if h <= max_side:
            area = w * h
            # 长条图集对显存/mipmap 不友好：按长宽比偏离 1:1 的程度加权
            aspect_penalty = 1.0 + 0.6 * abs(math.log2(w / h))
            score = area * aspect_penalty
            if best is None or score < best[0]:
                best = (score, w, h, pos)
        w *= 2
    if best is None:
        return None
    _, W, H, pos = best
    return W, H, pos


def make_plist(frames, W, H, texture_name):
    """frames: [(name, x, y, w, h, offx, offy, srcw, srch)]"""
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
               '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">')
    out.append('<plist version="1.0">')
    out.append('<dict>')
    out.append('\t<key>frames</key>')
    out.append('\t<dict>')
    for name, x, y, w, h, ox, oy, sw, sh in frames:
        out.append(f'\t\t<key>{escape(name)}</key>')
        out.append('\t\t<dict>')
        out.append('\t\t\t<key>aliases</key>')
        out.append('\t\t\t<array/>')
        out.append('\t\t\t<key>spriteOffset</key>')
        out.append(f'\t\t\t<string>{{{ox},{oy}}}</string>')
        out.append('\t\t\t<key>spriteSize</key>')
        out.append(f'\t\t\t<string>{{{w},{h}}}</string>')
        out.append('\t\t\t<key>spriteSourceSize</key>')
        out.append(f'\t\t\t<string>{{{sw},{sh}}}</string>')
        out.append('\t\t\t<key>textureRect</key>')
        out.append(f'\t\t\t<string>{{{{{x},{y}}},{{{w},{h}}}}}</string>')
        out.append('\t\t\t<key>textureRotated</key>')
        out.append('\t\t\t<false/>')
        out.append('\t\t</dict>')
    out.append('\t</dict>')
    out.append('\t<key>metadata</key>')
    out.append('\t<dict>')
    out.append('\t\t<key>format</key>')
    out.append('\t\t<integer>3</integer>')
    out.append('\t\t<key>pixelFormat</key>')
    out.append('\t\t<string>RGBA8888</string>')
    out.append('\t\t<key>premultiplyAlpha</key>')
    out.append('\t\t<false/>')
    out.append('\t\t<key>realTextureFileName</key>')
    out.append(f'\t\t<string>{escape(texture_name)}</string>')
    out.append('\t\t<key>size</key>')
    out.append(f'\t\t<string>{{{W},{H}}}</string>')
    out.append('\t\t<key>smartupdate</key>')
    digest = hashlib.md5(f"{texture_name}:{W}x{H}:{len(frames)}".encode()).hexdigest()
    out.append(f'\t\t<string>$TexturePacker:SmartUpdate:{digest}$</string>')
    out.append('\t\t<key>textureFileName</key>')
    out.append(f'\t\t<string>{escape(texture_name)}</string>')
    out.append('\t</dict>')
    out.append('</dict>')
    out.append('</plist>')
    out.append('')
    return "\n".join(out)


def process(anim_dir, rel, files, out_root, max_side, pad, force):
    name = os.path.basename(anim_dir)
    out_dir = os.path.join(out_root, rel) if rel != "." else os.path.join(out_root, name)
    png_path = os.path.join(out_dir, name + ".png")
    plist_path = os.path.join(out_dir, name + ".plist")
    if not force and os.path.exists(png_path) and os.path.exists(plist_path):
        return None

    t0 = time.time()
    # Pass 1: 尺寸、裁剪框，并缓存裁剪后的图（裁后面积小，内存可控）
    metas = []
    total_area = 0
    for f in files:
        p = os.path.join(anim_dir, f)
        with Image.open(p) as im:
            w, h = im.size
            rgba = im.convert("RGBA")
            bb = rgba.getchannel("A").getbbox()
            if bb is None:
                bx = max(0, (w - 1) // 2)
                by = max(0, (h - 1) // 2)
                bw = bh = 1
            else:
                bx, by, bx1, by1 = bb
                bw, bh = max(1, bx1 - bx), max(1, by1 - by)
            # 让 spriteOffset 落在整数像素：需 bx + bw/2 - w/2 为整数
            # 即 bw 与 w 同奇偶（2*bx、w 的奇偶决定），否则扩大 1px
            if (bw - w) % 2:
                if bx + bw < w:
                    bw += 1
                elif bx > 0:
                    bx -= 1
                    bw += 1
            if (bh - h) % 2:
                if by + bh < h:
                    bh += 1
                elif by > 0:
                    by -= 1
                    bh += 1
            if bw > w - bx:
                bw = w - bx
            if bh > h - by:
                bh = h - by
            crop = rgba.crop((bx, by, bx + bw, by + bh))
        metas.append({"file": f, "w": w, "h": h, "bx": bx, "by": by,
                      "bw": bw, "bh": bh, "crop": crop})
        total_area += bw * bh

    # 先估算是否必须缩放（面积 + 15% 间隙开销）
    scale = 1.0
    if total_area * 1.15 > max_side * max_side * 0.92:
        scale = math.sqrt(max_side * max_side * 0.85 / total_area)
        scale = min(1.0, math.floor(scale * 100) / 100)

    W = H = 0
    pos = None
    for attempt in range(8):
        items = []
        for i, m in enumerate(metas):
            bw = max(1, int(round(m["bw"] * scale)))
            bh = max(1, int(round(m["bh"] * scale)))
            items.append((bw, bh, i))
        items.sort(key=lambda t: (-t[1], -t[0]))
        layout = choose_layout(items, max_side, pad)
        if layout:
            W, H, pmap = layout
            pos = pmap  # shelf_pack 已按原始帧序号 i 建索引
            break
        scale *= 0.85
    if pos is None:
        raise RuntimeError(f"无法装入 {max_side}px 图集: {anim_dir}")

    # Pass 2: 合成
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    frames = []
    for i, m in enumerate(metas):
        bw = max(1, int(round(m["bw"] * scale)))
        bh = max(1, int(round(m["bh"] * scale)))
        x, y = pos[i]
        crop = m["crop"]
        if (bw, bh) != crop.size:
            crop = crop.resize((bw, bh), Image.LANCZOS)
        canvas.paste(crop, (x, y))
        ox = round((m["bx"] + m["bw"] / 2 - m["w"] / 2) * scale)
        oy = round((m["h"] / 2 - (m["by"] + m["bh"] / 2)) * scale)
        sw = max(1, int(round(m["w"] * scale)))
        sh = max(1, int(round(m["h"] * scale)))
        frames.append((m["file"], x, y, bw, bh, int(ox), int(oy), sw, sh))

    os.makedirs(out_dir, exist_ok=True)
    canvas.save(png_path, optimize=False, compress_level=6)
    with open(plist_path, "w", encoding="utf-8") as fp:
        fp.write(make_plist(frames, W, H, name + ".png"))

    return {
        "path": rel,
        "name": name,
        "frames": len(frames),
        "atlas": f"{W}x{H}",
        "scale": round(scale, 3),
        "png_kb": round(os.path.getsize(png_path) / 1024),
        "sec": round(time.time() - t0, 1),
    }


def _worker(task):
    d, rel, files, out_root, max_side, pad, force = task
    try:
        return rel, process(d, rel, files, out_root, max_side, pad, force), None
    except Exception as e:  # noqa: BLE001
        return rel, None, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("out")
    ap.add_argument("--max", type=int, default=4096)
    ap.add_argument("--pad", type=int, default=2)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default=None)
    ap.add_argument("--jobs", type=int, default=1)
    args = ap.parse_args()

    anims = find_animations(args.root, args.only)
    print(f"共 {len(anims)} 个动画", flush=True)
    results = []
    fails = []
    tasks = [(d, rel, files, args.out, args.max, args.pad, args.force)
             for d, rel, files in anims]

    if args.jobs > 1:
        from multiprocessing import Pool
        with Pool(args.jobs) as pool:
            for k, (rel, r, err) in enumerate(pool.imap_unordered(_worker, tasks, chunksize=1), 1):
                if err:
                    fails.append((rel, err))
                    print(f"[{k}/{len(tasks)}] FAIL {rel}: {err}", flush=True)
                elif r:
                    results.append(r)
                    print(f"[{k}/{len(tasks)}] {rel} -> {r['atlas']} {r['frames']}帧 "
                          f"scale={r['scale']} {r['png_kb']}KB {r['sec']}s", flush=True)
                else:
                    print(f"[{k}/{len(tasks)}] skip {rel}", flush=True)
    else:
        for k, (d, rel, files) in enumerate(anims, 1):
            try:
                r = process(d, rel, files, args.out, args.max, args.pad, args.force)
            except Exception as e:  # noqa: BLE001
                fails.append((rel, str(e)))
                print(f"[{k}/{len(anims)}] FAIL {rel}: {e}", flush=True)
                continue
            if r:
                results.append(r)
                print(f"[{k}/{len(anims)}] {rel} -> {r['atlas']} {r['frames']}帧 "
                      f"scale={r['scale']} {r['png_kb']}KB {r['sec']}s", flush=True)
            else:
                print(f"[{k}/{len(anims)}] skip {rel}", flush=True)

    summary = os.path.join(args.out, "_汇总.json")
    if results:
        old = []
        if os.path.exists(summary):
            try:
                old = json.load(open(summary, encoding="utf-8"))
            except Exception:
                old = []
        merged = {r["path"]: r for r in old}
        merged.update({r["path"]: r for r in results})
        json.dump(sorted(merged.values(), key=lambda x: x["path"]), open(summary, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    print(f"完成 {len(results)} 个，失败 {len(fails)} 个", flush=True)


if __name__ == "__main__":
    main()

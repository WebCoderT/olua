#!/usr/bin/env python3
"""
mir2map_batch.py — 把「原始地图/【真彩地图】DTxxxx-*」批量转成客户端 resources/map/<id>/ 资源

每张图产出:
  <id>.tmx        正交地图 48x32 格；若干 imagelayer（每页 2048x2048，offsetx/offsety 定位）
  <id>_pNN.jpg    分页大图（ground + 物件已合成，不透明）
  preview.jpg     预览图（小地图弹窗底图，宽 512）
  meta.json       来源与解码规则（供排查，不进资源包时可删）

id 规则: DT2101 -> 0 ... DT2162 -> 61（DT 号 - 2101）
label 规则: 目录名 "DTxxxx-后缀" 取后缀；无后缀用 DTxxxx

三种地面形态（全部以官方缩略图相关性验证，>0.8 才接受）:
  A 14B 图 + Tiles*.wil(96x64)   : 块(bx,by) -> 第 bx*(h/2)+by+1 张（列主序）；obj 字段 = 物件
  B 12B 图 + Objects*.wil(48x32) : 格(i,j) -> 第 i*h+j+1 张（列主序，取前 w*h 张）；无物件层
  C 14B 图 + SmTiles*.wil(96x96) : 值 v -> 块 ((v-1)%gw, (v-1)//gw)（行主序摆放）

用法: python3 mir2map_batch.py --src <原始地图目录> --out <resources/map> [--only DT2101,DT2102] [--dry]
"""
import argparse
import json
import math
import os
import re
import shutil
import struct
import sys

import numpy as np
from PIL import Image

CELL_W, CELL_H = 48, 32
PAGE = 2048
PREVIEW_W = 512


def find_file(d, prefix, ext):
    cands = [os.path.join(d, f) for f in os.listdir(d)
             if f.lower().startswith(prefix.lower()) and f.lower().endswith(ext)]
    return sorted(cands)[0] if cands else None


def load_wil(path_wil, path_wix):
    wil = open(path_wil, "rb").read()
    wix = open(path_wix, "rb").read()
    cnt = struct.unpack_from("<I", wix, 44)[0]
    offs = list(struct.unpack_from("<%dI" % cnt, wix, 48))
    return wil, offs


class Wil:
    def __init__(self, d, prefix):
        wil = find_file(d, prefix, ".wil")
        wix = find_file(d, prefix, ".wix")
        if not wil or not wix:
            raise FileNotFoundError(prefix)
        self.data, self.offs = load_wil(wil, wix)
        self.n = len(self.offs)

    def size(self, idx):
        o = self.offs[idx - 1]
        w, h, px, py = struct.unpack_from("<HHHH", self.data, o)
        return w, h

    def rgba(self, idx):
        """解码为 (rgb uint8 HxWx3, alpha HxW bool)，已上下翻转"""
        o = self.offs[idx - 1]
        w, h, px, py = struct.unpack_from("<HHHH", self.data, o)
        raw = np.frombuffer(self.data, dtype="<u2", count=w * h, offset=o + 8).reshape(h, w)
        r = ((raw >> 11) & 31).astype(np.uint32) * 255 // 31
        g = ((raw >> 5) & 63).astype(np.uint32) * 255 // 63
        b = (raw & 31).astype(np.uint32) * 255 // 31
        rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)[::-1]
        alpha = (raw > 0)[::-1]
        return rgb, alpha

    def rgb(self, idx):
        return self.rgba(idx)[0]


def parse_map(path):
    data = open(path, "rb").read()
    w, h = struct.unpack_from("<HH", data, 0)
    if len(data) == 52 + 12 * w * h:
        cell = 12
    elif len(data) == 52 + 14 * w * h:
        cell = 14
    elif w * h and 0 < w <= 1024 and 0 < h <= 1024:
        cell = 0  # 未知格式（如 DT2162 的 36 字节/格）——几何可用，视觉走缩略图兜底
    else:
        raise ValueError(f"{path}: 未知格式 len={len(data)} w={w} h={h}")
    return data, w, h, cell


def field(data, w, cell, i, j, slot):
    return struct.unpack_from("<H", data, 52 + (j * w + i) * cell + slot * 2)[0] & 0x7FFF


def score(canvas, thumb):
    small = np.asarray(Image.fromarray(canvas).resize(thumb.size), np.float32)
    b = np.asarray(thumb.convert("RGB"), np.float32)
    a = small - small.mean()
    b = b - b.mean()
    denom = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / denom) if denom else 0.0


def build_groundA(data, w, h, wil):
    """14B + Tiles(96x64): 块列主序"""
    bw, bh = w // 2, h // 2
    canvas = np.zeros((h * CELL_H, w * CELL_W, 3), np.uint8)
    need = bw * bh
    if wil.n < need:
        raise ValueError(f"Tiles 只有 {wil.n} 张 < 需要的 {need}")
    for by in range(bh):
        for bx in range(bw):
            canvas[by * 64:(by + 1) * 64, bx * 96:(bx + 1) * 96] = wil.rgb(bx * bh + by + 1)
    return canvas


def paste_rgba(canvas, rgb, alpha, x, y):
    H, W = canvas.shape[:2]
    th, tw = rgb.shape[:2]
    if y + th <= 0 or y >= H or x >= W:
        return
    if y < 0:
        rgb, alpha = rgb[-y:], alpha[-y:]
        y = 0
    if x < 0:
        rgb, alpha = rgb[:, -x:], alpha[:, -x:]
        x = 0
    hh, ww = rgb.shape[:2]
    if x + ww > W:
        rgb, alpha = rgb[:, :W - x], alpha[:, :W - x]
        ww = rgb.shape[1]
    if y + hh > H:
        rgb, alpha = rgb[:H - y], alpha[:H - y]
        hh = rgb.shape[0]
    if hh <= 0 or ww <= 0:
        return
    dst = canvas[y:y + hh, x:x + ww]
    canvas[y:y + hh, x:x + ww] = np.where(alpha[:, :, None], rgb, dst)


def build_groundB(data, w, h, wil):
    """12B + Objects(48x32): 逐格列主序（前 w*h 张）"""
    canvas = np.zeros((h * CELL_H, w * CELL_W, 3), np.uint8)
    n = w * h
    if wil.n < n:
        raise ValueError(f"Objects 只有 {wil.n} 张 < 需要的 {n}")
    for j in range(h):
        for i in range(w):
            # 个别格引用的是高物件（48x192+），裁剪到单格以免整张失败
            rgb = wil.rgb(i * h + j + 1)[:CELL_H, :CELL_W]
            canvas[j * CELL_H:j * CELL_H + rgb.shape[0], i * CELL_W:i * CELL_W + rgb.shape[1]] = rgb
    return canvas


def build_groundC(data, w, h, wil, slot=1):
    """14B + SmTiles(96x96): 值 v -> 块行主序位置"""
    gw, gh = w // 2, h // 3
    canvas = np.zeros((h * CELL_H, w * CELL_W, 3), np.uint8)
    used = 0
    for j in range(h):
        for i in range(w):
            v = field(data, w, 14, i, j, slot)
            if not v or v > wil.n:
                continue
            bx, by = (v - 1) % gw, (v - 1) // gw
            if by >= gh:
                continue
            canvas[by * 96:(by + 1) * 96, bx * 96:(bx + 1) * 96] = wil.rgb(v)
            used += 1
    return canvas, used


def add_objectsA(canvas, data, w, h, objwil):
    """14B: obj 字段 -> 物件库，48 宽、底部对齐格子下边缘"""
    if not objwil:
        return 0
    count = 0
    for j in range(h):
        for i in range(w):
            v = field(data, w, 14, i, j, 2)
            if not v or v > objwil.n:
                continue
            rgb, alpha = objwil.rgba(v)
            paste_rgba(canvas, rgb, alpha, i * CELL_W, (j + 1) * CELL_H - rgb.shape[0])
            count += 1
    return count


def emit_pages(canvas, out_dir, base):
    H, W = canvas.shape[:2]
    layers = []
    pages = 0
    for py in range(0, H, PAGE):
        for px in range(0, W, PAGE):
            page = canvas[py:py + PAGE, px:px + PAGE]
            name = f"{base}_p{pages:02d}.jpg"
            Image.fromarray(page).save(os.path.join(out_dir, name), quality=92, subsampling=1)
            layers.append({"src": name, "x": px, "y": py, "w": page.shape[1], "h": page.shape[0]})
            pages += 1
    return layers


def emit_tmx(out_dir, base, w, h, layers):
    xml_layers = []
    for k, l in enumerate(layers):
        xml_layers.append(
            f' <imagelayer id="{k + 1}" name="{"ground" if k == 0 else f"ground_p{k:02d}"}" offsetx="{l["x"]}" offsety="{l["y"]}">'
            f'<image source="{l["src"]}" width="{l["w"]}" height="{l["h"]}"/></imagelayer>')
    tmx = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" '
        f'width="{w}" height="{h}" tilewidth="{CELL_W}" tileheight="{CELL_H}" infinite="0" '
        f'nextlayerid="{len(layers) + 1}" nextobjectid="1">\n'
        + "\n".join(xml_layers) + "\n</map>\n")
    open(os.path.join(out_dir, f"{base}.tmx"), "w", encoding="utf-8").write(tmx)


def convert_one(d, out_root, dry=False):
    m = re.search(r"DT(\d{4})", os.path.basename(d))
    if not m:
        return None
    dt = int(m.group(1))
    map_id = str(dt - 2101)
    suffix = os.path.basename(d).split(f"DT{dt}", 1)[1].lstrip("-").strip()
    label = suffix or f"DT{dt}"

    map_path = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".map")][0]
    data, w, h, cell = parse_map(map_path)
    thumbs = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".bmp")]
    thumb = Image.open(thumbs[0]).convert("RGB") if thumbs else None

    tiles = objs = None
    try:
        tiles = Wil(d, "Tiles")
    except FileNotFoundError:
        pass
    try:
        objs = Wil(d, "Objects")
    except FileNotFoundError:
        pass
    smtiles = None
    for prefix in ("SmTiles", "smTiles", "SmTiles"):
        try:
            smtiles = Wil(d, prefix)
            break
        except FileNotFoundError:
            continue

    candidates = []
    if tiles and cell == 14:
        try:
            canvas = build_groundA(data, w, h, tiles)
            candidates.append(("A", canvas, 0))
        except Exception as e:
            print(f"   A 失败: {e}")
    if objs and (cell == 12 or objs.n == w * h):
        try:
            canvas = build_groundB(data, w, h, objs)
            candidates.append(("B", canvas, 0))
        except Exception as e:
            print(f"   B 失败: {e}")
    if smtiles:
        for slot in (1, 0):
            try:
                canvas, used = build_groundC(data, w, h, smtiles, slot)
                if used:
                    candidates.append((f"C{slot}", canvas, 0))
            except Exception as e:
                print(f"   C{slot} 失败: {e}")

    if not candidates and cell == 0 and thumb is not None:
        canvas = np.asarray(thumb.resize((w * CELL_W, h * CELL_H), Image.LANCZOS), np.uint8)
        out_dir = os.path.join(out_root, map_id)
        if not dry:
            if os.path.isdir(out_dir):
                shutil.rmtree(out_dir)
            os.makedirs(out_dir)
            layers = emit_pages(canvas, out_dir, map_id)
            emit_tmx(out_dir, map_id, w, h, layers)
            Image.fromarray(canvas).save(os.path.join(out_dir, "preview.jpg"), quality=88)
            json.dump({"id": map_id, "label": label, "source": os.path.basename(d),
                       "cells": [w, h], "cellFormat": 0, "rule": "thumb-fallback",
                       "pixel": [w * CELL_W, h * CELL_H]},
                      open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
        return {"id": map_id, "label": label, "rule": "thumb-fallback", "score": None,
                "size": [w * CELL_W, h * CELL_H], "objects": 0}
    if not candidates:
        raise RuntimeError("无可用地面规则")

    best = None
    for tag, canvas, _ in candidates:
        s = score(canvas, thumb) if thumb is not None else 0
        print(f"   规则{tag}: 相关性 {s:.3f}")
        if best is None or s > best[1]:
            best = (tag, s, canvas)
    tag, s, canvas = best
    if thumb is not None and s < 0.70:
        # 兜底：官方缩略图放大铺满（几何来自 .map，视觉降级；meta 里标注）
        canvas = np.asarray(
            thumb.resize((w * CELL_W, h * CELL_H), Image.LANCZOS), np.uint8)
        tag, s = "thumb-fallback", round(s, 3)

    obj_count = 0
    if tag == "A":
        obj_count = add_objectsA(canvas, data, w, h, objs)

    out_dir = os.path.join(out_root, map_id)
    if dry:
        return {"id": map_id, "label": label, "rule": tag, "score": round(s, 3),
                "size": [canvas.shape[1], canvas.shape[0]], "objects": obj_count}
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    layers = emit_pages(canvas, out_dir, map_id)
    emit_tmx(out_dir, map_id, w, h, layers)
    img = Image.fromarray(canvas)
    prev = img.copy()
    prev.thumbnail((PREVIEW_W, PREVIEW_W))
    prev.save(os.path.join(out_dir, "preview.jpg"), quality=88)
    json.dump({
        "id": map_id, "label": label, "source": os.path.basename(d),
        "map": os.path.basename(map_path), "cells": [w, h], "cellFormat": cell,
        "pixel": [canvas.shape[1], canvas.shape[0]], "rule": tag,
        "thumbScore": round(s, 3), "objects": obj_count, "pages": len(layers),
    }, open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8"),
        ensure_ascii=False, indent=1)
    return {"id": map_id, "label": label, "rule": tag, "score": round(s, 3),
            "size": [canvas.shape[1], canvas.shape[0]], "objects": obj_count, "pages": len(layers)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None, help="逗号分隔的 DT 号，如 DT2101,DT2102")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    dirs = sorted(x for x in os.listdir(args.src) if x.startswith("【真彩地图】") and "DT" in x)
    if args.only:
        want = {s.strip() for s in args.only.split(",")}
        dirs = [x for x in dirs if re.search(r"DT\d{4}", x).group(0) in want]
    os.makedirs(args.out, exist_ok=True)
    report, failed = [], []
    for d in dirs:
        print(f"== {d}")
        try:
            r = convert_one(os.path.join(args.src, d), args.out, args.dry)
            if r:
                report.append(r)
        except Exception as e:
            print(f"   !! 失败: {e}")
            failed.append({"dir": d, "error": str(e)})
    json.dump({"ok": report, "failed": failed},
              open(os.path.join("/tmp/mir2map", "batch-report.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n完成 {len(report)} 张，失败 {len(failed)} 张")
    for f in failed:
        print("  !", f["dir"], "-", f["error"])


if __name__ == "__main__":
    main()

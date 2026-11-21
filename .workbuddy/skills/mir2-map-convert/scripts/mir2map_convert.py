#!/usr/bin/env python3
"""
mir2map_convert.py — 传奇2 WEMADE「真彩地图」.map + WIL/WIX → 大图 PNG / TMX / meta.json

用法:
  python3 mir2map_convert.py --dir <地图目录> [--out <输出目录>] [--name <基准名>] [--export-tiles]

输入目录需包含:
  *.map                    地图数据
  Tiles*.wil + Tiles*.wix  地面大瓦片库（每张 96x64，张数 == (w/2)*(h/2) 时为专用库）
  Objects*.wil + Objects*.wix  物件库（可选）

解码规则（已用官方缩略图相关性 0.949 + 接缝连续性 + 肉眼验证）:
  .map  头部 52 字节，w=u16@0, h=u16@2；每格 14 字节 = bg(2)/mid(2)/obj(2)+8 标志；
        索引取低 15 位（&0x7FFF），1 基，0=无；高位 0x8000 恒置。
        bg 字段是旧版 48x32 小瓦片的遗留（真彩图里大量 0 但地面铺满，勿用）。
  地面  w/2 x h/2 个 96x64 块，块(bx,by) → Tiles WIL 第 bx*(h/2)+by+1 张（列主序！）。
        瓦片行自下而上存储 → 绘制前 transpose(FLIP_TOP_BOTTOM)。
  WIX   44 字节标题 + count=u32@44 + 偏移数组@48（int32 LE）。
  WIL   每图 8 字节头 (w,h,px,py) u16 LE；像素为未压缩 RGB565；
        px=7 / py=-44 是引擎常量；py>32767 时需 -65536。
  物件  map 的 obj 字段给出物件号与所在格 (i,j)；
        摆放 x = i*48, y = (j+1)*32 - 图高（底部对齐格子行下边缘），同样上下翻转。
"""
import argparse
import json
import os
import re
import struct
import sys
from PIL import Image

MAP_CELL = 14          # 每格字节数
MAP_HEADER = 52
BLOCK_W, BLOCK_H = 96, 64
CELL_W, CELL_H = 48, 32


def load_wil(base):
    """base.wil + base.wix → (wil_bytes, offsets[])"""
    wil = open(base + ".wil", "rb").read()
    wix = open(base + ".wix", "rb").read()
    count = struct.unpack_from("<I", wix, 44)[0]
    offs = list(struct.unpack_from("<%dI" % count, wix, 48))
    return wil, offs


def decode_image(wil, offs, idx, alpha=True):
    """解码 WIL 第 idx 张（1 基）→ RGBA，已做上下翻转（行自下而上存储）"""
    o = offs[idx - 1]
    w, h, px, py = struct.unpack_from("<HHHH", wil, o)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0 if alpha else 255))
    pix = img.load()
    for y in range(h):
        for x in range(w):
            v = struct.unpack_from("<H", wil, o + 8 + (y * w + x) * 2)[0]
            if v or not alpha:
                pix[x, y] = (
                    ((v >> 11) & 31) * 255 // 31,
                    ((v >> 5) & 63) * 255 // 63,
                    (v & 31) * 255 // 31,
                    255,
                )
    return img.transpose(Image.FLIP_TOP_BOTTOM)


def read_map(path):
    data = open(path, "rb").read()
    w, h = struct.unpack_from("<HH", data, 0)
    assert len(data) == MAP_HEADER + MAP_CELL * w * h, (
        f"地图大小不符: {len(data)} != {MAP_HEADER}+{MAP_CELL}*{w}*{h}")
    cells = []
    for j in range(h):
        for i in range(w):
            off = MAP_HEADER + (j * w + i) * MAP_CELL
            bg, mid, obj = struct.unpack_from("<HHH", data, off)
            cells.append((bg & 0x7FFF, mid & 0x7FFF, obj & 0x7FFF))
    return w, h, cells


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", required=True, help="含 .map / Tiles*.wil/.wix / Objects*.wil/.wix 的目录")
    ap.add_argument("--out", default=None, help="输出目录，默认 <dir>/_export")
    ap.add_argument("--name", default=None, help="输出基准名，默认目录名")
    ap.add_argument("--export-tiles", action="store_true", help="额外导出单张瓦片/物件 PNG")
    args = ap.parse_args()

    src = args.dir
    name = args.name or os.path.basename(src.rstrip("/"))
    out = args.out or os.path.join(src, "_export")
    os.makedirs(out, exist_ok=True)

    maps = [f for f in os.listdir(src) if f.lower().endswith(".map")]
    if len(maps) != 1:
        sys.exit(f"目录内应有且仅有一个 .map，找到: {maps}")
    tiles = [f for f in os.listdir(src) if f.lower().startswith("tiles") and f.lower().endswith(".wil")]
    objs = [f for f in os.listdir(src) if f.lower().startswith("objects") and f.lower().endswith(".wil")]

    mw, mh, cells = read_map(os.path.join(src, maps[0]))
    bw, bh = mw // 2, mh // 2          # 块网格
    px_w, px_h = mw * CELL_W, mh * CELL_H

    ground = Image.new("RGBA", (px_w, px_h), (0, 0, 0, 255))
    if tiles:
        wilT, offsT = load_wil(os.path.join(src, tiles[0][:-4]))
        need = bw * bh
        if len(offsT) < need:
            sys.exit(f"Tiles 库只有 {len(offsT)} 张，需要 {need}")
        for by in range(bh):
            for bx in range(bw):
                idx = bx * bh + by + 1      # 列主序，1 基
                ground.alpha_composite(
                    decode_image(wilT, offsT, idx, alpha=False),
                    (bx * BLOCK_W, by * BLOCK_H))

    # 物件层：obj 字段 → 物件号，底部对齐格子行下边缘
    objects_layer = Image.new("RGBA", (px_w, px_h), (0, 0, 0, 0))
    obj_records = []
    if objs:
        wilO, offsO = load_wil(os.path.join(src, objs[0][:-4]))
        seen = {}
        for j in range(mh):
            for i in range(mw):
                _, _, oi = cells[j * mw + i]
                if not oi:
                    continue
                if oi in seen:
                    rec = seen[oi]
                else:
                    img = decode_image(wilO, offsO, oi, alpha=True)
                    x, y = i * CELL_W, (j + 1) * CELL_H - img.height
                    objects_layer.alpha_composite(img, (x, y))
                    rec = {"wil": oi, "cell": [i, j], "x": x, "y": y,
                           "w": img.width, "h": img.height}
                    seen[oi] = rec
                    obj_records.append(rec)
        full = ground.copy()
        full.alpha_composite(objects_layer)
    else:
        full = ground

    # 产出
    ground.convert("RGB").save(os.path.join(out, f"{name}-纯地面.png"))
    ground.convert("RGB").save(os.path.join(out, f"{name}-地面.jpg"), quality=90)
    if objs:
        full.convert("RGB").save(os.path.join(out, f"{name}-完整地图(地面+物件).png"))
        objects_layer.save(os.path.join(out, f"{name}-物件层(透明).png"))

    tmx_obj = ""
    if objs:
        objs_xml = "\n".join(
            f'  <object id="{k + 1}" name="obj_{r["wil"]}" x="{r["x"]}" y="{r["y"]}" '
            f'width="{r["w"]}" height="{r["h"]}"><properties>'
            f'<property name="cell" value="{r["cell"][0]},{r["cell"][1]}"/>'
            f'<property name="wil_index" type="int" value="{r["wil"]}"/>'
            f"</properties></object>"
            for k, r in enumerate(obj_records))
        tmx_obj = (f'\n <objectgroup id="2" name="objects" draworder="topdown">\n'
                   f"{objs_xml}\n </objectgroup>")
    tmx = f'''<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" orientation="orthogonal" renderorder="right-down" width="{mw}" height="{mh}" tilewidth="{CELL_W}" tileheight="{CELL_H}" infinite="0" nextlayerid="3" nextobjectid="{len(obj_records) + 1}">
 <imagelayer id="1" name="ground"><image source="{name}-纯地面.png" width="{px_w}" height="{px_h}"/></imagelayer>{tmx_obj}
</map>
'''
    open(os.path.join(out, f"{name}.tmx"), "w", encoding="utf-8").write(tmx)

    meta = {
        "map": maps[0],
        "width": mw, "height": mh, "cell": [CELL_W, CELL_H],
        "pixel": [px_w, px_h], "blockGrid": [bw, bh],
        "tilesWil": tiles[0] if tiles else None,
        "objectsWil": objs[0] if objs else None,
        "indexRule": f"idx = bx*{bh} + by + 1 (列主序，1 基)",
        "tileFlip": "vertical (rows stored bottom-up)",
        "objects": obj_records,
    }
    json.dump(meta, open(os.path.join(out, f"{name}-meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    if args.export_tiles and tiles:
        tdir = os.path.join(out, "tiles")
        os.makedirs(tdir, exist_ok=True)
        wilT, offsT = load_wil(os.path.join(src, tiles[0][:-4]))
        for k in range(1, len(offsT) + 1):
            decode_image(wilT, offsT, k, alpha=False).save(os.path.join(tdir, f"tile_{k:03d}.png"))
        if objs:
            odir = os.path.join(out, "objects")
            os.makedirs(odir, exist_ok=True)
            wilO, offsO = load_wil(os.path.join(src, objs[0][:-4]))
            for k in range(1, len(offsO) + 1):
                decode_image(wilO, offsO, k, alpha=True).save(os.path.join(odir, f"obj_{k:02d}.png"))

    print(f"OK {name}: {mw}x{mh} 格 → {px_w}x{px_h}px, 块 {bw}x{bh}, 物件 {len(obj_records)} → {out}")


if __name__ == "__main__":
    main()

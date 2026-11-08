# -*- coding: utf-8 -*-
"""生成黑底处理前后对比图：从 plist 挑未旋转帧，裁出后贴彩色斜纹背景左右对比。
   用法: python compare.py <原图备份目录> <处理后目录> <图集名不含扩展名> <输出png>
   例:   python compare.py .backup/effect-png-originals assets/resources/effect skill/s_2009@0 对比.png"""
import sys, os, re, plistlib
import numpy as np
from PIL import Image, ImageDraw

BAK, RES, NAME, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
pl = plistlib.load(open(os.path.join(RES, NAME + ".plist"), "rb"))
frames = pl["frames"]

def parse(s):
    n = re.findall(r"-?\d+", s)
    return tuple(int(x) for x in n[:4])

picked = []
for k in sorted(frames):
    f = frames[k]
    if f.get("rotated"): continue
    x, y, w, h = parse(f["frame"])
    if w < 120 or h < 120: continue
    picked.append((k, x, y, w, h))
    if len(picked) == 2: break
print("选中帧:", [(k, w, h) for k, x, y, w, h in picked])

def stripes(w, h):
    xs = np.arange(w)[None, :]; ys = np.arange(h)[:, None]
    band = ((xs + ys) // 26) % 4
    pal = np.array([[214,69,69],[74,155,214],[122,190,90],[240,196,80]], dtype=np.uint8)
    return Image.fromarray(pal[np.broadcast_to(band, (h, w))], "RGB").convert("RGBA")

orig = Image.open(os.path.join(BAK, NAME + ".png")).convert("RGBA")
new  = Image.open(os.path.join(RES, NAME + ".png")).convert("RGBA")

PW, PH, GAP = 300, 330, 12
canvas = Image.new("RGBA", (PW*2 + GAP*3, PH*2 + GAP*3), (245, 244, 240, 255))
draw = ImageDraw.Draw(canvas)
for row, (k, x, y, w, h) in enumerate(picked):
    for col, src in enumerate([orig, new]):
        piece = src.crop((x, y, x+w, y+h))
        sc = min((PW-20)/w, (PH-20)/h)
        piece = piece.resize((max(1,int(w*sc)), max(1,int(h*sc))), Image.LANCZOS)
        px = GAP + col*(PW+GAP); py = GAP + row*(PH+GAP)
        cell = stripes(PW, PH)
        cell.alpha_composite(piece, ((PW-piece.width)//2, (PH-piece.height)//2))
        canvas.alpha_composite(cell, (px, py))
        draw.rectangle([px, py, px+PW-1, py+PH-1], outline=(120,118,112,255), width=1)
for col, label in enumerate(["before (backed up)", "after (fixed)"]):
    draw.text((GAP + col*(PW+GAP) + 6, GAP + 2*PH + GAP*2 + 4), label, fill=(60,60,58,255))
canvas.convert("RGB").save(OUT, "PNG")
print("已生成", OUT, canvas.size)

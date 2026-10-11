#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双城生成器：王城（辉煌霸气的主城）+ 卧龙城（世外桃源）
共用管线（自包含交付：tsx+图+碰撞+monster+npc 全在同目录）：
- 地形瓦片束：jpg 网格 tsx（同 v3）
- 高清大物件：每个 PNG 单独 tsx（实际尺寸, tilecount=1），wall 层左下锚定
- 对象层：monster（矩形刷怪区 id/max/min）+ npc（复活点/大陆传送）+ collision（矩形）
"""
import os
import math
import random
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

ROOT = "jpg"
YL = "游戏场景元素"
JZ = os.path.join(YL, "高清建筑")
ZW = os.path.join(YL, "植物")
DB = os.path.join(YL, "地表-山石-物件")
T = 128

ROCK_NAMES = ["00003", "00005", "00009", "00010", "00012", "00013", "00014",
              "00020", "00021", "00022", "00023", "00025", "00028", "00029",
              "00030", "00031", "00032", "00037", "00039", "00042", "00045",
              "00046", "00049", "00051", "00052"]
SHORE_NAMES = ["00002", "00006", "00007", "00008", "00015", "00016", "00017",
               "00024", "00026", "00033", "00036", "00048"]

COMMON_BUNDLES = [
    ("cao_di_1", "448", None), ("cao_di_2", "451", None),
    ("cao_di_3", "485", None), ("cao_di_4", "407", None),
    ("tu_lu_1", "000", None), ("sha_di_1", "348", None),
    ("shi_ban_1", "506", None), ("shi_ban_2", "501", None),
    ("shi_ban_lu_1", "470", None), ("nong_tian_1", "747", None),
    ("shui_mian_1", "074", None), ("an_shi_1", "073", SHORE_NAMES),
    ("hua_cong_1", "390", None), ("hua_cong_2", "458", None),
    ("hua_cong_3", "468", None), ("yan_shi_1", "073", ROCK_NAMES),
    ("mu_zhuang_1", "073", ["00068", "00069"]),
]

class MapBuilder:
    def __init__(self, out_dir, seed, bundles):
        self.OUT = out_dir
        os.makedirs(out_dir, exist_ok=True)
        self.rng = random.Random(seed)
        self.POOLS = {}
        self.GID2SRC = {}
        self.tsx_lines = []
        self.firstgid = 1
        self.PLACEMENTS = []
        self.collisions = []
        self.bundles = bundles
        self._build_bundles()

    # ---------- 瓦片束 ----------
    def _build_bundles(self):
        for name, group, names in self.bundles:
            d = os.path.join(ROOT, group)
            if names:
                files = [n + ".jpg" for n in names]
            else:
                files = sorted(f for f in os.listdir(d) if f.lower().endswith(".jpg"))
            files = [f for f in files if os.path.exists(os.path.join(d, f))]
            n = len(files)
            cols = max(2, math.ceil(math.sqrt(n))) if n > 1 else 1
            rows = math.ceil(n / cols)
            img = Image.new("RGB", (cols * T, rows * T))
            gids = []
            for i, f in enumerate(files):
                im = Image.open(os.path.join(d, f)).convert("RGB")
                if im.size != (T, T):
                    im = im.resize((T, T), Image.LANCZOS)
                r, c = divmod(i, cols)
                img.paste(im, (c * T, r * T))
                gids.append(self.firstgid + i)
                self.GID2SRC[self.firstgid + i] = os.path.join(d, f)
            img.save(os.path.join(self.OUT, name + ".jpg"), "JPEG", quality=92, subsampling=0)
            tsx = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
                   f'<tileset version="1.10" tiledversion="1.12.2" name="{name}" '
                   f'tilewidth="{T}" tileheight="{T}" tilecount="{n}" columns="{cols}">\n'
                   f' <image source="{name}.jpg" width="{img.width}" height="{img.height}"/>\n'
                   f'</tileset>\n')
            with open(os.path.join(self.OUT, name + ".tsx"), "w", encoding="utf-8") as f:
                f.write(tsx)
            self.tsx_lines.append(f' <tileset firstgid="{self.firstgid}" source="{name}.tsx"/>')
            self.POOLS[name] = list(range(self.firstgid, self.firstgid + n))
            self.firstgid += n

    def pick(self, key):
        pool = self.POOLS[key]
        return pool[self.rng.randrange(len(pool))]

    # ---------- 大物件 ----------
    def register_big(self, src_png, name, target_w):
        im = Image.open(src_png).convert("RGBA")
        im = im.crop(im.getchannel("A").getbbox())
        im = im.resize((target_w, max(1, round(im.height * target_w / im.width))), Image.LANCZOS)
        im.save(os.path.join(self.OUT, name + ".png"))
        gid = self.firstgid
        self.firstgid += 1
        tsx = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
               f'<tileset version="1.10" tiledversion="1.12.2" name="{name}" '
               f'tilewidth="{im.width}" tileheight="{im.height}" tilecount="1" columns="1">\n'
               f' <image source="{name}.png" width="{im.width}" height="{im.height}"/>\n'
               f'</tileset>\n')
        with open(os.path.join(self.OUT, name + ".tsx"), "w", encoding="utf-8") as f:
            f.write(tsx)
        self.tsx_lines.append(f' <tileset firstgid="{gid}" source="{name}.tsx"/>')
        return gid

    def place_big(self, gid, name, cx_px, bottom_py, kind):
        im = Image.open(os.path.join(self.OUT, name + ".png"))
        w, h = im.size
        MW = MH = self.MW
        gx = max(0, min(MW - 1, round((cx_px - w / 2) / T)))
        gy = max(0, min(MH - 1, round(bottom_py / T) - 1))
        px = gx * T + (T - w) // 2
        py = (gy + 1) * T
        p = dict(gid=gid, name=name, gx=gx, gy=gy, px=px, py=py, w=w, h=h, kind=kind)
        self.PLACEMENTS.append(p)
        return p

    # ---------- 网格 ----------
    def init_grid(self, MW, MH):
        self.MW, self.MH = MW, MH
        self.ground = [[0] * MW for _ in range(MH)]
        self.road = [[0] * MW for _ in range(MH)]
        self.decor = [[0] * MW for _ in range(MH)]
        self.raised = [[False] * MW for _ in range(MH)]
        self.blocked = [[False] * MW for _ in range(MH)]

    def in_map(self, x, y):
        return 0 <= x < self.MW and 0 <= y < self.MH

    def fill_rect(self, layer, x0, y0, w, h, fn, mark=False):
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                if self.in_map(x, y):
                    layer[y][x] = fn(x, y)
                    if mark:
                        self.blocked[y][x] = True

    def fill_ellipse(self, layer, cx, cy, rx, ry, fn, mark=False):
        for y in range(int(cy - ry), int(cy + ry) + 1):
            for x in range(int(cx - rx), int(cx + rx) + 1):
                if self.in_map(x, y) and ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    layer[y][x] = fn(x, y)
                    if mark:
                        self.blocked[y][x] = True

    def put_tree(self, gid, name, x, y, space=3, block=1):
        if not self.in_map(x, y) or self.blocked[y][x] or self.road[y][x] or self.decor[y][x]:
            return False
        for p in self.PLACEMENTS:
            if p["kind"] == "tree" and abs(p["gx"] - x) < space and abs(p["gy"] - y) < space:
                return False
        self.place_big(gid, name, x * T + T // 2, (y + 1) * T, "tree")
        for dy in range(-block, block + 1):
            for dx in range(-block, block + 1):
                if self.in_map(x + dx, y + dy):
                    self.blocked[y + dy][x + dx] = True
        return True

    def scatter_trees(self, cells, gids_names, space=3, prob=1.0, cap=999):
        pool = list(cells)
        self.rng.shuffle(pool)
        n = 0
        for x, y in pool:
            if n >= cap:
                break
            if self.rng.random() <= prob:
                gid, nm = gids_names[self.rng.randrange(len(gids_names))]
                if self.put_tree(gid, nm, x, y, space=space):
                    n += 1
        return n

    # ---------- 合并与输出 ----------
    def merge(self):
        MW, MH = self.MW, self.MH
        self.ground_out = [[0] * MW for _ in range(MH)]
        self.wall_out = [[0] * MW for _ in range(MH)]
        for y in range(MH):
            for x in range(MW):
                self.ground_out[y][x] = ((self.decor[y][x] if not self.raised[y][x] else 0)
                                         or self.road[y][x] or self.ground[y][x])
                self.wall_out[y][x] = self.decor[y][x] if self.raised[y][x] else 0
        for p in self.PLACEMENTS:
            self.wall_out[p["gy"]][p["gx"]] = p["gid"]

    def add_base_collisions(self, water_border=False):
        MW, MH, T_ = self.MW, self.MH, T
        MPP = MW * T_
        self.collisions += [
            (-64, -64, MPP + 128, 128), (MPP - 64, -64, 128, MPP + 128),
            (-64, MPP - 64, MPP + 128, 128), (-64, -64, 128, MPP + 128),
        ]
        # 水域逐行合并
        water = set(self.POOLS.get("shui_mian_1", []))
        for y in range(MH):
            x = 0
            while x < MW:
                if self.decor[y][x] in water:
                    x0 = x
                    while x < MW and self.decor[y][x] in water:
                        x += 1
                    self.collisions.append((x0 * T_, y * T_, (x - x0) * T_, T_))
                else:
                    x += 1
        # 小型立体物件
        prop = set(self.POOLS.get("yan_shi_1", [])) | set(self.POOLS.get("mu_zhuang_1", []))
        for y in range(MH):
            for x in range(MW):
                g = self.decor[y][x] if self.raised[y][x] else 0
                if g in prop:
                    self.collisions.append((x * T_ + 16, y * T_ + 44, T_ - 32, T_ - 60))

    def add_placement_collisions(self):
        for p in self.PLACEMENTS:
            if p["kind"] in ("house", "prop"):
                fw, fh = p["w"] * 0.82, p["h"] * 0.24
                self.collisions.append((round(p["px"] + (p["w"] - fw) / 2),
                                        round(p["py"] - fh - 6), round(fw), round(fh)))
            elif p["kind"] == "tree":
                fw, fh = p["w"] * 0.32, p["h"] * 0.12
                self.collisions.append((round(p["px"] + (p["w"] - fw) / 2),
                                        round(p["py"] - fh - 4), round(fw), round(fh)))
            elif p["kind"] == "gate":
                pw, ph = p["w"] * 0.30, p["h"] * 0.30
                self.collisions.append((round(p["px"] + p["w"] * 0.02), round(p["py"] - ph - 4),
                                        round(pw), round(ph)))
                self.collisions.append((round(p["px"] + p["w"] * 0.68), round(p["py"] - ph - 4),
                                        round(pw), round(ph)))

    def finalize(self, title, monster_zones, npc_points):
        self.merge()
        self.add_placement_collisions()
        MW, MH = self.MW, self.MH
        obj = []
        for i, (ox, oy, ow, oh) in enumerate(self.collisions, 100):
            obj.append(f'  <object id="{i}" x="{ox}" y="{oy}" width="{ow}" height="{oh}"/>')
        mlines, _oid = [], 1
        for nm, mid, mx, mn, tx, ty, tw_, th_ in monster_zones:
            mlines.append(
                f'  <object id="{_oid}" name="{nm}" x="{tx * T}" y="{ty * T}" '
                f'width="{tw_ * T}" height="{th_ * T}">\n   <properties>\n'
                f'    <property name="id" value="{mid}"/>\n'
                f'    <property name="max" value="{mx}"/>\n'
                f'    <property name="min" value="{mn}"/>\n   </properties>\n  </object>')
            _oid += 1
        nlines = []
        for nm, typ, pid, nx, ny in npc_points:
            head = f'  <object id="{_oid}" name="{nm}" type="{typ}" x="{nx}" y="{ny}">'
            if typ == "revive":
                nlines.append(f'{head}\n   <point/>\n  </object>')
            else:
                nlines.append(f'{head}\n   <properties>\n'
                              f'    <property name="id" value="{pid}"/>\n   </properties>\n'
                              f'   <point/>\n  </object>')
            _oid += 1

        def csv(layer):
            rows = [",".join(str(layer[y][x]) for x in range(MW)) + "," for y in range(MH)]
            rows[-1] = rows[-1][:-1]
            return "\n".join(rows)

        tmx = f'''<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="{MW}" height="{MH}" tilewidth="{T}" tileheight="{T}" infinite="0" nextlayerid="6" nextobjectid="{_oid}">
{chr(10).join(self.tsx_lines)}
 <layer id="1" name="ground" width="{MW}" height="{MH}">
  <data encoding="csv">
{csv(self.ground_out)}
  </data>
 </layer>
 <layer id="2" name="wall" width="{MW}" height="{MH}">
  <data encoding="csv">
{csv(self.wall_out)}
  </data>
 </layer>
 <objectgroup id="3" name="monster">
{chr(10).join(mlines)}
 </objectgroup>
 <objectgroup id="4" name="npc">
{chr(10).join(nlines)}
 </objectgroup>
 <objectgroup id="5" name="collision">
{chr(10).join(obj)}
 </objectgroup>
</map>
'''
        with open(os.path.join(self.OUT, title + ".tmx"), "w", encoding="utf-8") as f:
            f.write(tmx)

        # 预览（按 GID 缓存源图，避免逐格 open 的开销）
        SCALE = 64
        src_cache = {}

        def src_img(gid):
            if gid not in src_cache:
                src_cache[gid] = Image.open(self.GID2SRC[gid]).convert("RGB")
            return src_cache[gid]

        comp = Image.new("RGB", (MW * SCALE, MH * SCALE))
        for y in range(MH):
            for x in range(MW):
                gid = self.ground_out[y][x]
                if gid:
                    comp.paste(src_img(gid).resize(
                        (SCALE, SCALE), Image.LANCZOS), (x * SCALE, y * SCALE))
        for y in range(MH):
            for x in range(MW):
                gid = self.wall_out[y][x]
                if gid and gid in self.GID2SRC:
                    comp.paste(src_img(gid).resize(
                        (SCALE, SCALE), Image.LANCZOS), (x * SCALE, y * SCALE))
        place_cache = {}
        for p in sorted(self.PLACEMENTS, key=lambda q: q["py"]):
            if p["name"] not in place_cache:
                place_cache[p["name"]] = Image.open(
                    os.path.join(self.OUT, p["name"] + ".png")).convert("RGBA")
            im = place_cache[p["name"]]
            k = T // SCALE
            im = im.resize((p["w"] // k, p["h"] // k), Image.LANCZOS)
            comp.paste(im, (p["px"] // k, (p["py"] - p["h"]) // k), im)
        comp.resize((2048, 2048), Image.LANCZOS).save(
            os.path.join(self.OUT, f"预览_{title}.jpg"), "JPEG", quality=88, subsampling=0)

        cp = comp.copy()
        dr = ImageDraw.Draw(cp)
        for ox, oy, ow, oh in self.collisions:
            dr.rectangle([ox / T * SCALE, oy / T * SCALE,
                          (ox + ow) / T * SCALE, (oy + oh) / T * SCALE],
                         outline=(255, 0, 0), width=2)
        for nm, mid, mx, mn, tx, ty, tw_, th_ in monster_zones:
            dr.rectangle([tx * SCALE, ty * SCALE, (tx + tw_) * SCALE, (ty + th_) * SCALE],
                         outline=(0, 90, 255), width=3)
        for nm, typ, pid, nx, ny in npc_points:
            cx_, cy_ = nx / T * SCALE, ny / T * SCALE
            col = (0, 170, 0) if typ == "revive" else (170, 0, 200)
            dr.ellipse([cx_ - 12, cy_ - 12, cx_ + 12, cy_ + 12], outline=col, width=3)
            dr.line([cx_ - 18, cy_, cx_ + 18, cy_], fill=col, width=2)
            dr.line([cx_, cy_ - 18, cx_, cy_ + 18], fill=col, width=2)
        cp.resize((2048, 2048), Image.LANCZOS).save(
            os.path.join(self.OUT, f"预览_区域_{title}.jpg"), "JPEG", quality=88, subsampling=0)
        print(f"[{title}] 完成: 大物件{len(self.PLACEMENTS)} 碰撞{len(self.collisions)} "
              f"刷怪区{len(monster_zones)} NPC{len(npc_points)} GID<={self.firstgid-1}")

# ==================== 王城 ====================
def build_wangcheng():
    b = MapBuilder("王城地图", 20261004, COMMON_BUNDLES)
    rng = b.rng
    b.init_grid(64, 64)

    def grass(x, y):
        r = rng.random()
        return b.pick("cao_di_1") if r < 0.85 else (b.pick("cao_di_2") if r < 0.95 else b.pick("cao_di_3"))

    # 野外草地基底
    b.fill_rect(b.ground, 0, 0, 64, 64, grass)
    for y in range(64):
        for x in range(64):
            if x < 4 or y < 4 or x >= 60 or y >= 64 - 4:
                if rng.random() < 0.85:
                    b.ground[y][x] = b.pick("cao_di_4")

    # 城内石板铺装（11..52）
    b.fill_rect(b.ground, 11, 11, 42, 42, lambda x, y: b.pick("shi_ban_1"))

    # 护城河（8..10 / 53..55 环带）
    b.fill_rect(b.decor, 8, 8, 48, 48, lambda x, y: 0)
    for y in range(8, 56):
        for x in range(8, 56):
            if 8 <= x < 56 and (x < 11 or x >= 53 or y < 11 or y >= 53) \
               and 8 <= y < 56:
                b.decor[y][x] = b.pick("shui_mian_1")
                b.blocked[y][x] = True
    # 护城河岸石
    for y in range(64):
        for x in range(64):
            if b.decor[y][x]:
                continue
            near = any(b.in_map(x + dx, y + dy) and b.decor[y + dy][x + dx] in b.POOLS["shui_mian_1"]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            if near and b.road[y][x] == 0 and b.ground[y][x] not in b.POOLS["shi_ban_1"] \
               and rng.random() < 0.8:
                b.decor[y][x] = b.pick("an_shi_1")

    # 十字大道（501 米黄石板，6 格宽）+ 城门甬道穿护城河
    AV = (29, 34)
    b.fill_rect(b.road, AV[0], 8, 6, 48, lambda x, y: b.pick("shi_ban_2"), mark=True)
    b.fill_rect(b.road, 8, AV[0], 48, 6, lambda x, y: b.pick("shi_ban_2"), mark=True)
    # 甬道盖掉护城河段（城墙外延伸到 5..58）
    for seg in ((AV[0], 5, 6, 6), (AV[0], 53, 6, 6), (5, AV[0], 6, 6), (53, AV[0], 6, 6)):
        x0, y0, w, h = seg
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                if b.in_map(x, y):
                    b.road[y][x] = b.pick("shi_ban_2")
                    b.decor[y][x] = 0
                    b.blocked[y][x] = False

    # 中央广场（皇宫前）
    b.fill_rect(b.road, 24, 20, 16, 10, lambda x, y: b.pick("shi_ban_1"), mark=True)
    # 南门内广场
    b.fill_rect(b.road, 24, 40, 16, 10, lambda x, y: b.pick("shi_ban_1"), mark=True)

    # 御花园（西北/东北角，草皮+花）
    for gx0, gy0 in ((13, 13), (41, 13)):
        b.fill_rect(b.ground, gx0, gy0, 9, 7, grass)
        b.fill_rect(b.decor, gx0 + 1, gy0 + 1, 7, 2, lambda x, y: b.pick("hua_cong_1"))
        b.fill_rect(b.decor, gx0 + 1, gy0 + 4, 7, 2,
                    lambda x, y: b.pick("hua_cong_2" if rng.random() < 0.5 else "hua_cong_3"))

    # 校场（西南，沙土）
    b.fill_rect(b.road, 14, 42, 12, 9, lambda x, y: b.pick("sha_di_1"), mark=True)

    # ---- 大物件 ----
    BIGS = {}
    for nm, idx, tw in [
        ("gong_dian", "建筑_001.png", 1150),   # 皇宫大殿
        ("lou_ge_a", "建筑_019.png", 640),     # 重檐楼阁
        ("lou_ge_b", "建筑_110.png", 600),     # 楼阁
        ("ta_lou", "建筑_022.png", 420),       # 独立塔楼
        ("jiao_lou", "建筑_024.png", 780),     # 角楼
        ("cheng_men", "建筑_025.png", 980),    # 城门楼
        ("pai_fang", "建筑_074.png", 760),     # 白石牌坊
        ("shi_ta", "建筑_028.png", 420),       # 石塔
        ("dian_pu_a", "建筑_036.png", 560),    # 商铺
        ("dian_pu_b", "建筑_037.png", 560),
        ("dian_pu_c", "建筑_038.png", 520),
        ("dian_pu_d", "建筑_030.png", 560),
        ("jiu_lou", "建筑_018.png", 640),      # 酒楼
        ("zhai_a", "建筑_006.png", 620),       # 宅院
        ("zhai_b", "建筑_007.png", 600),
        ("zhai_c", "建筑_008.png", 620),
        ("zhai_d", "建筑_041.png", 600),
        ("liang_ting", "建筑_021.png", 430),   # 凉亭
    ]:
        BIGS[nm] = b.register_big(os.path.join(JZ, idx), nm, tw)

    # 皇宫：大殿 + 两侧楼阁 + 前双塔 + 后双楼阁
    b.place_big(BIGS["gong_dian"], "gong_dian", 32 * T, 21 * T, "house")
    b.place_big(BIGS["lou_ge_a"], "lou_ge_a", 26 * T, 21 * T, "house")
    b.place_big(BIGS["lou_ge_a"], "lou_ge_a", 38 * T, 21 * T, "house")
    b.place_big(BIGS["ta_lou"], "ta_lou", 26 * T, 23 * T, "house")
    b.place_big(BIGS["ta_lou"], "ta_lou", 38 * T, 23 * T, "house")
    b.place_big(BIGS["lou_ge_b"], "lou_ge_b", 27 * T, 14 * T, "house")
    b.place_big(BIGS["lou_ge_b"], "lou_ge_b", 37 * T, 14 * T, "house")

    # 四角角楼 + 南北城门楼
    for cx, cy in ((13 * T, 13 * T), (51 * T, 13 * T), (13 * T, 51 * T), (51 * T, 51 * T)):
        b.place_big(BIGS["jiao_lou"], "jiao_lou", cx, cy, "house")
    b.place_big(BIGS["cheng_men"], "cheng_men", 32 * T, 12 * T, "gate")
    b.place_big(BIGS["cheng_men"], "cheng_men", 32 * T, 53 * T, "gate")

    # 中轴白石牌坊（南广场）
    b.place_big(BIGS["pai_fang"], "pai_fang", 32 * T, 44 * T, "gate")

    # 东西市：商铺两排 + 酒楼
    shops = [("dian_pu_a", 19, 28), ("dian_pu_b", 25, 28), ("dian_pu_c", 39, 28),
             ("dian_pu_d", 45, 28), ("dian_pu_c", 21, 38), ("dian_pu_d", 27, 38),
             ("dian_pu_a", 37, 38), ("dian_pu_b", 43, 38)]
    for snm, sx, sy in shops:
        b.place_big(BIGS[snm], snm, sx * T, sy * T, "house")
    b.place_big(BIGS["jiu_lou"], "jiu_lou", 20 * T, 34 * T, "house")
    b.place_big(BIGS["jiu_lou"], "jiu_lou", 44 * T, 34 * T, "house")

    # 宅院（东西两坊）
    zhai = ["建筑_006.png", "建筑_007.png", "建筑_008.png", "建筑_041.png"]
    zid = ["zhai_a", "zhai_b", "zhai_c", "zhai_d"]
    for i, (hx, hy) in enumerate(((15, 44), (15, 49), (45, 44), (45, 49))):
        b.place_big(BIGS[zid[i % 4]], zid[i % 4], hx * T, hy * T, "house")

    # 花园凉亭 + 石塔
    b.place_big(BIGS["liang_ting"], "liang_ting", 17 * T, 18 * T, "house")
    b.place_big(BIGS["liang_ting"], "liang_ting", 47 * T, 18 * T, "house")
    b.place_big(BIGS["shi_ta"], "shi_ta", 17 * T, 21 * T, "house")
    b.place_big(BIGS["shi_ta"], "shi_ta", 47 * T, 21 * T, "house")

    # 民居坊（大道两侧各 2 座）
    for snm, sx, sy in (("zhai_a", 15, 23), ("zhai_b", 21, 23),
                        ("zhai_c", 43, 23), ("zhai_d", 49, 23)):
        b.place_big(BIGS[snm], snm, sx * T, sy * T, "house")

    # 南门广场双凉亭
    b.place_big(BIGS["liang_ting"], "liang_ting", 26 * T, 47 * T, "house")
    b.place_big(BIGS["liang_ting"], "liang_ting", 38 * T, 47 * T, "house")

    # 市井道具
    for nm, idx, tw, cx, by in [
        ("jing_jia", "146", 220, 22 * T, 33 * T),      # 辘轳井
        ("bu_gua", "142", 260, 42 * T, 31 * T),        # 卜卦摊
        ("cha_tan", "148", 300, 27 * T, 44 * T),       # 茶摊
        ("zhan_gu", "213", 240, 20 * T, 47 * T),       # 战鼓
    ]:
        gid = b.register_big(os.path.join(DB, f"场景素材_{idx}.png"), nm, tw)
        b.place_big(gid, nm, cx, by, "prop")
    BIGS["ju_ma"] = b.register_big(os.path.join(DB, "场景素材_220.png"), "ju_ma", 300)
    for cx, by in ((17 * T, 44 * T), (23 * T, 48 * T),
                   (20 * T, 46 * T), (18 * T, 49 * T)):   # 拒马
        b.place_big(BIGS["ju_ma"], "ju_ma", cx, by, "prop")

    # 树木：花园与野外
    trees = [(b.register_big(os.path.join(ZW, f), nm, tw), nm)
             for nm, f, tw in [("shu_a", "植物_012.png", 330), ("shu_b", "植物_013.png", 310),
                               ("shu_c", "植物_062.png", 330), ("shu_d", "植物_070.png", 320),
                               ("shu_e", "植物_114.png", 300)]]
    for _gid, _nm in trees:
        BIGS[_nm] = _gid
    wild = [(x, y) for y in range(64) for x in range(64)
            if x < 8 or y < 8 or x >= 56 or y >= 56]
    b.scatter_trees(wild, trees, space=3, prob=0.45, cap=30)
    garden = [(x, y) for gy0 in (13, 41) for y in range(gy0, gy0 + 7)
              for x in range(14, 23)] + [(x, y) for y in range(13, 20) for x in range(42, 51)]
    b.scatter_trees(garden, trees, space=3, prob=0.4, cap=10)

    # 大道行树（两侧，自动避开广场/建筑）
    for ty in range(14, 53, 4):
        b.put_tree(BIGS["shu_a"], "shu_a", 27, ty, space=2)
        b.put_tree(BIGS["shu_b"], "shu_b", 36, ty, space=2)

    b.add_base_collisions()
    zones = [
        ("1号怪物", 1, 10, 0, 2, 16, 6, 32),    # 西郊野外
        ("2号怪物", 2, 10, 0, 56, 16, 6, 32),   # 东郊野外
    ]
    npcs = [
        ("复活点", "revive", None, 32 * T, 25 * T),        # 皇宫前广场
        ("大陆传送", "npc", "0001", 32 * T, 41 * T + 64),  # 南门内
    ]
    b.finalize("王城", zones, npcs)

# ==================== 卧龙城 ====================
def build_wolongcheng():
    b = MapBuilder("卧龙城地图", 20261005, COMMON_BUNDLES)
    rng = b.rng
    b.init_grid(64, 64)

    def grass(x, y):
        r = rng.random()
        return b.pick("cao_di_1") if r < 0.84 else (b.pick("cao_di_2") if r < 0.94 else b.pick("cao_di_3"))

    b.fill_rect(b.ground, 0, 0, 64, 64, grass)
    for y in range(64):
        for x in range(64):
            if x < 4 or y < 4 or x >= 60 or y >= 60:
                if rng.random() < 0.8:
                    b.ground[y][x] = b.pick("cao_di_4")

    # 穿村溪流（y 30..32）
    b.fill_rect(b.decor, 6, 30, 52, 3, lambda x, y: b.pick("shui_mian_1"), mark=True)
    for y in range(64):
        for x in range(64):
            if b.decor[y][x]:
                continue
            near = any(b.in_map(x + dx, y + dy) and b.decor[y + dy][x + dx] in b.POOLS["shui_mian_1"]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            if near and b.road[y][x] == 0 and rng.random() < 0.75:
                b.decor[y][x] = b.pick("an_shi_1")

    # 北面小湖
    b.fill_ellipse(b.decor, 13, 15, 5, 4, lambda x, y: b.pick("shui_mian_1"), mark=True)
    for y in range(64):
        for x in range(64):
            if b.decor[y][x]:
                continue
            near = any(b.in_map(x + dx, y + dy) and b.decor[y + dy][x + dx] in b.POOLS["shui_mian_1"]
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            if near and b.road[y][x] == 0 and rng.random() < 0.8:
                b.decor[y][x] = b.pick("an_shi_1")

    # 蜿蜒主路（土路）+ 石板草径支路
    MAIN = [(32, 62, 32, 52), (32, 52, 26, 52), (26, 52, 26, 44), (26, 44, 32, 44),
            (32, 44, 32, 36), (32, 36, 32, 26), (32, 26, 24, 26), (24, 26, 24, 20),
            (24, 20, 32, 20), (32, 20, 40, 20), (40, 20, 40, 26), (40, 26, 48, 26),
            (48, 26, 48, 36), (48, 36, 40, 36), (40, 36, 40, 44), (40, 44, 48, 44),
            (48, 44, 48, 52), (48, 52, 56, 52), (18, 26, 18, 36), (14, 36, 26, 36)]
    for x0, y0, x1, y1 in MAIN:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for x in range(min(x0, x1), max(x0, x1) + 1):
                if b.in_map(x, y) and b.decor[y][x] == 0:
                    b.road[y][x] = b.pick("tu_lu_1")
                    b.blocked[y][x] = True
    SUB = [(12, 12, 20, 12), (20, 12, 20, 18), (36, 12, 46, 12), (46, 12, 46, 18),
           (12, 44, 12, 54), (12, 54, 20, 54), (56, 20, 58, 20), (56, 20, 56, 28)]
    for x0, y0, x1, y1 in SUB:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for x in range(min(x0, x1), max(x0, x1) + 1):
                if b.in_map(x, y) and b.decor[y][x] == 0 and b.road[y][x] == 0:
                    b.road[y][x] = b.pick("shi_ban_lu_1")

    # 桥位：溪流上的甬道（供放大石桥）
    for bx in (22, 42):
        for y in (29, 30, 31, 32, 33):
            for x in range(bx, bx + 3):
                if b.in_map(x, y):
                    b.road[y][x] = b.pick("shi_ban_2")
                    b.decor[y][x] = 0
                    b.blocked[y][x] = False

    # 中央榕树广场（草地空场+花）
    b.fill_rect(b.decor, 28, 46, 9, 5, lambda x, y: b.pick("hua_cong_1"))
    b.fill_rect(b.decor, 34, 47, 3, 3, lambda x, y: b.pick("hua_cong_2"))

    # 农田（西南）+ 花圃
    b.fill_rect(b.road, 20, 55, 8, 5, lambda x, y: b.pick("nong_tian_1"), mark=True)
    b.fill_rect(b.road, 30, 55, 6, 5, lambda x, y: b.pick("nong_tian_1"), mark=True)
    b.fill_rect(b.decor, 8, 42, 4, 2, lambda x, y: b.pick("hua_cong_3"))
    b.fill_rect(b.decor, 50, 12, 4, 2, lambda x, y: b.pick("hua_cong_2"))

    # ---- 大物件 ----
    BIGS = {}
    for nm, folder, idx, tw in [
        ("rong_shu", ZW, "植物_001.png", 520),     # 大榕树
        ("tao_a", ZW, "植物_040.png", 340),        # 桃花
        ("tao_b", ZW, "植物_041.png", 330),
        ("tao_c", ZW, "植物_042.png", 320),
        ("liu_a", ZW, "植物_045.png", 340),        # 柳树
        ("liu_b", ZW, "植物_046.png", 320),
        ("zhu_a", ZW, "植物_085.png", 300),        # 竹
        ("zhu_b", ZW, "植物_088.png", 300),
        ("shu_a", ZW, "植物_012.png", 330),
        ("shu_b", ZW, "植物_013.png", 310),
        ("shu_c", ZW, "植物_062.png", 330),
        ("gu_shu", ZW, "植物_109.png", 360),       # 古树
        ("hong_shu", ZW, "植物_105.png", 320),     # 红叶
        ("wu_a", JZ, "建筑_059.png", 560),         # 茅顶屋
        ("wu_b", JZ, "建筑_062.png", 540),         # 石屋
        ("wu_c", JZ, "建筑_063.png", 540),
        ("wu_d", JZ, "建筑_066.png", 520),         # 土屋
        ("wu_e", JZ, "建筑_100.png", 560),         # 农舍
        ("wu_f", JZ, "建筑_102.png", 620),         # 桃花小院
        ("wu_g", JZ, "建筑_103.png", 560),
        ("wu_h", JZ, "建筑_104.png", 560),
        ("liang_ting", JZ, "建筑_021.png", 420),   # 凉亭
        ("shi_qiao", DB, "场景素材_207.png", 520), # 石拱桥
        ("mu_qiao", DB, "场景素材_208.png", 480),
        ("jing_peng", DB, "场景素材_232.png", 240),# 茅棚井
        ("jing_jia", DB, "场景素材_146.png", 200), # 辘轳井
        ("cha_tan", DB, "场景素材_148.png", 280),  # 茶摊
        ("mu_cai", DB, "场景素材_244.png", 280),   # 木材堆
    ]:
        BIGS[nm] = b.register_big(os.path.join(folder, idx), nm, tw)

    # 石拱桥架在溪流桥位
    b.place_big(BIGS["shi_qiao"], "shi_qiao", 23 * T + 64, 34 * T, "prop")
    b.place_big(BIGS["mu_qiao"], "mu_qiao", 43 * T + 64, 34 * T, "prop")

    # 中央大榕树（广场）
    b.place_big(BIGS["rong_shu"], "rong_shu", 32 * T + 64, 48 * T, "tree")
    for dy in range(-1, 2):
        for dx in range(-1, 2):
            if b.in_map(31 + dx, 47 + dy):
                b.blocked[47 + dy][31 + dx] = True

    # 民居（沿路散布，带小院）
    houses = [
        ("wu_f", "建筑_102.png", 20, 14), ("wu_a", "建筑_059.png", 42, 15),
        ("wu_b", "建筑_062.png", 50, 22), ("wu_c", "建筑_063.png", 14, 22),
        ("wu_d", "建筑_066.png", 16, 40), ("wu_e", "建筑_100.png", 26, 49),
        ("wu_g", "建筑_103.png", 44, 40), ("wu_h", "建筑_104.png", 52, 48),
        ("wu_a", "建筑_059.png", 36, 56),
    ]
    for nm, src, hx, hy in houses:
        b.place_big(BIGS[nm], nm, hx * T + 64, (hy + 3) * T, "house")
        for y in range(hy, hy + 4):
            for x in range(hx - 1, hx + 3):
                if b.in_map(x, y) and b.road[y][x] == 0 and b.decor[y][x] == 0:
                    b.road[y][x] = b.pick("sha_di_1")
                    b.blocked[y][x] = True

    # 凉亭（北湖边）+ 井 + 茶摊 + 木材
    b.place_big(BIGS["liang_ting"], "liang_ting", 21 * T, 20 * T, "house")
    b.place_big(BIGS["jing_peng"], "jing_peng", 30 * T, 24 * T, "prop")
    b.place_big(BIGS["jing_jia"], "jing_jia", 24 * T, 58 * T, "prop")
    b.place_big(BIGS["cha_tan"], "cha_tan", 36 * T, 49 * T, "prop")
    b.place_big(BIGS["mu_cai"], "mu_cai", 54 * T, 34 * T, "prop")

    # 桃花林（两片）
    tao = [(BIGS["tao_a"], "tao_a"), (BIGS["tao_b"], "tao_b"), (BIGS["tao_c"], "tao_c")]
    cluster1 = [(x, y) for y in range(8, 15) for x in range(38, 52)]
    cluster2 = [(x, y) for y in range(44, 52) for x in range(6, 16)]
    b.scatter_trees(cluster1, tao, space=2, prob=0.55, cap=16)
    b.scatter_trees(cluster2, tao, space=2, prob=0.5, cap=12)

    # 竹林（西/北缘）
    zhu = [(BIGS["zhu_a"], "zhu_a"), (BIGS["zhu_b"], "zhu_b")]
    bamboo_band = [(x, y) for y in range(6, 58) for x in range(2, 7)] + \
                  [(x, y) for y in range(2, 7) for x in range(2, 40)]
    b.scatter_trees(bamboo_band, zhu, space=2, prob=0.5, cap=34)

    # 池塘柳堤
    liu = [(BIGS["liu_a"], "liu_a"), (BIGS["liu_b"], "liu_b")]
    lake_ring = [(x, y) for y in range(9, 22) for x in range(6, 20)
                 if not (9 <= x <= 18 and 10 <= y <= 19)]
    b.scatter_trees(lake_ring, liu, space=2, prob=0.45, cap=12)

    # 溪边柳树
    stream_ring = [(x, y) for y in (27, 28, 34, 35) for x in range(6, 58)]
    b.scatter_trees(stream_ring, liu, space=3, prob=0.45, cap=18)

    # 沿路花径
    def flower_patch(x0, y0, w, h, key):
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                if b.in_map(x, y) and b.road[y][x] == 0 and b.decor[y][x] == 0:
                    b.decor[y][x] = b.pick(key)
    flower_patch(28, 36, 3, 2, "hua_cong_1")
    flower_patch(34, 40, 3, 2, "hua_cong_2")
    flower_patch(18, 28, 2, 2, "hua_cong_3")
    flower_patch(44, 30, 2, 2, "hua_cong_1")
    flower_patch(30, 22, 2, 2, "hua_cong_2")

    # 榕树广场四周桃树
    ring = [(x, y) for y in range(42, 53) for x in range(26, 39)]
    b.scatter_trees(ring, tao, space=2, prob=0.3, cap=6)

    # 杂树点缀
    za = [(BIGS["shu_a"], "shu_a"), (BIGS["shu_b"], "shu_b"), (BIGS["shu_c"], "shu_c"),
          (BIGS["gu_shu"], "gu_shu"), (BIGS["hong_shu"], "hong_shu")]
    free = [(x, y) for y in range(64) for x in range(64)
            if not b.blocked[y][x] and not b.road[y][x] and not b.decor[y][x]
            and 7 < x < 57 and 7 < y < 57]
    b.scatter_trees(free, za, space=3, prob=0.5, cap=26)

    b.add_base_collisions()
    zones = [
        ("1号怪物", 1, 6, 0, 8, 2, 46, 7),      # 北侧山林（温和）
        ("2号怪物", 2, 6, 0, 40, 56, 22, 6),    # 东南林地
    ]
    npcs = [
        ("复活点", "revive", None, 32 * T + 64, 50 * T),
        ("大陆传送", "npc", "0002", 32 * T, 60 * T + 64),
    ]
    b.finalize("卧龙城", zones, npcs)

if __name__ == "__main__":
    build_wangcheng()
    build_wolongcheng()

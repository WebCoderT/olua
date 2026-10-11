#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「新手村」TMX 地图生成器 v3 —— 引入「游戏场景元素」高清素材
新增能力（在 v2 参考格式基础上）：
1. 高清建筑/植物/道具 PNG：每个元素单独 tsx（tilewidth=图片实际尺寸, tilecount=1）
2. wall 层锚定：大图底边对齐锚定格子底边、向左上延伸（与参考 shu_mu_2 一致）
3. 碰撞：大物件按底部占地生成矩形；牌坊留中间通道
4. 预览图按画家算法合成大物件
"""
import os
import math
import shutil
import random
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = "jpg"
YL = "游戏场景元素"
OUT = "新手村地图"
os.makedirs(OUT, exist_ok=True)
T = 128
MW = MH = 64
rng = random.Random(20261003)

# ---------------- 瓦片束（地形类；平面屋顶块已废弃，改用高清建筑） ----------------
ROCK_NAMES = ["00003", "00005", "00009", "00010", "00012", "00013", "00014",
              "00020", "00021", "00022", "00023", "00025", "00028", "00029",
              "00030", "00031", "00032", "00037", "00039", "00042", "00045",
              "00046", "00049", "00051", "00052"]
SHORE_NAMES = ["00002", "00006", "00007", "00008", "00015", "00016", "00017",
               "00024", "00026", "00033", "00036", "00048"]

BUNDLES = [
    ("cao_di_1",     "448", None),
    ("cao_di_2",     "451", None),
    ("cao_di_3",     "485", None),
    ("cao_di_4",     "407", None),
    ("tu_lu_1",      "000", None),
    ("sha_di_1",     "348", None),
    ("shi_ban_1",    "506", None),
    ("shi_ban_2",    "501", None),
    ("shi_ban_lu_1", "470", None),
    ("nong_tian_1",  "747", None),
    ("shui_mian_1",  "074", None),
    ("an_shi_1",     "073", SHORE_NAMES),
    ("hua_cong_1",   "390", None),
    ("hua_cong_2",   "458", None),
    ("hua_cong_3",   "468", None),
    ("yan_shi_1",    "073", ROCK_NAMES),
    ("mu_zhuang_1",  "073", ["00068", "00069"]),
]

POOLS = {}
GID2SRC = {}
firstgid = 1
tsx_lines = []
for name, group, names in BUNDLES:
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
        gids.append(firstgid + i)
        GID2SRC[firstgid + i] = os.path.join(d, f)
    img_path = os.path.join(OUT, name + ".jpg")
    img.save(img_path, "JPEG", quality=92, subsampling=0)
    tsx = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
           f'<tileset version="1.10" tiledversion="1.12.2" name="{name}" '
           f'tilewidth="{T}" tileheight="{T}" tilecount="{n}" columns="{cols}">\n'
           f' <image source="{name}.jpg" width="{img.width}" height="{img.height}"/>\n'
           f'</tileset>\n')
    with open(os.path.join(OUT, name + ".tsx"), "w", encoding="utf-8") as f:
        f.write(tsx)
    tsx_lines.append(f' <tileset firstgid="{firstgid}" source="{name}.tsx"/>')
    firstgid += n

BUNDLE_GIDS = {}
gid_cursor = 1
for name, group, names in BUNDLES:
    d = os.path.join(ROOT, group)
    if names:
        cnt = len([x for x in names if os.path.exists(os.path.join(d, x + ".jpg"))])
    else:
        cnt = len([f for f in os.listdir(d) if f.lower().endswith(".jpg")])
    BUNDLE_GIDS[name] = list(range(gid_cursor, gid_cursor + cnt))
    gid_cursor += cnt

POOL_MAP = {
    "grass_a": "cao_di_1", "grass_b": "cao_di_2", "grass_c": "cao_di_3",
    "grass_dark": "cao_di_4", "dirt": "tu_lu_1", "sand": "sha_di_1",
    "plaza": "shi_ban_1", "plaza_edge": "shi_ban_2", "stone_path": "shi_ban_lu_1",
    "farm": "nong_tian_1", "water": "shui_mian_1", "shore": "an_shi_1",
    "flower_w": "hua_cong_1", "flower_p": "hua_cong_2", "flower_p2": "hua_cong_3",
    "rock": "yan_shi_1", "post": "mu_zhuang_1",
}
for key, bname in POOL_MAP.items():
    POOLS[key] = BUNDLE_GIDS[bname]

def pick(key):
    pool = POOLS[key]
    return pool[rng.randrange(len(pool))]

# ---------------- 高清大物件管线 ----------------
# 大图：裁透明边 -> 等比缩放 -> 单独 png+tsx（tilewidth=图片实际尺寸, tilecount=1）
# 锚定：wall 层锚定格子，图片底边 = 格子底边，向左上延伸（参考 shu_mu_2 做法）
BIG_TSX = []                      # 追加 tsx 行（GID 升序）
PLACEMENTS = []                   # 每次摆放: dict(gid,gx,gy,px,py,w,h,kind,collide)
_gid_next = firstgid

def register_big(src_png, name, target_w):
    """注册一个大物件素材，返回 gid（同一素材复用同一 gid）"""
    global _gid_next
    im = Image.open(src_png).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    im = im.crop(bbox)
    ratio = target_w / im.width
    im = im.resize((target_w, max(1, round(im.height * ratio))), Image.LANCZOS)
    out_png = os.path.join(OUT, name + ".png")
    im.save(out_png)
    gid = _gid_next
    _gid_next += 1
    tsx = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
           f'<tileset version="1.10" tiledversion="1.12.2" name="{name}" '
           f'tilewidth="{im.width}" tileheight="{im.height}" tilecount="1" columns="1">\n'
           f' <image source="{name}.png" width="{im.width}" height="{im.height}"/>\n'
           f'</tileset>\n')
    with open(os.path.join(OUT, name + ".tsx"), "w", encoding="utf-8") as f:
        f.write(tsx)
    BIG_TSX.append(f' <tileset firstgid="{gid}" source="{name}.tsx"/>')
    return gid

def place_big(gid, name, cx_px, bottom_py, kind):
    """摆放：cx_px=图片水平中心像素, bottom_py=图片底边像素, kind=碰撞类型"""
    im = Image.open(os.path.join(OUT, name + ".png"))
    w, h = im.size
    px = round(cx_px - w / 2)
    gx = round(px / T)
    gy = round(bottom_py / T) - 1
    gx = max(0, min(MW - 1, gx))
    gy = max(0, min(MH - 1, gy))
    px = gx * T + (T - w) // 2        # 以格子为准微调，保证底边对齐
    py = (gy + 1) * T
    PLACEMENTS.append(dict(gid=gid, name=name, gx=gx, gy=gy,
                           px=px, py=py, w=w, h=h, kind=kind))
    return PLACEMENTS[-1]

# ---------------- 地图绘制 ----------------
ground = [[0] * MW for _ in range(MH)]
road = [[0] * MW for _ in range(MH)]
decor = [[0] * MW for _ in range(MH)]
raised = [[False] * MW for _ in range(MH)]
blocked = [[False] * MW for _ in range(MH)]

def in_map(x, y):
    return 0 <= x < MW and 0 <= y < MH

def fill_rect(layer, x0, y0, w, h, pool_fn, mark=False):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            if in_map(x, y):
                layer[y][x] = pool_fn(x, y)
                if mark:
                    blocked[y][x] = True

def fill_ellipse(layer, cx, cy, rx, ry, pool_fn, mark=False):
    for y in range(int(cy - ry), int(cy + ry) + 1):
        for x in range(int(cx - rx), int(cx + rx) + 1):
            if in_map(x, y) and ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                layer[y][x] = pool_fn(x, y)
                if mark:
                    blocked[y][x] = True

def grass_px(x, y):
    r = rng.random()
    if r < 0.84:   return pick("grass_a")
    if r < 0.94:   return pick("grass_b")
    return pick("grass_c")

# 1) 草地基底
fill_rect(ground, 0, 0, MW, MH, grass_px)

# 2) 边缘深草
B = 3
for y in range(MH):
    for x in range(MW):
        if x < B or y < B or x >= MW - B or y >= MH - B:
            if rng.random() < 0.85:
                ground[y][x] = pick("grass_dark")

# 3) 十字土路
ROAD_X = (30, 33)
ROAD_Y = (30, 33)
fill_rect(road, ROAD_X[0], 0, ROAD_X[1] - ROAD_X[0] + 1, MH,
          lambda x, y: pick("dirt"), mark=True)
fill_rect(road, 0, ROAD_Y[0], MW, ROAD_Y[1] - ROAD_Y[0] + 1,
          lambda x, y: pick("dirt"), mark=True)

# 3b) 路肩柔化
for y in range(MH):
    for x in range(MW):
        if road[y][x]:
            continue
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if in_map(nx, ny) and road[ny][nx]:
                if rng.random() < 0.25:
                    ground[y][x] = pick("sand")
                break

# 4) 中央石板广场 + 水井
PLZ = (24, 39)
fill_rect(road, PLZ[0], PLZ[0], PLZ[1] - PLZ[0] + 1, PLZ[1] - PLZ[0] + 1,
          lambda x, y: pick("plaza"), mark=True)
for x in range(PLZ[0], PLZ[1] + 1):
    road[PLZ[0]][x] = pick("plaza_edge")
    road[PLZ[1]][x] = pick("plaza_edge")
for y in range(PLZ[0], PLZ[1] + 1):
    road[y][PLZ[0]] = pick("plaza_edge")
    road[y][PLZ[1]] = pick("plaza_edge")

fill_rect(decor, 31, 31, 2, 2, lambda x, y: pick("water"), mark=True)  # 井水
for y in range(30, 34):
    for x in range(30, 34):
        if decor[y][x] == 0:
            decor[y][x] = pick("plaza_edge")

# 5) 民居位置（仅用于院子/阻挡规划；建筑本体用高清大图）
HOUSES = [
    (8, 8, 6, 5, "jz_1"), (17, 6, 5, 4, "jz_2"),
    (44, 8, 6, 5, "jz_3"), (52, 18, 5, 4, "jz_4"),
    (8, 42, 6, 5, "jz_5"), (18, 50, 5, 4, "jz_6"),
    (44, 56, 6, 5, "jz_7"), (54, 36, 5, 4, "jz_8"),
]
for hx, hy, hw, hh, _ in HOUSES:
    for y in range(hy - 1, hy + hh + 1):
        for x in range(hx - 1, hx + hw + 1):
            if in_map(x, y) and road[y][x] == 0:
                road[y][x] = pick("sand")
                blocked[y][x] = True

# 5b) 门前小路
PATHS = [
    (10, 14, 10, 29), (19, 11, 19, 29), (46, 14, 46, 29), (34, 20, 50, 20),
    (16, 45, 29, 45), (24, 52, 29, 52), (47, 54, 47, 55), (40, 37, 52, 37),
    (22, 57, 29, 57),
]
for x0, y0, x1, y1 in PATHS:
    for y in range(min(y0, y1), max(y0, y1) + 1):
        for x in range(min(x0, x1), max(x0, x1) + 1):
            if in_map(x, y) and road[y][x] == 0:
                road[y][x] = pick("stone_path")

# 6) 农田
fill_rect(road, 6, 55, 8, 5, lambda x, y: pick("farm"), mark=True)
fill_rect(road, 16, 55, 6, 5, lambda x, y: pick("farm"), mark=True)

# 7) 池塘
PCX, PCY, PRX, PRY = 47, 47, 8, 6
fill_ellipse(decor, PCX, PCY, PRX, PRY, lambda x, y: pick("water"), mark=True)
for y in range(MH):
    for x in range(MW):
        if decor[y][x]:
            continue
        near_water = any(
            in_map(x + dx, y + dy) and decor[y + dy][x + dx] in POOLS["water"]
            for dx in (-1, 0, 1) for dy in (-1, 0, 1))
        if near_water and road[y][x] == 0:
            decor[y][x] = pick("shore")
            blocked[y][x] = True

# 8) 花园
GARDENS = [
    (8, 14, 13, 15, "flower_w"), (9, 14, 12, 15, "flower_w2"),
    (44, 14, 49, 15, "flower_p"), (45, 14, 48, 15, "flower_p2"),
    (18, 55, 22, 56, "flower_p"),
]
for x0, y0, x1, y1, fk in GARDENS:
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if in_map(x, y) and decor[y][x] == 0 and road[y][x] == 0:
                decor[y][x] = pick(fk)

# 9) 村口木桩（立体小物件）
for gx, gy in ((29, 61), (34, 61), (29, 2), (34, 2)):
    if decor[gy][gx] == 0:
        decor[gy][gx] = POOLS["post"][gx % 2]
        raised[gy][gx] = True
        blocked[gy][gx] = True

# 10) 散布岩石（立体小物件）
free_cells = [(x, y) for y in range(MH) for x in range(MW)
              if not blocked[y][x] and road[y][x] == 0 and decor[y][x] == 0
              and not (PLZ[0] - 2 <= x <= PLZ[1] + 2 and PLZ[0] - 2 <= y <= PLZ[1] + 2)]
edge_cells = [(x, y) for (x, y) in free_cells
              if x < 12 or y < 12 or x >= MW - 12 or y >= MH - 12]
rng.shuffle(edge_cells)
rocks_n = 0
for x, y in edge_cells:
    if rocks_n >= 18:
        break
    ok = True
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            nx, ny = x + dx, y + dy
            if in_map(nx, ny) and decor[ny][nx] in POOLS["rock"]:
                ok = False
    if not ok:
        continue
    decor[y][x] = pick("rock")
    raised[y][x] = True
    rocks_n += 1

pond_ring = [(x, y) for y in range(PCY - PRY - 2, PCY + PRY + 3)
             for x in range(PCX - PRX - 2, PCX + PRX + 3)
             if in_map(x, y) and decor[y][x] in POOLS["shore"]]
rng.shuffle(pond_ring)
for x, y in pond_ring[:6]:
    if rng.random() < 0.5:
        decor[y][x] = pick("rock")
        raised[y][x] = True

# ---------------- 高清大物件：注册 + 摆放 ----------------
JZ = os.path.join(YL, "高清建筑")
ZW = os.path.join(YL, "植物")

# 8 座民居（居中对齐原房屋区域，底边贴院子下缘）
HOUSE_BIGS = [
    ("jz_1", "建筑_045.png", 760), ("jz_2", "建筑_002.png", 620),
    ("jz_3", "建筑_044.png", 720), ("jz_4", "建筑_053.png", 640),
    ("jz_5", "建筑_049.png", 700), ("jz_6", "建筑_059.png", 620),
    ("jz_7", "建筑_057.png", 700), ("jz_8", "建筑_047.png", 620),
]
for (hx, hy, hw, hh, nm), (nm2, src, tw) in zip(HOUSES, HOUSE_BIGS):
    gid = register_big(os.path.join(JZ, src), nm2, tw)
    place_big(gid, nm2, (hx + hw / 2) * T, (hy + hh) * T, "house")

# 凉亭（广场西北绿地）
gid = register_big(os.path.join(JZ, "建筑_021.png"), "liang_ting_1", 460)
place_big(gid, "liang_ting_1", 17 * T, 23 * T, "house")

# 石牌坊（南村口，跨主路，中间留通道）
gid = register_big(os.path.join(JZ, "建筑_094.png"), "pai_fang_1", 540)
place_big(gid, "pai_fang_1", 32 * T, 62 * T, "gate")

# 树木品种
TREES = {
    "shu_a":  ("植物_012.png", 330),
    "shu_b":  ("植物_013.png", 310),
    "liu_a":  ("植物_045.png", 340),
    "liu_b":  ("植物_046.png", 320),
    "shu_c":  ("植物_062.png", 330),
    "shu_d":  ("植物_070.png", 320),
    "zhu_a":  ("植物_085.png", 300),
    "shu_e":  ("植物_114.png", 300),
}
TREE_GIDS = {}
for nm, (src, tw) in TREES.items():
    TREE_GIDS[nm] = register_big(os.path.join(ZW, src), nm, tw)

def tree_free(x, y):
    if not in_map(x, y) or blocked[y][x] or road[y][x] or decor[y][x]:
        return False
    if PLZ[0] - 1 <= x <= PLZ[1] + 1 and PLZ[0] - 1 <= y <= PLZ[1] + 1:
        return False
    # 与已有树保持间距
    for p in PLACEMENTS:
        if p["kind"] == "tree":
            if abs(p["gx"] - x) < 3 and abs(p["gy"] - y) < 3:
                return False
    return True

placed_trees = 0
def put_tree(x, y):
    global placed_trees
    if not tree_free(x, y):
        return False
    nm = rng.choice(list(TREE_GIDS.keys()))
    place_big(TREE_GIDS[nm], nm, x * T + T // 2, (y + 1) * T, "tree")
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if in_map(x + dx, y + dy):
                blocked[y + dy][x + dx] = True
    placed_trees += 1
    return True

# 10b) 四周林带
band = [(x, y) for y in range(MH) for x in range(MW)
        if x < 8 or y < 8 or x >= MW - 8 or y >= MH - 8]
rng.shuffle(band)
for x, y in band:
    if placed_trees >= 26:
        break
    if rng.random() < 0.5:
        put_tree(x, y)

# 10c) 池塘边柳树
for ang in range(0, 360, 30):
    if placed_trees >= 34:
        break
    x = round(PCX + (PRX + 2.4) * math.cos(math.radians(ang)))
    y = round(PCY + (PRY + 2.2) * math.sin(math.radians(ang)))
    if rng.random() < 0.6:
        put_tree(x, y)

# 10d) 村内点缀树
for x, y in ((13, 19), (23, 12), (38, 13), (52, 26), (13, 34), (22, 46),
             (37, 50), (52, 45), (26, 60), (58, 55), (60, 8)):
    put_tree(x, y)
print(f"大物件: {len(PLACEMENTS)} 个摆放 (树 {placed_trees})")

# ---------------- 合并为 ground / wall 两层 ----------------
ground_out = [[0] * MW for _ in range(MH)]
wall_out = [[0] * MW for _ in range(MH)]
for y in range(MH):
    for x in range(MW):
        g = ((decor[y][x] if not raised[y][x] else 0) or road[y][x]
             or ground[y][x])
        ground_out[y][x] = g
        w = decor[y][x] if raised[y][x] else 0
        wall_out[y][x] = w
for p in PLACEMENTS:
    wall_out[p["gy"]][p["gx"]] = p["gid"]

# ---------------- 碰撞区域 ----------------
collisions = []
MPP = MW * T
collisions += [
    (-64, -64, MPP + 128, 128),
    (MPP - 64, -64, 128, MPP + 128),
    (-64, MPP - 64, MPP + 128, 128),
    (-64, -64, 128, MPP + 128),
]
# 水井
collisions.append((31 * T + 8, 31 * T + 8, 2 * T - 16, 2 * T - 16))
# 水域（逐行合并）
WATER_GIDS = set(POOLS["water"])
for y in range(MH):
    x = 0
    while x < MW:
        if decor[y][x] in WATER_GIDS:
            x0 = x
            while x < MW and decor[y][x] in WATER_GIDS:
                x += 1
            collisions.append((x0 * T, y * T, (x - x0) * T, T))
        else:
            x += 1
# 岩石/木桩
PROP_GIDS = set(POOLS["rock"]) | set(POOLS["post"])
for y in range(MH):
    for x in range(MW):
        if wall_out[y][x] in PROP_GIDS:
            collisions.append((x * T + 16, y * T + 44, T - 32, T - 60))
# 大物件
for p in PLACEMENTS:
    if p["kind"] == "house":
        fw, fh = p["w"] * 0.82, p["h"] * 0.24
        fx = p["px"] + (p["w"] - fw) / 2
        fy = p["py"] - fh - 6
        collisions.append((round(fx), round(fy), round(fw), round(fh)))
    elif p["kind"] == "tree":
        fw, fh = p["w"] * 0.32, p["h"] * 0.12
        fx = p["px"] + (p["w"] - fw) / 2
        fy = p["py"] - fh - 4
        collisions.append((round(fx), round(fy), round(fw), round(fh)))
    elif p["kind"] == "gate":
        # 牌坊：左右立柱碰撞，中间通道
        pw = p["w"] * 0.30
        ph = p["h"] * 0.30
        collisions.append((round(p["px"] + p["w"] * 0.02), round(p["py"] - ph - 4),
                           round(pw), round(ph)))
        collisions.append((round(p["px"] + p["w"] * 0.68), round(p["py"] - ph - 4),
                           round(pw), round(ph)))

# ---------------- 写 TMX ----------------
def layer_csv(layer):
    rows = [",".join(str(layer[y][x]) for x in range(MW)) + "," for y in range(MH)]
    rows[-1] = rows[-1][:-1]
    return "\n".join(rows)

obj_lines = []
for i, (ox, oy, ow, oh) in enumerate(collisions, 100):
    obj_lines.append(f'  <object id="{i}" x="{ox}" y="{oy}" width="{ow}" height="{oh}"/>')

# ---------------- monster / npc 对象层（参考格式） ----------------
# monster：矩形刷怪区，属性 id / max / min；命名「N号怪物」/「BOSS1」
# npc：只放「复活点」(type=revive, point) 和「大陆传送」(type=npc, id=目的地图编号, point)
MONSTER_ZONES = [
    # (名称, 怪物id, max, min, 瓦片x, y, w, h)
    ("1号怪物", 1,   10, 0,  3, 16, 13, 13),   # 西北荒野·低阶
    ("2号怪物", 2,   10, 0, 42, 22, 18, 12),   # 东北荒野
    ("3号怪物", 3,    8, 0,  3, 32, 21,  9),   # 西南荒野
    ("BOSS1",  200,   1, 0, 40, 26, 14, 10),   # 东南·池塘北 BOSS 场
]
NPC_POINTS = [
    # (名称, type, 目的地图id, 像素x, 像素y)
    ("复活点",   "revive", None,   32 * T,     34 * T + 64),
    ("大陆传送", "npc",    "0002", 32 * T,     61 * T + 64),
]

monster_lines = []
_oid = 1
for nm, mid, mx, mn, tx, ty, tw_, th_ in MONSTER_ZONES:
    monster_lines.append(
        f'  <object id="{_oid}" name="{nm}" x="{tx * T}" y="{ty * T}" '
        f'width="{tw_ * T}" height="{th_ * T}">\n'
        f'   <properties>\n'
        f'    <property name="id" value="{mid}"/>\n'
        f'    <property name="max" value="{mx}"/>\n'
        f'    <property name="min" value="{mn}"/>\n'
        f'   </properties>\n'
        f'  </object>')
    _oid += 1

npc_lines = []
for nm, typ, pid, nx, ny in NPC_POINTS:
    if typ == "revive":
        npc_lines.append(
            f'  <object id="{_oid}" name="{nm}" type="revive" x="{nx}" y="{ny}">\n'
            f'   <point/>\n'
            f'  </object>')
    else:
        npc_lines.append(
            f'  <object id="{_oid}" name="{nm}" type="npc" x="{nx}" y="{ny}">\n'
            f'   <properties>\n'
            f'    <property name="id" value="{pid}"/>\n'
            f'   </properties>\n'
            f'   <point/>\n'
            f'  </object>')
    _oid += 1

all_tsx = tsx_lines + BIG_TSX
tmx = f'''<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="{MW}" height="{MH}" tilewidth="{T}" tileheight="{T}" infinite="0" nextlayerid="6" nextobjectid="{_oid}">
{chr(10).join(all_tsx)}
 <layer id="1" name="ground" width="{MW}" height="{MH}">
  <data encoding="csv">
{layer_csv(ground_out)}
  </data>
 </layer>
 <layer id="2" name="wall" width="{MW}" height="{MH}">
  <data encoding="csv">
{layer_csv(wall_out)}
  </data>
 </layer>
 <objectgroup id="3" name="monster">
{chr(10).join(monster_lines)}
 </objectgroup>
 <objectgroup id="4" name="npc">
{chr(10).join(npc_lines)}
 </objectgroup>
 <objectgroup id="5" name="collision">
{chr(10).join(obj_lines)}
 </objectgroup>
</map>
'''
tmx_path = os.path.join(OUT, "新手村.tmx")
with open(tmx_path, "w", encoding="utf-8") as f:
    f.write(tmx)
print("tmx:", tmx_path, f"tsx总数={len(all_tsx)} GID最大={_gid_next-1}")

# 清理 v2 遗留的屋顶瓦片束
for old in ("wu_ding_1.jpg", "wu_ding_1.tsx", "wu_ding_2.jpg", "wu_ding_2.tsx",
            "tileset.png"):
    p = os.path.join(OUT, old)
    if os.path.exists(p):
        os.remove(p)
        print("清理:", old)
old_src = os.path.join(OUT, "瓦片源图")
if os.path.isdir(old_src):
    shutil.rmtree(old_src)

# ---------------- 渲染预览（画家算法：先瓦片，再按底边排序贴大物件） ----------------
SCALE = 64
comp = Image.new("RGB", (MW * SCALE, MH * SCALE))
for y in range(MH):
    for x in range(MW):
        gid = ground_out[y][x]
        if gid:
            comp.paste(Image.open(GID2SRC[gid]).convert("RGB").resize(
                (SCALE, SCALE), Image.LANCZOS), (x * SCALE, y * SCALE))
# wall 小物件按行序
for y in range(MH):
    for x in range(MW):
        gid = wall_out[y][x]
        if gid and gid in GID2SRC:
            comp.paste(Image.open(GID2SRC[gid]).convert("RGB").resize(
                (SCALE, SCALE), Image.LANCZOS), (x * SCALE, y * SCALE))
# 大物件
for p in sorted(PLACEMENTS, key=lambda q: q["py"]):
    im = Image.open(os.path.join(OUT, p["name"] + ".png")).convert("RGBA")
    tw, th = p["w"] // (T // SCALE), p["h"] // (T // SCALE)
    im = im.resize((tw, th), Image.LANCZOS)
    comp.paste(im, (p["px"] // (T // SCALE), (p["py"] - p["h"]) // (T // SCALE)), im)

prev = comp.resize((2048, 2048), Image.LANCZOS)
prev_path = os.path.join(OUT, "预览_新手村.jpg")
prev.save(prev_path, "JPEG", quality=88, subsampling=0)
print("预览:", prev_path)

# 碰撞可视化
from PIL import ImageDraw
cp = comp.copy()
dr = ImageDraw.Draw(cp)
for ox, oy, ow, oh in collisions:
    dr.rectangle([ox / T * SCALE, oy / T * SCALE,
                  (ox + ow) / T * SCALE, (oy + oh) / T * SCALE],
                 outline=(255, 0, 0), width=2)
for nm, mid, mx, mn, tx, ty, tw_, th_ in MONSTER_ZONES:
    dr.rectangle([tx * T / T * SCALE, ty * T / T * SCALE,
                  (tx + tw_) * T / T * SCALE, (ty + th_) * T / T * SCALE],
                 outline=(0, 90, 255), width=3)
for nm, typ, pid, nx, ny in NPC_POINTS:
    cx_, cy_ = nx / T * SCALE, ny / T * SCALE
    col = (0, 170, 0) if typ == "revive" else (170, 0, 200)
    dr.ellipse([cx_ - 12, cy_ - 12, cx_ + 12, cy_ + 12], outline=col, width=3)
    dr.line([cx_ - 18, cy_, cx_ + 18, cy_], fill=col, width=2)
    dr.line([cx_, cy_ - 18, cx_, cy_ + 18], fill=col, width=2)
cp.resize((2048, 2048), Image.LANCZOS).save(
    os.path.join(OUT, "预览_碰撞.jpg"), "JPEG", quality=88, subsampling=0)
print("区域预览: 碰撞", len(collisions), "刷怪区", len(MONSTER_ZONES), "NPC点", len(NPC_POINTS))

used = set()
for layer in (ground_out, wall_out):
    for row in layer:
        used.update(g for g in row if g)
print(f"实际用到 GID: {len(used)}")

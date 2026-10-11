#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「新手村」TMX 地图生成器 v2 —— 按「参考地图格式」规范输出
参考格式要点（从 参考地图格式/ 学习）：
1. 每个素材一个 .tsx + 一张图，与 .tmx 同目录（自包含）
2. tsx = 单瓦片 或 多瓦片网格（columns x rows）
3. <tileset firstgid=N source="xxx.tsx"/> 按顺序累加：next = firstgid + tilecount
4. 图层：ground（地形）+ wall（物件/建筑）
5. 地形用 JPG；version 1.10 / tiledversion 1.12.2 / CSV / orthogonal / right-down
"""
import os
import math
import shutil
import random
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = "jpg"
OUT = "新手村地图"
os.makedirs(OUT, exist_ok=True)
T = 128
MW = MH = 64
rng = random.Random(20261003)

# ---------------- 素材束定义：(tsx名, 分组, 可选指定文件) ----------------
ROCK_NAMES = ["00003", "00005", "00009", "00010", "00012", "00013", "00014",
              "00020", "00021", "00022", "00023", "00025", "00028", "00029",
              "00030", "00031", "00032", "00037", "00039", "00042", "00045",
              "00046", "00049", "00051", "00052"]
SHORE_NAMES = ["00002", "00006", "00007", "00008", "00015", "00016", "00017",
               "00024", "00026", "00033", "00036", "00048"]

BUNDLES = [
    # (tsx 名, 分组目录, 指定文件名列表或 None)
    ("cao_di_1",     "448", None),   # 草地主基底
    ("cao_di_2",     "451", None),   # 草地变体
    ("cao_di_3",     "485", None),   # 草地变体
    ("cao_di_4",     "407", None),   # 深色草（边缘野地）
    ("tu_lu_1",      "000", None),   # 土路
    ("sha_di_1",     "348", None),   # 沙土（路肩/院子）
    ("shi_ban_1",    "506", None),   # 石板广场
    ("shi_ban_2",    "501", None),   # 石板镶边
    ("shi_ban_lu_1", "470", None),   # 石板草径
    ("nong_tian_1",  "747", None),   # 农田
    ("shui_mian_1",  "074", None),   # 水面
    ("an_shi_1",     "073", SHORE_NAMES),  # 岸石
    ("hua_cong_1",   "390", None),   # 白花
    ("hua_cong_2",   "458", None),   # 粉花
    ("hua_cong_3",   "468", None),   # 粉花
    ("yan_shi_1",    "073", ROCK_NAMES),   # 岩石
    ("mu_zhuang_1",  "073", ["00068", "00069"]),  # 木桩
    ("wu_ding_1",    "476", None),   # 灰瓦顶
    ("wu_ding_2",    "152", None),   # 棕草顶
]

# ---------------- 生成 tsx + 图片，分配 GID ----------------
POOLS = {}       # 逻辑池名 -> [gid,...]
GID2SRC = {}     # gid -> 源 jpg 路径
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
    print(f"{name}: {n} tiles  firstgid={gids[0]}  img={img.size}")

# 逻辑池映射
POOL_MAP = {
    "grass_a": "cao_di_1", "grass_b": "cao_di_2", "grass_c": "cao_di_3",
    "grass_dark": "cao_di_4", "dirt": "tu_lu_1", "sand": "sha_di_1",
    "plaza": "shi_ban_1", "plaza_edge": "shi_ban_2", "stone_path": "shi_ban_lu_1",
    "farm": "nong_tian_1", "water": "shui_mian_1", "shore": "an_shi_1",
    "flower_w": "hua_cong_1", "flower_p": "hua_cong_2", "flower_p2": "hua_cong_3",
    "rock": "yan_shi_1", "post": "mu_zhuang_1",
    "roof_gray": "wu_ding_1", "roof_brown": "wu_ding_2",
}
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
for key, bname in POOL_MAP.items():
    POOLS[key] = BUNDLE_GIDS[bname]

def pick(key):
    pool = POOLS[key]
    return pool[rng.randrange(len(pool))]

# ---------------- 地图绘制（布局与 v1 相同） ----------------
ground = [[0] * MW for _ in range(MH)]
road = [[0] * MW for _ in range(MH)]
decor = [[0] * MW for _ in range(MH)]
build = [[0] * MW for _ in range(MH)]
raised = [[False] * MW for _ in range(MH)]   # decor 中的立体物件（岩石/木桩）
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

# 1) 草地基底
def grass_px(x, y):
    r = rng.random()
    if r < 0.84:   return pick("grass_a")
    if r < 0.94:   return pick("grass_b")
    return pick("grass_c")

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

# 5) 民居
HOUSES = [
    (8, 8, 6, 5, "roof_brown"), (17, 6, 5, 4, "roof_gray"),
    (44, 8, 6, 5, "roof_gray"), (52, 18, 5, 4, "roof_brown"),
    (8, 42, 6, 5, "roof_gray"), (18, 50, 5, 4, "roof_brown"),
    (44, 56, 6, 5, "roof_gray"), (54, 36, 5, 4, "roof_brown"),
]
for hx, hy, hw, hh, rk in HOUSES:
    fill_rect(build, hx, hy, hw, hh, lambda x, y: pick(rk), mark=True)
    for y in range(hy - 1, hy + hh + 1):
        for x in range(hx - 1, hx + hw + 1):
            if in_map(x, y) and road[y][x] == 0 and build[y][x] == 0:
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
            if in_map(x, y) and road[y][x] == 0 and build[y][x] == 0:
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
        if near_water and road[y][x] == 0 and build[y][x] == 0:
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
            if in_map(x, y) and decor[y][x] == 0 and build[y][x] == 0 and road[y][x] == 0:
                decor[y][x] = pick(fk)

# 9) 村口木桩（立体物件）
for gx, gy in ((29, 61), (34, 61), (29, 2), (34, 2)):
    if build[gy][gx] == 0 and decor[gy][gx] == 0:
        decor[gy][gx] = POOLS["post"][gx % 2]
        raised[gy][gx] = True
        blocked[gy][gx] = True

# 10) 散布岩石（立体物件）
free_cells = [(x, y) for y in range(MH) for x in range(MW)
              if not blocked[y][x] and road[y][x] == 0 and decor[y][x] == 0
              and build[y][x] == 0
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

# ---------------- 合并为 ground / wall 两层 ----------------
ground_out = [[0] * MW for _ in range(MH)]
wall_out = [[0] * MW for _ in range(MH)]
for y in range(MH):
    for x in range(MW):
        g = ((decor[y][x] if not raised[y][x] else 0) or road[y][x]
             or ground[y][x])
        ground_out[y][x] = g
        w = build[y][x] or (decor[y][x] if raised[y][x] else 0)
        wall_out[y][x] = w

# ---------------- 碰撞区域（参考格式：objectgroup name="collision" + 矩形对象） ----------------
# 约定（与参考地图一致）：
#   1. 四周边界墙 4 条矩形
#   2. 每个立体物件（房屋/水井/岩石/木桩）一个底部碰撞矩形
#   3. 水域整体不可通行（按行合并成矩形，贴合椭圆边缘）
collisions = []   # (x, y, w, h) 像素坐标

# 1) 边界墙（略伸出地图外，防止贴边穿出）
MPP = MW * T   # 地图像素宽
collisions += [
    (-64, -64, MPP + 128, 128),          # 上
    (MPP - 64, -64, 128, MPP + 128),     # 右
    (-64, MPP - 64, MPP + 128, 128),     # 下
    (-64, -64, 128, MPP + 128),          # 左
]

# 2) 房屋（整块屋顶区域）
for hx, hy, hw, hh, _rk in HOUSES:
    collisions.append((hx * T + 8, hy * T + 16, hw * T - 16, hh * T - 24))

# 3) 中央水井（2x2）
collisions.append((31 * T + 8, 31 * T + 8, 2 * T - 16, 2 * T - 16))

# 4) 水域（逐行合并水平连续段）
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

# 5) 岩石 / 木桩（单瓦片，底部略内缩的矩形）
PROP_GIDS = set(POOLS["rock"]) | set(POOLS["post"])
for y in range(MH):
    for x in range(MW):
        if wall_out[y][x] in PROP_GIDS:
            collisions.append((x * T + 16, y * T + 44, T - 32, T - 60))

def layer_csv(layer):
    # Tiled 的 CSV 格式：每行末尾必须带逗号（最后一行除外），否则报"数据已损坏"
    rows = [",".join(str(layer[y][x]) for x in range(MW)) + "," for y in range(MH)]
    rows[-1] = rows[-1][:-1]
    return "\n".join(rows)

obj_lines = []
for i, (ox, oy, ow, oh) in enumerate(collisions, 1):
    obj_lines.append(f'  <object id="{i}" x="{ox}" y="{oy}" width="{ow}" height="{oh}"/>')

tmx = f'''<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="{MW}" height="{MH}" tilewidth="{T}" tileheight="{T}" infinite="0" nextlayerid="4" nextobjectid="{len(collisions) + 1}">
{chr(10).join(tsx_lines)}
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
 <objectgroup id="3" name="collision">
{chr(10).join(obj_lines)}
 </objectgroup>
</map>
'''
tmx_path = os.path.join(OUT, "新手村.tmx")
with open(tmx_path, "w", encoding="utf-8") as f:
    f.write(tmx)
print("tmx:", tmx_path)

# 清理旧版单瓦片集产物
old_ts = os.path.join(OUT, "tileset.png")
if os.path.exists(old_ts):
    os.remove(old_ts)
old_src = os.path.join(OUT, "瓦片源图")
if os.path.isdir(old_src):
    shutil.rmtree(old_src)

# ---------------- 渲染预览 ----------------
SCALE = 64
comp = Image.new("RGB", (MW * SCALE, MH * SCALE))
for y in range(MH):
    for x in range(MW):
        gid = wall_out[y][x] or ground_out[y][x]
        if gid == 0:
            continue
        bx, by = GID2SRC[gid].rsplit("/", 1)
        comp.paste(Image.open(GID2SRC[gid]).convert("RGB").resize((SCALE, SCALE),
                   Image.LANCZOS), (x * SCALE, y * SCALE))
prev = comp.resize((2048, 2048), Image.LANCZOS)
prev_path = os.path.join(OUT, "预览_新手村.jpg")
prev.save(prev_path, "JPEG", quality=88, subsampling=0)
print("预览:", prev_path)

# 碰撞可视化预览（红色 = 碰撞区域）
from PIL import ImageDraw
cp = comp.copy()
dr = ImageDraw.Draw(cp)
for ox, oy, ow, oh in collisions:
    dr.rectangle([ox / T * SCALE, oy / T * SCALE,
                  (ox + ow) / T * SCALE, (oy + oh) / T * SCALE],
                 outline=(255, 0, 0), width=2)
cp.resize((2048, 2048), Image.LANCZOS).save(
    os.path.join(OUT, "预览_碰撞.jpg"), "JPEG", quality=88, subsampling=0)
print("碰撞预览:", os.path.join(OUT, "预览_碰撞.jpg"), f"共 {len(collisions)} 个碰撞矩形")

used = set()
for layer in (ground_out, wall_out):
    for row in layer:
        used.update(g for g in row if g)
print(f"实际用到 GID: {len(used)}")

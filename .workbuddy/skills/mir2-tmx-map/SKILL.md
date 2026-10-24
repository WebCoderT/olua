---
name: mir2-tmx-map
description: 传奇类 2.5D 端游/手游 TiledMap 场景地图生成器。从 TGA 素材库（jpg/ 无缝地砖 + 游戏场景元素/ 高清大物件）一键生成自包含 TMX 地图（tsx+图+碰撞+刷怪+NPC 五层齐全），已产出 11 张验证地图。
---

# mir2-tmx-map 地图生成技能

从本库素材生成 Tiled 1.10 格式 TMX 地图。**在项目根目录运行所有命令**（脚本按相对路径找 `jpg/` 与 `游戏场景元素/`）。

## 目录结构

```
.workbuddy/skills/mir2-tmx-map/
├── SKILL.md
└── scripts/
    ├── build_cities.py     # 核心管线：MapBuilder 类 + 王城/卧龙城两个参考实现
    ├── analyze_groups.py   # 素材分析：全库分组的主色调分类 + 无缝度评分
    ├── tga2jpg.py          # 素材预处理：TGA → JPG（Pillow，8 进程，quality=95 + subsampling=0 像素画边缘不糊）；本仓库未收录素材库，只在拿 TGA 原始库开工时用
    ├── build_village_v2.py # 旧版参考实现（新手村「参考格式版」，早期 4 阶段工作流产物）
    └── build_village_v3.py # 旧版参考实现（新手村迭代版）
```

示例生成器（项目根目录，也是活的教学样本）：
`build_snow_plateau.py`(冰雪高原) `build_grassland.py`(草原) `build_ruin_temple.py`(荒庙) `build_five_styles.py`(一次生成大漠/火山/水乡/石林/桃源五张，支持参数单跑)

## 标准流程

1. **选素材**：`python scripts/analyze_groups.py | grep 关键词` 看分类/无缝度（★ = seam<1.35 更无缝），再用 PIL 拼候选组预览图肉眼复核（**必须看图，分类器会误判**）。
2. **写生成器**：仿照任一示例，定义 `BUNDLES`（瓦片束）+ `BIGS`（高清大物件）+ 布局代码。
3. **运行 + 校验**：生成器跑完后用 Tiled CLI 实测：
   ```bash
   /Applications/Tiled.app/Contents/MacOS/tiled --export-map "XX地图/XX.tmx" /tmp/chk.json
   ```
   报"数据已损坏"≈ CSV 行尾逗号问题；正常则解析 chk.json 确认五层齐全。

## MapBuilder API 速查

```python
# 用户级安装用这个路径；项目级安装则用 <项目根>/.workbuddy/skills/mir2-tmx-map/scripts
sys.path.append(os.path.expanduser("~/.workbuddy/skills/mir2-tmx-map/scripts"))
from build_cities import MapBuilder, T, DB, ZW, JZ, ROCK_NAMES

b = MapBuilder("输出目录", 种子int, BUNDLES)   # bundles=(名字, 分组号, 子集list|None)
b.init_grid(64, 64)
b.fill_rect(b.ground, 0, 0, 64, 64, fn)        # fn(x,y)->gid；ground/wall/decor 三层网格
b.fill_ellipse(b.ground, cx, cy, rx, ry, fn)
b.ground[y][x] = b.pick("束名")                # 从该束随机取一张瓦片
b.road[y][x] = b.pick(...)                     # 道路层（自动加碰撞）
b.put_tree(gid, name, x, y, space=3)           # 大物件+碰撞
b.scatter_trees(cells, [(gid,name)...], space, prob, cap)
b.merge()                                      # decor 合入 ground/wall
b.add_base_collisions(water_border=True)       # 水面/散石/木桩碰撞
b.add_placement_collisions()
b.finalize("标题", monster_zones, npc_points)  # 出 tmx/tsx/图/预览/区域图
```

- 无水面的图：抄示例里的 `NoWaterBuilder`（覆盖 `add_base_collisions` 跳过水碰撞）。

## TMX 格式规范（权威，勿改）

- 头部 `version=1.10 tiledversion=1.12.2 orthogonal right-down`，CSV 编码。
- **每素材一个 .tsx + 一张图**，与 .tmx 同目录（自包含，整体拷贝交付）；外部 tsx 引用，firstgid 顺序累加（next = firstgid + tilecount）。
- 图层：`ground`+`wall` 瓦片层；`monster`(矩形刷怪区 id/max/min，BOSS id≥200 max=1) / `npc`(revive 复活点 + 传送 npc id=目的图编号) / `collision`(矩形)。
- 对象 id 分配：monster 1-49 / npc 50-99 / collision 100+。
- 地形用 JPG，透明物件用 PNG；大瓦片锚定格子左下角向上延伸；**不生成 .meta**（Cocos 自动生成）。
- **CSV 行尾必须带逗号（最后一行除外）**，否则 Tiled 报数据损坏。

## 踩坑清单（实测教训）

1. **主基底必须单组瓦片**：把色相不同的两组混作基底 = "花格布"废图（大漠 461+003、火山 520+462 均踩过）。变体组占比 ≤30% 且色相一致。
2. **纯黑/过亮瓦片慎用**：012 纯黑土在雪地/暗色底上单格出现像"空洞"；501 米白石板在暗色底上亮得像雪地。露土/旧迹一律用中间色过渡组（015/594 碎雪类）小块点缀。
3. **整片铺花毯会翻车**：545 粉花毯大片铺设像血池，只能 ≤5 格小块点缀。
4. **受管 Python 文件代理极慢**：预览渲染禁止逐格 `Image.open`（8000 次直接卡死）——build_cities 的 finalize 已内置按 GID/名字缓存，别在生成器里自己加逐格渲染。
5. **路段矩形填充**：x 上界是 `max(x0,x1)` 不是 `max(y0,y1)`（曾导致石路铺满 1/4 图）。
6. **POOLS 引用健壮性**：add_base_collisions 用 `.get()` 取池，缺水面的图不会 KeyError。
7. **生成器必须固定 seed**（传 int），调参重跑可复现、diff 可对比。
8. **每张图必须带 monster+npc 层**：传送 npc id 统一指向王城 0002，保持大陆图连通。

## 已验证素材风格索引（分组号 → 用途）

- 草地：448 主/451、485 变体/407 深草边；土路 000；沙地 348
- 雪地：593 主/355 青白/687 杂色；碎雪过渡 015/594；冰面 340；雪中石板路 083
- 水面：074 + 岸石 073（子集选图）；花丛 390/458
- 沙漠：461 沙丘主/009 变体/348 干河床
- 火山：520 暗红焦土主/012 焦黑裂痕
- 石材：096 苔石砖/385 碎裂石板/143 碎石/083、096 石路/227 荒土
- 暗色系：010/012/051（暗色/木）
- 高清大物件：地表-山石-物件/场景素材_NNN.png（尖岩塔 498-503、骨堆 42-48、断墙 233-236、石碑 497、土冢 243-250）；植物/植物_NNN.png（枯树 018-020、桃柳 012/076/079-080、花树 105/089）；高清建筑/建筑_NNN.png（石塔 022/024/028）

## 质量验收

1. Tiled CLI `--export-map` 实测通过（非仅语法检查）。
2. 看整图预览：无花格布、无黑色空洞、路网连贯、密林/水域边界自然。
3. firstgid 连续、tsx 图片齐全（解析 TMX 正则核对）。
4. 五层齐全 + 对象 id 在约定区间。

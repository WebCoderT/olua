#!/usr/bin/env node
/**
 * 地图原点口径审计（#566）：世界坐标 = 地图左上角为原点，TMX 坐标只差一次 y 取反
 *
 * 为什么要有它：这套口径错了不会报错、不会崩，只会「NPC 全体偏半张图」「怪物刷到地图外」——
 * 而且看起来像正常渲染，只能靠肉眼发现。历史包袱还特别重：客户端换算、导入工具、生成快照、
 * 小地图 / 预览图 / 寻路网格各写过一遍「中心 ± 半图」，改一处很容易漏另一处。
 *
 * 六条规则（全部是静态可判的，不做数值回归）：
 * 1. `GameMap.loadMap` 必须把 UITransform 锚点设成 (0,1)，且**在 `tmxAsset` 赋值之前**
 *    —— 引擎在赋值那一刻同步 `_buildLayerAndGroup()`→`_syncAnchorPoint()`，按当时锚点算图层锚点与
 *    顶点平移量；事后改锚点只改本节点，图层仍按旧锚点绘制（= 整体偏半张图）。
 * 2. `tmxAsset` 赋值之后必须**逐个图层重算一次 `_syncAnchorPoint()`** —— 图层只在 `TiledLayer.onEnable`
 *    里注册 ANCHOR_CHANGED 监听，而建图时地图节点还没入场景、图层未启用，地图那次 `_syncAnchorPoint()`
 *    没人接：`leftDownToCenter` 停在按默认锚点 0.5 算的 (W/2, H/2)，瓦片照旧铺在中心；坐标换算却已按
 *    左上角把角色送到 (x, -y) → 落在错位的图之外 = **整屏黑**（#568）。这条最容易漏，因为它不报错。
 * 3. `MapPointMath.mapPointToWorld` 的函数体必须是 `(x, y) -> (x, -y)` —— 任何 `- W/2`、
 *    `H/2 -` 都说明半图偏移又回来了；换算函数不许再收 `map` 参数（地图节点恒在世界原点，
 *    再叠一次世界坐标就是多余运算，也是「两套写法」的入口）。
 * 4. `LayerManager.move` 只许搬 UI 层与相机，**不许动地图层** —— 整套「世界坐标 = Tiled 坐标取反 y」
 *    的地基是「地图节点在世界原点」，地图层一旦被移动，所有点位会整体错位而不报错。
 * 5. `tools/import-spawn-areas.cjs` 里不许出现旧公式 `- mapW / 2` / `mapH / 2 -`。
 * 6. 生成的刷怪区快照必须落在图内（矩形四边都在 `[0,W] × [-H,0]` 里）—— 旧口径的值会越界，
 *    这是「生成物用错口径」唯一不需要跑客户端就能发现的判据。
 * 7. 客户端不许再出现 `mapCenter` 这类「地图中心」的命名（照旧代码抄回来最常见）。
 * 8. 越界判定必须落在**跑得起来的链路**上（#586）：`common/utils/spawn-area-bounds.util.ts` 是唯一判据，
 *    `map.service` 要真的用它算 `inBounds`、`world.service` 播种时要对越界区域告警 ——
 *    第 6 条只校验生成快照，而运行时读的是库表；库表只在空库时按快照 seed 一次，
 *    旧口径时期 seed 过的库会一直把怪刷在图外，静态审计看不见它。
 *
 * 用法：node tools/audit-map-origin.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const GAME_MAP = path.join(REPO, "client/assets/ui/components/map/GameMap.ts");
const POINT_MATH = path.join(REPO, "client/assets/ui/utils/map/MapPointMath.ts");
const IMPORT_TOOL = path.join(REPO, "tools/import-spawn-areas.cjs");
const SPAWN_AREAS = path.join(REPO, "server/src/modules/world/spawn-areas.generated.ts");
const MAP_SIZES = path.join(REPO, "server/src/shared/map-sizes.generated.ts");
const CLIENT_ASSETS = path.join(REPO, "client/assets");
const LAYER_MANAGER = path.join(REPO, "client/assets/ui/core/LayerManager.ts");

/** 逐条问题（文件名:行号 + 该做什么） */
const problems = [];

function problem(file, line, hint) {
  problems.push({ file, line, hint });
}

/** 读取文件（不存在直接报问题，别静默跳过） */
function read(file, label) {
  if (!fs.existsSync(file)) {
    problem(label, 0, "文件不存在 —— 审计的判据被删了就等于没有守点，请恢复或同步改本脚本");
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function checkAnchoredBeforeAsset() {
  const src = read(GAME_MAP, "client/assets/ui/components/map/GameMap.ts");
  if (!src) return;
  const lines = src.split("\n");
  const anchorAt = lines.findIndex((line) => /setAnchorPoint\(0,\s*1\)/.test(line));
  const assetAt = lines.findIndex((line) => /\.tmxAsset\s*=/.test(line));
  if (anchorAt < 0) {
    problem("client/assets/ui/components/map/GameMap.ts", 0, "地图节点必须 setAnchorPoint(0, 1)：原点在左上角，Tiled 坐标才只差一次 y 取反");
    return;
  }
  if (assetAt < 0) {
    problem("client/assets/ui/components/map/GameMap.ts", 0, "找不到 tmxAsset 赋值 —— 地图构建方式变了，请同步改本审计的判据");
    return;
  }
  if (anchorAt > assetAt) {
    problem(
      "client/assets/ui/components/map/GameMap.ts",
      anchorAt + 1,
      "锚点必须在 tmxAsset 赋值**之前**设：引擎在赋值时同步按当前锚点算图层锚点与顶点平移量，事后改只动本节点（= 地图整体偏半张图）",
    );
  }
}

function checkLayerAnchorResync() {
  const src = read(GAME_MAP, "client/assets/ui/components/map/GameMap.ts");
  if (!src) return;
  const lines = src.split("\n");
  const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);
  const assetAt = lines.findIndex((line) => /\.tmxAsset\s*=/.test(line));
  if (assetAt < 0) return; // 由 checkAnchoredBeforeAsset 报
  const syncAt = lines.findIndex((line) => !isComment(line) && /_syncAnchorPoint\(\)/.test(line));
  if (syncAt < 0) {
    problem(
      "client/assets/ui/components/map/GameMap.ts",
      0,
      "tmxAsset 赋值后没给图层重算 leftDownToCenter：建图时图层未启用、收不到 ANCHOR_CHANGED，瓦片会照旧铺在中心（坐标换算却已按左上角）→ 进图整屏黑。加 `for (const layer of tiledMap.getLayers()) (layer as any)._syncAnchorPoint();`",
    );
    return;
  }
  if (syncAt < assetAt) {
    problem(
      "client/assets/ui/components/map/GameMap.ts",
      syncAt + 1,
      "图层重算必须在 tmxAsset 赋值**之后**（赋值时才建出图层，之前还没有图层可重算）",
    );
  }
}

function checkPointMath() {
  const src = read(POINT_MATH, "client/assets/ui/utils/map/MapPointMath.ts");
  if (!src) return;
  // 函数体只允许一次 y 取反：`return new Vec3(x, -y);`
  if (!/export function mapPointToWorld\(\s*x: number,\s*y: number\s*\)\s*\{\s*return new Vec3\(x, -y\);\s*\}/.test(src)) {
    problem(
      "client/assets/ui/utils/map/MapPointMath.ts",
      0,
      "mapPointToWorld 必须是 `(x, y) -> (x, -y)`：出现 -W/2、H/2- 之类就是半图偏移回来了（#566 只保留 y 取反）",
    );
  }
  // 换算函数不再收 map 参数：地图节点恒在世界原点，再叠一次世界坐标是多余运算
  if (/mapPointToWorld\([^)]*map[^)]*\)|mapRectCenterToWorld\([^)]*map[^)]*\)/.test(src)) {
    problem(
      "client/assets/ui/utils/map/MapPointMath.ts",
      0,
      "换算函数不该再收 map 参数（地图节点在世界原点，本地坐标即世界坐标）—— 收了就会有人以为还要再叠一次",
    );
  }
}

/** 地图层必须静止：它是「世界坐标 = Tiled 坐标取反 y」这条口径的地基 */
function checkMapLayerStatic() {
  const src = read(LAYER_MANAGER, "client/assets/ui/core/LayerManager.ts");
  if (!src) return;
  const body = /static move\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  if (!body) {
    problem("client/assets/ui/core/LayerManager.ts", 0, "找不到 LayerManager.move —— 相机跟随的实现变了，请同步改本审计的判据");
    return;
  }
  if (/MapLayer/.test(body[1])) {
    problem(
      "client/assets/ui/core/LayerManager.ts",
      0,
      "LayerManager.move 不许移动地图层：地图节点必须留在世界原点，否则 MapPointMath 的换算（只取反 y）会整体错位且不报错",
    );
  }
}

function checkImportTool() {
  const src = read(IMPORT_TOOL, "tools/import-spawn-areas.cjs");
  if (!src) return;
  const lines = src.split("\n");
  lines.forEach((line, index) => {
    // 注释里允许提旧公式（讲清「旧口径是什么」），代码行不许
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    if (/-\s*mapW\s*\/\s*2/.test(line) || /mapH\s*\/\s*2\s*-/.test(line)) {
      problem("tools/import-spawn-areas.cjs", index + 1, "刷怪区坐标还在用旧口径（减半宽、翻半高）：应为 cx = x + w/2、cy = -(y + h/2)");
    }
  });
}

/** 解析生成物：mapId → 尺寸 / 区域列表（两份都是本仓库的生成物，格式固定） */
function parseMapSizes(src) {
  const sizes = {};
  for (const line of src.split("\n")) {
    const match = /^\s{2}"([^"]+)": \{ cols: \d+, rows: \d+, tileWidth: \d+, tileHeight: \d+, width: (\d+), height: (\d+) \}/.exec(line);
    if (match) sizes[match[1]] = { width: Number(match[2]), height: Number(match[3]) };
  }
  return sizes;
}

function parseSpawnAreas(src) {
  const areas = [];
  let mapId = null;
  for (const line of src.split("\n")) {
    const header = /^\s{2}"([^"]+)": \[$/.exec(line);
    if (header) {
      mapId = header[1];
      continue;
    }
    const area = /\{ name: "([^"]*)", monsterKey: "([^"]*)", min: -?\d+, max: -?\d+, cx: (-?[\d.]+), cy: (-?[\d.]+), w: ([\d.]+), h: ([\d.]+) \}/.exec(line);
    if (area && mapId) {
      areas.push({ mapId, name: area[1], cx: Number(area[3]), cy: Number(area[4]), w: Number(area[5]), h: Number(area[6]) });
    }
  }
  return areas;
}

function checkSpawnAreasInMap() {
  const sizes = parseMapSizes(read(MAP_SIZES, "server/src/shared/map-sizes.generated.ts"));
  const areas = parseSpawnAreas(read(SPAWN_AREAS, "server/src/modules/world/spawn-areas.generated.ts"));
  if (areas.length === 0) {
    problem("server/src/modules/world/spawn-areas.generated.ts", 0, "一个刷怪区都没解析出来 —— 生成物格式变了，请同步改本审计的解析（别让它空跑即通过）");
    return;
  }
  if (Object.keys(sizes).length === 0) {
    problem("server/src/shared/map-sizes.generated.ts", 0, "一张地图尺寸都没解析出来 —— 同上");
    return;
  }
  /** 越界区域（口径一错就一大片，逐条打会淹掉别的规则，只报前几条） */
  const outside = [];
  for (const area of areas) {
    const size = sizes[area.mapId];
    if (!size) {
      problem("server/src/shared/map-sizes.generated.ts", 0, `地图 ${area.mapId} 没有尺寸快照，但刷怪区快照里有它（重跑 node tools/import-spawn-areas.cjs）`);
      continue;
    }
    // 新口径：地图占 x∈[0,W]、y∈[-H,0]；区域矩形必须整体落在里面
    const inside = area.cx - area.w / 2 >= -1 && area.cx + area.w / 2 <= size.width + 1 && area.cy <= 1 && area.cy + area.h / 2 <= 1 && area.cy - area.h / 2 >= -size.height - 1;
    if (!inside) {
      outside.push(
        `区域「${area.name}」（地图 ${area.mapId}）中心 (${area.cx}, ${area.cy}) 尺寸 ${area.w}x${area.h}，图 ${size.width}x${size.height}`,
      );
    }
  }
  for (const line of outside.slice(0, 5)) {
    problem(
      "server/src/modules/world/spawn-areas.generated.ts",
      0,
      `${line} —— 不在图内，多半是还在用「地图中心为原点」的旧口径（应 cx = x + w/2、cy = -(y + h/2)）`,
    );
  }
  if (outside.length > 5) {
    problem(
      "server/src/modules/world/spawn-areas.generated.ts",
      0,
      `同类越界区域共 ${outside.length} 个（上面只列了前 5 个）—— 重跑 node tools/import-spawn-areas.cjs`,
    );
  }
}

/** 客户端里不许再出现旧口径的命名（照旧代码抄回来最常见） */
function checkLegacyNaming() {
  const stack = [CLIENT_ASSETS];
  const hits = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const lines = fs.readFileSync(full, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (/\bmapCenter\b/.test(line)) hits.push(`${path.relative(REPO, full)}:${index + 1}`);
      });
    }
  }
  if (hits.length > 0) {
    problem("client/assets", 0, `世界坐标里不该再有「地图中心」这个概念（改用 getMapWorldRect 的 x/y/width/height）：${hits.join("、")}`);
  }
}

/** 越界判据必须被真的用起来（#586）—— 字段加了没人算 = 等于没做 */
function checkBoundsWired() {
  const util = path.join(REPO, "server/src/common/utils/spawn-area-bounds.util.ts");
  const utilSrc = read(util, "server/src/common/utils/spawn-area-bounds.util.ts");
  if (utilSrc && !/export const SPAWN_AREA_TOLERANCE = 1;/.test(utilSrc)) {
    problem(
      "server/src/common/utils/spawn-area-bounds.util.ts",
      0,
      "容差必须是 1（导入按浮点算中心、列是整数，取整会造出 0.x 的假越界）—— 改容差要同时改本条规则与第 6 条的 ±1",
    );
  }

  const service = read(path.join(REPO, "server/src/modules/map/map.service.ts"), "server/src/modules/map/map.service.ts");
  if (service && !(/spawnAreaInBounds\(/.test(service) && /spawnAreaOverflow\(/.test(service))) {
    problem(
      "server/src/modules/map/map.service.ts",
      0,
      "详情必须按地图尺寸算 inBounds / overflow（用 spawn-area-bounds.util）：管理端只显示结论，不自己再判一遍",
    );
  }

  const world = read(path.join(REPO, "server/src/modules/world/world.service.ts"), "server/src/modules/world/world.service.ts");
  if (world && !/spawnAreaInBounds\(/.test(world)) {
    problem(
      "server/src/modules/world/world.service.ts",
      0,
      "播种时要对越界区域告警（spawnAreaInBounds）：库表可能还是旧口径 seed 的，怪会刷在图外而没人知道",
    );
  }
}

checkAnchoredBeforeAsset();
checkLayerAnchorResync();
checkPointMath();
checkMapLayerStatic();
checkImportTool();
checkSpawnAreasInMap();
checkLegacyNaming();
checkBoundsWired();

if (problems.length === 0) {
  console.log("✓ 地图原点口径：锚点 (0,1) 在 tmxAsset 之前、建图后图层重算过、换算只有 y 取反、地图层静止、刷怪区坐标全部落在图内（快照 + 库表两条路都有判据）");
  process.exit(0);
}

console.error(`✗ 地图原点口径有 ${problems.length} 处问题（#566：世界坐标原点 = 地图左上角）：`);
for (const item of problems) {
  console.error(`  ${item.file}${item.line ? `:${item.line}` : ""}\n    ${item.hint}`);
}
process.exit(1);

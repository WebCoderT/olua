#!/usr/bin/env node
/**
 * 刷怪区导入工具（#295 阶段一：刷怪配置归服务端）
 *
 * 从客户端 Tiled 地图文件（client/assets/resources/map/<id>/<id>.tmx）的 monster 对象组
 * 解析刷怪区域，做坐标换算后生成 server/src/modules/world/spawn-areas.generated.ts
 * （提交进仓库，服务端启动时若 map_spawn_areas 表为空会拿它做种子）。
 *
 * 坐标口径与客户端完全一致（#566 起：地图节点原点 = 地图左上角）：
 *   Tiled 矩形 x/y 是左上角、y 轴向下；中心 = (x + w/2, y + h/2)；
 *   换成世界坐标只需把 y 取反：cx = x + w/2，cy = -(y + h/2) —— **没有半图偏移**。
 *   （旧口径是「地图中心为原点」，cx = x + w/2 - mapW/2、cy = mapH/2 - (y + h/2)；
 *    与现在的差别是全图平移 (mapW/2, -mapH/2)，存量库由服务端的一次性迁移抹平，见 database.service。）
 *
 * 另外把每张图的地图像素尺寸写进 server/src/shared/map-sizes.generated.ts ——
 * 服务端升级坐标口径时要按图平移存量数据，只有本工具读得到 TMX 头的 width/height/tilewidth。
 *
 * #571 起再产出一份 server/src/shared/map-content.generated.ts：图层与**全部**对象组
 * （npc / monster / collision / objects）的原始 Tiled 数据（坐标不换算、属性原样保留）。
 * 管理端「地图管理」页是只读观测台，读的就是这份 —— 它要能对着 Tiled 看同一组数字，
 * 所以这里刻意不做坐标换算（世界坐标由刷怪区表那条路提供，两者在页面上分栏显示）。
 *
 * 解析口径移植自 client/assets/ui/utils/map/TiledObjects.ts（正则读 TMX 原文，
 * 不用引擎解析 —— 引擎会丢对象类并翻转 y）。
 *
 * 用法：
 *   node tools/import-spawn-areas.cjs                # 只重新生成 spawn-areas.generated.ts
 *   node tools/import-spawn-areas.cjs --db server/data/olua.db
 *                                                    # 同时把生成结果整份替换进库（表内该工具
 *                                                    # 视 JSON 为唯一真相；后台后续若开放手改
 *                                                    # 刷怪区，就不要再带 --db 跑）
 */

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const MAP_DIR = path.join(REPO, "client", "assets", "resources", "map");
const OUT_TS = path.join(REPO, "server", "src", "modules", "world", "spawn-areas.generated.ts");
const OUT_SIZES_TS = path.join(REPO, "server", "src", "shared", "map-sizes.generated.ts");
const OUT_CONTENT_TS = path.join(REPO, "server", "src", "shared", "map-content.generated.ts");

// ----------------------------------------------------------------------------//
// TMX 解析（移植 client/assets/ui/utils/map/TiledObjects.ts 的口径）
// ----------------------------------------------------------------------------//

/** 读取 XML 标签的属性值（属性名前要求空白或开头，避免命中 xxxname 这类后缀同名的属性） */
function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? match[1] : "";
}

/** 取某个对象组在 TMX 原文里的内容片段（对象组不嵌套，其后最近的 </objectgroup> 即为其结束） */
function readObjectGroupXml(xml, groupName) {
  const openTagPattern = /<objectgroup\b([^>]*)>/g;
  let match;
  while ((match = openTagPattern.exec(xml))) {
    const attributes = match[1];
    if (/\/\s*$/.test(attributes)) continue;
    if (readXmlAttribute(attributes, "name") !== groupName) continue;
    const contentStart = match.index + match[0].length;
    const contentEnd = xml.indexOf("</objectgroup>", contentStart);
    return contentEnd < 0 ? "" : xml.slice(contentStart, contentEnd);
  }
  return "";
}

/** 读取对象的自定义属性（值写在 value 属性里，或写在标签体内，两种 Tiled 写法都支持） */
function readObjectProperties(body) {
  const properties = {};
  const propertyPattern = /<property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/property>)/g;
  let match;
  while ((match = propertyPattern.exec(body))) {
    const name = readXmlAttribute(match[1], "name");
    if (!name) continue;
    const value = readXmlAttribute(match[1], "value");
    properties[name] = value || (match[2] ?? "").trim();
  }
  return properties;
}

/** 解析 monster 对象组里的矩形区域（无效区域返回 null，原因挂在 reason 上） */
function parseMonsterObject(objectXml) {
  const openTagPattern = /<object\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = openTagPattern.exec(objectXml))) {
    const attributes = match[1];
    const bodyStart = openTagPattern.lastIndex;
    const bodyEnd = match[2] === "/" ? bodyStart : objectXml.indexOf("</object>", bodyStart);
    const body = bodyEnd < 0 ? "" : objectXml.slice(bodyStart, bodyEnd);
    if (bodyEnd > bodyStart) openTagPattern.lastIndex = bodyEnd;

    const name = readXmlAttribute(attributes, "name");
    const x = Number(readXmlAttribute(attributes, "x")) || 0;
    const y = Number(readXmlAttribute(attributes, "y")) || 0;
    const width = Number(readXmlAttribute(attributes, "width")) || 0;
    const height = Number(readXmlAttribute(attributes, "height")) || 0;
    const properties = readObjectProperties(body);

    if (width <= 0 || height <= 0) {
      console.warn(`  [跳过] 区域「${name}」不是矩形（没有落点范围）`);
      continue;
    }
    const monsterKey = `${properties.id ?? ""}`;
    if (!monsterKey) {
      console.warn(`  [跳过] 区域「${name}」缺少 id 属性`);
      continue;
    }
    let min = Math.max(0, Math.floor(Number(properties.min) || 0));
    let max = Math.floor(Number(properties.max) || 0);
    if (max < min) {
      console.warn(`  [修正] 区域「${name}」的 max(${max}) < min(${min})，按 min 处理`);
      max = min;
    }
    console.log(`  ${name}: 怪物=${monsterKey} ${min}~${max} 只 @ (${Math.round(x)},${Math.round(y)}) ${Math.round(width)}x${Math.round(height)}`);
    return { name, x, y, width, height, monsterKey, min, max };
  }
  return null;
}

// ----------------------------------------------------------------------------//
// 图层与对象组解析（#571：管理端地图页的全量只读视图）
// ----------------------------------------------------------------------------//

/** 瓦片图层：只取结构（名字 / 格数），`<data>` 里的几万个 gid 对管理端没有意义 */
function parseLayers(xml) {
  const layers = [];
  const pattern = /<layer\b([^>]*)>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const attributes = match[1];
    if (/\/\s*$/.test(attributes)) continue;
    layers.push({
      name: readXmlAttribute(attributes, "name"),
      width: Number(readXmlAttribute(attributes, "width")) || 0,
      height: Number(readXmlAttribute(attributes, "height")) || 0,
    });
  }
  return layers;
}

/** 一个对象组里的全部对象（坐标原样保留：管理端要跟 Tiled 对得上） */
function parseObjects(body) {
  const objects = [];
  const openTagPattern = /<object\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = openTagPattern.exec(body))) {
    const attributes = match[1];
    const bodyStart = openTagPattern.lastIndex;
    const bodyEnd = match[2] === "/" ? bodyStart : body.indexOf("</object>", bodyStart);
    const inner = bodyEnd < 0 ? "" : body.slice(bodyStart, bodyEnd);
    if (bodyEnd > bodyStart) openTagPattern.lastIndex = bodyEnd;

    objects.push({
      id: Number(readXmlAttribute(attributes, "id")) || 0,
      name: readXmlAttribute(attributes, "name"),
      // Tiled 1.9 起把 type 改名 class；两种写法都认，空串 = 普通矩形
      klass: readXmlAttribute(attributes, "type") || readXmlAttribute(attributes, "class"),
      x: Number(readXmlAttribute(attributes, "x")) || 0,
      y: Number(readXmlAttribute(attributes, "y")) || 0,
      width: Number(readXmlAttribute(attributes, "width")) || 0,
      height: Number(readXmlAttribute(attributes, "height")) || 0,
      properties: readObjectProperties(inner),
    });
  }
  return objects;
}

/** 全部对象组（npc / monster / collision / 早期 objects），按 TMX 里的出现顺序 */
function parseObjectGroups(xml) {
  const groups = [];
  const openTagPattern = /<objectgroup\b([^>]*)>/g;
  let match;
  while ((match = openTagPattern.exec(xml))) {
    const attributes = match[1];
    if (/\/\s*$/.test(attributes)) continue;
    const start = match.index + match[0].length;
    const end = xml.indexOf("</objectgroup>", start);
    const body = end < 0 ? "" : xml.slice(start, end);
    groups.push({ name: readXmlAttribute(attributes, "name"), objects: parseObjects(body) });
    if (end > start) openTagPattern.lastIndex = end;
  }
  return groups;
}

// ----------------------------------------------------------------------------//
// 主流程
// ----------------------------------------------------------------------------//

function main() {
  const dbArg = process.argv.indexOf("--db");
  const dbPath = dbArg >= 0 ? path.resolve(process.cwd(), process.argv[dbArg + 1]) : null;

  if (!fs.existsSync(MAP_DIR)) {
    console.error(`地图目录不存在：${MAP_DIR}（本工具要在带有客户端素材的机器上跑）`);
    process.exit(1);
  }

  const areas = [];
  /** mapId → 地图像素尺寸（TMX 头里的 grid 数 × 单格像素） */
  const mapSizes = new Map();
  /** mapId → 图层与对象组（#571：管理端只读地图页的内容源） */
  const mapContents = new Map();
  const mapDirs = fs
    .readdirSync(MAP_DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((a, b) => Number(a) - Number(b));

  for (const mapId of mapDirs) {
    const tmxPath = path.join(MAP_DIR, mapId, `${mapId}.tmx`);
    if (!fs.existsSync(tmxPath)) {
      console.warn(`地图 ${mapId} 没有 ${mapId}.tmx，跳过`);
      continue;
    }
    const xml = fs.readFileSync(tmxPath, "utf8");
    const mapTag = /<map\b([^>]*)>/.exec(xml);
    if (!mapTag) {
      console.warn(`地图 ${mapId} 的 TMX 没有 <map> 头，跳过`);
      continue;
    }
    const cols = Number(readXmlAttribute(mapTag[1], "width"));
    const rows = Number(readXmlAttribute(mapTag[1], "height"));
    const tileW = Number(readXmlAttribute(mapTag[1], "tilewidth"));
    const tileH = Number(readXmlAttribute(mapTag[1], "tileheight"));
    const mapW = cols * tileW;
    const mapH = rows * tileH;
    mapSizes.set(mapId, { cols, rows, tileW, tileH, width: mapW, height: mapH });
    // 图层与对象组：安全图（没有 monster 组）也要收，管理端要能看到它的 NPC 与碰撞
    mapContents.set(mapId, { layers: parseLayers(xml), groups: parseObjectGroups(xml) });

    const groupXml = readObjectGroupXml(xml, "monster");
    if (!groupXml) {
      console.log(`地图 ${mapId}：没有 monster 对象组（安全地图不刷怪）`);
      continue;
    }
    console.log(`地图 ${mapId}（${mapW}x${mapH}）：`);
    // 对象不嵌套：一个 <object> 的内容到它自己的 </object> 为止
    const objectPattern = /<object\b[^>]*?(\/?)>/g;
    let objectMatch;
    while ((objectMatch = objectPattern.exec(groupXml))) {
      const bodyStart = objectPattern.lastIndex;
      const bodyEnd = objectMatch[1] === "/" ? bodyStart : groupXml.indexOf("</object>", bodyStart);
      const objectXml = groupXml.slice(objectMatch.index, bodyEnd < 0 ? groupXml.length : bodyEnd + "</object>".length);
      if (bodyEnd > bodyStart) objectPattern.lastIndex = bodyEnd;

      const parsed = parseMonsterObject(objectXml);
      if (!parsed) continue;
      areas.push({
        mapId,
        name: parsed.name,
        monsterKey: parsed.monsterKey,
        min: parsed.min,
        max: parsed.max,
        cx: parsed.x + parsed.width / 2,
        cy: -(parsed.y + parsed.height / 2),
        w: parsed.width,
        h: parsed.height,
      });
    }
  }

  // 生成 TS（快照按地图分组成嵌套结构，消费方按 mapId 取）
  const byMap = new Map();
  for (const area of areas) {
    if (!byMap.has(area.mapId)) byMap.set(area.mapId, []);
    const { mapId, ...rest } = area;
    byMap.get(area.mapId).push(rest);
  }
  const lines = [
    "/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map 目录）的 monster 对象组生成，勿手改（#295）",
    " *  坐标口径 = 客户端世界坐标（#566：地图节点原点在左上角、y 轴向上）：",
    " *  服务端随机落点公式与客户端旧版 MonsterAreaSpawner 完全一致。",
    " *  min/max = 该区域允许的最少/最多怪物数（播种按 max 展开成逐只落点）。",
    " */",
    "export interface SpawnAreaConfig {",
    "  /** 区域名（Tiled 对象名，如「1号怪物」） */",
    "  name: string;",
    "  /** 怪物 key（configs/monster 的关联键；播种时对照 monsters 表，不认识的跳过） */",
    "  monsterKey: string;",
    "  min: number;",
    "  max: number;",
    "  /** 区域中心 x（世界坐标） */",
    "  cx: number;",
    "  /** 区域中心 y（世界坐标） */",
    "  cy: number;",
    "  /** 区域宽 */",
    "  w: number;",
    "  /** 区域高 */",
    "  h: number;",
    "}",
    "",
    "/** mapId → 该图的刷怪区域列表 */",
    "export const SPAWN_AREAS: Record<string, SpawnAreaConfig[]> = {",
  ];
  for (const [mapId, list] of byMap) {
    lines.push(`  "${mapId}": [`);
    for (const area of list) {
      lines.push(
        `    { name: ${JSON.stringify(area.name)}, monsterKey: ${JSON.stringify(area.monsterKey)}, min: ${area.min}, max: ${area.max}, cx: ${round(area.cx)}, cy: ${round(area.cy)}, w: ${round(area.w)}, h: ${round(area.h)} },`,
      );
    }
    lines.push("  ],");
  }
  lines.push("};", "");
  fs.writeFileSync(OUT_TS, lines.join("\n"), "utf8");
  console.log(`\n已生成 ${path.relative(REPO, OUT_TS)}（${areas.length} 个区域 / ${byMap.size} 张图）`);

  // 地图尺寸快照（服务端升级坐标口径 / 任何需要地图边界的服务端逻辑都要它）
  const sizeLines = [
    "/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map）的 <map> 头生成，勿手改",
    " *  世界坐标口径（#566）：地图节点原点 = 地图左上角，y 轴向上 ⇒ 地图在世界里占",
    " *  x ∈ [0, width]、y ∈ [-height, 0]。",
    " */",
    "export interface MapPixelSize {",
    "  /** 横向格数 */",
    "  cols: number;",
    "  /** 纵向格数 */",
    "  rows: number;",
    "  /** 单格宽（像素） */",
    "  tileWidth: number;",
    "  /** 单格高（像素） */",
    "  tileHeight: number;",
    "  /** 地图像素宽（cols × tileWidth） */",
    "  width: number;",
    "  /** 地图像素高（rows × tileHeight） */",
    "  height: number;",
    "}",
    "",
    "/** mapId → 地图像素尺寸 */",
    "export const MAP_PIXEL_SIZES: Record<string, MapPixelSize> = {",
  ];
  for (const [mapId, size] of [...mapSizes.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    sizeLines.push(
      `  "${mapId}": { cols: ${size.cols}, rows: ${size.rows}, tileWidth: ${size.tileW}, tileHeight: ${size.tileH}, width: ${size.width}, height: ${size.height} },`,
    );
  }
  sizeLines.push("};", "");
  fs.writeFileSync(OUT_SIZES_TS, sizeLines.join("\n"), "utf8");
  console.log(`已生成 ${path.relative(REPO, OUT_SIZES_TS)}（${mapSizes.size} 张图）`);

  // 图层 / 对象组快照（#571）：管理端「地图管理」页的**客户端资源视图** ——
  // 页面会把这块标成「客户端资源（服务端未整理）」：坐标是 Tiled 原始值、不做换算，
  // 与库里那张 map_spawn_areas（服务端整理后的世界坐标）分栏显示，避免两套数字被当成一套。
  const contentLines = [
    "/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map）生成，勿手改（#571）",
    " *",
    " * 这是**客户端资源视图**，不是服务端的运营数据：",
    " * - 坐标保持 Tiled 原始口径（左上角原点、y 向下，和 Tiled 编辑器里看到的一致），不做换算；",
    " * - 对象属性原样保留（刷怪区的 id / min / max 等），不在这里解释含义；",
    " * - 服务端真正用于运行的是 `map_spawn_areas` 表（世界坐标，运营可整理）与 `world_monsters`。",
    " * 管理端展示它只有一个目的：让人能对着 Tiled 核对「资源里到底有什么」。",
    " */",
    "export interface MapLayerInfo {",
    "  /** 图层名（Tiled 里的图层名） */",
    "  name: string;",
    "  /** 横向格数 */",
    "  width: number;",
    "  /** 纵向格数 */",
    "  height: number;",
    "}",
    "",
    "export interface MapObjectInfo {",
    "  /** 对象 id（图内唯一，Tiled 的 nextobjectid 序列） */",
    "  id: number;",
    "  /** 对象名（如「1号怪物」「复活点」） */",
    "  name: string;",
    "  /** 对象类（Tiled 的 type / class；空串 = 普通矩形） */",
    "  klass: string;",
    "  /** Tiled 坐标 x（左上角原点，y 向下） */",
    "  x: number;",
    "  /** Tiled 坐标 y（左上角原点，y 向下） */",
    "  y: number;",
    "  /** 矩形宽（点对象为 0） */",
    "  width: number;",
    "  /** 矩形高（点对象为 0） */",
    "  height: number;",
    "  /** 自定义属性（原样：刷怪区的 id / min / max 等） */",
    "  properties: Record<string, string>;",
    "}",
    "",
    "export interface MapGroupInfo {",
    "  /** 对象组名（npc / monster / collision / 早期 objects） */",
    "  name: string;",
    "  objects: MapObjectInfo[];",
    "}",
    "",
    "export interface MapContent {",
    "  layers: MapLayerInfo[];",
    "  groups: MapGroupInfo[];",
    "}",
    "",
    "/** mapId → 图层与对象组（对象按 TMX 内的出现顺序） */",
    "export const MAP_CONTENTS: Record<string, MapContent> = {",
  ];
  for (const [mapId, content] of [...mapContents.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    contentLines.push(`  "${mapId}": {`);
    contentLines.push("    layers: [");
    for (const layer of content.layers) {
      contentLines.push(`      { name: ${JSON.stringify(layer.name)}, width: ${layer.width}, height: ${layer.height} },`);
    }
    contentLines.push("    ],");
    contentLines.push("    groups: [");
    for (const group of content.groups) {
      contentLines.push(`      { name: ${JSON.stringify(group.name)}, objects: [`);
      for (const object of group.objects) {
        contentLines.push(
          `        { id: ${object.id}, name: ${JSON.stringify(object.name)}, klass: ${JSON.stringify(object.klass)}, x: ${round(object.x)}, y: ${round(object.y)}, width: ${round(object.width)}, height: ${round(object.height)}, properties: ${JSON.stringify(object.properties)} },`,
        );
      }
      contentLines.push("      ] },");
    }
    contentLines.push("    ],");
    contentLines.push("  },");
  }
  contentLines.push("};", "");
  fs.writeFileSync(OUT_CONTENT_TS, contentLines.join("\n"), "utf8");

  const objectCount = [...mapContents.values()].reduce(
    (total, content) => total + content.groups.reduce((sum, group) => sum + group.objects.length, 0),
    0,
  );
  const layerCount = [...mapContents.values()].reduce((total, content) => total + content.layers.length, 0);
  console.log(`已生成 ${path.relative(REPO, OUT_CONTENT_TS)}（${mapContents.size} 张图 · ${layerCount} 个图层 · ${objectCount} 个对象）`);

  if (dbPath) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("BEGIN");
      db.exec("DELETE FROM map_spawn_areas");
      const insert = db.prepare(
        `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const area of areas) {
        insert.run(area.mapId, area.name, area.monsterKey, area.min, area.max, area.cx, area.cy, area.w, area.h, Date.now());
      }
      db.exec("COMMIT");
      console.log(`已整份替换进库：${dbPath}（${areas.length} 个区域）`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}

/** 坐标保留两位小数（浮点噪声没必要进仓库） */
function round(value) {
  return Math.round(value * 100) / 100;
}

main();

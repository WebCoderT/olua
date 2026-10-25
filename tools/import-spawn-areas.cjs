#!/usr/bin/env node
/**
 * 刷怪区导入工具（#295 阶段一：刷怪配置归服务端）
 *
 * 从客户端 Tiled 地图文件（client/assets/resources/map/<id>/<id>.tmx）的 monster 对象组
 * 解析刷怪区域，做坐标换算后生成 server/src/modules/world/spawn-areas.generated.ts
 * （提交进仓库，服务端启动时若 map_spawn_areas 表为空会拿它做种子）。
 *
 * 坐标口径与客户端完全一致（MonsterAreaSpawner 旧公式）：
 *   Tiled 矩形 x/y 是左上角、y 轴向下；中心 = (x + w/2, y + h/2)；
 *   换成地图节点本地坐标（中心为原点、y 向上）：cx = x + w/2 - mapW/2，cy = mapH/2 - (y + h/2)。
 *   地图节点挂在原点的图层容器下，世界坐标 = 本地坐标，所以快照 x/y 语义不变。
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
        cx: parsed.x + parsed.width / 2 - mapW / 2,
        cy: mapH / 2 - (parsed.y + parsed.height / 2),
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
    " *  坐标口径 = 客户端世界坐标（地图节点在原点）：cx/cy 是区域中心、w/h 是区域尺寸，",
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

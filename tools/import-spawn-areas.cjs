#!/usr/bin/env node
/**
 * 地图导入工具（刷怪区 + 几何 + 图层/对象组 → 数据库）
 *
 * 从客户端 Tiled 地图文件（client/assets/resources/map/<id>/<id>.tmx）解析三样东西，
 * **直接写进库**（#655 起库里是唯一权威，代码里不再有第二份快照）：
 *
 * 1. `map_spawn_areas` 表 —— monster 对象组里每个矩形的刷怪区（世界坐标）；
 * 2. `maps` 的几何列 —— `grid_cols/grid_rows/tile_width/tile_height/pixel_width/pixel_height`，
 *    服务端判定越界与客户端摆图都要它；
 * 3. `maps.content` 列 —— 图层与**全部**对象组（npc / monster / collision / objects）的原始
 *    Tiled 数据（坐标不换算、属性原样保留）。管理端「地图管理」页是只读观测台，读的就是这块。
 *
 * 写完之后要 `make config-export` 把值带进 `server/data/config-sync.sql`，否则别人拉下来
 * 还是旧数据（`config-sync.sql` 是空库自举的唯一来源，见 `database/config-snapshot.ts`）。
 *
 * ## 坐标口径
 *
 * 与客户端完全一致（#566 起：地图节点原点 = 地图左上角）：
 *   Tiled 矩形 x/y 是左上角、y 轴向下；中心 = (x + w/2, y + h/2)；
 *   换成世界坐标只需把 y 取反：cx = x + w/2，cy = -(y + h/2) —— **没有半图偏移**。
 *   （旧口径是「地图中心为原点」，cx = x + w/2 - mapW/2、cy = mapH/2 - (y + h/2)；
 *    与现在的差别是全图平移 (mapW/2, -mapH/2)，存量库由服务端的一次性迁移抹平，见 database.service。）
 *
 * **`content` 刻意不做坐标换算**：管理端要能对着 Tiled 看同一组数字。世界坐标只走
 * `map_spawn_areas` 那条路，两者在页面上分栏显示。
 *
 * 解析口径移植自 client/assets/ui/utils/map/TiledObjects.ts（正则读 TMX 原文，
 * 不用引擎解析 —— 引擎会丢对象类并翻转 y）。
 *
 * 用法：
 *   node tools/import-spawn-areas.cjs                       # 写默认库 server/data/olua.db
 *   node tools/import-spawn-areas.cjs --db server/data/olua.db
 *   node tools/import-spawn-areas.cjs --dry                 # 只解析，打印统计，不写库
 *
 * 注意 `map_spawn_areas` 是**整份替换**（库内该表视 TMX 为唯一真相）；后台后续若开放
 * 手改刷怪区，就不要再跑本工具。`maps` 的运营字段（名称 / 类型 / 进入条件）不受影响 ——
 * 只更新那 7 列几何。
 */

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const MAP_DIR = path.join(REPO, "client", "assets", "resources", "map");
const DEFAULT_DB = path.join(REPO, "server", "data", "olua.db");

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
  const dbPath = dbArg >= 0 ? path.resolve(process.cwd(), process.argv[dbArg + 1] ?? "") : DEFAULT_DB;
  const dryRun = process.argv.includes("--dry");

  if (!fs.existsSync(MAP_DIR)) {
    console.error(`地图目录不存在：${MAP_DIR}（本工具要在带有客户端素材的机器上跑）`);
    process.exit(1);
  }

  /** 刷怪区（世界坐标，整份替换 `map_spawn_areas`） */
  const areas = [];
  /** mapId → 几何（`maps` 的 6 个数值列） */
  const mapSizes = new Map();
  /** mapId → 图层与对象组（存 `maps.content` 的 JSON 原文） */
  const mapContents = new Map();
  const mapDirs = fs
    .readdirSync(MAP_DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    // 只认纯数字目录（map/ 下还有 prefab、icon 之类的资源子目录）
    .filter((name) => /^\d+$/.test(name))
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
    mapContents.set(mapId, { layers: parseLayers(xml), groups: roundObjects(parseObjectGroups(xml)) });

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
        cx: round(parsed.x + parsed.width / 2),
        cy: round(-(parsed.y + parsed.height / 2)),
        w: round(parsed.width),
        h: round(parsed.height),
      });
    }
  }

  const objectCount = [...mapContents.values()].reduce(
    (total, content) => total + content.groups.reduce((sum, group) => sum + group.objects.length, 0),
    0,
  );
  const layerCount = [...mapContents.values()].reduce((total, content) => total + content.layers.length, 0);
  console.log(
    `\n解析完成：${mapSizes.size} 张图 · ${layerCount} 个图层 · ${objectCount} 个对象 · ${areas.length} 个刷怪区`,
  );

  if (dryRun) {
    console.log("--dry：不写库");
    return;
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN");

    // 1) 刷怪区：整份替换（TMX 是唯一真相）
    db.exec("DELETE FROM map_spawn_areas");
    const insertArea = db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const area of areas) {
      insertArea.run(area.mapId, area.name, area.monsterKey, area.min, area.max, area.cx, area.cy, area.w, area.h, now);
    }

    // 2) 几何 + content：只动那 7 列，运营改的名称 / 进入条件不受影响
    const updateGeometry = db.prepare(
      `UPDATE maps SET grid_cols = ?, grid_rows = ?, tile_width = ?, tile_height = ?,
         pixel_width = ?, pixel_height = ?, content = ?
       WHERE map_id = ?`,
    );
    // 行不存在时补一行（正常情况由 config-sync.sql 带进来；新加一张图时跑本工具也不会漏）
    const insertMissing = db.prepare(
      `INSERT OR IGNORE INTO maps (map_id, label, type, level, combat, soul_of_war,
         grid_cols, grid_rows, tile_width, tile_height, pixel_width, pixel_height, content,
         updated_by, updated_at)
       VALUES (?, ?, '', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let created = 0;
    for (const [mapId, size] of mapSizes) {
      const content = JSON.stringify(mapContents.get(mapId));
      const result = updateGeometry.run(
        size.cols,
        size.rows,
        size.tileW,
        size.tileH,
        size.width,
        size.height,
        content,
        mapId,
      );
      if (Number(result.changes) === 0) {
        insertMissing.run(
          mapId,
          mapId,
          size.cols,
          size.rows,
          size.tileW,
          size.tileH,
          size.width,
          size.height,
          content,
          "import-spawn-areas",
          now,
        );
        created += 1;
        console.warn(`  [补行] maps 里原本没有 map_id=${mapId}，已插入（名称先用 id 占位，去后台改）`);
      }
    }

    db.exec("COMMIT");
    console.log(`\n已写入 ${dbPath}`);
    console.log(`  map_spawn_areas：${areas.length} 个区域（整份替换）`);
    console.log(`  maps 几何 + content：${mapSizes.size} 张图${created > 0 ? `（其中新补 ${created} 行）` : ""}`);
    console.log("\n下一步：make config-export（把值带进 server/data/config-sync.sql）");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** 坐标保留两位小数（浮点噪声没必要进库，也让重跑结果逐字节一致） */
function round(value) {
  return Math.round(value * 100) / 100;
}

/** 对象坐标同样收两位小数（Tiled 拖拽留下的是 267.381 这种三位小数，进库没有意义） */
function roundObjects(groups) {
  for (const group of groups) {
    for (const object of group.objects) {
      object.x = round(object.x);
      object.y = round(object.y);
      object.width = round(object.width);
      object.height = round(object.height);
    }
  }
  return groups;
}

main();

#!/usr/bin/env node
/**
 * 地图资源导入工具（几何 + 图层 → 数据库）
 *
 * 从客户端 Tiled 地图文件（client/assets/resources/map/<id>/<id>.tmx）解析两样东西，
 * **直接写进库**（#655 起库里是唯一权威，代码里不再有第二份快照）：
 *
 * 1. `maps` 的几何列 —— `grid_cols/grid_rows/tile_width/tile_height/pixel_width/pixel_height`，
 *    服务端判定刷怪区越界与客户端摆图都要它；
 * 2. `maps.content` 列 —— **图层结构**（名字 / 格数）。瓦片数据留在客户端资源里，这里只收结构。
 *
 * ## 它只认「几何 + 图层」（#676）
 *
 * 以前这个工具还解析 TMX 的 `monster` / `npc` / `collision` 对象组，把原始矩形收进
 * `content.groups` 给管理端做「资源对照」。现在三块都归后台了（#667 刷怪区 / #672 点位 /
 * #676 碰撞盒），**TMX 里的对象组已由 `tools/strip-map-objects.cjs` 整组删除** ——
 * 地图文件只剩瓦片与图层，只做显示。
 *
 * 所以 `content.groups` 恒为空数组：字段留着是为了存量库的老 content 仍能解析，
 * 读方（管理端详情 / 客户端快照）只看 `layers`。本工具也不再解析任何 `<objectgroup>`。
 *
 * ## 它不写运营数据
 *
 * 不碰 `map_spawn_areas` / `map_collisions` / `map_npcs`，也不碰 `maps` 的名称 / 类型 /
 * 进入条件 / 复活点。只在两种时候跑：**换了一张 TMX**（几何变了）或**新加一张图**（要补几何）。
 *
 * 写完之后要 `make config-export` 把几何与 content 带进 `server/data/config-sync.sql`，
 * 否则别人拉下来还是旧数据（`config-sync.sql` 是空库自举的唯一来源）。
 *
 * 解析口径是正则读 TMX 原文（不用引擎解析 —— 引擎会丢对象类并翻转 y）。
 *
 * 用法：
 *   node tools/import-map-resources.cjs                       # 写默认库 server/data/olua.db
 *   node tools/import-map-resources.cjs --db server/data/olua.db
 *   node tools/import-map-resources.cjs --dry                 # 只解析，打印统计，不写库
 */

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const MAP_DIR = path.join(REPO, "client", "assets", "resources", "map");
const DEFAULT_DB = path.join(REPO, "server", "data", "olua.db");

// ----------------------------------------------------------------------------//
// TMX 解析（正则读原文：引擎解析会丢对象类并翻转 y）
// ----------------------------------------------------------------------------//

/** 读取 XML 标签的属性值（属性名前要求空白或开头，避免命中 xxxname 这类后缀同名的属性） */
function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? match[1] : "";
}

// ----------------------------------------------------------------------------//
// 图层解析（管理端地图页的只读视图）
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

  /** mapId → 几何（`maps` 的 6 个数值列） */
  const mapSizes = new Map();
  /** mapId → 图层（存 `maps.content` 的 JSON 原文；`groups` 恒为空数组，见文件头） */
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
    mapSizes.set(mapId, { cols, rows, tileW, tileH, width: cols * tileW, height: rows * tileH });
    // 只收图层结构；`groups` 恒空 —— TMX 里已经没有对象组了（#676），点位 / 区域 / 碰撞盒在各自表里
    mapContents.set(mapId, { layers: parseLayers(xml), groups: [] });
    console.log(`地图 ${mapId}：${cols * tileW}x${rows * tileH}（${cols}×${rows} 格 · ${tileW}×${tileH} 单格）`);
  }

  const layerCount = [...mapContents.values()].reduce((total, content) => total + content.layers.length, 0);
  console.log(`\n解析完成：${mapSizes.size} 张图 · ${layerCount} 个图层（对象组已不在 TMX 里，本工具也不解析）`);

  if (dryRun) {
    console.log("--dry：不写库");
    return;
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN");

    // 几何 + content：只动那 7 列，运营改的名称 / 进入条件 / 刷怪区都不受影响
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
    const now = Date.now();
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
          "import-map-resources",
          now,
        );
        created += 1;
        console.warn(`  [补行] maps 里原本没有 map_id=${mapId}，已插入（名称先用 id 占位，去后台改）`);
      }
    }

    db.exec("COMMIT");
    console.log(`\n已写入 ${dbPath}`);
    console.log(`  maps 几何 + content：${mapSizes.size} 张图${created > 0 ? `（其中新补 ${created} 行）` : ""}`);
    console.log("\n下一步：make config-export（把值带进 server/data/config-sync.sql）");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

main();

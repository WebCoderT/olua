#!/usr/bin/env node
/**
 * 怪物表现几何导入工具（图集 → `monster_presentation` 表的几何列）
 *
 * **#655 起数据库是唯一权威**：怪物表现行（icon / out / 几何 / 移动 / AI 参数 / 速度倍率）
 * 就住在 `monster_presentation` 表里，本工具只负责**测量素材**并写回那几列几何：
 *
 *   out_offset_x / out_offset_y     ← 图集基准帧的 `spriteOffset`（双轴取反）
 *   content_width / content_height  ← 图集基准帧的 `spriteSize`（可见身体尺寸）
 *
 * 其余列（icon / out / move_speed / aggressive / detect_range / speed_rate）**一律不动** ——
 * 它们是运营数据（管理端「怪物配置」可改），重跑本工具不该把它们抹回去。
 * `aggressive` 曾经跟着几何一起写（#751 之前按「身体宽 ≥ 250 或 boss」推算），现在只**打印建议值**
 * 供对账：一只怪主不主动是玩法决定，不是素材决定，写口在管理端。
 *
 * 几何口径（与引擎渲染一致，消费点 `GameUiHelper.createMonsterBody`）：
 * - contentSize = spriteSize（裁剪区尺寸）= 可见身体尺寸；碰撞盒、点击选中、头顶血条的
 *   位置都由它决定；
 * - outOffset = -spriteOffset（裁剪区中心相对画布中心的反向偏移），外观节点摆在它上面，
 *   可见身体中心就正好落在节点原点。
 *
 * ## 加一只怪的正确姿势
 *
 * 1. 素材入 `assets/resources/monster/out/<id>/stand/stand.plist`（图集，基准帧 d4_00.png）；
 * 2. `monsters` 表加数值行 + `monster_presentation` 表加表现行（管理端「怪物配置」）；
 * 3. 跑本工具量几何 → `make config-export`。
 *
 * key 双向对账：`monster_presentation`（资源）与 `monsters`（数值）必须一一对应，多一只
 * 少一只都直接报错 —— 「有数值没资源」的怪在地图上会变成隐形人，「有资源没数值」的怪
 * 根本进不了刷怪表。
 *
 * 用法：
 *   node client/tools/gen-monster-config.cjs           # 写默认库 server/data/olua.db
 *   node client/tools/gen-monster-config.cjs --db <path>
 *   node client/tools/gen-monster-config.cjs --dry     # 只测量并打印，不写库
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "..");
const DEFAULT_DB = path.join(REPO, "server/data/olua.db");
// #235 起帧动画是图集（stand.png + stand.plist），不再有散帧 meta
const OUT_DIR = path.join(ROOT, "assets/resources/monster/out");

/** 建议规则：可见身体宽达到该值（像素）判主动怪（220 只怪身体宽 p75 ≈ 250，即约四分之一大体型 + BOSS 主动）。
 * **只用于打印建议**，不写库 —— 一只怪主不主动是玩法决定（#751） */
const AGGRESSIVE_BODY_WIDTH = 250;
/** 几何基准帧：图集 stand 是 8 向 × 4 帧，帧名 d<方向>_<序号>；方向 4 = 正面（DOWN）第 0 帧 */
const STAND_BASE_FRAME = "d4_00.png";

//#region 1. 图集基准帧的 trim 实测

function readTrim(outPath) {
  const id = outPath.split("/").pop();
  const plistPath = path.join(OUT_DIR, id, "stand", "stand.plist");
  if (!fs.existsSync(plistPath)) throw new Error(`找不到图集：${plistPath}`);
  const plist = fs.readFileSync(plistPath, "utf8");
  const i = plist.indexOf(`<key>${STAND_BASE_FRAME}</key>`);
  if (i < 0) throw new Error(`图集里没有基准帧 ${STAND_BASE_FRAME}：${plistPath}`);
  const seg = plist.slice(i, i + 700);
  const tuple = (name) => {
    const m = new RegExp(`<key>${name}</key>\\s*<string>\\{([^}]+)\\}`).exec(seg);
    if (!m) throw new Error(`基准帧缺 ${name}：${plistPath}`);
    return m[1].split(",").map(Number);
  };
  const size = tuple("spriteSize");
  const offset = tuple("spriteOffset");
  return {
    width: size[0],
    height: size[1],
    offsetX: offset[0],
    offsetY: offset[1],
  };
}

//#endregion

//#region 2. 主流程

function main() {
  const dbArg = process.argv.indexOf("--db");
  const dbPath = dbArg >= 0 ? path.resolve(process.cwd(), process.argv[dbArg + 1] ?? "") : DEFAULT_DB;
  const dryRun = process.argv.includes("--dry");

  if (!fs.existsSync(OUT_DIR)) {
    console.error(`素材目录不存在：${OUT_DIR}（本工具要在带有客户端素材的机器上跑）`);
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}（先启动一次服务端建库，或 make config-import）`);
    process.exit(1);
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const presentation = db
      .prepare("SELECT id, out, aggressive FROM monster_presentation ORDER BY CAST(id AS INTEGER)")
      .all();
    if (presentation.length === 0) throw new Error("monster_presentation 一行都没有，中止（防止误清空）");
    const tiers = new Map(
      db
        .prepare("SELECT id, tier FROM monsters")
        .all()
        .map((row) => [String(row.id), String(row.tier)]),
    );
    if (tiers.size === 0) throw new Error("monsters 一行都没有，中止（先导入配置）");

    // 双向对账：两表 key 集合必须一致
    const presentationKeys = new Set(presentation.map((row) => String(row.id)));
    const onlyPresentation = [...presentationKeys].filter((key) => !tiers.has(key));
    const onlyMonsters = [...tiers.keys()].filter((key) => !presentationKeys.has(key));
    if (onlyPresentation.length || onlyMonsters.length) {
      throw new Error(
        "monster_presentation（资源）与 monsters（数值）的 key 不一致，先补齐再量几何：\n" +
          (onlyPresentation.length ? `  只有资源行（数值表缺）：${onlyPresentation.join(", ")}\n` : "") +
          (onlyMonsters.length ? `  只有数值行（资源表缺）：${onlyMonsters.join(", ")}\n` : ""),
      );
    }

    const rows = [];
    for (const row of presentation) {
      const id = String(row.id);
      const out = String(row.out ?? "");
      if (!out) throw new Error(`怪物 ${id} 的 out 字段是空的（资源路径是运营数据，本工具只量几何）`);
      const trim = readTrim(out);
      rows.push({
        id,
        trim,
        // 建议值：tier=boss 或体型够大。**不写库**，只在对账时提示差异
        suggestedAggressive: tiers.get(id) === "boss" || trim.width >= AGGRESSIVE_BODY_WIDTH,
        currentAggressive: Number(row.aggressive) === 1,
      });
    }

    const aggressiveCount = rows.filter((row) => row.suggestedAggressive).length;
    console.log(`主动怪建议：${aggressiveCount}/${rows.length}（身体宽 ≥ ${AGGRESSIVE_BODY_WIDTH} 或 tier=boss，仅供参考）`);
    const diverged = rows.filter((row) => row.suggestedAggressive !== row.currentAggressive).map((row) => row.id);
    if (diverged.length > 0) {
      console.log(`  与库里现状不同：${diverged.join(", ")}（要改去管理端「怪物配置」勾「主动攻击」）`);
    }
    const widths = rows.map((row) => row.trim.width).sort((a, b) => a - b);
    console.log(`身体宽 min/median/max: ${widths[0]}/${widths[Math.floor(widths.length / 2)]}/${widths[widths.length - 1]}`);

    if (dryRun) {
      console.log("--dry：不写库");
      return;
    }

    db.exec("BEGIN");
    const update = db.prepare(
      `UPDATE monster_presentation
         SET out_offset_x = ?, out_offset_y = ?, content_width = ?, content_height = ?, updated_at = ?
       WHERE id = ?`,
    );
    const now = Date.now();
    let changed = 0;
    for (const row of rows) {
      const result = update.run(
        -row.trim.offsetX,
        -row.trim.offsetY,
        row.trim.width,
        row.trim.height,
        now,
        row.id,
      );
      changed += Number(result.changes);
    }
    db.exec("COMMIT");
    console.log(`\n已写入 ${dbPath}`);
    console.log(`  monster_presentation 几何：${changed} 行（icon / out / 行为参数一律未动）`);
    console.log("\n下一步：make config-export（把值带进 server/data/config-sync.sql）");
  } finally {
    db.close();
  }
}

main();

//#endregion

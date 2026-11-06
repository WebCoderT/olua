#!/usr/bin/env node
/**
 * 一次性脚本：resources 目录重排 + 命名规范（#753）
 *
 * ## 为什么是脚本
 * `client/assets/resources` 有 ~2500 个素材文件、63 个平级目录，且目录里躺着
 * `.meta`（Cocos 的 uuid 载体）——手工重命名必然漏 meta、必然漏 plist 内部的贴图名。
 * 这里把「旧路径 → 新路径」写成**声明式规则**，一次算出全量映射，干跑看碰撞，
 * 再原子 rename。脚本本身提交进库，作为这次搬迁的记录（可据此反推/回退）。
 *
 * ## 三类规则
 * 1. **目录搬迁**（`LAYOUT.from` → `to`）：最长前缀命中，子目录自动跟随；
 * 2. **文件名变换**（`LAYOUT.file`）：入参是「相对 from 的路径（不含扩展名）」，
 *    返回新路径（允许带 `/`，用于把 `titles/sfx_13009/sfx_13009` 拉平成 `13009`）；
 * 3. **特例表**（`LAYOUT.rename` / `ARCHIVE`）：一对一改名、以及零引用素材归档。
 *
 * `.meta` 一律跟着素材走（`a.png` → `b.png` 则 `a.png.meta` → `b.png.meta`），
 * 目录 meta 按新目录名重算；子目录被拉平后留下的旧目录 meta、空目录、孤立 meta 一并清掉。
 *
 * **图集（plist）内部要改**：plist 里 `realTextureFileName` / `textureFileName` 与每帧的
 * key 都带图集基名（`sfx_30123_0.png`、`sfx_30123_0_0000.png`）。只改文件名不改它们，
 * 运行时就是「图集在、贴图找不到」——整片空白，且没有任何编译期报错。
 *
 * 用法：
 *   node tools/oneoff-migrate-resources.cjs            # 干跑：打印统计 + 冲突 + 样例
 *   node tools/oneoff-migrate-resources.cjs --apply    # 落盘
 *   node tools/oneoff-migrate-resources.cjs --apply --log /tmp/moves.json
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RES = path.join(ROOT, "client", "assets", "resources");

/** 素材扩展名（只有这些才参与搬迁；其余（清单 json）单独处理） */
const ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".plist", ".ttf", ".wav", ".mp3", ".tmx", ".tsx", ".fnt"]);

const snakeToKebab = (rel) => rel.replace(/_/g, "-");

//#region 规则表

/**
 * 目录规则。`from` 是旧路径前缀（posix），`to` 是新前缀。
 * 顺序无关（按最长前缀命中），但同一层含义上按「界面 → 特效 → 实体」排，便于阅读。
 */
const LAYOUT = [
  // ---------------- 界面零件（进 ui/）----------------
  { from: "avatars", to: "ui/avatar" },
  { from: "bottom-nav-bar", to: "ui/nav", file: snakeToKebab },
  { from: "buttons", to: "ui/button" },
  { from: "common", to: "ui/common", file: snakeToKebab },
  { from: "dialog", to: "ui/dialog" },
  // pregress 是拼写错误（progress）；rename 的 key 是「已 kebab 化之后」的名字
  { from: "loading", to: "ui/loading", file: snakeToKebab, rename: { "pregress-content": "progress-content" } },
  {
    from: "login",
    to: "ui/login",
    file: snakeToKebab,
    // 目录已经叫 login 了，文件名再叫 login-bg 是重复；图标补全单词
    rename: { "login-bg": "bg", "icon-pwd": "icon-password", "icon-user": "icon-account" },
  },
  { from: "mall", to: "ui/mall" },
  { from: "money", to: "ui/money" },
  { from: "slots", to: "ui/slot" },
  {
    from: "small-map",
    to: "ui/minimap",
    // 原文件名是 GBK 被当 UTF-8 读出来的乱码「灞忚斀 鍓湰」（＝屏蔽副本），还带空格，
    // 且中间夹了私用区码位（U+E21B）——按「非 ASCII 即改名」处理，别指望能手打出那个字
    file: (rel) => (/[^\x20-\x7e]/.test(rel) ? "block-instance" : rel),
  },
  { from: "tips", to: "ui/tips", file: snakeToKebab },
  // 主界面：number/ 与 ui/ 两个子目录先于 main 命中（最长前缀）
  { from: "main/number", to: "ui/hud/number" },
  { from: "main/ui", to: "ui/hud/panel", file: snakeToKebab },
  { from: "main", to: "ui/hud", file: snakeToKebab },
  // 选角：图集进 preview/，文件名从 create_role_1_1_stand@0 收到 1-1-stand@0
  {
    from: "create_role/plist",
    to: "ui/create-role/preview",
    file: (rel) => rel.replace(/^create_role_(\d+)_(\d+)_(stand|show)@(\d+)$/, "$1-$2-$3@$4"),
  },
  {
    from: "create_role",
    to: "ui/create-role",
    file: (rel) => rel.replace(/_/g, "-"),
    // 1_0..5_1 在代码里是「性别/职业 按钮的 选中/未选中」，原名完全看不出含义
    rename: {
      "1-0": "sex-boy-off",
      "1-1": "sex-boy-on",
      "2-0": "sex-girl-off",
      "2-1": "sex-girl-on",
      "3-0": "class-warrior-off",
      "3-1": "class-warrior-on",
      "4-0": "class-mage-off",
      "4-1": "class-mage-on",
      "5-0": "class-taoist-off",
      "5-1": "class-taoist-on",
      "back-btn": "back-button",
      "start-btn": "start-button",
      "new-role": "new-role",
      "bg-bottom": "bg-bottom",
      "bg-dialog": "bg-dialog",
      idlv: "idle-info",
      "label-1": "label-gender",
      "label-2": "label-class",
      "label-title": "label-title",
      "tips-1": "tips-1",
      "tips-2": "tips-2",
      "tips-3": "tips-3",
      "select-player@0": "select-player@0",
    },
  },
  { from: "fonts", to: "font" },

  // ---------------- 特效（effect/ 内部收口 + 语义前缀）----------------
  // sfx_ 是 sound effect 的缩写，被错用在这些图集上；编号是美术资产号，保留
  { from: "effect/borders", to: "effect/border", file: (rel) => rel.replace(/^sfx_(\d+)_0$/, "border-$1") },
  { from: "effect/backgrounds", to: "effect/background", file: (rel) => rel.replace(/^sfx_(\d+)$/, "bg-$1") },
  { from: "effect/light", to: "effect/light", file: (rel) => rel.replace(/^light_(\d+)$/, "$1") },
  { from: "effect/plist", to: "effect/transform", file: (rel) => rel.replace(/^transform_/, "") },
  { from: "effect/selected", to: "effect/select", file: (rel) => rel.replace(/^select_/, "") },
  { from: "effect/skill", to: "effect/skill", file: (rel) => rel.replace(/^s_/, "") },
  { from: "effect/status", to: "effect/status", file: (rel) => rel.replace(/^s_/, "") },

  // ---------------- 实体 ----------------
  // 称号图集原来是 titles/<名>/<名>.png（多套一层），战魂是平铺；统一成平铺
  { from: "titles", to: "title", file: (rel) => rel.replace(/^sfx_(\d+)\/sfx_\d+$/, "$1") },
  { from: "war-soul", to: "soul", file: (rel) => rel.replace(/^sfx_(\d+)$/, "$1") },
  { from: "clothes", to: "equipment/clothes" },
  { from: "weapons", to: "equipment/weapons" },
  { from: "monster/icon", to: "monster/icon", file: (rel) => rel.replace(/^(\d+)_00000$/, "$1") },
  { from: "role/1", to: "role/boy" },
  { from: "role/2", to: "role/girl" },
  // 药品图标原来是拼音缩写（jcy = 金创药），改成药剂 id（drug_hp_1 → drug-hp-1）
  {
    from: "item",
    to: "item",
    file: (rel) => rel.replace(/_/g, "-"),
    rename: {
      "jcy-1": "drug-hp-1",
      "jcy-2": "drug-hp-2",
      "jcy-3": "drug-hp-3",
      "jcy-4": "drug-hp-4",
      "jcy-5": "drug-hp-5",
      "mfy-1": "drug-mp-1",
      "mfy-2": "drug-mp-2",
      "mfy-3": "drug-mp-3",
      tys: "drug-sun",
      qxxy: "drug-hp-pct",
      qxly: "drug-mp-pct",
    },
  },
  // NPC：npc_2108 → 2108（数字是美术资源号，与 npcs.src 一致）
  { from: "npc", to: "npc", file: (rel) => rel.replace(/^npc_/, "") },
  // 音效：sounds/ → audio/，文件名 kebab
  { from: "sounds", to: "audio", file: snakeToKebab },
];

/**
 * 零引用素材：全工程（客户端/服务端/管理端/工具）都搜不到引用，且不是数据库里的路径。
 * 不删——移到 `_loose_frames_archive/`（该目录本就用来放「已出素材的原始件」，可回退）。
 */
const ARCHIVE = [
  // npc/ 里混着两套编号：npc_2108（当前在用）与 m_10005@0（旧版，零引用）
  /^npc\/m_\d+@\d+\.(png|plist)$/,
  // item/ 里的拼音缩写图标：只有 jcy/mfy/tys/qxxy/qxly 这几张对应 drugs.icon，
  // 其余的 fs/sz/tz 系列在全工程（代码 / 库 / 管理端）里都搜不到引用
  /^item\/(fs|sz|tz)[_-]\d+\.png$/,
];

/** 直接删除：外部工具产物（内容还带 Windows 反斜杠），与素材无关 */
const DROP = [/^clothes\/_汇总\.json$/, /^weapons\/_汇总\.json$/];

/** 由本脚本重新生成，不参与搬迁 */
const SKIP = [/^image-manifest\.json$/, /^audio-manifest\.json$/];

//#endregion

//#region 映射计算

function matchRule(rel) {
  let best = null;
  for (const rule of LAYOUT) {
    if (rel === rule.from || rel.startsWith(`${rule.from}/`)) {
      if (!best || rule.from.length > best.from.length) best = rule;
    }
  }
  return best;
}

/**
 * 算一个素材文件的新相对路径
 * @param {string} rel 旧路径（含扩展名，posix）
 * @returns {{ to: string|null, drop: boolean, archive: boolean }}
 */
function mapAsset(rel) {
  if (DROP.some((re) => re.test(rel))) return { to: null, drop: true, archive: false };
  if (ARCHIVE.some((re) => re.test(rel))) return { to: null, drop: false, archive: true };

  const rule = matchRule(rel);
  if (!rule) return { to: rel, drop: false, archive: false }; // 不在规则里 = 原样保留（map/、skill/icon/ 等）

  const ext = path.posix.extname(rel);
  const withinDir = path.posix.relative(rule.from, rel).slice(0, -ext.length);
  let renamed = rule.file ? rule.file(withinDir) : withinDir;
  if (rule.rename) {
    const key = renamed.split("/").pop();
    const mapped = rule.rename[key];
    if (mapped) renamed = [...renamed.split("/").slice(0, -1), mapped].join("/");
  }
  return { to: `${rule.to}/${renamed}${ext}`.replace(/\/+/g, "/"), drop: false, archive: false };
}

//#endregion

//#region 收集 + 校验

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), nextRel, out);
    else out.push(nextRel);
  }
}

const all = [];
walk(RES, "", all);

/** @type {Array<{from:string,to:string,drop?:boolean,archive?:boolean}>} */
const moves = [];
for (const rel of all) {
  const ext = path.posix.extname(rel);
  if (ext === ".meta") continue; // meta 跟随素材，稍后配对
  if (SKIP.some((re) => re.test(rel))) continue;
  if (!ASSET_EXTS.has(ext) && !DROP.some((re) => re.test(rel))) {
    // 规则之外、又不是已知素材：原样保留（例如 map 下的 .tmx/.tsx 已覆盖，未知类型保守不动）
    if (!matchRule(rel)) continue;
  }
  const mapped = mapAsset(rel);
  if (mapped.drop) moves.push({ from: rel, to: "", drop: true });
  else if (mapped.archive) moves.push({ from: rel, to: "", archive: true });
  else if (mapped.to !== rel) moves.push({ from: rel, to: mapped.to });
}

// 冲突检测：目标路径不得重复，也不得撞上未搬迁的现存文件
const existing = new Set(all.filter((rel) => !rel.endsWith(".meta")));
const movedFrom = new Set(moves.filter((m) => !m.drop && !m.archive).map((m) => m.from));
const targetCount = new Map();
const collisions = [];
for (const move of moves) {
  if (move.drop || move.archive) continue;
  const hit = targetCount.get(move.to) ?? [];
  hit.push(move.from);
  targetCount.set(move.to, hit);
  if (existing.has(move.to) && !movedFrom.has(move.to)) collisions.push({ to: move.to, from: move.from, why: "目标已存在" });
}
for (const [to, froms] of targetCount) {
  if (froms.length > 1) collisions.push({ to, from: froms.join(" + "), why: "多个来源指向同一目标" });
}

//#endregion

//#region 执行

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const logIndex = args.indexOf("--log");
const logPath = logIndex >= 0 ? args[logIndex + 1] : null;

const byTop = new Map();
for (const move of moves) {
  const key = move.drop ? "(删除)" : move.archive ? "(归档)" : move.from.split("/")[0];
  byTop.set(key, (byTop.get(key) ?? 0) + 1);
}

console.log(`素材根：${RES}`);
console.log(`扫描 ${all.filter((rel) => !rel.endsWith(".meta")).length} 个素材文件，需处理 ${moves.length} 个`);
for (const [top, count] of [...byTop.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${top}: ${count}`);

const renames = moves.filter((m) => !m.drop && !m.archive && path.posix.basename(m.from) !== path.posix.basename(m.to));
console.log(`\n其中改名（不只是换目录）：${renames.length} 个，样例：`);
for (const move of renames.slice(0, 12)) console.log(`  ${move.from}\n    → ${move.to}`);

if (collisions.length) {
  console.log(`\n✘ ${collisions.length} 处冲突，先修规则：`);
  for (const item of collisions.slice(0, 20)) console.log(`  ${item.why}：${item.to}（来自 ${item.from}）`);
  process.exit(1);
}

if (!apply) {
  const dumpIndex = args.indexOf("--dump");
  if (dumpIndex >= 0) {
    const prefix = args[dumpIndex + 1] ?? "";
    console.log(`\n全部映射（前缀 ${prefix || "(全部)"}）：`);
    for (const move of moves) {
      if (!`${move.from} ${move.to}`.includes(prefix)) continue;
      console.log(`  ${move.from}  →  ${move.drop ? "(删除)" : move.archive ? "(归档)" : move.to}`);
    }
  }
  console.log("\n干跑结束（未落盘）。加 --apply 执行。");
  process.exit(0);
}

// 1) meta 配对：素材搬哪，meta 跟到哪（目录级 meta 不在此列）
const metaMoves = [];
for (const move of moves) {
  if (move.drop || move.archive) continue;
  const metaFrom = `${move.from}.meta`;
  if (fs.existsSync(path.join(RES, metaFrom))) metaMoves.push({ from: metaFrom, to: `${move.to}.meta` });
}

const ensureDir = (filePath) => fs.mkdirSync(path.dirname(filePath), { recursive: true });
const archiveRoot = path.join(ROOT, "_loose_frames_archive", "orphans-2026-11");

let movedCount = 0;
const records = [];
for (const move of [...moves, ...metaMoves]) {
  const source = path.join(RES, move.from);
  if (!fs.existsSync(source)) continue;
  if (move.drop) {
    fs.unlinkSync(source);
    records.push({ from: move.from, to: null, action: "drop" });
    continue;
  }
  if (move.archive) {
    const target = path.join(archiveRoot, move.from);
    ensureDir(target);
    fs.renameSync(source, target);
    // meta 一起归档：uuid 是回退时保持引用的关键，留在原地只会被当孤立 meta 清掉
    const metaSource = `${source}.meta`;
    if (fs.existsSync(metaSource)) fs.renameSync(metaSource, `${target}.meta`);
    records.push({ from: move.from, to: `_loose_frames_archive/orphans-2026-11/${move.from}`, action: "archive" });
    continue;
  }
  const target = path.join(RES, move.to);
  ensureDir(target);
  fs.renameSync(source, target);
  records.push({ from: move.from, to: move.to, action: "move" });
  movedCount += 1;
}
console.log(`\n✔ 搬运 ${movedCount} 个文件（含 meta）`);

// 2) plist 内部：贴图名与帧 key 都带旧基名，必须同步
let plistFixed = 0;
for (const move of moves) {
  if (move.drop || move.archive) continue;
  if (!move.to.endsWith(".plist")) continue;
  const oldBase = path.posix.basename(move.from, ".plist");
  const newBase = path.posix.basename(move.to, ".plist");
  if (oldBase === newBase) continue;
  const full = path.join(RES, move.to);
  const text = fs.readFileSync(full, "utf8");
  const next = text.split(oldBase).join(newBase);
  if (next !== text) {
    fs.writeFileSync(full, next, "utf8");
    plistFixed += 1;
  }
}
console.log(`✔ 修正 ${plistFixed} 个 plist 的贴图名 / 帧名`);

// 3) 清空目录与目录 meta：自底向上，删掉没有素材的目录
function prune(dir) {
  let kept = 0;
  /** 目录与其 meta 在同一轮里可能被删两次（外层删目录时顺手删了 meta，内层又遇到那条 entry） */
  const remove = (target) => {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) {
      remove(path.join(dir, entry.name));
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (prune(full) === 0) {
        fs.rmdirSync(full);
        remove(`${full}.meta`);
        continue;
      }
      kept += 1;
      continue;
    }
    // 孤立 meta：素材不在
    if (entry.name.endsWith(".meta") && !fs.existsSync(full.slice(0, -".meta".length))) {
      remove(full);
      continue;
    }
    kept += 1;
  }
  return kept;
}
prune(RES);
console.log("✔ 清理空目录与孤立 meta");

if (logPath) {
  fs.writeFileSync(logPath, `${JSON.stringify(records, null, 1)}\n`, "utf8");
  console.log(`日志：${logPath}（${records.length} 条）`);
}

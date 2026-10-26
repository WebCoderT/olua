/**
 * 资源引用守卫（resource-refs guard）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 代码（configs / ui）里引用的每个 resources 路径，与磁盘上的实际素材是**两套真相**：
 * 路径写错、素材换版后目录改名 / 移位，运行时的表现全部是「静默空白」——
 * resources.load 的 err 只打一条 console.error，图集缺失更是设计上的静默回退
 * （AnimationHelper：图集优先、散帧兜底、都缺就空着）。没有任何编译错误会拦住它。
 *
 * 2026-10-26 换版 resources（Release 2026-10-25-1 整体替换本地目录）时，这个问题
 * 从「理论风险」变成「必查项」：素材包是外部产物，目录结构、帧名形态、图集有无
 * 都可能与上一版不同，而代码引用路径不会自己跟着变。排查一遍发现的差异要修，
 * 修完之后**靠这个审计守住**——下次再换素材包，`make audit` 直接把所有断链列出来。
 *
 * ===========================================================================
 * 检查什么
 * ===========================================================================
 *   1. 静态字面量引用：扫描 client/assets/{configs,ui,types,skills} 的 TS 源码，
 *      所有「一级目录是 resources 顶级目录」的字符串字面量（含 "logo" 特例），
 *      必须命中磁盘上的文件（任一常见扩展名，大小写不敏感）或目录。
 *   2. 展开型引用：路径由模板串在运行时拼接、字面量只在数据表里出现 id 的那几类
 *      （称号 titles/sfx_<id>、详情背景 backgrounds/sfx_<serial>、光柱
 *      effect/light/light_<n>），从配置表的数值字段展开成完整路径逐一核对。
 *   3. 图集 / 散帧结构对应（磁盘侧自检）：外观树（monster/clothes/weapons）的每个
 *      散帧目录 <树>/out/<id> 必须有对应图集目录 <树>/atlas/out/<id>（至少 1 个
 *      plist）；role/<n> 对应 role/atlas/<n>；npc/npc_* 对应 npc/atlas/<name>/<name>.plist；
 *      backgrounds/sfx_* 对应 backgrounds/atlas/<name>/<name>.plist。
 *      AnimationHelper 的口径是「图集优先、散帧兜底」，两者全缺 = 该外观整片空白。
 *
 * 不查什么：resources 里存在但代码没引用的素材（噪音大，增删素材不等于要改代码）；
 * manifest 与磁盘的一致性（那是 client/tools/resources_sync.py verify 的职责，单一来源）。
 *
 * 用法：node tools/audit-resource-refs.cjs
 * 退出码：全部命中 = 0；任一断链 = 1（`make audit` 据此判定 FAIL）
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RES_ROOT = path.join(ROOT, "client", "assets", "resources");
/** 扫描引用的源码目录（TS 源码；场景 .scene/.fire 是引擎文件不扫） */
const SCAN_DIRS = ["client/assets/configs", "client/assets/ui", "client/assets/types", "client/assets/skills"];

/** 常见资源扩展名（大小写不敏感比对；素材包里有 00000.PNG 这类大写扩展名） */
const EXTS = new Set(["png", "jpg", "jpeg", "plist", "ttf", "fnt", "tmx", "tsx", "json", "mp3", "wav"]);

/** 通用扫描的跳过值：无斜杠（"stand" 这类普通字符串）、引擎类型、代码标识 */
function looksLikeResourcePath(value) {
  if (typeof value !== "string") return false;
  if (!value || value.includes("${")) return false; // 模板串走展开核对
  if (value.startsWith("/") || value.endsWith("/")) return false;
  if (/^(https?:|cc\.|node:)/.test(value)) return false;
  if (value === "logo") return true; // resources 根目录的散图特例
  return /^[\w-]+\/[\w\-/@.]+$/.test(value) && !value.includes("..");
}

//#region 磁盘索引

/**
 * 剥掉 TS 注释（// 与 /* *\/），只留代码与字符串字面量
 *
 * 不剥的话注释里的示例路径（types/status.ts 曾写过「如 "skill/2009"」）会被当成真实引用误报。
 * 状态机逐字符走：字符串字面量（' " `，含转义）原样保留——资源路径里不会出现 // 或 /*，
 * 反过来注释里出现引号（中文引号除外）也被字符串态吃掉，两不误伤。
 */
function stripComments(source) {
  let out = "";
  let state = "code"; // code | line | block | "'" | '"' | "`"
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i++; continue; }
      if (ch === "/" && next === "*") { state = "block"; i++; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { state = ch; out += ch; continue; }
      out += ch;
      continue;
    }
    if (state === "line") { if (ch === "\n") { state = "code"; out += ch; } continue; }
    if (state === "block") { if (ch === "*" && next === "/") { state = "code"; i++; } continue; }
    // 字符串态：转义原样吞两字符；回到 code
    if (ch === "\\") { out += ch + (next ?? ""); i++; continue; }
    if (ch === state) state = "code";
    out += ch;
  }
  return out;
}

/** 相对 resources 根的全部文件（小写路径集合，供大小写不敏感比对） */
const diskFiles = new Set();
/** 相对 resources 根的全部目录 */
const diskDirs = new Set();

function indexDisk(dir, rel = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      diskDirs.add(relPath);
      indexDisk(path.join(dir, entry.name), relPath);
    } else {
      diskFiles.add(relPath.toLowerCase());
    }
  }
}
indexDisk(RES_ROOT);

/** resources 顶级目录名（通用扫描用「一级目录在 resources 里存在」来圈定候选字面量） */
const resTopDirs = new Set([...diskDirs].filter((p) => !p.includes("/")));
resTopDirs.forEach((name) => {
  // 顶级散图（logo.png）的茎也要进集合：字面量 "logo" 不带斜杠
  if (!name.includes(".")) return;
});

function fileExists(rel) {
  if (diskFiles.has(`${rel.toLowerCase()}`)) return true;
  // 带扩展名的直接查；不带的挨个补扩展名
  if (path.extname(rel)) return diskFiles.has(rel.toLowerCase());
  for (const ext of EXTS) if (diskFiles.has(`${rel.toLowerCase()}.${ext}`)) return true;
  return false;
}

function dirExists(rel) {
  return diskDirs.has(rel);
}

/** 图集引用（@分页）的 plist 存在性；一般引用的文件/目录存在性 */
function resourceExists(rel) {
  return fileExists(rel) || dirExists(rel);
}

/** 外观图集目录是否存在（getAtlasSrc 规则的磁盘版；空串 = 该形态没有图集规则） */
function atlasDirOf(outSrc) {
  const matched = /^(\w+)\/out\/(.+)$/.exec(outSrc);
  if (matched) return `${matched[1]}/atlas/out/${matched[2]}`;
  const roleMatched = /^role\/(\d+)$/.exec(outSrc);
  return roleMatched ? `role/atlas/${roleMatched[1]}` : "";
}

/** 单循环目录动画的图集 plist（getLoopAtlasDir 规则的磁盘版；空串 = 走散帧） */
function loopAtlasPlistOf(dirSrc) {
  const matched = /^(npc|backgrounds)\/(\w+)$/.exec(dirSrc);
  return matched ? `${matched[1]}/atlas/${matched[2]}/${matched[2]}.plist` : "";
}

//#endregion

//#region 1. 静态字面量引用

const failures = [];
let passed = 0;
const refs = new Map(); // 值 -> [来源文件:行号]

function collectFromSource(relative) {
  const full = path.join(ROOT, relative);
  const source = stripComments(fs.readFileSync(full, "utf8"));
  for (const match of [...source.matchAll(/["'`]([^"'`\n]+)["'`]/g)]) {
    const value = match[1];
    if (!looksLikeResourcePath(value)) continue;
    const top = value.split("/")[0];
    if (value !== "logo" && !resTopDirs.has(top)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    if (!refs.has(value)) refs.set(value, []);
    refs.get(value).push(`${relative}:${line}`);
  }
}

for (const dir of SCAN_DIRS) {
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith(".meta")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) collectFromSource(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, dir));
}

for (const [value, sources] of refs) {
  if (resourceExists(value)) {
    passed += 1;
    continue;
  }
  // 外观帧目录引用允许「散帧缺、图集在」：AnimationHelper 图集优先、散帧兜底
  const atlasDir = atlasDirOf(value);
  if (atlasDir && dirExists(atlasDir)) {
    passed += 1;
    continue;
  }
  const loopPlist = loopAtlasPlistOf(value);
  if (loopPlist && fileExists(loopPlist)) {
    passed += 1;
    continue;
  }
  failures.push(`引用断链：${value}（${sources.slice(0, 3).join(", ")}${sources.length > 3 ? " 等" : ""}）`);
}

//#endregion

//#region 2. 展开型引用（模板串的取值在数据表数值字段里）

/** 称号：title.ts 的 `{ id: <数字>,` → titles/sfx_<id> 目录（titles 不在 getLoopAtlasDir 里，纯散帧） */
const titleSource = stripComments(fs.readFileSync(path.join(ROOT, "client/assets/configs/title.ts"), "utf8"));
const titleIds = [...titleSource.matchAll(/\bid:\s*(\d+),/g)].map((m) => Number(m[1]));
if (!titleIds.length) failures.push("展开核对：title.ts 里解析不出称号 id（写法变了？）");
for (const id of titleIds) {
  const dir = `titles/sfx_${id}`;
  if (dirExists(dir)) passed += 1;
  else failures.push(`称号外观断链：${dir}（configs/title.ts id=${id}）`);
}

/** 详情背景：background.ts 的 detailBackgroundSerials 数组体（编号常多个同行）→ 散帧目录或图集 */
const bgSource = stripComments(fs.readFileSync(path.join(ROOT, "client/assets/configs/background.ts"), "utf8"));
const bgArray = /detailBackgroundSerials(?::\s*number\[\])?\s*=\s*\[([^\]]+)\]/.exec(bgSource);
const bgSerials = bgArray ? [...bgArray[1].matchAll(/\b(\d{5})\b/g)].map((m) => Number(m[1])) : [];
if (!bgSerials.length) failures.push("展开核对：background.ts 里解析不出背景编号（写法变了？）");
for (const serial of bgSerials) {
  const dir = `backgrounds/sfx_${serial}`;
  const plist = loopAtlasPlistOf(dir);
  if (dirExists(dir) || (plist && fileExists(plist))) passed += 1;
  else failures.push(`详情背景断链：${dir}（configs/background.ts serial=${serial}）`);
}

/** 光柱：light.ts 的 lightSerials → effect/light/light_<n>.plist */
const lightSource = stripComments(fs.readFileSync(path.join(ROOT, "client/assets/configs/light.ts"), "utf8"));
const lightSerials = [...lightSource.matchAll(/^\s*const lightSerials: number\[\] = \[([^\]]+)\]/gm)].flatMap((m) =>
  m[1].split(",").map((piece) => Number(piece.trim())).filter((n) => Number.isFinite(n)),
);
if (!lightSerials.length) failures.push("展开核对：light.ts 里解析不出光柱编号（写法变了？）");
for (const serial of lightSerials) {
  const plist = `effect/light/light_${serial}.plist`;
  if (fileExists(plist)) passed += 1;
  else failures.push(`光柱图集断链：${plist}（configs/light.ts serial=${serial}）`);
}

//#endregion

//#region 3. 图集 / 散帧结构对应（磁盘侧自检）

/** 外观树：散帧目录 <树>/out/<id> 必须有图集目录（至少 1 个 plist）—— 两者全缺 = 外观空白 */
const OUT_TREES = ["monster", "clothes", "weapons"];
for (const tree of OUT_TREES) {
  const outRoot = path.join(RES_ROOT, tree, "out");
  if (!fs.existsSync(outRoot)) continue;
  for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const outDir = `${tree}/out/${entry.name}`;
    const atlasDir = `${tree}/atlas/out/${entry.name}`;
    const atlasFull = path.join(RES_ROOT, atlasDir);
    const plists = fs.existsSync(atlasFull)
      ? fs.readdirSync(atlasFull).filter((name) => name.toLowerCase().endsWith(".plist")).length
      : 0;
    if (dirExists(outDir) && plists > 0) {
      passed += 1;
      continue;
    }
    // 散帧与图集都缺内容（空目录 / 图集目录没 plist）才算断链；散帧缺但图集在是合法形态
    const hasLoose = dirExists(outDir) && fs.readdirSync(path.join(RES_ROOT, outDir)).some((name) => EXTS.has(path.extname(name).toLowerCase().slice(1)));
    if (!hasLoose && plists === 0) failures.push(`外观树断链：${outDir} 既无散帧也无图集 plist（${atlasDir}）`);
  }
}

/** role 本体：role/<n> 散帧 或 role/atlas/<n> 图集，二者必须其一有内容 */
for (const entry of fs.readdirSync(path.join(RES_ROOT, "role"), { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
  const loose = fs.readdirSync(path.join(RES_ROOT, "role", entry.name)).some((name) => EXTS.has(path.extname(name).toLowerCase().slice(1)));
  const atlasFull = path.join(RES_ROOT, "role", "atlas", entry.name);
  const plists = fs.existsSync(atlasFull)
    ? fs.readdirSync(atlasFull).filter((name) => name.toLowerCase().endsWith(".plist")).length
    : 0;
  if (loose || plists > 0) passed += 1;
  else failures.push(`role 本体断链：role/${entry.name} 既无散帧也无图集`);
}

/** npc / backgrounds：单循环图集 plist 与散帧目录必须其一有内容 */
for (const [tree, dirPattern] of [["npc", /^npc_\w+$/], ["backgrounds", /^sfx_\w+$/]]) {
  const root = path.join(RES_ROOT, tree);
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !dirPattern.test(entry.name)) continue;
    const plist = `${tree}/atlas/${entry.name}/${entry.name}.plist`;
    const loose = fs.readdirSync(path.join(root, entry.name)).some((name) => EXTS.has(path.extname(name).toLowerCase().slice(1)));
    if (loose || fileExists(plist)) passed += 1;
    else failures.push(`单循环动画断链：${tree}/${entry.name} 既无散帧也无图集 plist（${plist}）`);
  }
}

//#endregion

//#region 汇总

const auditCount = refs.size + titleIds.length + bgSerials.length + lightSerials.length;
console.log(`扫描 ${SCAN_DIRS.length} 个源码目录：静态引用 ${refs.size} · 称号 ${titleIds.length} · 详情背景 ${bgSerials.length} · 光柱 ${lightSerials.length}，加磁盘结构核对共 ${passed} 处命中`);

if (failures.length === 0) {
  console.log(`\n✔ 资源引用与磁盘素材一致（核对 ${passed} 处）`);
  process.exit(0);
}

console.log(`\n✗ 资源引用有 ${failures.length} 处断链：\n`);
failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
console.log("\n  处理方向：路径写错改代码；素材缺补素材包；确属未打包外观参照既有条目把 out 置空。");
process.exit(1);

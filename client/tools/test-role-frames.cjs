#!/usr/bin/env node
/**
 * 角色本体素材单测（client/tools/test-role-frames.cjs）
 *
 * ===========================================================================
 * #235 起散帧全部图集化，本文件随之改写
 * ===========================================================================
 * 改写前它数的是 `_loose_frames_archive/role` 下那批逐帧 PNG（416 帧 / 全局连续编号 /
 * role/2 从 600 起）。那批文件已经打包进 `assets/resources/role/<n>/<action>/<action>.plist`
 * 并从仓库移出，于是判据换成图集口径 —— 事故（外观整片空白）的真正成因是**帧匹配**，
 * 与「帧在磁盘上是不是散着放」无关，所以这几条仍然必须成立：
 *
 * · 每个动作的图集 PNG 是合法 PNG（ext 与真实格式一致，历史上踩过 `.PNG` 大写扩展名）
 * · 每个动作的 plist 里有帧、帧名能解析出「方向 + 帧序号」，且每帧都真的在图集里
 * · 每个动作覆盖 8 个方向、每个方向的帧号从 0 起连续（切片段时按 0 基下标取）
 * · 男 role/1 与女 role/2 两套同规格（缺一套就是「换个性别整片空白」）
 * · 动画表 88 组（11 动作 × 8 方向）都能在对应动作图集里找到帧
 *
 * 用法：node client/tools/test-role-frames.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ROLE_DIRS = ["1", "2"];
const RES_ROOT = path.join(PROJECT_ROOT, "assets", "resources");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let outDir;
try {
  outDir = prepare("olua-role-frames", ["configs/animation.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}
const { roleAnimationMap, directions, roleActionAtlas } = require(path.join(outDir, "configs/animation.js"));

const readPngHead = (file) => {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head;
};

/** 某套外观某个动作的帧：`d<方向>_<序号>` → { 方向: [序号…] } */
function readAtlas(dir, action) {
  const dirPath = path.join(RES_ROOT, "role", dir, action);
  const plistPath = path.join(dirPath, `${action}.plist`);
  if (!fs.existsSync(plistPath)) return null;
  const names = Array.from(fs.readFileSync(plistPath, "utf8").matchAll(/<key>(d\d_\d+)\.png<\/key>/g)).map((match) => match[1]);
  const byDirection = new Map();
  for (const name of names) {
    const [direction, index] = name.split("_");
    if (!byDirection.has(direction)) byDirection.set(direction, []);
    byDirection.get(direction).push(Number(index));
  }
  return { png: path.join(dirPath, `${action}.png`), byDirection };
}

console.log("【1】素材格式：每个动作的图集都是合法 PNG（扩展名与真实格式一致）");
for (const dir of ROLE_DIRS) {
  const bad = [];
  const missing = [];
  for (const { action } of roleActionAtlas) {
    const atlas = readAtlas(dir, action);
    if (!atlas) { missing.push(action); continue; }
    const head = readPngHead(atlas.png);
    // 典型的空帧占位是 BMP（"BM"）——历史上用 1×1 BMP 冒充 PNG
    if (!head.equals(PNG_SIGNATURE)) bad.push(`${action}（magic ${head.slice(0, 2).toString("hex")}）`);
  }
  check(missing.length === 0, `role/${dir} 的 ${roleActionAtlas.length} 个动作都有图集`, missing.join("、"));
  check(bad.length === 0, `role/${dir} 的图集 PNG 格式正确`, bad.slice(0, 5).join("、"));
}

console.log("\n【2】帧名：每个动作覆盖 8 个方向，帧号从 0 起连续");
for (const dir of ROLE_DIRS) {
  const badDirection = [];
  const badNumbering = [];
  for (const { action } of roleActionAtlas) {
    const atlas = readAtlas(dir, action);
    if (!atlas) continue;
    if (atlas.byDirection.size !== directions.length) badDirection.push(`${action}:${atlas.byDirection.size}向`);
    for (const [direction, indexes] of atlas.byDirection) {
      const sorted = [...indexes].sort((a, b) => a - b);
      const contiguous = sorted.every((value, position) => value === position);
      if (!contiguous) badNumbering.push(`${action}/${direction}:${sorted.join(",")}`);
    }
  }
  check(badDirection.length === 0, `role/${dir} 每个动作都覆盖 ${directions.length} 个方向`, badDirection.slice(0, 5).join("、"));
  check(
    badNumbering.length === 0,
    `role/${dir} 每个「动作 × 方向」的帧号都从 0 起连续（切片段按下标取帧）`,
    badNumbering.slice(0, 3).join(" / "),
  );
}

console.log("\n【3】动画切割：88 组「动作 × 方向」都能在对应动作图集里找到帧");
check(roleAnimationMap.size === 88, "动画表共 11 个动作 × 8 个方向 = 88 组", `实际 ${roleAnimationMap.size}`);
// 动画名 = `${action}_${direction}`，方向本身可能带下划线（right_up / left_down …），
// 所以按方向后缀「从长到短」匹配去掉，才不会把 stand_right_up 切成 stand_right
const directionSuffixes = directions.map((direction) => `_${direction}`).sort((a, b) => b.length - a.length);
function toAction(name) {
  for (const suffix of directionSuffixes) {
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}
for (const dir of ROLE_DIRS) {
  const atlases = new Map(roleActionAtlas.map(({ action }) => [action, readAtlas(dir, action)]));
  // 动画表用的是「整张表全局帧号」：动作按 roleActionAtlas 的顺序首尾相接，
  // 每个动作占 frames × 方向数 个号（换动作时号段整体后移）
  const specFrames = new Map();
  const actionBase = new Map();
  let cursor = 0;
  for (const { action, frames } of roleActionAtlas) {
    specFrames.set(action, frames);
    actionBase.set(action, cursor);
    cursor += frames * directions.length;
  }
  const emptyPairs = [];
  roleAnimationMap.forEach((frameIndexes, name) => {
    const atlas = atlases.get(toAction(name));
    if (!atlas) { emptyPairs.push(`${name}:无图集`); return; }
    // 动画区间是「动作内全局帧号」（方向 n 从 n × 单方向帧数 起），图集里是「按方向的 0 基下标」；
    // 单方向帧数取配置里的 frames（= 8），图集实际只有前几帧（后几帧历史上是空占位）
    const action = toAction(name);
    const perDirection = specFrames.get(action) ?? 0;
    // 方向也要按「最长后缀」匹配（否则 stand_right_up 会被当成 *_up）
    const suffix = directionSuffixes.find((item) => name.length > item.length && name.endsWith(item));
    const directionIndex = suffix ? directions.indexOf(suffix.slice(1)) : -1;
    if (directionIndex < 0) { emptyPairs.push(`${name}:方向不明`); return; }
    const offset = (actionBase.get(action) ?? 0) + directionIndex * perDirection;
    const available = new Set((atlas.byDirection.get(`d${directionIndex}`) ?? []).map((index) => offset + index));
    if (!frameIndexes.some((index) => available.has(index))) emptyPairs.push(name);
  });
  check(emptyPairs.length === 0, `role/${dir} 的每个「动作 × 方向」都能切出帧`, emptyPairs.slice(0, 6).join("、"));
  const stand = atlases.get("stand");
  check((stand?.byDirection.get("d4") ?? []).length > 0, `role/${dir} 的 stand 有正面帧（角色出生就会播到）`);
}

finish("PASS：role 两套本体图集格式正确、帧名覆盖 8 向且从 0 起连续、88 组动画全部可切。");

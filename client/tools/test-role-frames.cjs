#!/usr/bin/env node
/**
 * role 帧素材守卫单测
 *
 * 背景（2026-10-07 真事故）：`resources/role/{1,2}` 里混入 368 个「扩展名 .png、本体却是 1×1 BMP」的
 * **空帧占位**（导出工具给「该帧无内容」的帧输出的 70 字节占位文件）。Cocos 按 .png 解码必然失败 →
 * 每张图的 .meta 都是 `imported:false` / `subMetas:{}`（没有任何子资源）→ 客户端导入阶段刷屏报错。
 * 已全部移除（各目录由 600 个文件降到 416 帧），原件备份在 `.workbuddy/backup/role-empty-frames-*`。
 *
 * 本测试钉住四件事，防止同类问题再次混进来、也防止清理时误删真帧：
 *   1. 目录里**每个帧文件都是合法 PNG**（扩展名与真实格式一致 —— 这是本次事故的根因）
 *   2. 两套素材（role/1 男、role/2 女）按各自**帧号基准**归一后，动画表的每个动作 × 每个方向都能切出帧
 *   3. 帧号不重复、无孤立 .meta（`.png.meta` 存在但 `.png` 不在）
 *   4. role/1 的基准为 0、role/2 的基准为 600（configs/animation.animationFrameBases）
 *
 * 用法：node client/tools/test-role-frames.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 事故后各目录的帧数（600 - 184 个空帧占位）；真帧被误删会让它变小 */
const EXPECTED_FRAME_COUNT = 416;
const ROLE_DIRS = ["1", "2"];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const roleRoot = path.join(PROJECT_ROOT, "assets", "resources", "role");
if (!fs.existsSync(roleRoot)) {
  fail(`找不到素材目录：${roleRoot}`);
  process.exit();
}

let outDir;
try {
  outDir = prepare("olua-role-frames", ["configs/animation.ts", "ui/utils/animation/FrameOrder.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}
const { roleAnimationMap, directions, animationFrameBases, getAnimationFrameBase } = require(path.join(outDir, "configs/animation.js"));
const { getFrameIndex } = require(path.join(outDir, "ui/utils/animation/FrameOrder.js"));

// 动画名 = `${action}_${direction}`，而方向本身可能带下划线（right_up / left_down …），
// 所以按方向后缀「从长到短」匹配去掉，才不会把 stand_right_up 切成 stand_right
const directionSuffixes = directions.map((direction) => `_${direction}`).sort((a, b) => b.length - a.length);
function toAction(name) {
  for (const suffix of directionSuffixes) {
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

console.log("【1】素材格式：每个帧文件都是合法 PNG（扩展名与真实格式一致）");
const framesByDir = {};
ROLE_DIRS.forEach((dir) => {
  const dirPath = path.join(roleRoot, dir);
  if (!fs.existsSync(dirPath)) {
    check(false, `role/${dir} 目录存在`);
    framesByDir[dir] = [];
    return;
  }
  const pngs = fs.readdirSync(dirPath).filter((name) => name.toLowerCase().endsWith(".png"));
  const notPng = [];
  const emptyNumbers = [];
  pngs.forEach((name) => {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(path.join(dirPath, name), "r");
    try {
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!head.equals(PNG_SIGNATURE)) {
      // 典型的空帧占位是 BMP（"BM"）——把这类文件单独点名，便于定位
      notPng.push(`${name}（magic ${head.slice(0, 2).toString("hex")}）`);
      if (head[0] === 0x42 && head[1] === 0x4d) emptyNumbers.push(name);
    }
  });
  check(notPng.length === 0, `role/${dir} 的 ${pngs.length} 个帧文件格式与扩展名一致`, notPng.slice(0, 5).join("、"));
  if (emptyNumbers.length) console.log(`      （其中 ${emptyNumbers.length} 个是 1×1 BMP 空帧占位，需清理：node client/tools/clean-role-empty-frames.cjs --apply）`);

  // 帧号（末尾连续数字）；同时收集重号
  const numbers = [];
  const seen = new Set();
  const duplicated = [];
  pngs.forEach((name) => {
    const index = getFrameIndex(name);
    if (index === null) return;
    if (seen.has(index)) duplicated.push(index);
    seen.add(index);
    numbers.push(index);
  });
  check(duplicated.length === 0, `role/${dir} 帧号无重复`, duplicated.slice(0, 5).join("、"));
  check(pngs.length === EXPECTED_FRAME_COUNT, `role/${dir} 帧数保持 ${EXPECTED_FRAME_COUNT}（清理空帧后各 184 个占位被移除，真帧一个不少）`, `实际 ${pngs.length}`);

  // 孤立 .meta：.png.meta 在、对应 .png 不在 —— 删帧时漏删 meta 会留下它，编辑器会报一次缺失
  const metas = fs.readdirSync(dirPath).filter((name) => name.toLowerCase().endsWith(".png.meta"));
  const orphan = metas.filter((meta) => !fs.existsSync(path.join(dirPath, meta.slice(0, -".meta".length))));
  check(orphan.length === 0, `role/${dir} 无孤立 .meta`, orphan.slice(0, 5).join("、"));

  framesByDir[dir] = numbers;
});

/**
 * 角色动画表 roleAnimationMap 的每个动作 × 每个方向在该目录里都至少能切出 1 帧
 * 与 AnimationHelper.buildClips 同口径：**先把帧号减掉该目录的帧号基准**再匹配动作区间
 * （role/2 的帧号从 600 起、与 role/1 全局连续编号，不减基准则一组都切不出来 → 外观整片空白）
 */
function checkClips(dir) {
  const base = getAnimationFrameBase(`role/${dir}`);
  const available = new Set((framesByDir[dir] || []).map((index) => index - base));
  const actionTotals = new Map();
  const emptyPairs = [];
  roleAnimationMap.forEach((frameIndexes, name) => {
    const hits = frameIndexes.filter((index) => available.has(index));
    const action = toAction(name);
    actionTotals.set(action, (actionTotals.get(action) || 0) + hits.length);
    if (hits.length === 0) emptyPairs.push(name);
  });
  check(emptyPairs.length === 0, `role/${dir}（帧号基准 ${base}）的每个「动作 × 方向」都能切出帧`, emptyPairs.slice(0, 6).join("、"));
  return { available, actionTotals };
}

console.log("\n【2】动画切割：roleAnimationMap 的每个动作 × 每个方向至少能切出 1 帧");
check(roleAnimationMap.size === 88, "动画表共 11 个动作 × 8 个方向 = 88 组", `实际 ${roleAnimationMap.size}`);
const clipsByDir = {};
ROLE_DIRS.forEach((dir) => {
  clipsByDir[dir] = checkClips(dir);
});
// 逐动作打印每方向有效帧数（可见性：素材每个方向 8 帧里后 4 帧本就是空占位，故多为 4 帧）
const directionCount = 8;
const clipSummary = clipsByDir["1"].actionTotals;
console.log("      每个动作每方向有效帧数（括号内为该动作合计；男 role/1 与女 role/2 同规格）：");
clipSummary.forEach((total, action) => {
  console.log(`        ${action.padEnd(16, " ")} ${(total / directionCount).toFixed(1)} 帧/方向  (合计 ${total})`);
});

console.log("\n【3】动画片段可播放：每个动作都有帧，且帧序从 0 号起算");
// 男/女各一套默认身体（见 configs/role.roleDefaultCloths），两套都必须能正常播
ROLE_DIRS.forEach((dir) => {
  const available = clipsByDir[dir].available;
  check(available.has(0), `role/${dir} 存在 0 号帧（待机起始帧，角色出生就会播到）`);
  check((clipsByDir[dir].actionTotals.get("stand") || 0) > 0, `role/${dir} 的 stand 动作能切出片段`);
});
// 女性外观的帧号基准必须登记：role/2 若不登记基准，上面「每个动作都能切出帧」会直接失败
check(getAnimationFrameBase("role/1") === 0, "role/1 无需帧号基准（素材从 0 起编号）");
check(getAnimationFrameBase("role/2") === 600, "role/2 登记了帧号基准 600（与 role/1 全局连续编号）", `实际 ${getAnimationFrameBase("role/2")}`);
check(animationFrameBases.size > 0, "帧号基准表非空（未登记基准的目录按 0 处理）");

finish("PASS：role 两套素材全为合法 PNG、无重号无孤立 meta、各自按帧号基准归一后 88 组动画全部可切、帧数保持 416。");

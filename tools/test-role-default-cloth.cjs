#!/usr/bin/env node
/**
 * 角色默认外观（未穿衣服时的身体）单测
 *
 * 盯的不变量（改默认外观 / 加性别素材后必须全绿）：
 * · 配置表：男 role/1、女 role/2，字段与装备外观同口径（out / outScale / outPositions）
 * · 回落：未登记的性别（SEX.ALL、旧存档空值、未知串）一律回落男性 —— 角色任何情况下都必须有身体
 * · 素材对齐：配置的每个目录都真实存在、帧数完整，且按**该目录的帧号基准**归一后动画表 88 组全能切
 * · 接线：外观回退与预加载都按 role.sex 取默认外观（不再是单一常量），且旧常量已彻底清除
 * · 同口径：RoleAppearance 的衣服/武器变换参数是 OutTransform，装备与默认外观共用一套变换代码
 *
 * 数据层跑在沙箱里（真实的 configs/role + configs/animation + items，见 lib/configs-sandbox.cjs），
 * 素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const roleRoot = path.join(PROJECT_ROOT, "assets/resources/role");

let outDir;
try {
  outDir = prepare("olua-role-default-cloth", ["configs/animation.ts", "ui/utils/animation/FrameOrder.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}

const { roleDefaultCloths, getRoleDefaultCloth } = require(path.join(outDir, "configs/role.js"));
const { roleAnimationMap, directions, animationFrameBases, getAnimationFrameBase } = require(path.join(outDir, "configs/animation.js"));
const { SEX } = require(path.join(outDir, "types/role.js"));
const { getFrameIndex } = require(path.join(outDir, "ui/utils/animation/FrameOrder.js"));

const roleSource = read("assets/configs/role.ts");
const animationSource = read("assets/configs/animation.ts");
const appearanceSource = read("assets/ui/components/role/RoleAppearance.ts");
const preloadSource = read("assets/ui/core/PreloadManager.ts");
const animationHelperSource = read("assets/ui/helpers/AnimationHelper.ts");
const goodSource = read("assets/types/good.ts");

console.log("\n— A. 配置表：按性别分表 —");
check(roleDefaultCloths.size === 2, "默认外观表恰好两个性别（男 / 女）", `实际 ${roleDefaultCloths.size}`);
check(getRoleDefaultCloth(SEX.BOY).out === "role/1", "男性默认外观 = role/1", getRoleDefaultCloth(SEX.BOY).out);
check(getRoleDefaultCloth(SEX.GRIL).out === "role/2", "女性默认外观 = role/2", getRoleDefaultCloth(SEX.GRIL).out);
check(getRoleDefaultCloth(SEX.BOY) === roleDefaultCloths.get(SEX.BOY), "getRoleDefaultCloth(男) 取到表里那一项（不是每次新建）");
check(getRoleDefaultCloth(SEX.GRIL) === roleDefaultCloths.get(SEX.GRIL), "getRoleDefaultCloth(女) 取到表里那一项");

console.log("\n— B. 回落：任何性别都必须有身体 —");
check(getRoleDefaultCloth(SEX.ALL) === roleDefaultCloths.get(SEX.BOY), "SEX.ALL 回落男性（不是返回 undefined）");
check(!!getRoleDefaultCloth("").out, "未知性别串回落男性且 out 非空");
check(!!getRoleDefaultCloth("9").out, "越界性别回落男性且 out 非空");
[SEX.BOY, SEX.GRIL, SEX.ALL].forEach((sex) => {
  const cloth = getRoleDefaultCloth(sex);
  check(!!cloth && !!cloth.out, `性别 ${sex} 的默认外观存在且 out 非空`);
});

console.log("\n— C. 字段口径：与装备外观一致（out / outScale / outPositions）—");
roleDefaultCloths.forEach((cloth, sex) => {
  check(typeof cloth.out === "string" && cloth.out.length > 0, `性别 ${sex} 的 out 是非空字符串`);
  check(typeof cloth.outScale === "number", `性别 ${sex} 的 outScale 是数字`, String(cloth.outScale));
  check(Array.isArray(cloth.outPositions) && cloth.outPositions.length === directions.length, `性别 ${sex} 的 outPositions 按 ${directions.length} 个方向各一项`, `实际 ${cloth.outPositions ? cloth.outPositions.length : "无"}`);
  check(
    Array.isArray(cloth.outPositions) && cloth.outPositions.every((position) => typeof position?.x === "number" && typeof position?.y === "number"),
    `性别 ${sex} 的每个方向位置都是 Vec2`,
  );
});
check(/export interface OutTransform/.test(goodSource), "types/good 导出共用外观变换接口 OutTransform");
check(/outScale\?: number;/.test(goodSource) && /outPositions\?: Vec2\[\];/.test(goodSource), "OutTransform 的字段可选（装备与默认外观都能满足）");

console.log("\n— D. 素材对齐：目录存在、帧数完整、按帧号基准全能切 —");
roleDefaultCloths.forEach((cloth, sex) => {
  const dirPath = path.join(roleRoot, cloth.out.replace(/^role\//, ""));
  if (!fs.existsSync(dirPath)) {
    check(false, `性别 ${sex} 的默认外观目录存在（${cloth.out}）`);
    return;
  }
  const pngs = fs.readdirSync(dirPath).filter((name) => name.toLowerCase().endsWith(".png"));
  check(pngs.length > 0, `性别 ${sex} 的目录 ${cloth.out} 里有帧`, `${pngs.length} 帧`);

  // 与 AnimationHelper.buildClips 同口径：帧号先减该目录的帧号基准，再匹配动作区间
  const base = getAnimationFrameBase(cloth.out);
  const available = new Set(pngs.map((name) => getFrameIndex(name)).filter((index) => index !== null).map((index) => index - base));
  const emptyPairs = [];
  roleAnimationMap.forEach((frameIndexes, name) => {
    if (!frameIndexes.some((index) => available.has(index))) emptyPairs.push(name);
  });
  check(available.has(0), `性别 ${sex} 的目录存在归一后的 0 号帧（待机起始帧）`);
  check(emptyPairs.length === 0, `性别 ${sex} 的目录按帧号基准 ${base} 归一后 88 组动画全部能切出帧`, emptyPairs.slice(0, 6).join("、"));
});

console.log("\n— E. 帧号基准登记（与另一套全局连续编号的素材必须登记）—");
check(animationFrameBases.get("role/2") === 600, "configs/animation 给 role/2 登记基准 600", String(animationFrameBases.get("role/2")));
check(getAnimationFrameBase("role/1") === 0, "role/1 从 0 起编号，无需登记（基准 0）");
check(getAnimationFrameBase("role/9") === 0, "未登记的目录基准为 0（不会因缺登记而崩）");

console.log("\n— F. 接线：回退与预加载都按性别取默认外观 —");
check(/getRoleDefaultCloth\(role\.sex\)/.test(appearanceSource), "RoleAppearance 按 role.sex 取默认外观");
check(/getRoleDefaultCloth\(role\.sex\)\.out/.test(preloadSource), "PreloadManager 按 role.sex 取默认外观再预加载");
check(/getRoleDefaultCloth/.test(roleSource) && /export function getRoleDefaultCloth/.test(roleSource), "configs/role 导出 getRoleDefaultCloth");
check(/getAnimationFrameBase\(dirSrc\)/.test(animationHelperSource), "AnimationHelper.prepare 按目录取帧号基准");
check(/buildClips\([\s\S]*?frameBase/.test(animationHelperSource) && /index - frameBase/.test(animationHelperSource), "buildClips 在匹配动作区间前减掉帧号基准");

console.log("\n— G. 旧常量已彻底清除（单一常量无法区分性别）—");
check(!/ROLE_DEFAULT_CLOTH_OUT/.test(roleSource), "configs/role 不再导出 ROLE_DEFAULT_CLOTH_OUT");
const legacyHits = [];
["assets/configs", "assets/ui", "assets/entities", "assets/types"].forEach((root) => {
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && /ROLE_DEFAULT_CLOTH_OUT/.test(fs.readFileSync(full, "utf8"))) legacyHits.push(path.relative(PROJECT_ROOT, full));
    });
  };
  walk(path.join(PROJECT_ROOT, root));
});
check(legacyHits.length === 0, "全工程无 ROLE_DEFAULT_CLOTH_OUT 残留引用", legacyHits.slice(0, 5).join("、"));

console.log("\n— H. 同口径：衣服/武器变换走同一套代码 —");
check(/private clothTransform: OutTransform \| null/.test(appearanceSource), "RoleAppearance 持有 clothTransform: OutTransform | null");
check(/private weaponTransform: OutTransform \| null/.test(appearanceSource), "RoleAppearance 持有 weaponTransform: OutTransform | null");
check(/applyOutTransform\(node: Node, transform: OutTransform \| null\)/.test(appearanceSource), "applyOutTransform 参数类型是 OutTransform（装备与默认外观共用）");
check(!/this\.clothEquipment|this\.weaponEquipment/.test(appearanceSource), "旧的 Equipment 型字段已清干净（改用 OutTransform）");
check(/this\.clothTransform = cloth \?\? fallback;/.test(appearanceSource), "有衣服用装备变换，没衣服用默认外观变换");
check(/applyOutTransform\(this\.cloth, this\.clothTransform\)/.test(appearanceSource), "play 里应用的是 clothTransform（换向时默认外观也跟着走）");

finish("PASS：默认外观按性别分表（男 role/1、女 role/2），未知性别回落男性，素材按帧号基准全部可切，接线与旧常量清除均一致。");

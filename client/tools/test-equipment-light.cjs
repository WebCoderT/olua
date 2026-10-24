#!/usr/bin/env node
/**
 * 装备光柱单测（client/tools/test-equipment-light.cjs）
 *
 * 盯的不变量（加/改光柱后必须全绿）：
 * · 资源表与磁盘一致（resources/effect/light 下每个光柱图集都登记、登记的每个都真实存在、key 唯一）
 * · 前缀 5 档全覆盖、恰好一次，且按强度升序取 1~5 号光柱
 * · 6 号光柱**未被前缀表占用**（预留给特殊装备手动添加）
 * · 取用优先级：自定义表（精确 id → 基础件 key）→ 前缀表 → 不显示；自定义指向未登记光柱时回退前缀表
 * · 全部装备都能取到光柱（掉落物不会出现「有的装备没光柱」）
 * · 素材守卫：每个光柱的 plist 图集与同名 png 成对存在、帧号连续无缺口、plist 画布尺寸 == PNG 尺寸
 *   —— 打包时逐帧 alpha 裁剪并以 spriteOffset 保留回贴位置，播放画面与原逐帧版一致（见 #216）
 * · 接线：唯一挂点在掉落物零件、光柱排在图标之前（画在图标下层）、图集循环播放、进图前预加载
 *
 * 数据层跑在沙箱里（真实的 configs/light + equipments + items，见 lib/configs-sandbox.cjs），
 * 素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const LIGHT_DIR = path.join(PROJECT_ROOT, "assets/resources/effect/light");
const PREFIX_COUNT = 5;
const LIGHT_COUNT = 6;
/** 预留光柱（留给特殊装备手动添加，不参与前缀映射） */
const RESERVED_LIGHT = "light/6";

let outDir;
try {
  outDir = prepare("olua-equipment-light", ["configs/light.ts", "ui/utils/animation/FrameOrder.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}

const { lightResources, lights, prefixLights, customEquipmentLights, getEquipmentLightKey, getAssignedLights } = require(path.join(outDir, "configs/light.js"));
const { EQUIPMENT_PREFIX, isEquipment } = require(path.join(outDir, "types/good.js"));
const { getItemsByType } = require(path.join(outDir, "configs/items.js"));
const { getFrameIndex } = require(path.join(outDir, "ui/utils/animation/FrameOrder.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const gameUiSource = read("assets/ui/helpers/GameUiHelper.ts");
const preloadSource = read("assets/ui/core/PreloadManager.ts");
const lightSource = read("assets/configs/light.ts");
const layoutSource = read("assets/configs/layout/lights.ts");
const barrelSource = read("assets/configs/hudLayout.ts");

/** PNG 尺寸（IHDR：宽高在固定偏移 16/20，大端 uint32） */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

console.log("\n— A. 光柱资源表与磁盘 —");
const diskAtlases = fs
  .readdirSync(LIGHT_DIR)
  .filter((name) => /^light_\d+\.plist$/.test(name))
  .map((name) => Number(name.match(/^light_(\d+)\.plist$/)[1]))
  .sort((a, b) => a - b);
check(diskAtlases.length === LIGHT_COUNT, `磁盘有 ${LIGHT_COUNT} 个光柱图集`, `实际 ${diskAtlases.length}：${diskAtlases.join("、")}`);
check(lightResources.length === diskAtlases.length, `资源表数量与磁盘一致（${lightResources.length} 个）`);
check(
  JSON.stringify(lightResources.map((r) => r.key)) === JSON.stringify(diskAtlases.map((serial) => `light/${serial}`)),
  "资源表与磁盘图集一一对应（无多登 / 漏登 / 写错编号）",
);
check(new Set(lightResources.map((r) => r.key)).size === lightResources.length, "光柱 key 唯一");
check(lightResources.every((r) => r.atlas === `effect/light/light_${r.key.split("/")[1]}`), "atlas 路径 = effect/light/light_<编号>（resources 加载口径）");
check(
  lightResources.every((r) => fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${r.atlas}.plist`)) && fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${r.atlas}.png`))),
  "登记的每个光柱图集（plist + png）都真实存在",
);
check(lights.size === lightResources.length, "key → 资源 Map 与资源表等长");

console.log("\n— B. 前缀映射表（5 档全覆盖）—");
const prefixValues = Object.keys(EQUIPMENT_PREFIX)
  .map((name) => EQUIPMENT_PREFIX[name])
  .filter((value) => !Number.isNaN(Number(value)));
check(prefixValues.length === PREFIX_COUNT, `枚举里有 ${PREFIX_COUNT} 个前缀`, `实际 ${prefixValues.length}`);
check(prefixLights.size === PREFIX_COUNT, `前缀表恰好 ${PREFIX_COUNT} 条`, `实际 ${prefixLights.size}`);
prefixValues.forEach((prefix) => {
  check(prefixLights.has(prefix), `前缀 ${prefix} 已分配光柱`);
});
check(
  lightResources.every((r) => true) && lightResources.length === lights.size,
  "资源表与 Map 口径一致",
);
Array.from(prefixLights.keys()).forEach((prefix) => {
  const key = prefixLights.get(prefix);
  check(lights.has(key), `前缀 ${prefix} → ${key} 已在资源表登记`);
});
// 强度升序：前缀枚举值越大 → 光柱编号越大（越强的装备光柱越靠后）
const ordered = prefixValues.slice().sort((a, b) => Number(a) - Number(b));
const serials = ordered.map((prefix) => Number(prefixLights.get(prefix).split("/")[1]));
check(
  serials.every((serial, index) => index === 0 || serial > serials[index - 1]),
  "前缀越强光柱编号越大（强度升序取 1~5 号）",
  ordered.map((prefix, index) => `${prefix}→${serials[index]}`).join("、"),
);
check(serials[0] === 1 && serials[serials.length - 1] === PREFIX_COUNT, `前缀表用的是 1~${PREFIX_COUNT} 号光柱`, serials.join("、"));

console.log("\n— C. 6 号光柱预留 —");
const assignedKeys = new Set(Array.from(prefixLights.values()));
check(!assignedKeys.has(RESERVED_LIGHT), `${RESERVED_LIGHT} 未被前缀表占用（预留）`);
check(assignedKeys.size === PREFIX_COUNT, `前缀表用到 ${PREFIX_COUNT} 个不同光柱（无重复占用）`);
check(lightResources.length - assignedKeys.size === LIGHT_COUNT - PREFIX_COUNT, "恰好 1 个光柱未被前缀表使用（就是预留那个）");
check(customEquipmentLights.size === 0, "自定义光柱表当前为空（预留待特殊装备手动添加）");
check(/customEquipmentLightData/.test(lightSource) && /equipment:[\s\S]{0,40}light:/.test(lightSource), "自定义表结构已就位（写一条即生效）");
{
  // 只截前缀表那一段（到 Map 建立为止）：预留光柱只能出现在自定义表的示例里
  const prefixTableSource = lightSource.slice(lightSource.indexOf("const prefixLightData"), lightSource.indexOf("prefixLights = new Map"));
  check(prefixTableSource.length > 0 && !/light\/6/.test(prefixTableSource), "前缀表实现里没有硬塞 6 号光柱（预留只留给自定义表）");
}

console.log("\n— D. 取用逻辑（优先级与回退）—");
const equipments = getItemsByType("equipment");
check(equipments.length > 0, "能取到装备总表", `${equipments.length} 件`);
const missing = equipments.filter((equipment) => !getEquipmentLightKey(equipment));
check(missing.length === 0, "全部装备都能取到光柱（没有「有的装备落在地上没光柱」）", missing.slice(0, 5).map((e) => e.id).join("、"));
check(equipments.every((equipment) => prefixLights.get(equipment.prefix) === getEquipmentLightKey(equipment)), "取到的光柱 = 该装备前缀对应的光柱");
check(getEquipmentLightKey(null) === null, "传 null 返回 null（不显示）");
check(getEquipmentLightKey(undefined) === null, "传 undefined 返回 null（不显示）");

// 自定义表：精确 id 优先；改完立刻还原，避免污染后续断言
const sample = equipments.find((equipment) => equipment.id);
const baseKey = sample.id.split("_p")[0];
const originalPrefixKey = getEquipmentLightKey(sample);
customEquipmentLights.set(sample.id, RESERVED_LIGHT);
check(getEquipmentLightKey(sample) === RESERVED_LIGHT, "写自定义表（精确 id）后优先级高于前缀表");
customEquipmentLights.delete(sample.id);
check(getEquipmentLightKey(sample) === originalPrefixKey, "删掉自定义条目后回到前缀表");
customEquipmentLights.set(baseKey, RESERVED_LIGHT);
const variant = equipments.find((equipment) => equipment.id !== baseKey && equipment.id.startsWith(`${baseKey}_p`));
check(!!variant && getEquipmentLightKey(variant) === RESERVED_LIGHT, "写基础件 key → 该装备的全部变体都生效");
customEquipmentLights.delete(baseKey);
check(getEquipmentLightKey(sample) === originalPrefixKey, "还原后回到前缀表");
customEquipmentLights.set(sample.id, "light/99");
check(getEquipmentLightKey(sample) === originalPrefixKey, "自定义指向未登记光柱 → 回退前缀表（不显示为空）");
customEquipmentLights.delete(sample.id);

console.log("\n— E. 素材守卫（图集成对 / 帧号连续 / 画布口径一致）—");
const frameStats = [];
/** 解析 cocos2d-v3 plist（XML）：提取 frames 帧名列表 + metadata 的 textureFileName/textureSize */
function parsePlist(file) {
  const xml = fs.readFileSync(file, "utf8");
  const framesSection = xml.slice(xml.indexOf("<key>frames</key>"), xml.indexOf("<key>metadata</key>"));
  const frameNames = Array.from(framesSection.matchAll(/<key>([A-Za-z0-9_.\\/]+\.png)<\/key>\s*<dict>/g)).map((m) => m[1]);
  const metaSection = xml.slice(xml.indexOf("<key>metadata</key>"));
  const pick = (key) => {
    const m = metaSection.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`));
    return m ? m[1] : null;
  };
  return {
    frameNames,
    textureFileName: pick("textureFileName"),
    textureSize: pick("size"),
    sourceSizes: Array.from(framesSection.matchAll(/<key>spriteSourceSize<\/key>\s*<string>\{([^}]+)\}<\/string>/g)).map((m) => m[1]),
  };
}
lightResources.forEach((resource) => {
  const plistPath = path.join(PROJECT_ROOT, "assets/resources", `${resource.atlas}.plist`);
  const pngPath = path.join(PROJECT_ROOT, "assets/resources", `${resource.atlas}.png`);
  const plist = parsePlist(plistPath);
  const frames = plist.frameNames;
  check(frames.length > 0, `${resource.key} 图集里有帧`, `${frames.length} 帧`);

  // 帧号连续无缺口（帧名保留源目录的 5 位数字命名）
  const indexes = frames.map((name) => getFrameIndex(name.split("/").pop())).filter((index) => index !== null);
  check(indexes.length === frames.length, `${resource.key} 每个帧名都能解析出帧号`);
  const sorted = indexes.slice().sort((a, b) => a - b);
  check(
    sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length,
    `${resource.key} 帧号连续无缺口（缺帧会少画面）`,
    `${sorted[0]}~${sorted[sorted.length - 1]} 共 ${sorted.length}`,
  );

  // plist 画布口径与 PNG 一致（textureFileName 与 png 同名）
  const size = pngSize(pngPath);
  check(
    plist.textureFileName === `${resource.atlas.split("/").pop()}.png`,
    `${resource.key} textureFileName 与 png 同名`,
    plist.textureFileName,
  );
  const [textureW, textureH] = (plist.textureSize || "").replace(/[{}]/g, "").split(",").map(Number);
  check(
    textureW === size.width && textureH === size.height,
    `${resource.key} plist 画布尺寸 == PNG 尺寸`,
    `${plist.textureSize} vs ${size.width}×${size.height}`,
  );
  // 每帧的 spriteSourceSize（原始画布）一致，回贴位置由 spriteOffset 保留（播放画面与原逐帧版一致）
  const sourceSizes = new Set(plist.sourceSizes);
  check(sourceSizes.size === 1, `${resource.key} 各帧原始画布一致（${Array.from(sourceSizes).join("、")}）`);
  frameStats.push({ key: resource.key, count: frames.length });
});
console.log("      帧数一览：");
frameStats.forEach((stat) => console.log(`        ${stat.key.padEnd(10, " ")} ${stat.count} 帧`));

console.log("\n— F. 接线：挂点唯一、画在图标下层、循环播放、预加载 —");
check(/this\.applyEquipmentLight\(node, good\)/.test(gameUiSource), "掉落物零件里挂了装备光柱（唯一挂点）");
{
  // 层级：光柱必须在图标之前 addChild（同一父节点下排在前面的画在下层）
  const createDropItem = gameUiSource.slice(gameUiSource.indexOf("static createDropItem"), gameUiSource.indexOf("static createDropNameRow"));
  const lightIndex = createDropItem.indexOf("applyEquipmentLight");
  const iconIndex = createDropItem.indexOf("node.addChild(icon)");
  check(lightIndex >= 0 && iconIndex >= 0 && lightIndex < iconIndex, "光柱在图标之前挂载（画在图标下层，物品本身清晰可辨）");
}
check(/if \(!isEquipment\(good\)\) return;/.test(gameUiSource.slice(gameUiSource.indexOf("static applyEquipmentLight"), gameUiSource.indexOf("static createEquipmentLight"))), "非装备不挂光柱");
check(/playLoopAtlas\(/.test(gameUiSource.slice(gameUiSource.indexOf("static applyEquipmentLight"), gameUiSource.indexOf("static createEquipmentLight"))), "光柱用图集循环播放（playLoopAtlas）");
check(/equipmentLightLayout\.frameRate/.test(gameUiSource), "帧率走 configs/layout/lights（界面不写死）");
check(/equipmentLightLayout\.size/.test(gameUiSource) && /equipmentLightLayout\.namePrefix/.test(gameUiSource), "尺寸与节点名前缀走 configs/layout/lights");
{
  const createLight = gameUiSource.slice(gameUiSource.indexOf("static createEquipmentLight"), gameUiSource.indexOf("static createEquipmentLight") + 600);
  check(!/trim\s*=\s*true/.test(createLight), "光柱没有把 trim 改成 true（这批素材 trim=true 会帧间抖动）");
  check(!/Sprite\.SizeMode\.RAW/.test(createLight), "光柱用固定尺寸（CUSTOM），不按素材原始尺寸撑开");
}
check(/getEquipmentLightKey\(good\)/.test(gameUiSource) && /lights\.get\(lightKey\)/.test(gameUiSource), "取用走 configs/light 的映射表");
check(!/"effect\/light/.test(gameUiSource), "界面里没有硬编码光柱素材路径（路径只出现在 configs/light）");
check(/getAssignedLights/.test(preloadSource) && /preloadLights/.test(preloadSource), "PreloadManager 预留了光柱预加载");
check(/await this\.preloadLights\(\)/.test(preloadSource), "进图流程里调用了光柱预加载（掉落物一生成光柱就在）");
const assigned = getAssignedLights();
check(assigned.length === PREFIX_COUNT, `预加载口径 = 前缀表用到的 ${PREFIX_COUNT} 个光柱`, `实际 ${assigned.length}`);
check(
  assigned.every((resource) => fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${resource.atlas}.plist`)) && fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${resource.atlas}.png`))),
  "预加载的每个光柱图集（plist + png）都真实存在",
);
check(assigned.every((resource) => !assignedKeys.has(RESERVED_LIGHT) || resource.key !== RESERVED_LIGHT), "预留光柱不进常规预加载（用到时再按需加载）");
check(/export const equipmentLightLayout/.test(layoutSource), "configs/layout/lights 导出显示口径");
check(/export \* from "\.\/layout\/lights"/.test(barrelSource) && /layout\/lights\.ts/.test(barrelSource), "hudLayout barrel 登记了 lights 布局（统一入口）");

finish("PASS：光柱资源表与磁盘一致、前缀 5 档全覆盖、6 号预留未占用、取用与回退正确、素材与接线口径一致。");

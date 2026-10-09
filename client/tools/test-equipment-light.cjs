#!/usr/bin/env node
/**
 * 装备光柱单测（client/tools/test-equipment-light.cjs）
 *
 * 盯的不变量（加/改光柱后必须全绿）：
 * · 资源表与磁盘一致（resources/effect/light 下每个目录都登记、登记的每个都真实存在、key 唯一）
 * · 前缀 5 档全覆盖、恰好一次，且按强度升序取 1~5 号光柱
 * · 6 号光柱**未被前缀表占用**（预留给特殊装备手动添加）
 * · 取用优先级：自定义表（精确 id → 基础件 key）→ 前缀表 → 不显示；自定义指向未登记光柱时回退前缀表
 * · 全部装备都能取到光柱（掉落物不会出现「有的装备没光柱」）
 * · 素材守卫：目录内帧号连续无缺口、每帧尺寸一致；meta 与 PNG 同口径（raw 尺寸 == PNG 尺寸）
 *   —— 这条是 trim=false 的前提（这批帧 auto-trim 真裁剪 + 非 0 offset，trim=true 会帧间抖动）
 * · 接线：唯一挂点在掉落物零件、光柱排在图标之前（画在图标下层）、目录循环播放、进图前预加载
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
const diskDirs = fs
  .readdirSync(LIGHT_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort((a, b) => Number(a) - Number(b));
check(diskDirs.length === LIGHT_COUNT, `磁盘有 ${LIGHT_COUNT} 个光柱目录`, `实际 ${diskDirs.length}：${diskDirs.join("、")}`);
check(lightResources.length === diskDirs.length, `资源表数量与磁盘一致（${lightResources.length} 个）`);
check(
  JSON.stringify(lightResources.map((r) => r.key)) === JSON.stringify(diskDirs.map((dir) => `light/${dir}`)),
  "资源表与磁盘目录一一对应（无多登 / 漏登 / 写错编号）",
);
check(new Set(lightResources.map((r) => r.key)).size === lightResources.length, "光柱 key 唯一");
check(lightResources.every((r) => r.dir === `effect/light/${r.key.split("/")[1]}`), "dir 路径 = effect/light/<编号>（resources 加载口径）");
check(lightResources.every((r) => fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", r.dir))), "登记的每个光柱目录都真实存在");
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

console.log("\n— E. 素材守卫（帧号连续 / 尺寸一致 / meta 与 PNG 同口径）—");
const frameStats = [];
lightResources.forEach((resource) => {
  const dirPath = path.join(PROJECT_ROOT, "assets/resources", resource.dir);
  const pngs = fs
    .readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort();
  const indexes = pngs.map((name) => getFrameIndex(name)).filter((index) => index !== null);
  check(indexes.length === pngs.length, `${resource.key} 每个帧名都能解析出帧号`);
  const sorted = indexes.slice().sort((a, b) => a - b);
  check(
    sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length,
    `${resource.key} 帧号连续无缺口（缺帧会少画面、空帧占位会报导入错误）`,
    `${sorted[0]}~${sorted[sorted.length - 1]} 共 ${sorted.length}`,
  );
  const sizes = pngs.map((name) => pngSize(path.join(dirPath, name)));
  const first = sizes[0];
  check(sizes.every((size) => size.width === first.width && size.height === first.height), `${resource.key} 各帧尺寸一致`, `${first.width}×${first.height}`);

  // meta 口径：导入成功 + 子资源齐 + 原始画布尺寸 == PNG 尺寸
  // （auto-trim 真裁剪 + 非 0 offset 的这一类素材，必须 trim=false 才不会帧间抖动）
  const badMetas = [];
  let trimmedFrames = 0;
  pngs.forEach((name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dirPath, `${name}.meta`), "utf8"));
    const spriteFrame = meta.subMetas && meta.subMetas.f9941 ? meta.subMetas.f9941 : null;
    const size = pngSize(path.join(dirPath, name));
    const data = spriteFrame ? spriteFrame.userData : null;
    if (!meta.imported || !data || data.rawWidth !== size.width || data.rawHeight !== size.height) badMetas.push(name);
    if (data && data.trimType === "auto" && (data.width !== data.rawWidth || data.height !== data.rawHeight)) trimmedFrames++;
  });
  check(badMetas.length === 0, `${resource.key} 全部帧导入成功且 meta 原始画布 == PNG 尺寸`, badMetas.slice(0, 5).join("、"));
  check(trimmedFrames > 0, `${resource.key} 属于 auto-trim 真裁剪素材（${trimmedFrames} 帧被裁剪）→ 显示口径必须 trim=false`);
  frameStats.push({ key: resource.key, count: pngs.length, trimmed: trimmedFrames });
});
console.log("      帧数一览（括号内为被裁剪的帧数）：");
frameStats.forEach((stat) => console.log(`        ${stat.key.padEnd(10, " ")} ${stat.count} 帧（${stat.trimmed} 帧裁剪）`));

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
check(/playLoopDir\(/.test(gameUiSource.slice(gameUiSource.indexOf("static applyEquipmentLight"), gameUiSource.indexOf("static createEquipmentLight"))), "光柱用目录帧循环播放（playLoopDir）");
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
check(assigned.every((resource) => fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", resource.dir))), "预加载的每个光柱目录都真实存在");
check(assigned.every((resource) => !assignedKeys.has(RESERVED_LIGHT) || resource.key !== RESERVED_LIGHT), "预留光柱不进常规预加载（用到时再按需加载）");
check(/export const equipmentLightLayout/.test(layoutSource), "configs/layout/lights 导出显示口径");
check(/export \* from "\.\/layout\/lights"/.test(barrelSource) && /layout\/lights\.ts/.test(barrelSource), "hudLayout barrel 登记了 lights 布局（统一入口）");

finish("PASS：光柱资源表与磁盘一致、前缀 5 档全覆盖、6 号预留未占用、取用与回退正确、素材与接线口径一致。");

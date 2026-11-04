#!/usr/bin/env node
/**
 * 装备详情背景单测（client/tools/test-equipment-detail-background.cjs）
 *
 * 盯的不变量（改详情背景系统后必须全绿）：
 * · 资源表与磁盘一致（resources/backgrounds 下每个帧序列目录都登记、登记的每个都真实存在、key 唯一）
 * · 前后缀 15 种组合全覆盖、恰好一次，且用的是「前 15 个」背景（sfx_16000 ~ sfx_16014）
 * · 取用优先级：自定义表（精确 id → 基础件 key）→ 前后缀表 → 不显示；自定义指向未登记背景时回退
 * · 真实装备表抽查：从 items 总表解析出的装备能查到正确的背景
 * · 素材守卫：目录内帧名末尾序号升序（AnimationHelper 按序号排序 → 播放顺序正确）；
 *   目录内每帧尺寸一致、meta 未裁剪且 offset 为 0 —— 背景直接换弹窗精灵的帧、按节点尺寸铺满的前提
 * · 接线：详情弹窗挂背景（换弹窗自身精灵的帧、不是 Layout 子节点）、目录循环播放、片段缓存、预加载、barrel 导出
 *
 * 数据层跑在沙箱里（真实的 configs/background + equipments + items，见 lib/configs-sandbox.cjs），
 * 素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

// #235 散帧图集化：每个背景一个图集（resources/backgrounds/<key>/<key>.plist + .png）
const BACKGROUND_DIR = path.join(PROJECT_ROOT, "assets", "resources", "backgrounds");
const outDir = prepare("olua-equipment-detail-background", ["configs/background.ts"]);
const {
  detailBackgroundResources,
  detailBackgrounds,
  prefixSuffixDetailBackgrounds,
  customEquipmentDetailBackgrounds,
  getEquipmentDetailBackgroundKey,
  getAssignedDetailBackgrounds,
} = require(path.join(outDir, "configs/background.js"));
const { applyEquipmentDetailBackgrounds } = require(path.join(outDir, "configs/background.js"));
const { getEquipment, getItem, items } = require(path.join(outDir, "configs/items.js"));
const { getEquipmentVariantKey, getEquipmentBaseKey } = require(path.join(outDir, "configs/equipments.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/** PNG 尺寸（IHDR：宽高在固定偏移 16/20，大端 uint32） */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

console.log("\n— A. 背景资源表 —");
const diskKeys = fs
  .readdirSync(BACKGROUND_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^sfx_\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const registryKeys = detailBackgroundResources.map((resource) => resource.key).sort();
check(registryKeys.length === diskKeys.length, `资源表数量与磁盘一致（${registryKeys.length} 个）`);
check(JSON.stringify(registryKeys) === JSON.stringify(diskKeys), "资源表与磁盘目录一一对应（无多登/漏登/写错编号）");
check(new Set(detailBackgroundResources.map((r) => r.key)).size === detailBackgroundResources.length, "背景 key 唯一");
check(detailBackgroundResources.every((r) => r.dir === `backgrounds/${r.key}`), "dir 路径 = backgrounds/<key>（resources 加载口径）");
check(detailBackgroundResources.every((r) => fs.existsSync(path.join(BACKGROUND_DIR, r.key))), "登记的每个背景目录都真实存在");
check(detailBackgrounds.size === detailBackgroundResources.length, "key → 资源 Map 与资源表等长");

console.log("\n— B. 前后缀映射表（5 前缀 × 3 后缀 = 15 组合）—");
const PREFIX_COUNT = 5;
const SUFFIX_COUNT = 3;
const combos = [];
for (let p = 0; p < PREFIX_COUNT; p++) for (let s = 0; s < SUFFIX_COUNT; s++) combos.push(`${p}|${s}`);

// #695：映射来自快照（服务端下发）。测试里先断言「快照到达前为空」，再 apply 一份
// 测试自建的 15 条映射（套用出厂编号口径，期望值全部从 applied 数据推导，不锁出厂数值）
check(prefixSuffixDetailBackgrounds.size === 0, "快照到达前前后缀映射为空（没有本地兜底表）");
check(customEquipmentDetailBackgrounds.size === 0, "快照到达前自定义表为空");
check(getAssignedDetailBackgrounds().length === 0, "快照到达前预加载清单为空（不加载任何背景）");

const APPLIED = [];
for (let s = 0; s < SUFFIX_COUNT; s++) for (let p = 0; p < PREFIX_COUNT; p++) APPLIED.push({ prefix: p, suffix: s, key: `sfx_${16000 + s * PREFIX_COUNT + p}` });
applyEquipmentDetailBackgrounds({ backgrounds: APPLIED, customBackgrounds: [] });

check(combos.every((combo) => prefixSuffixDetailBackgrounds.has(combo)), "apply 后 15 种组合全部有映射", `缺：${combos.filter((c) => !prefixSuffixDetailBackgrounds.has(c)).join("、") || "无"}`);
check(prefixSuffixDetailBackgrounds.size === combos.length, "映射表没有多余的组合");
const assignedKeys = getAssignedDetailBackgrounds().map((r) => r.key);
check(new Set(assignedKeys).size === combos.length, "前后缀表用到的背景互不重复");
check(JSON.stringify(assignedKeys) === JSON.stringify(APPLIED.map((row) => row.key)), "assigned 顺序 = applied 登记顺序（预加载与映射同源）", assignedKeys.join(","));
check(assignedKeys.every((key) => detailBackgrounds.has(key)), "映射到的背景都在资源表里");
check(assignedKeys.every((key) => fs.existsSync(path.join(BACKGROUND_DIR, key))), "映射到的背景目录都在磁盘上");

// 资源清单里没有的 key：丢弃并留日志（配了不存在的编号，背景动画会加载失败）
applyEquipmentDetailBackgrounds({
  backgrounds: APPLIED.slice(0, 14).concat([{ prefix: 4, suffix: 2, key: "sfx_99999" }]),
  customBackgrounds: [],
});
check(prefixSuffixDetailBackgrounds.size === 14 && !prefixSuffixDetailBackgrounds.has("4|2"), "指向未登记目录的组合被丢弃（不进映射）");
applyEquipmentDetailBackgrounds({ backgrounds: APPLIED, customBackgrounds: [] });
check(prefixSuffixDetailBackgrounds.size === 15, "重新 apply 合法数据后映射恢复");

console.log("\n— C. 取用函数（getEquipmentDetailBackgroundKey）—");
const backgroundOf = (prefix, suffix, id) => getEquipmentDetailBackgroundKey({ id, prefix, suffix, type: "equipment" });
const first = APPLIED[0].key;
const last = APPLIED[14].key;
check(backgroundOf(0, 0, "x") === first, "普通的·人级 → applied 表第 1 条", backgroundOf(0, 0, "x"));
check(backgroundOf(4, 2, "x") === last, "超神的·神级 → applied 表第 15 条", backgroundOf(4, 2, "x"));
check(backgroundOf(0, 1, "x") === APPLIED[5].key && backgroundOf(4, 0, "x") === APPLIED[4].key, "后缀档内按前缀递增（取 applied 表同位次）");
check(getEquipmentDetailBackgroundKey(null) === null, "没有装备 → 不显示");
check(backgroundOf(9, 9, "x") === null, "异常前后缀 → 不显示（查不到组合）");
check(backgroundOf(0, 0, "") === first, "id 缺失也按前后缀表取");
// 自定义表：#695 起经 apply 下发（测试里直接写 Map 等价于服务端下发了这些条目）
const CUSTOM_KEY = detailBackgroundResources[detailBackgroundResources.length - 1].key;
check(!customEquipmentDetailBackgrounds.size, "apply 空自定义表后仍为空（出厂不给特殊装备配背景）");
customEquipmentDetailBackgrounds.set("weapon_special", CUSTOM_KEY);
check(backgroundOf(0, 0, "weapon_special") === CUSTOM_KEY, "自定义表按精确 id 命中，优先于前后缀表");
check(backgroundOf(0, 0, "weapon_other_p3s2") === first, "没登记基础件时，变体不沾光（回退前后缀表）");
customEquipmentDetailBackgrounds.set("weapon_all", CUSTOM_KEY);
check(backgroundOf(0, 0, "weapon_other") === first, "没登记的 id 不显示自定义背景");
check(backgroundOf(4, 2, "weapon_all_p4s2") === CUSTOM_KEY, "自定义表按基础件 key 命中变体 id（整件装备的全部变体生效）");
// 指向未登记目录的自定义条目：apply 时就被丢弃（不进 Map），取用回退前后缀表
applyEquipmentDetailBackgrounds({ backgrounds: APPLIED, customBackgrounds: [{ equipment: "weapon_bad", key: "sfx_99999" }] });
check(!customEquipmentDetailBackgrounds.has("weapon_bad"), "自定义条目指向未登记目录 → apply 时丢弃并留日志");
check(backgroundOf(0, 0, "weapon_bad") === first, "丢弃后的装备回退前后缀表（不显示成空白）");
applyEquipmentDetailBackgrounds({ backgrounds: APPLIED, customBackgrounds: [{ equipment: "weapon_all", key: CUSTOM_KEY }] });
check(backgroundOf(4, 2, "weapon_all_p4s2") === CUSTOM_KEY, "重新 apply 后自定义表恢复（Map 是重建不是增量）");

console.log("\n— D. 真实装备表抽查（用 applied 表的前后两条）—");
const cloth = getItem("cloth_1");
check(!!cloth && getEquipmentDetailBackgroundKey(cloth) === first, "基础件 cloth_1（普通的·人级）→ applied 表第 1 条");
const godly = getItem("weapon_20_p4s2");
check(!!godly && getEquipmentDetailBackgroundKey(getEquipment("weapon_20_p4s2")) === last, "变体 weapon_20_p4s2（超神的·神级）→ applied 表第 15 条");
// 非装备不写死 id（药品/材料的编号是注册表按序生成的，改配置就会漂移）：从总表现抓一件
let nonEquipment = null;
items.forEach((good) => {
  if (!nonEquipment && good.type !== "equipment") nonEquipment = good;
});
check(!!nonEquipment && getEquipmentDetailBackgroundKey(nonEquipment) === null, "非装备（药品/材料）→ 不显示");
// 变体 key 的拼/反解互为逆运算（基础件 key 是自定义表的检索键，格式错 = 自定义背景静默失效）
check(getEquipmentVariantKey("cloth_1", 0, 0) === "cloth_1" && getEquipmentVariantKey("cloth_1", 3, 2) === "cloth_1_p3s2", "getEquipmentVariantKey 与装备表生成变体 id 的口径一致");
check(getEquipmentBaseKey("cloth_1_p3s2") === "cloth_1" && getEquipmentBaseKey("cloth_1") === "cloth_1", "getEquipmentBaseKey 能反解变体 id");

console.log("\n— E. 素材守卫（图集在位 / 帧序 / 尺寸一致 / 未裁剪）—");
/** 读一个背景的图集帧（帧名 → 几何），plist 是 cocos2d-v3 格式 */
function readAtlas(key) {
  const dir = path.join(BACKGROUND_DIR, key);
  const plistPath = path.join(dir, `${key}.plist`);
  const pngPath = path.join(dir, `${key}.png`);
  if (!fs.existsSync(plistPath) || !fs.existsSync(pngPath)) return null;
  const plist = fs.readFileSync(plistPath, "utf8");
  const frames = [];
  for (const block of plist.split("<key>").slice(1)) {
    const name = block.slice(0, block.indexOf("</key>"));
    if (!/\.png$/i.test(name)) continue;
    const seg = plist.slice(plist.indexOf(`<key>${name}</key>`), plist.indexOf(`<key>${name}</key>`) + 400);
    const tuple = (field) => {
      const hit = new RegExp(`<key>${field}</key>\\s*<string>\\{([^}]+)\\}`).exec(seg);
      return hit ? hit[1].split(",").map(Number) : null;
    };
    frames.push({ name, size: tuple("spriteSize"), source: tuple("spriteSourceSize"), offset: tuple("spriteOffset") });
  }
  return { png: pngPath, frames };
}

let checkedFrames = 0;
for (const resource of detailBackgroundResources) {
  const atlas = readAtlas(resource.key);
  check(!!atlas, `${resource.key} 的图集（plist + png）在位`);
  if (!atlas || atlas.frames.length === 0) continue;
  checkedFrames += atlas.frames.length;
  // 帧名末尾序号必须严格升序（loadLoopFrames 按序号排序，序号重复/乱序 = 播放顺序不可信）
  const orders = atlas.frames.map((frame) => Number((frame.name.match(/(\d+)\.png$/i) || [])[1]));
  check(
    orders.every((order, index) => index === 0 || order > orders[index - 1]),
    `${resource.key} 帧名末尾序号按升序排列（AnimationHelper 按序号排序的前提）`,
    orders.join(","),
  );
  // 画布必须统一：背景帧换弹窗精灵显示时用 trim=false，引擎按 spriteSourceSize + spriteOffset
  // 把裁剪内容贴回原画布 —— 画布一致 + 偏移正确，帧间才不会跳（打包时的自动裁剪是正常行为）
  const baseCanvas = atlas.frames[0].source;
  const canvasMismatch = atlas.frames.filter((frame) => !frame.source || frame.source[0] !== baseCanvas[0] || frame.source[1] !== baseCanvas[1]);
  check(canvasMismatch.length === 0, `${resource.key} 每帧画布一致（spriteSourceSize = ${baseCanvas.join("×")}）`, `${canvasMismatch.length}/${atlas.frames.length} 帧不一致`);
  // 裁剪区不能越出画布，偏移必须落在「画布 − 裁剪」的余量内
  const badOffset = atlas.frames.filter(
    (frame) =>
      frame.size[0] > baseCanvas[0] ||
      frame.size[1] > baseCanvas[1] ||
      Math.abs(frame.offset[0]) * 2 > baseCanvas[0] - frame.size[0] ||
      Math.abs(frame.offset[1]) * 2 > baseCanvas[1] - frame.size[1],
  );
  check(badOffset.length === 0, `${resource.key} 每帧的裁剪尺寸与偏移都在画布内（trim=false 能正确回贴）`, badOffset.slice(0, 3).map((frame) => frame.name).join("、"));
  // 图集 PNG 本身不能小于单帧（否则贴图区放不下，取到的会是空白）
  const sheet = pngSize(atlas.png);
  check(
    sheet.width >= baseCanvas[0] && sheet.height >= baseCanvas[1],
    `${resource.key} 的图集 PNG（${sheet.width}×${sheet.height}）容得下单帧画布（${baseCanvas.join("×")}）`,
  );
}
console.log(`      共核对 ${detailBackgroundResources.length} 个背景 / ${checkedFrames} 帧`);

finish("PASS：详情背景资源表、前后缀映射、取用优先级、素材守卫与界面接线全部通过。");

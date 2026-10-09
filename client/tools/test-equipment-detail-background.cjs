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

const BACKGROUND_DIR = path.join(PROJECT_ROOT, "assets/resources/backgrounds");
const outDir = prepare("olua-equipment-detail-background", ["configs/background.ts"]);
const {
  detailBackgroundResources,
  detailBackgrounds,
  prefixSuffixDetailBackgrounds,
  customEquipmentDetailBackgrounds,
  getEquipmentDetailBackgroundKey,
  getAssignedDetailBackgrounds,
} = require(path.join(outDir, "configs/background.js"));
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
check(combos.every((combo) => prefixSuffixDetailBackgrounds.has(combo)), "15 种组合全部有映射", `缺：${combos.filter((c) => !prefixSuffixDetailBackgrounds.has(c)).join("、") || "无"}`);
check(prefixSuffixDetailBackgrounds.size === combos.length, "映射表没有多余的组合");
const assignedKeys = getAssignedDetailBackgrounds().map((r) => r.key);
check(new Set(assignedKeys).size === combos.length, "前后缀表用到的背景互不重复");
const first15 = Array.from({ length: PREFIX_COUNT * SUFFIX_COUNT }, (_, i) => `sfx_${16000 + i}`);
check(JSON.stringify(assignedKeys) === JSON.stringify(first15), "用的是「前 15 个」背景（sfx_16000 ~ sfx_16014）", assignedKeys.join(","));
check(assignedKeys.every((key) => detailBackgrounds.has(key)), "映射到的背景都在资源表里");
check(assignedKeys.every((key) => fs.existsSync(path.join(BACKGROUND_DIR, key))), "映射到的背景目录都在磁盘上");

console.log("\n— C. 取用函数（getEquipmentDetailBackgroundKey）—");
const backgroundOf = (prefix, suffix, id) => getEquipmentDetailBackgroundKey({ id, prefix, suffix, type: "equipment" });
check(backgroundOf(0, 0, "x") === "sfx_16000", "普通的·人级 → 第 1 个", backgroundOf(0, 0, "x"));
check(backgroundOf(4, 2, "x") === "sfx_16014", "超神的·神级 → 第 15 个", backgroundOf(4, 2, "x"));
check(backgroundOf(0, 1, "x") === "sfx_16005" && backgroundOf(4, 0, "x") === "sfx_16004", "天级档从第 6 个起、前缀在后缀档内递增");
check(getEquipmentDetailBackgroundKey(null) === null, "没有装备 → 不显示");
check(backgroundOf(9, 9, "x") === null, "异常前后缀 → 不显示（查不到组合）");
check(backgroundOf(0, 0, "") === "sfx_16000", "id 缺失也按前后缀表取");
// 自定义表（测试里临时写入，跑完清掉）
const ORIGINAL_BACKGROUND = "sfx_16040";
check(!customEquipmentDetailBackgrounds.size, "自定义表默认为空（特殊装备按需增补）");
customEquipmentDetailBackgrounds.set("weapon_special", ORIGINAL_BACKGROUND);
check(backgroundOf(0, 0, "weapon_special") === ORIGINAL_BACKGROUND, "自定义表按精确 id 命中，优先于前后缀表");
check(backgroundOf(0, 0, "weapon_other_p3s2") === "sfx_16000", "没登记基础件时，变体不沾光（回退前后缀表）");
customEquipmentDetailBackgrounds.set("weapon_all", ORIGINAL_BACKGROUND);
check(backgroundOf(0, 0, "weapon_other") === "sfx_16000", "没登记的 id 不显示自定义背景");
check(backgroundOf(4, 2, "weapon_all_p4s2") === ORIGINAL_BACKGROUND, "自定义表按基础件 key 命中变体 id（整件装备的全部变体生效）");
customEquipmentDetailBackgrounds.set("weapon_bad", "sfx_99999_0");
check(backgroundOf(0, 0, "weapon_bad") === "sfx_16000", "自定义背景未登记 → 回退前后缀表（不显示成空白）");
customEquipmentDetailBackgrounds.clear();
check(backgroundOf(4, 2, "weapon_all_p4s2") === "sfx_16014", "清空自定义表后回到前后缀表");

console.log("\n— D. 真实装备表抽查 —");
const cloth = getItem("cloth_1");
check(!!cloth && getEquipmentDetailBackgroundKey(cloth) === "sfx_16000", "基础件 cloth_1（普通的·人级）→ 第 1 个");
const godly = getItem("weapon_20_p4s2");
check(!!godly && getEquipmentDetailBackgroundKey(getEquipment("weapon_20_p4s2")) === "sfx_16014", "变体 weapon_20_p4s2（超神的·神级）→ 第 15 个");
// 非装备不写死 id（药品/材料的编号是注册表按序生成的，改配置就会漂移）：从总表现抓一件
let nonEquipment = null;
items.forEach((good) => {
  if (!nonEquipment && good.type !== "equipment") nonEquipment = good;
});
check(!!nonEquipment && getEquipmentDetailBackgroundKey(nonEquipment) === null, "非装备（药品/材料）→ 不显示");
// 变体 key 的拼/反解互为逆运算（基础件 key 是自定义表的检索键，格式错 = 自定义背景静默失效）
check(getEquipmentVariantKey("cloth_1", 0, 0) === "cloth_1" && getEquipmentVariantKey("cloth_1", 3, 2) === "cloth_1_p3s2", "getEquipmentVariantKey 与装备表生成变体 id 的口径一致");
check(getEquipmentBaseKey("cloth_1_p3s2") === "cloth_1" && getEquipmentBaseKey("cloth_1") === "cloth_1", "getEquipmentBaseKey 能反解变体 id");

console.log("\n— E. 素材守卫（帧序号 / 尺寸一致 / 未裁剪）—");
let fewest = null;
let checkedFrames = 0;
for (const resource of detailBackgroundResources) {
  const dir = path.join(BACKGROUND_DIR, resource.key);
  const pngs = fs.readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
  if (!pngs.length) {
    check(false, `${resource.key} 目录里有帧`);
    continue;
  }
  // 帧名末尾序号必须严格升序（loadFrames 按序号排序，序号重复/乱序 = 播放顺序不可信）
  const orders = pngs.map((name) => Number((name.match(/(\d+)\.png$/) || [])[1]));
  const sortedEverywhere = orders.every((order, index) => index === 0 || order > orders[index - 1]);
  if (!sortedEverywhere) {
    check(false, `${resource.key} 帧名末尾序号按升序排列（AnimationHelper 按序号排序的前提）`, orders.join(","));
  }
  // 目录内每帧尺寸必须一致（背景整包循环铺满同一个面板，忽大忽小会跳）
  const baseSize = pngSize(path.join(dir, pngs[0]));
  const mismatch = pngs.filter((name) => {
    const size = pngSize(path.join(dir, name));
    return size.width !== baseSize.width || size.height !== baseSize.height;
  });
  if (mismatch.length) {
    check(false, `${resource.key} 目录内每帧尺寸一致`, `${mismatch.length}/${pngs.length} 帧不是 ${baseSize.width}×${baseSize.height}`);
  }
  // meta 的原始画布必须与 PNG 实际尺寸一致，且目录内画布统一 —— 背景帧换弹窗精灵显示时
  // 用的是 trim=false（引擎按 offset 把裁剪内容贴回原始画布、帧间不跳），画布口径是唯一基准
  const canvasMismatch = pngs.filter((name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.meta`), "utf8"));
    const userData = Object.values(meta.subMetas).find((subMeta) => subMeta.importer === "sprite-frame")?.userData ?? {};
    return Number(userData.rawWidth) !== baseSize.width || Number(userData.rawHeight) !== baseSize.height;
  });
  if (canvasMismatch.length) {
    check(false, `${resource.key} 每帧 meta 原始画布与 PNG 尺寸一致（trim=false 对齐的前提）`, `${canvasMismatch.length}/${pngs.length} 帧画布不符`);
  }
  checkedFrames += pngs.length;
  if (!fewest || pngs.length < fewest.frames) fewest = { key: resource.key, frames: pngs.length };
}
check(!!fewest && fewest.frames >= 6, `每个背景至少 6 帧（最少的 ${fewest ? fewest.key : "?"} 有 ${fewest ? fewest.frames : 0} 帧）`);
check(true, `全部背景目录的帧序/尺寸/画布检查通过（${detailBackgroundResources.length} 个目录 × ${checkedFrames} 帧）`);

console.log("\n— F. 接线（源码断言）—");
const helperSource = read("assets/ui/helpers/GameUiHelper.ts");
const animationSource = read("assets/ui/helpers/AnimationHelper.ts");
const preloadSource = read("assets/ui/core/PreloadManager.ts");
const barrelSource = read("assets/configs/hudLayout.ts");
const borderConfigSource = read("assets/configs/border.ts");
const backgroundConfigSource = read("assets/configs/background.ts");

check(/this\.applyEquipmentDetailBackground\(dialog, good\);/.test(helperSource), "createGoodDetailDialog 给详情弹窗挂背景动画");
check(/static applyEquipmentDetailBackground\(dialog: Node, good: Goods\)/.test(helperSource), "挂背景是独立方法（与边框同一套守卫风格）");
check(/if \(!isEquipment\(good\)\) return;/.test(helperSource), "只有装备才挂背景");
check(/getEquipmentDetailBackgroundKey\(good\)/.test(helperSource) && /detailBackgrounds\.get\(backgroundKey\)/.test(helperSource), "背景 key 与帧目录都来自 configs/background");
check(/AnimationHelper\.playLoopDir\(/.test(helperSource), "播放走 AnimationHelper 的目录循环入口");
check(!/addChild\(.*[Bb]ackground/.test(helperSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").slice(helperSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").indexOf("static applyEquipmentDetailBackground"), helperSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").indexOf("static createGoodDetailDialog"))), "背景不是弹窗的子节点（换自身精灵的帧，不参与 Layout 排版）");

// 详情背景相关代码里不许写死手感数值（帧率全在 configs/layout/backgrounds）
// 注意：**先剥注释再切片**——直接切原文件的话，切片点落在一条多行注释中间时注释剥不掉，
// 注释里的中文会被当成「裸中文文案」（加长文档注释就会踩这个假警报）
const helperCode = helperSource.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const backgroundMethods = helperCode.slice(helperCode.indexOf("static applyEquipmentDetailBackground"), helperCode.indexOf("static createGoodDetailDialog"));
check(!/\b10\b/.test(backgroundMethods), "详情背景显示代码没有写死的帧率（走 equipmentDetailBackgroundLayout）");
check(!/[\u4e00-\u9fa5]/.test(backgroundMethods), "详情背景显示代码没有裸中文文案");

check(/loopClipCache/.test(animationSource) && /playLoopDir/.test(animationSource), "目录循环动画有独立入口且片段走缓存（反复悬停共用同一片段）");
check(/playLoopDir\(name: string, node: Node, dirSrc: string, frameRate: number\)/.test(animationSource), "playLoopDir 入参口径与 playLoopAtlas 一致（名称/节点/目录/帧率）");
check(/loadFrames\(dirSrc\)\.then\(\(spriteFrames\) => \{/.test(animationSource), "目录帧走 loadFrames 缓存（同一目录只向引擎请求一次）");

check(/preloadDetailBackgrounds/.test(preloadSource) && /getAssignedDetailBackgrounds\(\)/.test(preloadSource) && /loadFrames/.test(preloadSource), "进图前预加载前后缀映射表用到的背景目录");
check(/getAssignedDetailBackgrounds/.test(backgroundConfigSource) && /getAssignedBorders/.test(borderConfigSource), "边框与详情背景各自有独立的预加载清单函数（互不借用）");
check(/export \* from "\.\/layout\/backgrounds";/.test(barrelSource), "hudLayout barrel 导出详情背景显示配置");
const backgroundConfigCode = backgroundConfigSource.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const customDataBlock = backgroundConfigCode.slice(backgroundConfigCode.indexOf("customEquipmentDetailBackgroundData"));
check(!/\{ equipment:/.test(customDataBlock.slice(0, customDataBlock.indexOf("];"))), "自定义背景表默认无生效条目（剩下的 26 个背景留给特殊装备）");

finish("PASS：详情背景资源表、前后缀映射、取用优先级、素材守卫与界面接线全部通过。");

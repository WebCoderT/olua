#!/usr/bin/env node
/**
 * 装备边框单测（tools/test-equipment-border.cjs）
 *
 * 盯的不变量（改边框系统后必须全绿）：
 * · 资源表与磁盘一致（resources/borders 下每张图集都登记、登记的每张都真实存在、key 唯一）
 * · 前后缀 15 种组合全覆盖、恰好一次，且用的是「前 15 张」边框（sfx_30123_0 ~ sfx_30137_0）
 * · 取用优先级：自定义表（精确 id → 基础件 key）→ 前后缀表 → 不显示；自定义指向未登记边框时回退
 * · 真实装备表抽查：从 items 总表解析出的装备能查到正确的边框
 * · 素材守卫：帧名末尾序号升序（AnimationHelper 按序号排序 → 播放顺序正确）；
 *   每帧 rect 尺寸 == 原始尺寸（未裁剪）—— 显示层 trim=true + 按原始尺寸 contain 的前提
 * · 接线：createGood 挂边框（挂在图标上而非格子下）、trim=true、片段缓存、预加载、barrel 导出
 *
 * 数据层跑在沙箱里（真实的 configs/border + equipments + items，见 lib/configs-sandbox.cjs），
 * 素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const BORDER_DIR = path.join(PROJECT_ROOT, "assets/resources/borders");
const outDir = prepare("olua-equipment-border", ["configs/border.ts"]);
const { borderResources, borders, prefixSuffixBorders, customEquipmentBorders, getEquipmentBorderKey, getAssignedBorders } = require(path.join(outDir, "configs/border.js"));
const { getEquipment, getItem, items } = require(path.join(outDir, "configs/items.js"));
const { getEquipmentVariantKey, getEquipmentBaseKey } = require(path.join(outDir, "configs/equipments.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

console.log("\n— A. 边框资源表 —");
const diskKeys = fs
  .readdirSync(BORDER_DIR)
  .filter((name) => name.endsWith(".plist"))
  .map((name) => name.replace(/\.plist$/, ""))
  .sort();
const registryKeys = borderResources.map((resource) => resource.key).sort();
check(registryKeys.length === diskKeys.length, `资源表数量与磁盘一致（${registryKeys.length} 张）`);
check(JSON.stringify(registryKeys) === JSON.stringify(diskKeys), "资源表与磁盘文件一一对应（无多登/漏登/写错编号）");
check(new Set(borderResources.map((r) => r.key)).size === borderResources.length, "边框 key 唯一");
check(borderResources.every((r) => r.atlas === `borders/${r.key}`), "atlas 路径 = borders/<key>（resources 加载口径）");
check(borders.size === borderResources.length, "key → 资源 Map 与资源表等长");

console.log("\n— B. 前后缀映射表（5 前缀 × 3 后缀 = 15 组合）—");
const PREFIX_COUNT = 5;
const SUFFIX_COUNT = 3;
const combos = [];
for (let p = 0; p < PREFIX_COUNT; p++) for (let s = 0; s < SUFFIX_COUNT; s++) combos.push(`${p}|${s}`);
check(combos.every((combo) => prefixSuffixBorders.has(combo)), "15 种组合全部有映射", `缺：${combos.filter((c) => !prefixSuffixBorders.has(c)).join("、") || "无"}`);
check(prefixSuffixBorders.size === combos.length, "映射表没有多余的组合");
const assignedKeys = getAssignedBorders().map((r) => r.key);
check(new Set(assignedKeys).size === combos.length, "前后缀表用到的边框互不重复");
const first15 = Array.from({ length: PREFIX_COUNT * SUFFIX_COUNT }, (_, i) => `sfx_${30123 + i}_0`);
check(JSON.stringify(assignedKeys) === JSON.stringify(first15), "用的是「前 15 张」边框（sfx_30123_0 ~ sfx_30137_0）", assignedKeys.join(","));
check(assignedKeys.every((key) => borders.has(key)), "映射到的边框都在资源表里");

console.log("\n— C. 取用函数（getEquipmentBorderKey）—");
const borderOf = (prefix, suffix, id) => getEquipmentBorderKey({ id, prefix, suffix, type: "equipment" });
check(borderOf(0, 0, "x") === "sfx_30123_0", "普通的·人级 → 第 1 张", borderOf(0, 0, "x"));
check(borderOf(4, 2, "x") === "sfx_30137_0", "超神的·神级 → 第 15 张", borderOf(4, 2, "x"));
check(borderOf(0, 1, "x") === "sfx_30128_0" && borderOf(4, 0, "x") === "sfx_30127_0", "天级档从第 6 张起、前缀在后缀档内递增");
check(getEquipmentBorderKey(null) === null, "没有装备 → 不显示");
check(borderOf(9, 9, "x") === null, "异常前后缀 → 不显示（查不到组合）");
check(borderOf(0, 0, "") === "sfx_30123_0", "id 缺失也按前后缀表取");
// 自定义表（测试里临时写入，跑完清掉）
const ORIGINAL_BORDERS = "sfx_30206_0";
check(!customEquipmentBorders.size, "自定义表默认为空（特殊装备按需增补）");
customEquipmentBorders.set("weapon_special", ORIGINAL_BORDERS);
check(borderOf(0, 0, "weapon_special") === ORIGINAL_BORDERS, "自定义表按精确 id 命中，优先于前后缀表");
check(borderOf(0, 0, "weapon_other_p3s2") === "sfx_30123_0", "没登记基础件时，变体不沾光（回退前后缀表）");
customEquipmentBorders.set("weapon_all", ORIGINAL_BORDERS);
check(borderOf(0, 0, "weapon_other") === "sfx_30123_0", "没登记的 id 不显示自定义边框");
check(borderOf(4, 2, "weapon_all_p4s2") === ORIGINAL_BORDERS, "自定义表按基础件 key 命中变体 id（整件装备的全部变体生效）");
customEquipmentBorders.set("weapon_bad", "sfx_99999_0");
check(borderOf(0, 0, "weapon_bad") === "sfx_30123_0", "自定义边框未登记 → 回退前后缀表（不显示成空白）");
customEquipmentBorders.clear();
check(borderOf(4, 2, "weapon_all_p4s2") === "sfx_30137_0", "清空自定义表后回到前后缀表");

console.log("\n— D. 真实装备表抽查 —");
const cloth = getItem("cloth_1");
check(!!cloth && getEquipmentBorderKey(cloth) === "sfx_30123_0", "基础件 cloth_1（普通的·人级）→ 第 1 张");
const godly = getItem("weapon_20_p4s2");
check(!!godly && getEquipmentBorderKey(getEquipment("weapon_20_p4s2")) === "sfx_30137_0", "变体 weapon_20_p4s2（超神的·神级）→ 第 15 张");
// 非装备不写死 id（药品/材料的编号是注册表按序生成的，改配置就会漂移）：从总表现抓一件
let nonEquipment = null;
items.forEach((good) => {
  if (!nonEquipment && good.type !== "equipment") nonEquipment = good;
});
check(!!nonEquipment && getEquipmentBorderKey(nonEquipment) === null, "非装备（药品/材料）→ 不显示");
// 变体 key 的拼/反解互为逆运算（基础件 key 是自定义表的检索键，格式错 = 自定义边框静默失效）
check(getEquipmentVariantKey("cloth_1", 0, 0) === "cloth_1" && getEquipmentVariantKey("cloth_1", 3, 2) === "cloth_1_p3s2", "getEquipmentVariantKey 与装备表生成变体 id 的口径一致");
check(getEquipmentBaseKey("cloth_1_p3s2") === "cloth_1" && getEquipmentBaseKey("cloth_1") === "cloth_1", "getEquipmentBaseKey 能反解变体 id");

console.log("\n— E. 素材守卫（帧序号 / 未裁剪）—");
let worst = null;
for (const resource of borderResources) {
  const plist = path.join(BORDER_DIR, `${resource.key}.plist`);
  if (!fs.existsSync(plist)) {
    check(false, `${resource.key}.plist 存在`);
    continue;
  }
  const text = fs.readFileSync(plist, "utf8");
  const frames = [];
  const pattern = /<key>([^<]+\.png)<\/key>\s*<dict>(.*?)<\/dict>/gs;
  let match;
  while ((match = pattern.exec(text))) {
    const body = match[2];
    const frame = /<key>frame<\/key>\s*<string>\{\{(-?\d+),(-?\d+)\},\{(\d+),(\d+)\}\}<\/string>/.exec(body);
    const source = /<key>sourceSize<\/key>\s*<string>\{(\d+),(\d+)\}<\/string>/.exec(body);
    if (frame && source) frames.push({ name: match[1], w: Number(frame[3]), h: Number(frame[4]), sw: Number(source[1]), sh: Number(source[2]) });
  }
  if (!worst || frames.length < worst.frames) worst = { key: resource.key, frames: frames.length };
  const orders = frames.map((frame) => Number((frame.name.match(/(\d+)\.png$/) || [])[1]));
  const sortedEverywhere = orders.every((order, index) => index === 0 || order > orders[index - 1]);
  if (!sortedEverywhere) {
    check(false, `${resource.key} 帧名序号在图集里按升序排列（AnimationHelper 按序号排序的前提）`, orders.join(","));
  }
  const trimmed = frames.filter((frame) => frame.w !== frame.sw || frame.h !== frame.sh);
  if (trimmed.length) {
    check(false, `${resource.key} 每帧 rect 尺寸 == 原始尺寸（未裁剪；显示层 trim=true + 按原始尺寸 contain 的前提）`, `${trimmed.length}/${frames.length} 帧被裁剪`);
  }
}
check(!!worst && worst.frames >= 8, `每张边框至少 8 帧（最少的 ${worst ? worst.key : "?"} 有 ${worst ? worst.frames : 0} 帧）`);
check(true, "全部边框图集的帧序与未裁剪检查通过（84 张 × 8~12 帧）");

console.log("\n— F. 接线（源码断言）—");
const helperSource = read("assets/ui/helpers/GameUiHelper.ts");
const animationSource = read("assets/ui/helpers/AnimationHelper.ts");
const preloadSource = read("assets/ui/core/PreloadManager.ts");
const barrelSource = read("assets/configs/hudLayout.ts");
const equipmentSource = read("assets/configs/equipments.ts");

check(/this\.applyEquipmentBorder\(sprite, good\);/.test(helperSource), "createGood 给物品图标挂边框（传的是图标节点，边框随图标压暗/销毁）");
check(/if \(!isEquipment\(good\)\) return;/.test(helperSource), "只有装备才挂边框");
check(/getEquipmentBorderKey\(good\)/.test(helperSource) && /borders\.get\(borderKey\)/.test(helperSource), "边框 key 与图集路径都来自 configs/border");
check(/icon\.addChild\(border\);/.test(helperSource), "边框是图标的子节点（不是格子的子节点，不影响拖动找图标）");
check(/sprite\.sizeMode = Sprite\.SizeMode\.CUSTOM;/.test(helperSource) && /sprite\.trim = true;/.test(helperSource) && /addComponent\(Animation\)/.test(helperSource), "边框零件：CUSTOM 尺寸 + trim=true（绕开未裁剪素材的非 0 offset）+ 动画组件");
check(/frame\.originalSize/.test(helperSource) && /Math\.min\(box\.width \/ source\.width, box\.height \/ source\.height\)/.test(helperSource), "尺寸按首帧原始宽高 contain 进外框");
check(/loadFramesFromAtlas/.test(helperSource) && /playLoopAtlas/.test(helperSource), "帧走 AnimationHelper 的图集缓存，播放走图集循环入口");

// 边框相关代码里不许写死手感数值（尺寸/帧率全在 configs/layout/borders）
// 注意：**先剥注释再切片**——直接切原文件的话，切片点落在一条多行注释中间时注释剥不掉，
// 注释里的中文会被当成「裸中文文案」（加长文档注释就会踩这个假警报）
const borderCode = helperSource.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const borderMethods = borderCode.slice(borderCode.indexOf("static applyEquipmentBorder"), borderCode.indexOf("static fitNodeToBox") + 800);
check(!/\b(56|10|255)\b/.test(borderMethods), "边框显示代码没有写死的尺寸/帧率/透明度（全走 equipmentBorderLayout）");
check(!/[\u4e00-\u9fa5]/.test(borderMethods), "边框显示代码没有裸中文文案");

check(/loopClipCache/.test(animationSource), "图集循环动画的片段有缓存（几十个格子共用同一片段）");
check(/createWithSpriteFrames\(spriteFrames, this\.normalizeFrameRate\(frameRate\)\)/.test(animationSource), "片段帧率 = 配置的每秒帧数");
check(/AnimationClip\.WrapMode\.Loop/.test(animationSource), "图集循环动画是 Loop 模式");
check(/import \{ getFrameIndex, getFrameOrder \} from "\.\.\/utils\/animation\/FrameOrder";/.test(animationSource) && /getFrameOrder\(a\.name\) - getFrameOrder\(b\.name\)/.test(animationSource), "帧序号解析收敛到 FrameOrder 纯函数（先去扩展名再取末尾连续数字，兼容带目录、带大小写扩展名的帧名，边框播放顺序不再赌图集原始序）");

check(/preloadBorders/.test(preloadSource) && /getAssignedBorders\(\)/.test(preloadSource) && /loadFramesFromAtlas/.test(preloadSource), "进图前预加载前后缀映射表用到的边框图集");
check(/export \* from "\.\/layout\/borders";/.test(barrelSource), "hudLayout barrel 导出边框显示配置");
check(/getEquipmentVariantKey\(key, p, s\)/.test(equipmentSource) && equipmentSource.includes("getEquipmentBaseKey"), "变体 key 的拼装与反解都在 equipments（自定义边框按基础件 key 命中的前提）");

finish("PASS：边框资源表、前后缀映射、取用优先级、素材守卫与界面接线全部通过。");

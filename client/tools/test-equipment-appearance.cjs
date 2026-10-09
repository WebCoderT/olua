#!/usr/bin/env node
/**
 * 装备外观（衣服/武器外显动画）回归单测
 *
 * 背景（2026-10-07 事故）：穿上装备后外观不显示、内观正常。
 * 根因：装备外观帧全部是大写扩展名（clothes/weapons 下 3 万多张 `*.PNG`），Cocos 导入器
 * 不认大写扩展名 → 子资源名整串保留扩展名（帧名是 "00000.PNG" 而非 "00000"）；
 * 旧代码按 `Number(帧名)` 取帧序号 → NaN → `indexOf(NaN)` 恒 -1 → 一个动画片段都切不出来，
 * Animation 组件上没有 state，`crossFade(name)` 静默什么都不做 → 外观永远空白。
 * 内观是静态 Sprite（不走帧序号），所以显示正常。怪物/NPC/称号等都是小写 `.png` 不受影响。
 *
 * 修复：帧序号解析收敛到 `ui/utils/animation/FrameOrder`（先去扩展名再取末尾连续数字）。
 *
 * 覆盖：
 * - 纯函数：getFrameIndex / getFrameOrder 对三种帧名形态（纯数字 / 前缀名 / 大写扩展名）的解析
 * - 真实资源：衣服外观帧的 .meta displayName 确实是大写形态（事故现场），新解析能取对序号
 * - 真实切割：用磁盘上的真实帧名 + 真实 AnimationHelper.buildClips，88 个动作片段全齐、
 *   帧数与帧序正确（stand_down = 32~39）；并证明旧口径 Number(帧名) 解析出来是 NaN
 * - 全量覆盖：所有衣服/武器 out 目录都能切出全部动作片段（任何一件装备穿上后外观都有得播）
 * - 配置：每件衣服/武器条目的 out 目录在磁盘上存在（唯一例外 weapon_5 的 out 为空串）
 * - 源码：AnimationHelper 不再直接 Number(帧名)，排序与挑帧都走 FrameOrder 纯函数
 *
 * 用法：node client/tools/test-equipment-appearance.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, PROJECT_ROOT, check, finish } = require("./lib/configs-sandbox.cjs");

const HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/helpers/AnimationHelper.ts");
const CLOTHES_DIR = path.join(PROJECT_ROOT, "assets/resources/clothes/out");
const WEAPONS_DIR = path.join(PROJECT_ROOT, "assets/resources/weapons/out");

/** cc 垫片追加：AnimationHelper 还要用 Animation/AnimationClip/SpriteFrame 等（测试只走纯切割，桩够用） */
const CC_EXTRA = `
class AnimationClip {
  constructor() { this.wrapMode = 0; this.enableTrsBlending = false; this.name = ""; }
  static createWithSpriteFrames(frames, duration) { const clip = new AnimationClip(); clip.frames = frames; clip.duration = duration; return clip; }
}
AnimationClip.WrapMode = { Normal: 1, Loop: 2 };
class Animation { static EventType = { FINISHED: "finished" }; }
class SpriteFrame {}
class SpriteAtlas {}
class Node {}
Object.assign(module.exports, {
  Animation, AnimationClip, SpriteFrame, SpriteAtlas, Node,
  resources: { loadDir: () => {}, getDirWithPath: () => [] },
  isValid: () => true,
});
`;

const outDir = prepare("olua-appearance", ["configs/animation.ts", "ui/utils/animation/FrameOrder.ts", "ui/helpers/AnimationHelper.ts"], CC_EXTRA);
const { getFrameIndex, getFrameOrder } = require(path.join(outDir, "ui/utils/animation/FrameOrder.js"));
const { roleAnimationMap } = require(path.join(outDir, "configs/animation.js"));
const AnimationHelper = require(path.join(outDir, "ui/helpers/AnimationHelper.js")).default;

/** 假帧：只有切割逻辑用到的 name 与 getRect */
function fakeFrame(name, width = 86, height = 93) {
  return { name, getRect: () => ({ x: 0, y: 0, width, height }) };
}

/**
 * 按导入器的真实行为把磁盘文件名变成子资源名：
 * 小写 .png 被识别 → 去扩展名；大写 .PNG 不被识别 → 整串保留（事故形态）
 */
function diskName(file) {
  return /\.PNG$/.test(file) ? file : file.replace(/\.[^.]*$/, "");
}

/** 读一个外观目录的全部帧名（按导入器口径），切出全部动作片段 */
function buildClipsFromDisk(dir) {
  const files = fs.readdirSync(dir).filter((file) => /\.png$/i.test(file));
  // 与 loadFrames 同口径：先按帧序号排序（readdir 序不可信），再交给 buildClips 过滤
  const frames = files.map((file) => fakeFrame(diskName(file))).sort((a, b) => getFrameOrder(a.name) - getFrameOrder(b.name));
  return AnimationHelper.buildClips(roleAnimationMap, frames, `test|${dir}`);
}

//#region 纯函数：三种帧名形态

check(getFrameIndex("00000") === 0, "纯数字帧名取到序号 0（0 是合法帧序号，不是「取不到」）");
check(getFrameIndex("00000.PNG") === 0, "大写扩展名帧名（事故形态）也能取到序号 0");
check(getFrameIndex("sfx_13001_0_0003") === 3, "前缀名取末尾连续数字");
check(getFrameIndex("1002/attack/00001.png") === 1, "带目录与扩展名的帧名取末段序号");
check(getFrameIndex("auto_attack/00000") === 0, "图集帧名（前缀/序号）取末段序号");
check(getFrameIndex("npc_a") === null, "取不到数字返回 null（区别于 0）");
check(getFrameIndex("") === null, "空名返回 null");
check(getFrameOrder("npc_a") === 0, "排序序号取不到按 0（不参与「有没有帧号」的判断）");
check(getFrameOrder("00007.PNG") === 7, "排序序号与大写扩展名通用");
check(Number.isNaN(Number("00000.PNG")), "事故见证：旧口径 Number(帧名) 对大写扩展名解析出 NaN（indexOf 恒 -1）");

//#endregion

//#region 真实资源：事故现场（衣服外观帧的子资源名带大写扩展名）

const sampleMeta = JSON.parse(fs.readFileSync(path.join(CLOTHES_DIR, "005", "00000.PNG.meta"), "utf8"));
const sampleName = Object.values(sampleMeta.subMetas).find((sub) => sub.name === "spriteFrame").displayName;
check(sampleName === "00000.PNG", "衣服外观帧的导入器子资源名整串保留大写扩展名（事故现场）", `displayName = ${sampleName}`);
check(getFrameIndex(sampleName) === 0, "新解析对真实子资源名取到帧序号 0");
check(getFrameIndex("00001.PNG") === 1 && getFrameIndex("00039.PNG") === 39, "真实帧名序号逐个取对");

//#endregion

//#region 真实切割：buildClips 用磁盘帧名切出全部动作片段

const clothClips = buildClipsFromDisk(path.join(CLOTHES_DIR, "005"));
check(clothClips.size === roleAnimationMap.size, "衣服外观 005 切出全部动作片段", `${clothClips.size}/${roleAnimationMap.size}`);
const standDown = clothClips.get("stand_down");
check(!!standDown, "stand_down 有片段");
check(standDown.frames.length === 8, "stand_down 帧数 = 每方向帧长 8", `${standDown.frames.length}`);
check(standDown.frames.every((frame) => /^0003[0-9]/.test(frame.name)), "stand_down 帧序 = 32~39（动作段起点 + 方向下标 × 帧长）");
check(standDown.frames[0].name.startsWith("00032"), "stand_down 首帧 = 00032（排序生效，不是文件枚举序）");
const weaponClips = buildClipsFromDisk(path.join(WEAPONS_DIR, "001"));
check(weaponClips.size === roleAnimationMap.size, "武器外观 001 切出全部动作片段", `${weaponClips.size}/${roleAnimationMap.size}`);

//#endregion

//#region 全量覆盖：所有衣服/武器 out 目录都有完整片段

const { getItem, getItemsByType } = require(path.join(outDir, "configs/items.js"));
const { EQUIPMENT_TYPE, GOOD_TYPE, isEquipment } = require(path.join(outDir, "types/good.js"));

const wearables = getItemsByType(GOOD_TYPE.EQUIPMENT).filter((good) => isEquipment(good) && (good.slot === EQUIPMENT_TYPE.CLOTH || good.slot === EQUIPMENT_TYPE.WEAPON));
const outDirs = new Set();
wearables.forEach((good) => {
  if (good.out) outDirs.add(good.out);
});
check(outDirs.size > 0, "装备外观目录收集齐", `${outDirs.size} 个目录 / ${wearables.length} 件装备（含变体）`);

let brokenDirs = [];
outDirs.forEach((outSrc) => {
  const dir = path.join(PROJECT_ROOT, "assets/resources", outSrc);
  if (!fs.existsSync(dir)) {
    brokenDirs.push(`${outSrc} <目录不存在>`);
    return;
  }
  const clips = buildClipsFromDisk(dir);
  if (clips.size !== roleAnimationMap.size) brokenDirs.push(`${outSrc} 只切出 ${clips.size}/${roleAnimationMap.size} 个动作`);
});
check(brokenDirs.length === 0, "每个外观目录都能切出全部动作片段（穿上任何一件装备外观都有得播）", brokenDirs.slice(0, 5).join("；"));

//#endregion

//#region 配置：out 目录在磁盘上存在（weapon_5 的 out 为空串是登记过的例外）

const missingOut = wearables.filter((good) => good.slot === EQUIPMENT_TYPE.CLOTH && !good.out).map((good) => good.id);
const missingDir = new Set();
wearables.forEach((good) => {
  if (!good.out) return;
  if (!fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", good.out))) missingDir.add(good.out);
});
check(missingOut.length === 0, "每件衣服都配了外观目录", missingOut.join("、"));
check(missingDir.size === 0, "每件衣服/武器的外观目录在磁盘上存在", Array.from(missingDir).join("、"));
check(getItem("weapon_5") && getItem("weapon_5").out === "", "weapon_5 外观为空串（登记过的例外：资源缺失，运行时隐藏武器节点）");

//#endregion

//#region 源码：帧序号解析收敛到 FrameOrder，不再有裸 Number(帧名)

const helperSource = fs.readFileSync(HELPER_FILE, "utf8");
check(/import \{ getFrameIndex, getFrameOrder \} from "\.\.\/utils\/animation\/FrameOrder";/.test(helperSource), "AnimationHelper 引入 FrameOrder 纯函数");
check(!/Number\(spriteFrame\.name\)/.test(helperSource) && !/Number\(frame\.name\)/.test(helperSource), "不再直接 Number(帧名)（大写扩展名会解析成 NaN）");
check(/getFrameIndex\(spriteFrame\.name\)/.test(helperSource), "片段切割按 getFrameIndex 挑帧");
check(/getFrameOrder\(a\.name\) - getFrameOrder\(b\.name\)/.test(helperSource), "目录帧排序按 getFrameOrder");
check(!/nameOrder\(/.test(helperSource) && !/frameOrder\(/.test(helperSource), "排序序号唯一来源（本地 nameOrder/frameOrder 已删）");

//#endregion

finish("装备外观回归全部通过");

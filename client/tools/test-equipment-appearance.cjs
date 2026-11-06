#!/usr/bin/env node
/**
 * 装备外观（衣服/武器外显动画）回归单测
 *
 * ===========================================================================
 * 事故与它留下的判据（2026-10-07）
 * ===========================================================================
 * 穿上装备后外观不显示、内观正常。根因：外观帧全部是大写扩展名 `*.PNG`，Cocos 导入器
 * 不认大写 → 子资源名整串保留扩展名（`00000.PNG`）；旧代码 `Number(帧名)` → NaN →
 * `indexOf(NaN)` 恒 -1 → 一个片段都切不出来 → 外观永远空白。
 *
 * #235 起散帧全部打包成动作图集（`<out>/<动作>/<动作>.plist`，帧名 `d<方向>_<帧>`），
 * 帧号不再靠 `Number(帧名)` 猜 —— 但「别再用 Number(帧名)」这条判据仍然要守，
 * 所以本文件保留纯函数部分，资源部分改成图集口径。
 *
 * 覆盖：
 * - 纯函数：getFrameIndex / getFrameOrder 对三种帧名形态（纯数字 / 前缀名 / 大写扩展名）的解析
 * - 图集帧名：`d4_00` 这类自描述帧名能被解析，且 AnimationHelper 走的是正则分组而不是 Number()
 * - 真实资源：每件衣服/武器的每个动作都有图集、每个动作覆盖 8 个方向、帧号从 0 起连续
 * - 配置：每件衣服/武器条目的 out 目录在磁盘上存在（唯一例外 weapon_5 的 out 为空串）
 * - 源码：帧序号解析收敛到 FrameOrder；图集分支按 `d<方向>_<帧>` 分组
 *
 * 用法：node client/tools/test-equipment-appearance.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, PROJECT_ROOT, check, finish } = require("./lib/configs-sandbox.cjs");

const HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/helpers/AnimationHelper.ts");
// #235 散帧图集化：衣服/武器外显在 resources 下的 <out>/<动作>/<动作>.plist
const RES_ROOT = path.join(PROJECT_ROOT, "assets", "resources");

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
const { roleAnimationMap, directions, roleActionAtlas } = require(path.join(outDir, "configs/animation.js"));

//#region 纯函数：三种帧名形态

check(getFrameIndex("00000") === 0, "纯数字帧名取到序号 0（0 是合法帧序号，不是「取不到」）");
check(getFrameIndex("00000.PNG") === 0, "大写扩展名帧名（事故形态）也能取到序号 0");
check(getFrameIndex("13009_0_0003") === 3, "前缀名取末尾连续数字");
check(getFrameIndex("1002/attack/00001.png") === 1, "带目录与扩展名的帧名取末段序号");
check(getFrameIndex("auto_attack/00000") === 0, "图集帧名（前缀/序号）取末段序号");
check(getFrameIndex("npc_a") === null, "取不到数字返回 null（区别于 0）");
check(getFrameIndex("") === null, "空名返回 null");
check(getFrameOrder("npc_a") === 0, "排序序号取不到按 0（不参与「有没有帧号」的判断）");
check(getFrameOrder("00007.PNG") === 7, "排序序号与大写扩展名通用");
check(Number.isNaN(Number("00000.PNG")), "事故见证：旧口径 Number(帧名) 对大写扩展名解析出 NaN（indexOf 恒 -1）");

//#endregion

//#region 图集帧名：d<方向>_<帧> 自描述

check(getFrameIndex("d4_00") === 0 && getFrameIndex("d4_03") === 3, "图集帧名 d4_00 / d4_03 取到的末尾序号是帧下标（事故形态不再出现）");
const helperSource = fs.readFileSync(HELPER_FILE, "utf8");
check(/const matched = \/\^d\(\\d\+\)_\(\\d\+\)\$\/\.exec\(frame\.name\.replace\(\/\\\.png\$\/i, ""\)\)/.test(helperSource), "AnimationHelper 按 d<方向>_<帧> 正则拆帧名（不靠 Number）");
check(/const direction = directions\[directionIndex\];/.test(helperSource), "方向下标直接索引 directions（帧名自带方向，不再依赖帧号表）");

//#endregion

//#region 真实资源：每件衣服/武器的每个动作都有图集且覆盖 8 向

/** 某套外观所有问题的清单（缺图集 / 空图集 / 方向不全 / 帧号不连续） */
function inspectOut(outSrc) {
  const dirPath = path.join(RES_ROOT, outSrc);
  if (!fs.existsSync(dirPath)) return ["目录不存在"];
  const problems = [];
  for (const { action } of roleActionAtlas) {
    const plistPath = path.join(dirPath, action, `${action}.plist`);
    if (!fs.existsSync(plistPath)) { problems.push(`${action}:缺图集`); continue; }
    const frames = Array.from(fs.readFileSync(plistPath, "utf8").matchAll(/<key>(d\d_\d+)\.png<\/key>/g)).map((match) => match[1]);
    if (frames.length === 0) { problems.push(`${action}:空图集`); continue; }
    const byDirection = new Map();
    for (const name of frames) {
      const [direction, index] = name.split("_");
      byDirection.set(direction, [...(byDirection.get(direction) ?? []), Number(index)]);
    }
    if (byDirection.size !== directions.length) problems.push(`${action}:${byDirection.size}向`);
    for (const [direction, indexes] of byDirection) {
      const sorted = [...indexes].sort((a, b) => a - b);
      if (!sorted.every((value, position) => value === position)) problems.push(`${action}/${direction}:帧号不连续`);
    }
  }
  return problems;
}

const sample = inspectOut("equipment/clothes/out/005");
check(sample.length === 0, "衣服 005 的 11 个动作图集齐全、各覆盖 8 向且帧号从 0 起连续", sample.slice(0, 5).join("；"));

//#endregion

//#region 全量覆盖：所有衣服/武器 out 目录都能播

const { getItem, getItemsByType } = require(path.join(outDir, "configs/items.js"));
const { EQUIPMENT_TYPE, GOOD_TYPE, isEquipment } = require(path.join(outDir, "types/good.js"));

const wearables = getItemsByType(GOOD_TYPE.EQUIPMENT).filter((good) => isEquipment(good) && (good.slot === EQUIPMENT_TYPE.CLOTH || good.slot === EQUIPMENT_TYPE.WEAPON));
const outDirs = new Set();
wearables.forEach((good) => {
  if (good.out) outDirs.add(good.out);
});
check(outDirs.size > 0, "装备外观目录收集齐", `${outDirs.size} 个目录 / ${wearables.length} 件装备（含变体）`);

const brokenDirs = [];
outDirs.forEach((outSrc) => {
  const problems = inspectOut(outSrc);
  if (problems.length) brokenDirs.push(`${outSrc} <${problems.slice(0, 2).join("、")}>`);
});
check(brokenDirs.length === 0, "每个外观目录的动作图集都完整（穿上任何一件装备外观都有得播）", brokenDirs.slice(0, 5).join("；"));

//#endregion

//#region 配置：out 目录在磁盘上存在（weapon_5 的 out 为空串是登记过的例外）

const missingOut = wearables.filter((good) => good.slot === EQUIPMENT_TYPE.CLOTH && !good.out).map((good) => good.id);
const missingDir = new Set();
wearables.forEach((good) => {
  if (!good.out) return;
  if (!fs.existsSync(path.join(RES_ROOT, good.out))) missingDir.add(good.out);
});
check(missingOut.length === 0, "每件衣服都配了外观目录", missingOut.join("、"));
check(missingDir.size === 0, "每件衣服/武器的外观目录在磁盘上存在", Array.from(missingDir).join("、"));
check(getItem("weapon_5") && getItem("weapon_5").out === "", "weapon_5 外观为空串（登记过的例外：资源缺失，运行时隐藏武器节点）");

//#endregion

//#region 源码：帧序号解析收敛到 FrameOrder，不再有裸 Number(帧名)

check(/import \{ getFrameIndex, getFrameOrder \} from "\.\.\/utils\/animation\/FrameOrder";/.test(helperSource), "AnimationHelper 引入 FrameOrder 纯函数");
check(!/Number\(spriteFrame\.name\)/.test(helperSource) && !/Number\(frame\.name\)/.test(helperSource), "不再直接 Number(帧名)（大写扩展名会解析成 NaN）");
check(/getFrameIndex\(spriteFrame\.name\)/.test(helperSource), "片段切割按 getFrameIndex 挑帧");
check(/getFrameOrder\(a\.name\) - getFrameOrder\(b\.name\)/.test(helperSource), "目录帧排序按 getFrameOrder");
check(!/nameOrder\(/.test(helperSource) && !/frameOrder\(/.test(helperSource), "排序序号唯一来源（本地 nameOrder/frameOrder 已删）");

//#endregion

finish("装备外观回归全部通过");

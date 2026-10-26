#!/usr/bin/env node
/**
 * 技能数值与实现解耦单测（client/tools/test-skill-decouple.cjs，#31）
 *
 * 盯的不变量（改技能系统后必须全绿）：
 * A. 纯数据模块（configs/skill-data.ts）：12 个技能的全部数值字段逐一钉死 ——
 *    改数值必须来改这里（有意的摩擦），不允许悄悄漂移；数据模块里不允许出现 onClick
 * B. 模块边界（源码断言）：skill-data.ts 零引擎依赖（import 白名单只有 types/ 三件套），
 *    技能实现只住在 skills/warrior.ts，由接线层 configs/skill.ts 引用
 * C. 接线运行期：单独编译 configs/skill.ts，把编译产物里的 skills/warrior.js 换成命名函数桩，
 *    require 后验证 12 个 id 的 onClick 与实现映射一一对应（函数同一性），
 *    且 skills Map 的顺序、数值与数据模块一致
 *
 * 沙箱机制：A 段复用 lib/configs-sandbox.cjs 的 prepare（真实配置表 + cc 垫片）；
 * C 段要编译带引擎依赖的 skill.ts，prepare 的「零错误」门槛迈不过去，故自建沙箱 +
 * 编译后替换产物（tsc 对 warrior 依赖图的报错是预期的，skill.ts 自身必须 0 错）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PROJECT_ROOT, findTsc, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

// ==============================================================================
//  A. 纯数据模块：12 个技能数值逐一钉死
// ==============================================================================

console.log("\n— A. 纯数据模块（configs/skill-data.ts）—");

const outDir = prepare("olua-skill-decouple", ["configs/skill-data.ts"]);
const { skillData, oeccupationSkills, basicAttackSkillId, skillTypeLabels, skillTargetTypeLabels } = require(path.join(outDir, "configs/skill-data.js"));

/** 递归按键排序，让深比较不受字段书写顺序影响 */
const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
};

/** 11 档等差伤害系数（1001~1011 除 1008 外全是 3→4 这一档；1000 是 1→2，手写在下面当锚） */
const rates = (from, to, count = 11) =>
  Array.from({ length: count }, (_, index) => Math.round((from + ((to - from) * index) / (count - 1)) * 100) / 100).map((value) => ({
    baseType: "physicalAttack",
    baseTypeRate: value,
  }));

/** 1000 的系数手写全列：既是期望值，也把 rates helper 的正确性锚住 */
const RATES_1000 = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2].map((value) => ({ baseType: "physicalAttack", baseTypeRate: value }));

/**
 * 12 个技能的期望数值（与 #31 重构前快照逐字节一致，改这里 = 改数值，必须走 issue）
 * 枚举值取其字符串字面量（SkillType "0"=主动 / SkillTargetType "1"=单体 / ACTION "stand" 等）
 */
const EXPECTED = {
  "1000": { id: "1000", label: "‌基础剑术", icon: "skill/icon/1001", cooldown: 1, mpCost: 0, targetType: "1", oeccupation: "1", level: 1, description: "普通单体攻击技能，通过挥砍手中武器，对敌人直接造成普通物理伤害，伤害与物理攻击相关", type: "0", distance: 10, damageCoefficients: RATES_1000, action: "attack_near", canAuto: true },
  "1001": { id: "1001", label: "烈火剑法", icon: "skill/icon/1006", cooldown: 1, mpCost: 8, targetType: "1", oeccupation: "1", level: 10, description: "战士标志性爆发技能，10级可造成‌280%~560%‌ 攻击伤害，附带15%暴击率，觉醒后还会附加灼烧效果，是PK秒杀、打BOSS爆发的核心招式", type: "0", distance: 10, damageCoefficients: rates(3, 4), action: "attack_skill_1", push: { distance: 120 }, canAuto: false, effect: "effect/skill/s_1006@0", effectIsOnSelf: true },
  "1002": { id: "1002", label: "刺杀剑术", icon: "skill/icon/1003", cooldown: 1, mpCost: 6, targetType: "1", oeccupation: "1", level: 10, description: "公认的破防神技，隔位释放的第二格剑气为无属性攻击，可无视目标防御，直接穿透法师的魔法盾，是克制远程职业、挑战高防BOSS的必备技能", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1003": { id: "1003", label: "莲月剑法", icon: "skill/icon/2003", cooldown: 1, mpCost: 6, targetType: "1", oeccupation: "1", level: 10, description: "传奇3版本特色技能，可打出两段连击，总伤害达300%，目标防御越高伤害增幅越明显，适合团战持续黏人输出、残血收割", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1004": { id: "1004", label: "‌擒龙手‌", icon: "skill/icon/3010", cooldown: 1, mpCost: 10, targetType: "1", oeccupation: "1", level: 10, description: "高阶特色技能，可将远处的目标直接拉到身边并附加眩晕，同时给自己增加攻击buff，是团战中强切敌方后排的神技", type: "0", distance: 100000, damageCoefficients: rates(3, 4), action: "attack_far", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: false },
  "1005": { id: "1005", label: "野蛮冲撞", icon: "skill/icon/1010", cooldown: 1, mpCost: 8, targetType: "1", oeccupation: "1", level: 10, description: "全版本通用的核心控场技能，10级可冲撞4格，65%概率将等级低于自身的目标撞飞并眩晕0.8秒，用于追击敌人、分割敌方阵型、抢BOSS卡位都非常实用", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1006": { id: "1006", label: "逐日剑法‌", icon: "skill/icon/2202", cooldown: 1, mpCost: 8, targetType: "1", oeccupation: "1", level: 10, description: "四格范围内的突进突袭技能，可快速拉近与远程职业的距离，弥补战士手短的短板，是PK中追击残血目标的利器", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1007": { id: "1007", label: "狮子吼", icon: "skill/icon/3007", cooldown: 1, mpCost: 12, targetType: "1", oeccupation: "1", level: 10, description: "范围麻痹技能，可震开并麻痹周围3格内的敌人，等级高于目标时必中，被围攻时能快速脱身，团战中可打乱敌方后排输出节奏", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1008": { id: "1008", label: "十步一杀", icon: "skill/icon/1005", cooldown: 1, mpCost: 10, targetType: "0", oeccupation: "4", level: 10, description: "高阶专属技能，突进目标后有概率触发麻痹效果，是后期版本中打先手控制的神技", type: "0", distance: 200, damageCoefficients: [], action: "attack_far", canAuto: false, effect: "effect/skill/s_3010@0" },
  "1009": { id: "1009", label: "半月弯刀", icon: "skill/icon/1004", cooldown: 1, mpCost: 6, targetType: "1", oeccupation: "1", level: 10, description: "扇形范围群攻技能，可同时攻击身前半圆内的多个敌人，挂机清怪效率极高，被围时贴身释放也能快速清场突围", type: "0", distance: 0, damageCoefficients: rates(3, 4), action: "stand", canAuto: false, effect: "effect/skill/s_1002@0", effectIsOnSelf: true },
  "1010": { id: "1010", label: "‌护体神盾", icon: "skill/icon/2009", cooldown: 60, mpCost: 15, statusId: "2001", requireTarget: false, targetType: "3", oeccupation: "1", level: 1, description: "被动减伤技能，概率格挡 incoming 伤害，大幅提升战士的生存能力，是后期团战中站得住脚的关键保障", type: "2", distance: 0, damageCoefficients: rates(3, 4), action: "attack_far", canAuto: false },
  "1011": { id: "1011", label: "金刚护体", icon: "skill/icon/1008", cooldown: 1, mpCost: 15, statusId: "2002", requireTarget: false, targetType: "1", oeccupation: "1", level: 10, description: "主动防御buff，开启后短时间内可提升40%物防、30%魔防，附带25%减伤效果，能硬抗法师多套技能，打BOSS和团战前必开", type: "2", distance: 0, damageCoefficients: rates(3, 4), action: "attack_far", canAuto: false },
};

check(skillData.length === 12, `技能表 12 个（实得 ${skillData.length}）`);
check(JSON.stringify(skillData.map((s) => s.id)) === JSON.stringify(["1000", "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011"]), "id 序列 1000→1011 连续（插入顺序即 Map 顺序）");
check(skillData.every((skill) => !("onClick" in skill)), "数据模块里没有任何 onClick（实现在接线层，不进来）");

for (const [id, expected] of Object.entries(EXPECTED)) {
  const skill = skillData.find((item) => item.id === id);
  if (!skill) {
    check(false, `${id} 在技能表里`);
    continue;
  }
  const same = JSON.stringify(sortDeep(skill)) === JSON.stringify(sortDeep(expected));
  check(same, `${id} ${expected.label}：全部数值字段与期望一致`, same ? "" : `实际 ${JSON.stringify(sortDeep(skill))}`);
}

// 数据模块的其余四个导出（消费方照旧从 configs/skill 拿，这里钉来源）
check(oeccupationSkills.get("1")?.length === 12 && oeccupationSkills.get("2")?.length === 0 && oeccupationSkills.get("3")?.length === 0, "职业技能映射：战士 12 个、法师/道士空");
check(basicAttackSkillId === "1000", "普攻技能 = 1000（左键点怪直接放的那个）");
check(JSON.stringify(skillTypeLabels) === JSON.stringify({ "0": "主动", "1": "被动", "2": "状态", "3": "回复" }), "技能类型文案表");
check(JSON.stringify(skillTargetTypeLabels) === JSON.stringify({ "0": "区域", "1": "单体", "2": "群体", "3": "自身" }), "技能目标类型文案表");

// ==============================================================================
//  B. 模块边界（源码断言）
// ==============================================================================

console.log("\n— B. 模块边界（零引擎依赖 / 实现只住 warrior）—");

const dataSource = read("assets/configs/skill-data.ts");
const skillSource = read("assets/configs/skill.ts");

const importLines = dataSource.split("\n").filter((line) => /^import /.test(line));
check(importLines.length > 0 && importLines.every((line) => /^import .* from "\.\.\/types\/(role|skill|animation)";$/.test(line)), "skill-data.ts 的 import 只有 types/ 三件套（role / skill / animation）", importLines.join(" | "));
check(!/from "\.\.\/skills\/warrior"/.test(dataSource), "skill-data.ts 不 import 技能实现（注释里允许提到名字，import 语句不允许）");
check(!/from "\.\.\/ui\//.test(dataSource) && !/from "\.\.\/entities\//.test(dataSource), "skill-data.ts 不引用 ui/ 运行时与 entities/");
check(/import \{ skill_1000, skill_1001, skill_1008, skill_1010 \} from "\.\.\/skills\/warrior";/.test(skillSource), "skill.ts（接线层）引用 skills/warrior 的 4 个实现");
check(/const skillHandlers: Record<SkillId, \(context: SkillContext\) => void> = \{/.test(skillSource), "接线映射是 Record<SkillId, ...>（tsc 强制 12 个 id 齐全，漏接编译不过）");
check(/skills\.set\(item\.id, \{ \.\.\.item, onClick: skillHandlers\[item\.id\] \}\);/.test(skillSource), "skills Map 由 spread 合成（数值透传 + onClick 按 id 接上）");

// ==============================================================================
//  C. 接线运行期（编译 skill.ts → 产物 warrior.js 换命名函数桩 → 同一性）
// ==============================================================================

console.log("\n— C. 接线运行期（12 个 id 接到对的实现）—");

const tsc = findTsc();
if (!tsc) {
  check(false, "找不到 tsc（client/node_modules/typescript）");
} else {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-skill-decouple-wire-"));
  try {
    // cc 垫片：运行期 index.js + 编译期 d.ts（Node 接口给 types/skill 的 import type 用）
    const shimDir = path.join(work, "node_modules/cc");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "index.js"), [
      "class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }",
      "class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }",
      "class Size { constructor(w = 0, h = 0) { this.width = w; this.height = h; } }",
      "class Color { constructor(r = 255, g = 255, b = 255, a = 255) { Object.assign(this, { r, g, b, a }); } }",
      "module.exports = { Vec2, Vec3, Size, Color };",
    ].join("\n"));
    fs.writeFileSync(path.join(shimDir, "package.json"), '{"name":"cc","main":"index.js"}');
    fs.writeFileSync(path.join(work, "cc.d.ts"), [
      'declare module "cc" {',
      "  export class Vec2 { constructor(x?: number, y?: number); x: number; y: number; }",
      "  export class Vec3 { constructor(x?: number, y?: number, z?: number); x: number; y: number; z: number; }",
      "  export class Size { constructor(w?: number, h?: number); width: number; height: number; }",
      "  export class Color { constructor(r?: number, g?: number, b?: number, a?: number); }",
      "  export type Node = any;",
      "  export function isValid(x: any): boolean;",
      "}",
    ].join("\n"));

    const out = path.join(work, "out");
    fs.writeFileSync(path.join(work, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2019",
        module: "CommonJS",
        moduleResolution: "node",
        outDir: out,
        rootDir: path.join(PROJECT_ROOT, "assets"),
        baseUrl: work,
        paths: { cc: [path.join(work, "cc.d.ts")] },
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        experimentalDecorators: true,
        noEmitOnError: false,
        types: [],
      },
      files: [path.join(PROJECT_ROOT, "assets/configs/skill.ts")],
    }, null, 2));

    const compiled = spawnSync(process.execPath, [tsc, "-p", path.join(work, "tsconfig.json")], { encoding: "utf8" });
    const log = `${compiled.stdout || ""}${compiled.stderr || ""}`;
    // warrior 依赖图（cc / ui/core/*）编不过是预期的；skill.ts 与 skill-data.ts 自身必须 0 错
    const ownErrors = log.split("\n").filter((line) => line.includes("error TS") && /configs\/(skill|skill-data)\.ts/.test(line));
    check(ownErrors.length === 0, "skill.ts / skill-data.ts 自身编译 0 错（warrior 依赖图报错属预期）", ownErrors.slice(0, 3).join(" | "));

    // 编译产物里的 skills/warrior.js 换成命名函数桩（切断 cc / ui 依赖，保留 4 个导出）
    const warriorJs = path.join(out, "skills/warrior.js");
    check(fs.existsSync(warriorJs), "产物里有 skills/warrior.js（替换法成立）");
    if (fs.existsSync(warriorJs)) {
      fs.writeFileSync(warriorJs, [
        '"use strict";',
        'Object.defineProperty(exports, "__esModule", { value: true });',
        "exports.skill_1010 = exports.skill_1008 = exports.skill_1001 = exports.skill_1000 = void 0;",
        "function skill_1000() {}",
        "function skill_1001() {}",
        "function skill_1008() {}",
        "function skill_1010() {}",
        "exports.skill_1000 = skill_1000;",
        "exports.skill_1001 = skill_1001;",
        "exports.skill_1008 = skill_1008;",
        "exports.skill_1010 = skill_1010;",
      ].join("\n"));

      const wired = require(path.join(out, "configs/skill.js"));
      const stubs = require(warriorJs);
      /** id → 应接的实现函数名（与 warrior.ts 的导出名一一对应） */
      const HANDLERS = {
        "1000": "skill_1000", "1001": "skill_1001", "1002": "skill_1000", "1003": "skill_1000",
        "1004": "skill_1000", "1005": "skill_1000", "1006": "skill_1000", "1007": "skill_1000",
        "1008": "skill_1008", "1009": "skill_1000", "1010": "skill_1010", "1011": "skill_1000",
      };
      for (const [id, fn] of Object.entries(HANDLERS)) {
        const skill = wired.skills.get(id);
        check(!!skill && typeof skill.onClick === "function" && skill.onClick === stubs[fn], `${id} 的 onClick === ${fn}（同一性）`);
      }
      check(JSON.stringify([...wired.skills.keys()]) === JSON.stringify(Object.keys(HANDLERS)), "skills Map 键序 = 1000→1011（消费方按 id 取，不依赖顺序，但钉住防漂移）");

      // 接线后的消费方视图：数值透传没被 spread 弄丢（抽 1001 的 push 与 1008 的空系数）
      const skill1001 = wired.skills.get("1001");
      const skill1008 = wired.skills.get("1008");
      check(skill1001.push?.distance === 120 && skill1001.effectIsOnSelf === true, "接线后 1001 的 push / effectIsOnSelf 原样透传");
      check(Array.isArray(skill1008.damageCoefficients) && skill1008.damageCoefficients.length === 0, "接线后 1008 的伤害系数仍是空数组（区域突进技能）");
      // spread 之后的完整字段集 = A 段期望 + onClick 函数（JSON 会忽略函数值，onClick 的有无由上面同一性断言负责）
      const skill1000 = wired.skills.get("1000");
      check(
        typeof skill1000.onClick === "function" && JSON.stringify(sortDeep({ ...skill1000, onClick: undefined })) === JSON.stringify(sortDeep(EXPECTED["1000"])),
        "接线后 1000 完整字段集 = A 段期望（数值一个没丢）",
      );
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

finish("PASS：技能数值（12 个技能逐字段）、模块边界（零引擎依赖）与接线（id→实现同一性）全部通过。");

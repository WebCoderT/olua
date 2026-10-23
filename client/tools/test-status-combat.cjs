#!/usr/bin/env node
/**
 * 状态数值参与伤害结算的单测（issue #14）
 *
 * 覆盖三层：
 * 1. configs/status 的 combat 数值语义（格挡概率/系数、防御乘法）与文案一致
 * 2. BattleMath 纯函数：collectStatusCombatModifiers 叠加口径、resolveIncomingDamage 判定
 * 3. applyHitDamage 接线：状态修正真的进了伤害公式（大防御系数 → 伤害归零）
 *
 * BattleMath 依赖 cc 的 BoxCollider2D/Node（类型位 + getComponent 实参），
 * 沙箱垫片缺这两个导出，用 ccExtra 补上（本测试不会真的调碰撞判定）。
 */
const path = require("path");
const { prepare, check, finish } = require(path.join(__dirname, "lib/configs-sandbox.cjs"));

const outDir = prepare(
  "olua-status-combat",
  ["configs/status.ts", "ui/utils/battle/BattleMath.ts"],
  "class BoxCollider2D {}\nclass Node {}\nmodule.exports.BoxCollider2D = BoxCollider2D;\nmodule.exports.Node = Node;\n",
);

const { statuses } = require(path.join(outDir, "configs/status.js"));
const {
  collectStatusCombatModifiers,
  resolveIncomingDamage,
  applyHitDamage,
  NO_STATUS_MODIFIERS,
} = require(path.join(outDir, "ui/utils/battle/BattleMath.js"));

console.log("\n=== configs/status：数值语义与文案一致 ===");
const shield = statuses.get("2001");
const diamond = statuses.get("2002");
check(!!shield && !!diamond, "2001 护体神盾 / 2002 金刚护体都已注册");
check(shield.combat?.blockChance === 0.3, "护体神盾格挡概率 0.3");
check(shield.combat?.blockFactor === 0.5, "护体神盾格挡系数 0.5（减半）");
check(diamond.combat?.defenseMultiplier === 1.5, "金刚护体防御乘法系数 1.5");
check(shield.description.includes("30%"), "描述文案与概率一致（30%）");
check(shield.description.includes("减半"), "描述文案与系数一致（减半）");
check(diamond.description.includes("×1.5"), "描述文案与系数一致（×1.5）");

console.log("\n=== collectStatusCombatModifiers：叠加口径 ===");
const none = collectStatusCombatModifiers([]);
check(none.blockChance === 0 && none.blockFactor === 1 && none.defenseMultiplier === 1, "无状态 = 中性修正值");
check(none !== NO_STATUS_MODIFIERS && none.blockChance === NO_STATUS_MODIFIERS.blockChance, "返回独立副本（调用方改它不影响常量）");
const blockedOnly = collectStatusCombatModifiers(["2001"]);
check(blockedOnly.blockChance === 0.3 && blockedOnly.blockFactor === 0.5 && blockedOnly.defenseMultiplier === 1, "只有护体神盾：概率/系数就位、防御不变");
const defenseOnly = collectStatusCombatModifiers(["2002"]);
check(defenseOnly.blockChance === 0 && defenseOnly.defenseMultiplier === 1.5, "只有金刚护体：防御乘法、不参与格挡");
const both = collectStatusCombatModifiers(["2001", "2002"]);
check(both.blockChance === 0.3 && both.blockFactor === 0.5 && both.defenseMultiplier === 1.5, "双状态：格挡照旧、防御 1 × 1.5 = 1.5");
check(collectStatusCombatModifiers(["9999", "2002"]).defenseMultiplier === 1.5, "未注册/无 combat 的状态静默跳过");

console.log("\n=== resolveIncomingDamage：格挡判定（给定 roll 可复现） ===");
const base = { blockChance: 0.3, blockFactor: 0.5, defenseMultiplier: 1 };
check(resolveIncomingDamage(100, base, 0.29).blocked && resolveIncomingDamage(100, base, 0.29).damage === 50, "roll < 概率 → 格挡且伤害减半（100 → 50）");
check(!resolveIncomingDamage(100, base, 0.3).blocked && resolveIncomingDamage(100, base, 0.3).damage === 100, "roll = 概率 → 不格挡（严格小于）");
check(resolveIncomingDamage(7, base, 0).damage === 4, "小数值减半四舍五入（7 → 4）");
check(resolveIncomingDamage(1, base, 0).damage === 1, "伤害 1 格挡后不为 0 以下、取整保底（1 → 1）");
check(!resolveIncomingDamage(100, NO_STATUS_MODIFIERS, 0).blocked && resolveIncomingDamage(100, NO_STATUS_MODIFIERS, 0).damage === 100, "无修正：永不格挡、伤害原样");

console.log("\n=== applyHitDamage：状态修正真的进了伤害公式 ===");
// 防御乘到极大：无论攻击/防御区间怎么掷，防御项恒压过攻击 → 伤害必为 0
const tanky = { physicalDefense: [5, 10], magicDefense: [0, 0], taoistDefense: [0, 0], hp: 1000 };
const enemy = { physicalAttack: [10, 20], magicAttack: [0, 0], taoistAttack: [0, 0] };
let zeroDamage = true;
let blockedSeen = 0;
for (let i = 0; i < 300; i++) {
  const result = applyHitDamage(tanky, enemy, "physicalAttack", { blockChance: 0.3, blockFactor: 0.5, defenseMultiplier: 1000 });
  if (result.damage !== 0) zeroDamage = false;
  if (result.blocked) blockedSeen++;
}
check(zeroDamage, "防御 ×1000：300 次结算伤害全部为 0（防御项乘法生效）");
const victim = { physicalDefense: [0, 0], magicDefense: [0, 0], taoistDefense: [0, 0], hp: 1000 };
const bare = { physicalAttack: [50, 50], magicAttack: [0, 0], taoistAttack: [0, 0] };
const hit = applyHitDamage(victim, bare);
check(hit.damage === 50 && victim.hp === 950, "无修正：行为与旧口径一致（50 伤、扣血 50）");
check(typeof hit.blocked === "boolean", "返回值带格挡标记");
// 格挡概率用大样本宽界校验（0.3 概率、2000 次，[0.2, 0.4] 界极宽不会抖红）
const brace = { physicalDefense: [0, 0], magicDefense: [0, 0], taoistDefense: [0, 0], hp: 100000 };
const strongEnemy = { physicalAttack: [100, 100], magicAttack: [0, 0], taoistAttack: [0, 0] };
let blockedCount = 0;
for (let i = 0; i < 2000; i++) {
  if (applyHitDamage(brace, strongEnemy, "physicalAttack", base).blocked) blockedCount++;
}
const rate = blockedCount / 2000;
check(rate > 0.2 && rate < 0.4, `格挡频率落在 0.3 附近（实测 ${rate}）`);
// 格挡后扣血 = 半伤：blockChance 1 强制必格挡（大样本上面已把血打掉，这里重置满血再验）
const forcedBlock = { blockChance: 1, blockFactor: 0.5, defenseMultiplier: 1 };
brace.hp = 1000;
const before = brace.hp;
const blockedHit = applyHitDamage(brace, strongEnemy, "physicalAttack", forcedBlock);
check(blockedHit.blocked && blockedHit.damage === 50 && brace.hp === before - 50, "必格挡：100 伤只扣 50 血");

console.log("\n=== 接线静态断言（读源码）===");
const root = path.join(__dirname, "..");
const fs = require("fs");
const monsterAi = fs.readFileSync(path.join(root, "assets/ui/core/MonsterAI.ts"), "utf8");
check(
  monsterAi.includes("collectStatusCombatModifiers(StatusManager.getActiveIds())"),
  "MonsterAI.hitPlayer 每次受击都从进行中的状态汇总修正",
);
check(monsterAi.includes("showDamageText(player, damage, blocked)"), "格挡结果传给飘字展示");
const hoverTip = fs.readFileSync(path.join(root, "assets/ui/core/HoverTipManager.ts"), "utf8");
check(hoverTip.includes('getText("hover_status_block"') && hoverTip.includes('getText("hover_status_defense"'), "悬停详情把 combat 语义翻成数值行");
const statusManager = fs.readFileSync(path.join(root, "assets/ui/core/StatusManager.ts"), "utf8");
check(statusManager.includes("static getActiveIds()"), "StatusManager 暴露进行中的状态编号");

finish("#14 状态数值参与伤害结算：全部断言通过");

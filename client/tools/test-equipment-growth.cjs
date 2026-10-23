#!/usr/bin/env node
/**
 * 装备成长曲线回归单测（issue #16；跑的是**真实配置表与真实派生函数**，不是复刻）
 *
 * 编译沙箱（configs 编成 CommonJS + cc 垫片）见 client/tools/lib/configs-sandbox.cjs。
 * 装备数值的唯一来源 = configs/growth 的 equipmentStats(level, slot)（等级定档 × 部位权重 ×
 * setPowerRate）+ 前后缀倍率（equipmentPrefixRates × equipmentSuffixRates），
 * configs/equipments 的条目里不写战斗数值 —— 本测试盯的就是这条链路的体感约定：
 *
 * · 同等级不同部位有清晰强度差（武器攻高防低 / 衣服血防主源 / 回血只在防御部位）
 * · 前后缀阶梯严格递增且能拉开差距（普通的·人级 1.0 → 超神·神级 4.2）
 * · 低级与高级装备拉开明显差距（成长可感知）
 * · 曲线单调：同部位同倍率，等级升属性不降（skill 坑 5：档界处最容易出现「升一级反而变弱」）
 * · 装备是固定值（区间两端同数），详情弹窗只显示一个数
 * · 低等级小份额部位保底 1（不因四舍五入把项链的防御抹成 0）
 * · 口径①：七件套合计 ≈ setPowerRate × 裸属性（验公式）
 * · 口径②：玩家实际可及的一套 < 全套（头盔/腰带/鞋/项链/戒指只有 1 级件，缺口见 issue #18）
 *
 * 用法：node client/tools/test-equipment-growth.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 取区间/固定值的上限（装备属性统一是 [min, max]） */
const upper = (value) => (Array.isArray(value) ? value[1] : value);
const lower = (value) => (Array.isArray(value) ? value[0] : value);

function main() {
  let outDir;
  try {
    outDir = prepare("olua-equipment-growth", ["configs/items.ts", "configs/growth.ts", "configs/equipments.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { equipmentStats, equipmentGrowth, getRoleLevelAttributes, equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/growth.js"));
  const { items, getItem } = require(path.join(outDir, "configs/items.js"));
  const { isEquipment } = require(path.join(outDir, "types/good.js"));
  const { EQUIPMENT_TYPE } = require(path.join(outDir, "types/good.js"));

  console.log("\n=== 部位强度差：同等级不同部位（equipmentStats 直接验证）===");
  const weapon60 = equipmentStats(60, "weapon");
  const cloth60 = equipmentStats(60, "cloth");
  const helmet60 = equipmentStats(60, "helmet");
  const necklace60 = equipmentStats(60, "necklace");
  check(upper(weapon60.physicalAttack) > upper(cloth60.physicalAttack) * 2, "武器攻击远高于衣服（部位定位：武器是攻击主源）");
  check(upper(cloth60.maxHp) > upper(weapon60.maxHp) && upper(cloth60.physicalDefense) > upper(weapon60.physicalDefense), "衣服血防都高于武器（部位定位：衣服是血防主源）");
  check(weapon60.maxHp === 0 && upper(weapon60.hpRecover) === 0, "武器不给血量与回血");
  check(upper(cloth60.hpRecover) > 0 && upper(helmet60.hpRecover) > 0, "防御部位提供回血");
  check(upper(necklace60.hpRecover) === 0, "首饰不提供回血（回血是防具的收益）");

  console.log("\n=== 曲线性质：固定值 / 保底 / 单调 ===");
  const slots = ["weapon", "cloth", "helmet", "belt", "shoes", "necklace", "ring"];
  let fixedOk = true;
  let floorOk = true;
  for (const slot of slots) {
    for (const level of [1, 17, 33, 60]) {
      const stats = equipmentStats(level, slot);
      for (const key of Object.keys(stats)) {
        const range = stats[key];
        if (Array.isArray(range) && range[0] !== range[1]) fixedOk = false; // 装备必须是固定值
        if (key !== "hpRecover" && range[0] > 0 && range[0] < 1) floorOk = false; // 小份额部位保底 1
      }
    }
  }
  check(fixedOk, "装备属性全部为固定值（区间两端同数，详情弹窗只显示一个数）");
  check(floorOk, "低等级小份额部位保底 1（四舍五入不会把项链的防御抹成 0）");
  check(equipmentStats(1, "necklace").physicalDefense[0] >= 1, "1 级项链防御 ≥ 1（保底生效）");
  let monotonicOk = true;
  for (const slot of slots) {
    for (const key of ["maxHp", "physicalAttack", "physicalDefense"]) {
      for (let level = 2; level <= 60; level++) {
        if (upper(equipmentStats(level, slot)[key]) < upper(equipmentStats(level - 1, slot)[key])) monotonicOk = false;
        if (key === "maxHp" && equipmentStats(level, slot).maxHp < equipmentStats(level - 1, slot).maxHp) monotonicOk = false;
      }
    }
  }
  check(monotonicOk, "同部位属性随装备等级单调不减（1→60 逐级校验，含档界）");

  console.log("\n=== 成长差距：低级 vs 高级 / 前后缀阶梯 ===");
  const role60 = getRoleLevelAttributes(60);
  const weapon1 = equipmentStats(1, "weapon");
  const growthRatio = upper(weapon60.physicalAttack) / upper(weapon1.physicalAttack);
  check(growthRatio > 100, `武器攻击 1 级 → 60 级拉开 ${Math.round(growthRatio)} 倍（成长可感知）`);
  check(upper(cloth60.maxHp) / equipmentStats(1, "cloth").maxHp > 100, "衣服血量 1 → 60 级同样拉开百倍以上");
  // 前后缀阶梯：weapon_1（1 级武器）的 15 个变体，攻击上限必须随倍率严格递增
  const variantUpper = (p, s) => upper(getItem(`weapon_1${p === 0 && s === 0 ? "" : `_p${p}s${s}`}`).physicalAttack);
  let ladderOk = true;
  for (let p = 0; p < equipmentPrefixRates.length; p++) {
    for (let s = 0; s < equipmentSuffixRates.length; s++) {
      const rate = equipmentPrefixRates[p] * equipmentSuffixRates[s];
      if (variantUpper(p, s) !== Math.round(upper(weapon1.physicalAttack) * rate)) ladderOk = false;
      if (s + 1 < equipmentSuffixRates.length && variantUpper(p, s) >= variantUpper(p, s + 1)) ladderOk = false;
    }
    if (p + 1 < equipmentPrefixRates.length && variantUpper(p, 0) >= variantUpper(p + 1, 0)) ladderOk = false;
  }
  check(ladderOk, "weapon_1 全部 15 个变体：攻击上限 = 基础 × 前缀倍率 × 后缀倍率，且阶梯严格递增");
  const best = variantUpper(equipmentPrefixRates.length - 1, equipmentSuffixRates.length - 1);
  check(best === Math.round(upper(weapon1.physicalAttack) * 4.2), `顶配变体（超神·神级）= 基础 × 4.2（当前 ${best}）`);
  check(best > upper(weapon1.physicalAttack) * 4, "前后缀顶级与基础件差距超过 4 倍（变体强度一眼可辨）");

  console.log("\n=== 全套口径：①公式合计 ②实际可及 ===");
  // ① 七件套（各部位同级）合计 = setPowerRate × 裸属性上限（逐部位四舍五入允许 ±件数 的误差）
  const activeSlots = slots.filter((slot) => {
    let has = false;
    items.forEach((eq) => {
      if (isEquipment(eq) && eq.slot === slot) has = true;
    });
    return has;
  });
  check(activeSlots.length === 7, `配置里有装备的部位共 ${activeSlots.length} 个（weapon/cloth/helmet/belt/shoes/necklace/ring）`);
  const sumAttack = activeSlots.reduce((sum, slot) => sum + upper(equipmentStats(60, slot).physicalAttack), 0);
  const sumDefense = activeSlots.reduce((sum, slot) => sum + upper(equipmentStats(60, slot).physicalDefense), 0);
  check(Math.abs(sumAttack - equipmentGrowth.setPowerRate * role60.physicalAttack[1]) <= activeSlots.length, `攻击七件套合计 ${sumAttack} ≈ ${equipmentGrowth.setPowerRate} × 裸攻击上限 ${role60.physicalAttack[1]}`);
  check(Math.abs(sumDefense - equipmentGrowth.setPowerRate * role60.physicalDefense[1]) <= activeSlots.length, `防御七件套合计同样 ≈ setPowerRate × 裸防御上限`);
  // ② 玩家实际可及的一套：每个部位取「等级 ≤ 60 的最高档」——
  // 头盔/腰带/鞋子/项链/戒指目前只有 1 级件（素材缺口，issue #18），实际合计必然明显低于全套
  const reachable = {};
  let reachableAttack = 0;
  let fullAttack = 0;
  for (const slot of activeSlots) {
    let bestLevel = 0;
    items.forEach((eq) => {
      if (isEquipment(eq) && eq.slot === slot && eq.prefix === 0 && eq.suffix === 0 && eq.level <= 60 && eq.level > bestLevel) bestLevel = eq.level;
    });
    reachable[slot] = bestLevel;
    reachableAttack += upper(equipmentStats(bestLevel, slot).physicalAttack);
    fullAttack += upper(equipmentStats(60, slot).physicalAttack);
  }
  const sparseSlots = activeSlots.filter((slot) => reachable[slot] < 60);
  check(sparseSlots.length > 0, `缺口如实记录：${sparseSlots.join("/")} 的最高装备等级 = ${sparseSlots.map((slot) => reachable[slot]).join("/")}（不到 60 级，见 issue #18）`);
  check(reachableAttack < fullAttack, `玩家可及的攻 ${reachableAttack} < 全套攻 ${fullAttack}（口径①完美 ≠ 内容跟上了）`);

  finish("PASS：装备成长曲线的部位强度差 / 前后缀阶梯 / 等级成长 / 单调性与两套口径全部成立。");
}

main();

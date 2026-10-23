#!/usr/bin/env node
/**
 * 背包「叠加数量角标」回归单测（跑的是**真实配置表与真实判定函数**，不是复刻）
 *
 * 编译沙箱（把 configs 编成 CommonJS + cc 垫片）见 client/tools/lib/configs-sandbox.cjs ——
 * node 里直接调用真实的 `getItem` / `getStackBadge` / `getStackLimit` 跑断言。
 *
 * 盯的不变量（issue #15 验收）：
 * · 「可叠加」判据唯一来源 = 配置字段 stackable（不可叠加的装备永远不画角标，不靠数量反推）
 * · 数量 = 1（或缺省）不画角标 —— 一件就是一件，画个 1 是噪音
 * · 数量 > 1 画当前数量；数量达到单格上限 maxStack 时 full = true（渲染层据此换满叠色）
 * · 认不出的 id（配置表已下架）不画角标
 * · 真实配置：所有药品 / 材料可叠加且有上限，所有装备不可叠加（配置约定没有例外）
 *
 * 用法：node client/tools/test-bag-stack-badge.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-bag-stack-badge.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-bag-stack-badge");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items, getItem, getStackBadge, getStackLimit } = require(path.join(outDir, "configs/items.js"));
  const { GOOD_TYPE, isEquipment } = require(path.join(outDir, "types/good.js"));

  const countByType = (type) => {
    let total = 0;
    items.forEach((good) => {
      if (good.type === type) total++;
    });
    return total;
  };

  console.log("\n=== 判定：不可叠加（装备）永远不画 ===");
  const cloth = getItem("cloth_1");
  check(cloth && !cloth.stackable, "前置：cloth_1 配置为不可叠加");
  check(getStackBadge(cloth, 1) === null, "装备 count=1 → null");
  check(getStackBadge(cloth, 5) === null, "装备 count=5 → null（不可叠加没有数量概念）");
  check(getStackBadge(null, 5) === null, "认不出的 id（getItem 落空）→ null");

  console.log("\n=== 判定：可叠加物的显示规则 ===");
  const drug = getItem("drug_hp_1");
  check(drug && drug.stackable, "前置：drug_hp_1 配置为可叠加");
  check(getStackBadge(drug, undefined) === null, "数量缺省 → null");
  check(getStackBadge(drug, 0) === null, "数量 0（异常值按 1 兜底）→ null");
  check(getStackBadge(drug, 1) === null, "数量 = 1 → null（issue 验收：数量 1 不显示）");
  const half = getStackBadge(drug, 5);
  check(!!half && half.text === "5" && !half.full, "数量 5 → 画「5」且非满叠");
  const limit = getStackLimit(drug);
  const full = getStackBadge(drug, limit);
  check(!!full && full.text === String(limit) && full.full, `数量达上限 ${limit} → 画「${limit}」且 full = true`, `getStackLimit(drug_hp_1) = ${limit}`);

  console.log("\n=== 真实配置：全表扫一遍（约定没有例外）===");
  let drugOk = true;
  items.forEach((good) => {
    if (good.type === GOOD_TYPE.DRUG && (!good.stackable || getStackLimit(good) <= 1)) drugOk = false;
  });
  check(drugOk, `全部 ${countByType(GOOD_TYPE.DRUG)} 种药品可叠加且有上限（>1）`);
  let materialOk = true;
  items.forEach((good) => {
    if (good.type === GOOD_TYPE.MATERIAL && (!good.stackable || getStackLimit(good) <= 1)) materialOk = false;
  });
  check(materialOk, `全部 ${countByType(GOOD_TYPE.MATERIAL)} 种材料可叠加且有上限（>1）`);
  let equipmentOk = true;
  let equipmentCount = 0;
  items.forEach((good) => {
    if (!isEquipment(good)) return;
    equipmentCount++;
    if (good.stackable) equipmentOk = false;
  });
  check(equipmentOk, `全部 ${equipmentCount} 件装备不可叠加`);

  // 满叠与不满叠在真实配置上必须真的能区分开（否则 fullColor 永远不出现或永远出现）
  const drugFull = getStackBadge(drug, limit);
  const drugNotFull = getStackBadge(drug, Math.min(2, limit - 1));
  check(!!drugFull?.full && !drugNotFull?.full, "满叠与不满叠可区分（渲染层换色才有意义）");

  finish("PASS：角标判定与配置一致——装备与数量 1 不画、数量即文字、满叠可区分、全表约定无例外。");
}

main();

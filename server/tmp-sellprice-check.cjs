/** 临时自测（跑完即删）：覆盖层装「出厂值」时，卖价必须与生成物 SELL_PRICES 逐值相同 */
const g = require("./dist/shared/game-data.generated.js");
const ro = require("./dist/shared/runtime-overrides.js");

const attrCols = (a) => ({
  max_hp: a.maxHp,
  hp_recover: a.hpRecover,
  physical_attack_min: a.physicalAttack[0],
  physical_attack_max: a.physicalAttack[1],
  magic_attack_min: a.magicAttack[0],
  magic_attack_max: a.magicAttack[1],
  taoist_attack_min: a.taoistAttack[0],
  taoist_attack_max: a.taoistAttack[1],
  physical_defense_min: a.physicalDefense[0],
  physical_defense_max: a.physicalDefense[1],
  magic_defense_min: a.magicDefense[0],
  magic_defense_max: a.magicDefense[1],
  taoist_defense_min: a.taoistDefense[0],
  taoist_defense_max: a.taoistDefense[1],
});

const equipmentRows = Object.entries(g.EQUIPMENT_BASES).map(([id, meta]) => ({
  id,
  level: meta.level,
  ...attrCols(meta.attributes),
}));
const drugRows = Object.entries(g.DRUGS).map(([id, d]) => ({
  id,
  label: d.label,
  description: d.description,
  level: d.level,
  sell_price: d.sellPrice,
  max_stack: d.maxStack,
  cooldown: d.cooldown,
  effect_hp: d.hp,
  effect_mp: d.mp,
  effect_hp_percent: d.hpPercent,
  effect_mp_percent: d.mpPercent,
}));
const itemRows = Object.entries(g.ITEM_BASES).map(([id, d]) => ({
  id,
  label: d.label,
  description: d.description,
  level: d.level,
  sell_price: d.sellPrice,
  max_stack: d.maxStack,
}));

ro.applyEquipmentOverrides(equipmentRows);
ro.applyDrugOverrides(drugRows);
ro.applyItemOverrides(itemRows);

let mismatch = 0;
const samples = [];
for (const [id, price] of Object.entries(g.SELL_PRICES)) {
  const actual = ro.sellPriceOf(id);
  if (actual !== price) {
    mismatch += 1;
    if (samples.length < 8) samples.push(`${id}: 覆盖层 ${actual} vs 出厂 ${price}`);
  }
}
console.log(`逐值比对：${Object.keys(g.SELL_PRICES).length} 条价签，${mismatch} 条不一致`);
samples.forEach((line) => console.log("  ✗", line));

// 反向：不在价签里的 id 必须判「不可卖」
const notSellable = ["no_such_good", "quest_1", "cloth_2"];
const wrong = notSellable.filter((id) => ro.sellPriceOf(id) !== null);
console.log(`不可卖判定：${notSellable.length} 个样本，误判 ${wrong.length} 个 ${wrong.join(",")}`);

// 等级改价：把某件装备等级从 1 改到 50，回收价应变成 curve(50)（变体再乘倍率）
const base = equipmentRows[0];
const v0 = ro.sellPriceOf(base.id);
ro.applyEquipmentOverrides([{ ...base, level: 50 }, ...equipmentRows.slice(1)]);
const v50 = ro.sellPriceOf(base.id);
const variant50 = ro.sellPriceOf(`${base.id}_p4s2`);
console.log(`等级 1 → 50：${v0} → ${v50}（期望 ${g.EQUIPMENT_RECYCLE_PRICES[49]}）· p4s2 变体 ${variant50}（期望 ${Math.round(g.EQUIPMENT_RECYCLE_PRICES[49] * 1.4 * 3)}）`);

process.exitCode = mismatch === 0 && wrong.length === 0 ? 0 : 1;

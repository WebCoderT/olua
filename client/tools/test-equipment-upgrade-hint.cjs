// 装备槽「更好装备」提示与一键替换（issue #196）
//
// 角色信息弹窗的装备槽在「背包里有更好的可穿装备」时亮角标，点击角标直接换上。
// 按项目先例做两层断言：
// 1) 数据层真实行为：equipmentCombatValue（战斗力贡献口径）与 findBagEquipmentUpgrade
//    （扫背包取更优装备）借 configs-sandbox 跑真实配置表；
// 2) 接线：读源码静态断言角标点击 → StorageManager.equipBetterFromBag → equipFromBag，
//    以及背包变动后提示随 RoleUIManager.refreshBag 重算。

const fs = require("fs");
const path = require("path");
const { prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const ROOT = path.join(__dirname, "..");

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, "assets", rel), "utf8");
}

function main() {
  const outDir = prepare("olua-equip-upgrade-hint", []);
  const items = require(path.join(outDir, "configs/items.js"));
  const equipments = require(path.join(outDir, "configs/equipments.js"));
  const { EQUIPMENT_TYPE } = require(path.join(outDir, "types/good.js"));

  console.log("=== 数据层：equipmentCombatValue（战斗力贡献口径）===");
  const weapon1 = items.getItem("weapon_1");
  check(!!weapon1, "weapon_1 存在（测试前置）");
  // 手算期望值：权重表 configs/battle.combatCalc = 攻 5 ×3 / 防 10 ×3 / maxHp 15，
  // 区间型属性取上下限之和 —— 这份期望值钉死了口径，权重表或实现任一方漂移都会红
  const expected =
    (weapon1.physicalAttack[0] + weapon1.physicalAttack[1]) * 5 +
    (weapon1.magicAttack[0] + weapon1.magicAttack[1]) * 5 +
    (weapon1.taoistAttack[0] + weapon1.taoistAttack[1]) * 5 +
    (weapon1.physicalDefense[0] + weapon1.physicalDefense[1]) * 10 +
    (weapon1.magicDefense[0] + weapon1.magicDefense[1]) * 10 +
    (weapon1.taoistDefense[0] + weapon1.taoistDefense[1]) * 10 +
    weapon1.maxHp * 15;
  check(equipments.equipmentCombatValue(weapon1) === expected, "战斗力贡献 = 权重 × 区间上下限之和 + maxHp × 权重（手算逐项核对）");
  // hpRecover 不计入口径（与战斗力一致：回血不算战斗力）
  const withRecover = Object.assign({}, weapon1, { hpRecover: 99999 });
  check(equipments.equipmentCombatValue(withRecover) === equipments.equipmentCombatValue(weapon1), "hpRecover 不计入战斗力贡献（回血不算战斗力）");
  // 前缀变体严格更强（quality 曲线单调 → 提示只在真变强时出现）
  const variant = items.getItem(equipments.getEquipmentVariantKey("weapon_1", 1, 0));
  check(!!variant && equipments.equipmentCombatValue(variant) > equipments.equipmentCombatValue(weapon1), "前缀变体的战斗力贡献严格高于基础件");

  console.log("=== 数据层：findBagEquipmentUpgrade（扫背包取更优装备）===");
  const canUse = () => true; // 可穿判定由调用方注入，单测里用恒真桩
  const weapon1Value = equipments.equipmentCombatValue(weapon1);
  const weapon2 = items.getItem("weapon_2");
  const weapon3 = items.getItem("weapon_3");
  // 前置：武器按等级单调变强（ configs/growth.equipmentStats 单调曲线）
  check(
    equipments.equipmentCombatValue(weapon3) > equipments.equipmentCombatValue(weapon2) && equipments.equipmentCombatValue(weapon2) > weapon1Value,
    "weapon_1 < weapon_2 < weapon_3（等级曲线单调，测试前置）",
  );

  const mk = (id, count = 1) => ({ id, count });
  const mkBag = (rows) => rows.map((row) => row.map((cell) => (cell ? mk(...[].concat(cell)) : null)));

  // 1. 背包里有更好的武器 → 返回那一格
  const bag1 = mkBag([[["drug_hp_1", 5], null, ["weapon_2"]], [null, null, null]]);
  const hit1 = items.findBagEquipmentUpgrade(bag1, EQUIPMENT_TYPE.WEAPON, canUse, weapon1);
  check(!!hit1 && hit1.row === 0 && hit1.col === 2 && hit1.equipment.id === "weapon_2", "背包里有更强的同槽位装备 → 返回那一格与装备本体");
  check(JSON.stringify(bag1) === JSON.stringify(mkBag([[["drug_hp_1", 5], null, ["weapon_2"]], [null, null, null]])), "纯函数不改入参背包");

  // 2. 只解析同槽位装备：药品、其他槽位装备、认不出的 id 一概跳过
  const cloth = items.getItem("cloth_1");
  check(!!cloth && cloth.slot !== EQUIPMENT_TYPE.WEAPON, "cloth_1 存在且不是武器（测试前置）");
  const bag2 = mkBag([[["drug_hp_1", 5], ["cloth_1"], ["no_such_item"]], [["weapon_1"]]]);
  const hit2 = items.findBagEquipmentUpgrade(bag2, EQUIPMENT_TYPE.WEAPON, canUse, null);
  check(!!hit2 && hit2.row === 1 && hit2.col === 0, "药品/他槽位装备/认不出的 id 全部跳过，只认同槽位装备");

  // 3. 不可穿的不提示（canUse 注入 false）
  const bag3 = mkBag([[["weapon_3"]]]);
  check(items.findBagEquipmentUpgrade(bag3, EQUIPMENT_TYPE.WEAPON, () => false, weapon1) === null, "不可穿（等级/性别/职业不符）→ 不提示");

  // 4. 槽位为空：任何可穿的同槽位装备都算提升，取最强的一件
  const bag4 = mkBag([[["weapon_2"]], [["weapon_3"], null]]);
  const hit4 = items.findBagEquipmentUpgrade(bag4, EQUIPMENT_TYPE.WEAPON, canUse, null);
  check(!!hit4 && hit4.equipment.id === "weapon_3", "空槽位时任何可穿件都算提升，多件取战斗力最高的一件");

  // 5. 「严格大于」：战斗力相同的装备不提示（避免无意义换装）
  const bag5 = mkBag([[["weapon_1"]]]);
  check(items.findBagEquipmentUpgrade(bag5, EQUIPMENT_TYPE.WEAPON, canUse, weapon1) === null, "战斗力不高于穿戴件 → 不提示（严格大于口径）");

  // 6. 越界/空背包安全
  check(items.findBagEquipmentUpgrade([], EQUIPMENT_TYPE.WEAPON, canUse, null) === null, "空背包 → null");
  check(items.findBagEquipmentUpgrade([[null, null]], EQUIPMENT_TYPE.WEAPON, canUse, null) === null, "全空格背包 → null");

  console.log("=== 接线：角标点击 → 数据层 → 背包变动刷新（源码静态断言）===");
  const storage = readSrc("ui/core/StorageManager.ts");
  check(/static findBetterEquipmentInBag\(slot: EQUIPMENT_TYPE\)/.test(storage) && /findBagEquipmentUpgrade\(/.test(storage), "StorageManager.findBetterEquipmentInBag 包装纯函数（注入角色与可穿判定）");
  check(/static equipBetterFromBag\(slot: EQUIPMENT_TYPE\)/.test(storage) && /equipBetterFromBag[\s\S]*?findBetterEquipmentInBag[\s\S]*?equipFromBag\(/.test(storage), "StorageManager.equipBetterFromBag = 找更优格 + 复用 equipFromBag 换装（旧装备回原格）");

  const group = readSrc("ui/components/panel/EquipmentSlotGroup.ts");
  check(/attachUpgradeHint\(slot, type\)/.test(group) && /updateSlot\(type: EQUIPMENT_TYPE/.test(group), "EquipmentSlotGroup.updateSlot 清格子后重挂角标（clearChildren 会销毁子节点）");
  check(/if \(button === "left"\) this\.onEquipBetter\(type\)/.test(group), "角标左键 → onEquipBetter（右键脱下监听不受冒泡影响）");
  check(/updateUpgradeHint\(type: EQUIPMENT_TYPE, visible: boolean\)/.test(group), "角标显隐由 updateUpgradeHint 控制（创建时默认隐藏）");

  const dialog = readSrc("ui/components/dialogs/RoleInfoDialog.ts");
  check(/StorageManager\.equipBetterFromBag\(type\)/.test(dialog), "RoleInfoDialog 把角标点击接到 equipBetterFromBag");
  check(/refreshHints\(\)/.test(dialog) && (dialog.match(/this\.refreshHints\(\)/g) || []).length >= 2, "RoleInfoDialog 在 open 与 updateDialog 里都重算提示");

  const manager = readSrc("ui/core/RoleUIManager.ts");
  check(/static refreshBag\(\)[\s\S]{0,200}?roleInfoDialog\?\.refreshHints\(\)/.test(manager), "RoleUIManager.refreshBag 顺带重算弹窗提示（拾取/丢弃/回收/换装后提示实时刷新）");

  const panels = readSrc("configs/layout/panels.ts");
  check(/upgradeHint: \{/.test(panels) && /position: new Vec2\(19, 19\)/.test(panels), "角标几何进 configs/layout/panels.equipmentSlotLayout.upgradeHint（组件只引用不自带坐标）");
  const texts = readSrc("configs/texts.ts");
  check(/label_equip_upgrade_hint: "换"/.test(texts), "角标文案进 configs/texts（玩家中文不出 ui/，见 audit-config-leak）");
  const helper = readSrc("ui/helpers/GameUiHelper.ts");
  check(/getText\("label_equip_upgrade_hint"\)/.test(helper) && /circle\(0, 0, layout\.size\.width \/ 2\)/.test(helper), "GameUiHelper.createEquipmentUpgradeHint 用 Graphics 圆底 + 文案表文案");

  finish("装备升级提示：数据层行为与接线全部符合口径");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

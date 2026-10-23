// 背包装备详情「按住 Ctrl 与身上穿戴对比」（issue #198）
//
// 悬停背包中的装备、按住左侧 Ctrl 时，详情弹窗在属性列表下方追加与身上穿戴件的逐项对比；
// 身上该槽位没穿（或悬停的就是身上那件）时不显示对比。按项目先例做两层断言：
// 1) 数据层真实行为：equipmentAttributeDiffs（逐项差值）与 formatSignedAttributeValue
//    （带符号格式化）借 configs-sandbox 跑真实配置表；
// 2) 接线：读源码静态断言 Ctrl 状态模块、悬停重建与退订、背包格子注入对比源、
//    身上装备槽/商城不接对比、文案与配色走配置。

const fs = require("fs");
const path = require("path");
const { prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const ROOT = path.join(__dirname, "..");

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, "assets", rel), "utf8");
}

function main() {
  const outDir = prepare("olua-equip-compare", ["configs/good.ts"]);
  const items = require(path.join(outDir, "configs/items.js"));
  const equipments = require(path.join(outDir, "configs/equipments.js"));
  const good = require(path.join(outDir, "configs/good.js"));

  console.log("=== 数据层：formatSignedAttributeValue（带符号格式化）===");
  const fmt = equipments.formatSignedAttributeValue;
  check(fmt(5) === "+5", "正数带 + 号");
  check(fmt(0) === "0", "零原样（持平不写 +0）");
  check(fmt(-3) === "-3", "负数自带负号");
  check(fmt([4, 4]) === "+4", "区间两端相等只显示一个数（装备是固定值）");
  check(fmt([2, -1]) === "+2 / -1", "区间不等逐端加号、斜杠分隔");

  console.log("=== 数据层：equipmentAttributeDiffs（逐项差值）===");
  const weapon1 = items.getItem("weapon_1");
  const weapon2 = items.getItem("weapon_2");
  check(!!weapon1 && !!weapon2, "weapon_1 / weapon_2 存在（测试前置）");
  const keys = ["physicalAttack", "magicAttack", "maxHp", "hpRecover"];
  const diffs = equipments.equipmentAttributeDiffs(keys, weapon2, weapon1);
  check(diffs.length === 4 && diffs[0].key === "physicalAttack" && diffs[3].key === "hpRecover", "按传入 key 顺序逐项输出（顺序即显示顺序）");
  // 手算核对：区间属性逐端相减、单值属性直接相减
  const pa = diffs[0];
  check(
    JSON.stringify(pa.worn) === JSON.stringify(weapon1.physicalAttack) &&
      JSON.stringify(pa.value) === JSON.stringify(weapon2.physicalAttack) &&
      pa.delta[0] === weapon2.physicalAttack[0] - weapon1.physicalAttack[0] &&
      pa.delta[1] === weapon2.physicalAttack[1] - weapon1.physicalAttack[1],
    "区间属性：worn/value 原样透传，delta 逐端 = 候选 − 穿戴",
  );
  const hp = diffs[2];
  check(typeof hp.delta === "number" && hp.delta === weapon2.maxHp - weapon1.maxHp, "单值属性（maxHp）：delta = 候选 − 穿戴");
  const rec = diffs[3];
  check(typeof rec.delta === "number" && rec.delta === weapon2.hpRecover - weapon1.hpRecover, "单值属性（hpRecover）同样参与对比（是否显示由槽位属性表决定）");
  // 反向对比：差值整体翻负，着色方据此判「变弱」
  const reversed = equipments.equipmentAttributeDiffs(keys, weapon1, weapon2);
  check(equipments.formatSignedAttributeValue(reversed[0].delta).startsWith("-"), "反向对比差值为负（着色方据此标红）");
  // 战斗力口径与对比行同源：weapon_2 贡献严格高于 weapon_1，对比行才能显示「变强」
  check(equipments.equipmentCombatValue(weapon2) > equipments.equipmentCombatValue(weapon1), "战斗力贡献：weapon_2 > weapon_1（对比行与「更好装备」提示同一口径）");
  // 槽位显示属性表确实包含 hpRecover 的部位（腰带）也包含区间与单值两类（口径核对）
  const beltKeys = good.goodShowAttributes.get("belt");
  check(Array.isArray(beltKeys) && beltKeys.includes("maxHp") && beltKeys.includes("hpRecover") && beltKeys.includes("physicalDefense"), "goodShowAttributes（腰带）覆盖区间与单值属性，顺序即对比显示顺序");

  console.log("=== 接线：Ctrl 状态 → 悬停重建 → 背包注入对比源（源码静态断言）===");
  const modifier = readSrc("ui/utils/input/ModifierKeys.ts");
  check(/KeyCode\.CTRL_LEFT/.test(modifier), "ModifierKeys 只认左侧 Ctrl（KeyCode.CTRL_LEFT，右侧不触发）");
  check(/Input\.EventType\.KEY_DOWN[\s\S]*Input\.EventType\.KEY_UP/.test(modifier), "KEY_DOWN/KEY_UP 双向跟踪按住/松开");
  check(/if \(pressed === ctrlPressed\) return;/.test(modifier), "状态未变不通知（按住不松连发 KEY_DOWN 不会狂重建弹窗）");
  check(/export function isCtrlPressed/.test(modifier) && /ctrlListeners\.delete\(listener\)/.test(modifier), "isCtrlPressed 读状态、onCtrlChange 返回退订函数");

  const helper = readSrc("ui/helpers/GameUiHelper.ts");
  check(/createGoodDetailDialog\(good: Goods, anchor: Node, compare: Equipment \| "hint" \| null = null\)/.test(helper), "createGoodDetailDialog 第三参 = 对比模式（装备 / hint / null）");
  check(/onCtrlChange\(handleCtrlChange\)/.test(helper) && /unsubscribeCtrl\?\.\(\)/.test(helper), "悬停期间订阅 Ctrl 变化整窗重建，关闭时退订（MOUSE_LEAVE/节点销毁都收）");
  check(/worn\.id !== good\.id/.test(helper), "悬停的就是身上那件 → 不显示对比（全等差值是噪音）");
  check(/createGoodCompareSection\(good as Equipment, compare\)/.test(helper) && /equipmentAttributeDiffs\(goodShowAttributes\.get\(good\.slot\)/.test(helper), "对比段按槽位显示属性逐项出「旧值 → 新值（±差）」");
  check(/label_good_detail_compare_combat/.test(helper) && /equipmentCombatValue\(worn\)/.test(helper), "对比段含战斗力行（与「更好装备」提示同一口径）");

  const storage = readSrc("ui/core/StorageManager.ts");
  check(/static getWornEquipment\(slot: EQUIPMENT_TYPE\): Equipment \| null/.test(storage), "StorageManager.getWornEquipment = 对比数据源（未穿戴返回 null）");

  const bag = readSrc("ui/components/panel/BagGridView.ts");
  check(/compareWornProvider: \(\) => \(isEquipment\(good\) \? StorageManager\.getWornEquipment\(good\.slot\) : null\)/.test(bag), "背包格子注入对比源（非装备不比）");
  const group = readSrc("ui/components/panel/EquipmentSlotGroup.ts");
  check(/GameUiHelper\.createGood\(slot, equipment\)/.test(group), "身上装备槽不传 compareWornProvider（身上不与自己比）");
  const mall = readSrc("ui/components/dialogs/MallDialog.ts");
  check(/createGoodDetailDialog\(good, anchor\)/.test(mall), "商城详情走两参调用（不接对比）");

  const texts = readSrc("configs/texts.ts");
  check(
    /label_good_detail_compare_title: "对比 · 身上穿戴"/.test(texts) &&
      /label_good_detail_compare_row: "\{worn\} → \{value\}（\{delta\}）"/.test(texts) &&
      /label_good_detail_compare_hint: "按住 Ctrl 与身上装备对比"/.test(texts) &&
      /label_combat: "战斗力"/.test(texts),
    "对比相关文案全部进 configs/texts（玩家中文不出 ui/，见 audit-config-leak）",
  );
  const dialogs = readSrc("configs/layout/dialogs.ts");
  check(
    /compare: \{/.test(dialogs) && /gainColor: new Color\(120, 220, 120\)/.test(dialogs) && /lossColor: new Color\(255, 80, 80\)/.test(dialogs) && /sameColor: new Color\(170, 170, 170\)/.test(dialogs),
    "对比配色进 configs/layout/dialogs.goodDetailLayout.compare（变强绿 / 变弱红 / 持平灰）",
  );

  finish("Ctrl 装备对比：数据层行为与接线全部符合口径");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

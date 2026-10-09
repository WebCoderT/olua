#!/usr/bin/env node
/**
 * 新手背包预置的自动化验证：跑**真实的 getNewRoleEquipments + 真实的 Role 构造函数**
 * （沙箱见 client/tools/lib/storage-sandbox.cjs，它编译真 configs 与真 entities/Role）
 *
 * 需求口径：**建号时把 1 级武器的全部前后缀变体都放进背包**
 * （1 级只有 weapon_1 一件 → 15 个品质：普通的·人级 … 超神的·神级；出生就能对比外观与边框）
 *
 * 盯的不变量（改新手物品清单 / 背包容量后必须全绿）：
 * · 1 级武器的 15 个变体**一个不少、一个不重**地进背包，每格数量 1
 * · 清单里的每一件都能被物品总表解析（没有幽灵 id）
 * · 清单长度 ≤ 背包容量（超出的会被 Role 构造函数丢弃，必须在这里先炸出来）
 * · 通用件 + 全部基础武器 + 全部基础衣服仍然照发（别为了加变体把原有东西挤掉）
 * · 背包结构仍是 bagRow × bagCol，空格为 null；两个角色互不共享数组
 *
 * 用法：node client/tools/test-new-role-bag.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareStorage } = require("./lib/storage-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ROLE_CONFIG_FILE = path.join(PROJECT_ROOT, "assets/configs/role.ts");
const EQUIPMENTS_FILE = path.join(PROJECT_ROOT, "assets/configs/equipments.ts");
const ROLE_ENTITY_FILE = path.join(PROJECT_ROOT, "assets/entities/Role.ts");

let sandbox;
try {
  sandbox = prepareStorage("olua-new-role-bag");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}
const { Role, outDir } = sandbox;

// 先加载物品总表：registerItem 会给配置对象补上 id（Role 构造函数靠它写格子），
// 所以必须在调用 getNewRoleEquipments 之前 require 一次
const { items, getItem, getEquipment } = require(path.join(outDir, "configs/items.js"));
const { getEquipmentsByLevel, getBaseEquipments, weapons, clothes } = require(path.join(outDir, "configs/equipments.js"));
const { getNewRoleEquipments, newRoleVariantWeaponLevel, bagRow, bagCol } = require(path.join(outDir, "configs/role.js"));

const VARIANT_LEVEL = newRoleVariantWeaponLevel;

console.log("— 配置层：1 级武器的全部前后缀变体 —");

const levelWeapons = getEquipmentsByLevel(weapons, VARIANT_LEVEL);
const variantKey = (eq) => `${eq.prefix}-${eq.suffix}`;

check(VARIANT_LEVEL === 1, "预置等级取 1 级（configs/role.newRoleVariantWeaponLevel）", `= ${VARIANT_LEVEL}`);
check(levelWeapons.length === 15, `${VARIANT_LEVEL} 级武器共 15 件（1 件基础 × 5 前缀 × 3 后缀）`, `${levelWeapons.length} 件`);
check(
  new Set(levelWeapons.map(variantKey)).size === 15,
  "15 件的前缀×后缀组合互不重复",
  [...new Set(levelWeapons.map(variantKey))].join(" "),
);
{
  const expected = [];
  for (let p = 0; p <= 4; p++) for (let s = 0; s <= 2; s++) expected.push(`${p}-${s}`);
  const actual = levelWeapons.map(variantKey).sort();
  check(actual.join() === expected.sort().join(), "前缀 0~4 × 后缀 0~2 全组合覆盖（没有缺档）");
}
check(levelWeapons.every((eq) => eq.level === VARIANT_LEVEL), "这 15 件全是该等级的装备（等级=佩戴门槛，变体与基础件同级）");
check(levelWeapons.every((eq) => eq.id), "15 件都带 id（未注册进物品总表的条目会在建号时被静默跳过）");
check(levelWeapons.length < weapons.size, "只取该等级（不是把武器的全部 15 倍变体都发出去）", `${levelWeapons.length} / ${weapons.size}`);

console.log("— 新手物品清单：getNewRoleEquipments —");

const list = getNewRoleEquipments("1", "1");
const ids = list.map((eq) => eq.id);
const countOf = (id) => ids.filter((value) => value === id).length;
const variantIds = levelWeapons.map((eq) => eq.id);

check(ids.every(Boolean), "清单里每一件都已注册（都有 id）");
check(variantIds.every((id) => countOf(id) === 1), `15 个变体在清单里各出现一次`, `缺 ${variantIds.filter((id) => countOf(id) !== 1).join("/") || "无"}`);
check(new Set(ids).size === ids.length, "清单里没有重复 id（基础件不会被变体再发一遍）");
check(list.length === 5 + getBaseEquipments(weapons).length + getBaseEquipments(clothes).length + 14, "清单 = 通用件 5 + 全部基础武器 + 全部基础衣服 + 1 级武器其余 14 个变体", `${list.length} 件`);
check(list.every((eq) => getEquipment(eq.id)), "清单里每一件都能被物品总表解析（无幽灵 id）");
check(ids.includes("weapon_1"), "基础件 weapon_1（普通的·人级）仍在清单里");
check(list.length <= bagRow * bagCol, "清单长度不超背包容量（超出的会被 Role 构造函数丢弃）", `${list.length} ≤ ${bagRow * bagCol}`);

console.log("— 角色实体：建号后背包里到底有什么 —");

const role = new Role("探针", "1", "1");
const flattened = [];
role.bag.forEach((row) => row.forEach((cell) => flattened.push(cell)));
const bagIds = flattened.filter(Boolean).map((cell) => cell.id);

check(role.bag.length === bagRow && role.bag[0].length === bagCol, "背包结构 = bagRow × bagCol", `${role.bag.length} × ${role.bag[0].length}`);
check(variantIds.every((id) => bagIds.includes(id)), "15 个 1 级武器变体全部进了背包", `实际 ${variantIds.filter((id) => bagIds.includes(id)).length} / 15`);
check(variantIds.every((id) => bagIds.filter((value) => value === id).length === 1), "每个变体只占一格（没有重复发）");
check(flattened.filter(Boolean).every((cell) => cell.count === 1), "每格数量都是 1（装备不可叠加）");
check(flattened.filter(Boolean).every((cell) => getItem(cell.id)), "背包每一格都能被物品总表解析（没有死格子）");
check(bagIds.length === list.length, "背包里的件数 = 清单件数（没有溢出丢弃）", `${bagIds.length} / ${list.length}`);
check(flattened.slice(bagIds.length).every((cell) => cell === null), "剩余格子全是空的（物品从第一格起连续摆放）");

// 各职业/性别都成立（目前预置清单不区分职业，这条是防止以后按职业筛时漏掉）
["1", "2", "3"].forEach((occupation) => {
  const probe = new Role(`探针${occupation}`, occupation, "2");
  const probeIds = [];
  probe.bag.forEach((row) => row.forEach((cell) => cell && probeIds.push(cell.id)));
  check(variantIds.every((id) => probeIds.includes(id)), `职业 ${occupation} 建号同样拿到 15 个变体`);
});

// 两个角色的背包必须各自独立（共用同一份数组会在改一个角色的背包时污染另一个）
{
  const a = new Role("甲", "1", "1");
  const b = new Role("乙", "1", "1");
  a.bag[0][0] = null;
  check(b.bag[0][0] !== null, "两个角色的背包互不影响（不是同一个数组）");
  check(a.bag !== b.bag && a.bag[0] !== b.bag[0], "背包的容器也是各自新建的");
}

console.log("— 源码接线：别把这条口径改回去 —");

const roleSource = fs.readFileSync(ROLE_CONFIG_FILE, "utf8");
const equipmentsSource = fs.readFileSync(EQUIPMENTS_FILE, "utf8");
const entitySource = fs.readFileSync(ROLE_ENTITY_FILE, "utf8");

check(/getEquipmentsByLevel\(weapons, newRoleVariantWeaponLevel\)/.test(roleSource), "新手清单按配置等级取武器变体");
check(/if \(weapon\.prefix === EQUIPMENT_PREFIX\.NORMAL && weapon\.suffix === EQUIPMENT_SUFFIX\.MORTAL\) return;/.test(roleSource), "基础件（普通的·人级）不重复发（上面已发过）");
check(/export function getEquipmentsByLevel\(map: Map<string, Equipment>, level: number\): Equipment\[\]/.test(equipmentsSource), "按等级取装备的查询函数在 equipments 里（配置层的唯一来源）");
{
  const body = equipmentsSource.slice(equipmentsSource.indexOf("export function getEquipmentsByLevel"));
  check(/map\.forEach\(/.test(body.slice(0, 400)) && !/\[\.\.\.map/.test(body.slice(0, 400)), "用 map.forEach 遍历（loose 编译会毁掉 [...map.values()]）");
}
check(/if \(newRoleItems\.length > capacity\)/.test(entitySource), "Role 构造函数对超容量的新手物品留日志（不静默丢弃）");
check(/newRoleItems\.slice\(0, capacity\)\.forEach/.test(entitySource), "写格子前先按容量截断（绝不越界写 bag[row]）");

finish(`PASS：新手背包预置（${VARIANT_LEVEL} 级武器的 15 个前后缀变体）数据与接线全部通过。`);

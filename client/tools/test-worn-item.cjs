// 装备槽存对象（#816 后半）回归
//
// 背景：`equipments` 的槽位从「裸 id」改成 `{ id, bound?, from? }`。
// 为什么必须带元数据：`bound`（绑定角色 / 不可交易）与 `from`（掉落溯源）是**这件东西的属性**，
// 槽位只存 id 时，穿上去那一刻就被清掉 —— 脱下来变成一件未绑定、无溯源的新东西，
// 「穿一次就洗白」（与「五瓶绑定药用到剩一瓶变可交易」是同一个病，#789/#816 修的前半）。
//
// 断言分两层（与 test-bag-bind 同一套做法）：
//   A. 数据层真实行为：借 configs-sandbox 跑真实 configs/items 的 `wornIdOf` / `wornItemOf`；
//   B. 接线：读源码静态断言（槽位读法只有一处出口）。
//
// 显示效果（槽位图标、内观、头顶外观）一律人眼看，这里只钉「读哪个字段、走哪条分支」。

const fs = require("fs");
const path = require("path");
const { prepare } = require("./lib/configs-sandbox.cjs");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function check(ok, label) {
  if (ok) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.log(`❌ ${label}`);
  }
}

function finish(summary) {
  console.log(`\n${summary}`);
  console.log(`通过 ${passed} 条，失败 ${failed} 条`);
  if (failed > 0) process.exit(1);
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, "assets", rel), "utf8");
}

/** 抓取方法/函数体（从签名起，到配对大括号） */
function extractBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  let paren = 0;
  let i = src.indexOf("(", start);
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return null;
}

function main() {
  const outDir = prepare("olua-worn-item", ["configs/items.ts"]);
  const { wornIdOf, wornItemOf, bagMetaOf } = require(path.join(outDir, "configs/items.js"));

  //#region A. 数据层：wornIdOf（读 id 的唯一出口）

  console.log("=== 数据层：wornIdOf 认新形状，也认老形状 ===");
  check(wornIdOf({ id: "cloth_1" }) === "cloth_1", "新形状：{ id } → id");
  check(wornIdOf({ id: "  cloth_1  " }) === "cloth_1", "id 两端空白被 trim（存档里出现过带空格的 id）");
  check(wornIdOf("cloth_1") === "cloth_1", "老档 / 远端互见帧：裸字符串 → id");
  check(wornIdOf({ id: "cloth_1", bound: true }) === "cloth_1", "带元数据时照常取 id（元数据不影响解析）");
  check(wornIdOf(null) === null, "null（空槽）→ null");
  check(wornIdOf(undefined) === null, "undefined（缺键的老档）→ null");
  check(wornIdOf("") === null, "空串（服务端历史形状的空槽）→ null");
  check(wornIdOf("   ") === null, "全空白串 → null");
  check(wornIdOf({}) === null, "对象但没有 id → null（半截对象不让它变成一件装备）");
  check(wornIdOf({ id: 5 }) === null, "id 不是字符串 → null（存档里的脏值不猜）");
  check(wornIdOf({ id: "" }) === null, "id 是空串 → null");

  //#endregion

  //#region A. 数据层：wornItemOf（读档迁移的入口）

  console.log("\n=== 数据层：wornItemOf 把三种老形状收敛成对象 ===");
  const origin = { role: "张三", monster: "monster_1", at: 1700000000000 };

  const fromBare = wornItemOf("weapon_1");
  check(fromBare && fromBare.id === "weapon_1", "裸 id（v2 存档）→ { id }");
  check(fromBare && !("bound" in fromBare) && !("from" in fromBare), "裸 id 迁移后不多出 bound / from 键（存档不虚胖）");

  const fromFull = wornItemOf({ id: "weapon_1", bound: true, from: origin });
  check(fromFull && fromFull.id === "weapon_1" && fromFull.bound === true, "对象：id 与 bound 原样保留");
  check(fromFull && fromFull.from && fromFull.from.monster === "monster_1", "对象：溯源原样保留");
  check(fromFull && fromFull.from !== origin, "溯源是副本（不把引用带走，改结果不污染入参）");

  // #597 之前的存档：槽位里放的是**完整物品快照**（有 type / count / 一大堆数值）
  const fromSnapshot = wornItemOf({ id: "cloth_1", type: "equipment", count: 1, slot: "cloth", label: "布衣" });
  check(fromSnapshot && fromSnapshot.id === "cloth_1", "完整快照对象 → 只留 id（元数据那时候还不存在）");
  check(fromSnapshot && Object.keys(fromSnapshot).length === 1, "快照迁移后只剩 id 一个键（不把快照字段带进存档）");

  check(wornItemOf({ id: "weapon_1", bound: "1" }) && !("bound" in wornItemOf({ id: "weapon_1", bound: "1" })), "bound 只认 true（\"1\" 这类脏值一律当未绑定）");
  check(!("bound" in wornItemOf({ id: "weapon_1", bound: 1 })), "bound 是数字 1 也不算绑定（只认布尔 true）");
  check(wornItemOf(null) === null && wornItemOf(undefined) === null, "null / undefined → 空槽");
  check(wornItemOf("") === null && wornItemOf("   ") === null, "空串 → 空槽（服务端历史形状）");
  check(wornItemOf(42) === null && wornItemOf([]) === null, "数字 / 数组 → 空槽（形状不对就当没穿）");
  check(wornItemOf({}) === null, "{} → 空槽");

  // 幂等：迁移链可能重跑（惰性迁移 + 脚本各跑一次），对象再进去必须一模一样
  const twice = wornItemOf(wornItemOf({ id: "weapon_1", bound: true, from: origin }));
  check(JSON.stringify(twice) === JSON.stringify(fromFull), "幂等：对象再迁一次结果不变（重跑不会磨掉元数据）");

  //#endregion

  //#region A. 数据层：元数据口径与背包格子是同一份

  console.log("\n=== 数据层：槽位与格子共用 bagMetaOf（口径只有一份）===");
  const cellMeta = bagMetaOf({ id: "weapon_1", count: 1, bound: true, from: origin });
  const wornMeta = bagMetaOf({ id: "weapon_1", bound: true, from: origin });
  check(
    JSON.stringify(cellMeta) === JSON.stringify(wornMeta),
    "同一件东西：背包格子与装备槽位取到的元数据完全一致（穿脱只换地方、不改值）",
  );
  check(bagMetaOf(null) && Object.keys(bagMetaOf(null)).length === 0, "bagMetaOf(null) 返回空元数据（不抛异常）");

  //#endregion

  //#region B. 接线：类型、读档迁移、读取出口

  console.log("\n=== 接线：存档形状与读取出口 ===");
  const roleSrc = readSrc("entities/Role.ts");
  check(/equipments: \{ \[key in EQUIPMENT_TYPE\]: WornItem \| null \}/.test(roleSrc), "Role.equipments 的类型是 WornItem | null（不是 string）");
  check(/import \{[^}]*WornItem[^}]*\} from "\.\.\/types\/good"/.test(roleSrc), "Role 从 types/good 引 WornItem");

  const goodSrc = readSrc("types/good.ts");
  check(/export interface WornItem \{/.test(goodSrc), "types/good 里声明了 WornItem（与 BagCell 同一个 BagOrigin）");
  check(/bound\?: boolean;/.test(goodSrc) && /from\?: BagOrigin;/.test(goodSrc), "WornItem 带 bound / from 两个可选字段");

  const storageSrc = readSrc("ui/core/StorageManager.ts");
  const ensureBody = extractBody(storageSrc, "static ensureRoleDefaults(");
  check(!!ensureBody, "找到 StorageManager.ensureRoleDefaults");
  check(!!ensureBody && ensureBody.includes("wornItemOf("), "读档把槽位规整成对象（wornItemOf）");
  check(!!ensureBody && !/\(value as Goods\)\.id \?\? null/.test(ensureBody), "不再把槽位对象折叠成裸 id（那正是丢元数据的老写法）");
  check(
    !!ensureBody && /withBagMeta\(id, count, bagMetaOf\(/.test(ensureBody),
    "背包读档保留 bound / from（否则重登一次，详情弹窗的「已绑定」与溯源就没了）",
  );

  // 读取出口：全部经 wornIdOf（一处漏了就是「槽位显示成空 / 外观变光着」）
  const wornIdSites = [
    ["ui/core/PreloadManager.ts", "预加载：角色外观帧（衣服 + 武器）"],
    ["ui/components/panel/RoleInShowView.ts", "内观：衣服与武器"],
    ["ui/components/dialogs/RoleInfoDialog.ts", "角色信息弹窗：槽位图标"],
    ["ui/components/panel/EquipmentSlotGroup.ts", "装备槽分组：槽位图标"],
  ];
  for (const [file, label] of wornIdSites) {
    const src = readSrc(file);
    check(/getEquipment\(wornIdOf\(/.test(src), `${label}：getEquipment 前经 wornIdOf 取 id`);
    check(!/getEquipment\((role|equipments)\.equipments\[/.test(src), `${label}：没有残留「直接把槽位值当 id」的读法`);
  }
  check(/return getEquipment\(wornIdOf\(this\.findOnlineRole\(\)\?\.equipments\[slot\]\)\)/.test(storageSrc), "StorageManager.getWornEquipment：经 wornIdOf");
  check(/getEquipment\(wornIdOf\(role\.equipments\[slot\]\)\)/.test(storageSrc), "findBetterEquipmentInBag：对比基准也经 wornIdOf");
  check(/!wornIdOf\(role\.equipments\[slot\]\)/.test(storageSrc), "unequipToBag：空槽判定用 wornIdOf（「有对象」不等于「有 id」）");

  const appearSrc = readSrc("ui/components/role/RoleAppearance.ts");
  check(/equipments: \{ cloth: WornItem \| null; weapon: WornItem \| null \}/.test(appearSrc), "RoleOutSource 收的是槽位对象（主角与远端玩家走同一份取源逻辑）");
  check((appearSrc.match(/getEquipment\(wornIdOf\(source\.equipments\./g) || []).length === 2, "外观两处（衣服 / 武器）都经 wornIdOf");

  const otherSrc = readSrc("ui/core/OtherPlayerManager.ts");
  check(/cloth: worn\(appearance\.c\)/.test(otherSrc), "远端玩家：互见帧的 id 包成 { id }（c = cloth，#768 缩写；协议里只有 id，没有元数据）");
  check(/const worn = \(id: string\) => \(id \? \{ id \} : null\);/.test(otherSrc), "远端玩家：空串 → null（协议用空串表示没穿）");

  //#endregion

  finish("装备槽存对象（#816）：以上断言");
}

main();

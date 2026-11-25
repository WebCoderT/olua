#!/usr/bin/env node
/**
 * 背包自动化纯函数回归单测（#1278，跑的是**真实配置表与真实函数**，不是复刻）
 *
 * 编译沙箱（把 configs 编成 CommonJS + cc 垫片）见 client/tools/lib/configs-sandbox.cjs；
 * auto-bag-prefs 需要 `sys.localStorage`，垫片末尾补一个内存版（ccExtra）。
 *
 * 盯的不变量（改判定后必须全绿）：
 * · collectBagRecycleEntries：装备只看「全部装备」整类开关（逐件 id 不收装备）；
 *   非装备只看勾选的 id；解析不出配置的 id 不动；同 id 合并件数；不改入参背包
 * · summarizeBagRecycleBySelection：与收集结果 × 单价（装备 recyclePrice / 非装备 sellPirce）一致；
 *   空清单 → 空结算
 * · findUsableCells：只返回勾选 id 的非装备格（装备即使混进 ids 也被防御性挡掉）、坐标正确
 * · auto-bag-prefs：无记录 = 全不勾（默认安全）；set→get 往返；按角色隔离；坏 JSON 回落默认
 *
 * 用法：node client/tools/test-auto-bag.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 内存版 sys.localStorage（auto-bag-prefs 的偏好存取在 node 沙箱里就靠它） */
const PREFS_CC_EXTRA = `
const __prefsMem = new Map();
module.exports.sys = {
  localStorage: {
    getItem: (k) => (__prefsMem.has(k) ? __prefsMem.get(k) : null),
    setItem: (k, v) => { __prefsMem.set(k, String(v)); },
    removeItem: (k) => { __prefsMem.delete(k); },
  },
};
`;

function main() {
  let outDir;
  try {
    outDir = prepare("olua-auto-bag", ["ui/core/storage/auto-bag-prefs.ts"], PREFS_CC_EXTRA);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items, collectBagRecycleEntries, summarizeBagRecycleBySelection, findUsableCells } = require(path.join(outDir, "configs/items.js"));
  const { getRecyclePrice } = require(path.join(outDir, "configs/equipments.js"));
  const { bagRow, bagCol } = require(path.join(outDir, "configs/role.js"));
  const { isDrug, isEquipment } = require(path.join(outDir, "types/good.js"));
  const prefs = require(path.join(outDir, "ui/core/storage/auto-bag-prefs.js"));

  const makeGrid = (rows = bagRow, cols = bagCol) => Array.from({ length: rows }, () => new Array(cols).fill(null));
  const put = (grid, row, col, id, count = 1) => {
    grid[row][col] = { id, count };
  };

  // ── 真实表里的素材 id（配置表由沙箱按出厂数据灌好）──
  const goodsList = [...items.values()];
  const equipmentIds = goodsList.filter((good) => isEquipment(good)).map((good) => good.id).filter(Boolean);
  const drug = goodsList.find((good) => isDrug(good) && good.sellPirce > 0);
  check(!!equipmentIds.length, "沙箱里有装备（出厂数据已灌）", `${equipmentIds.length} 件`);
  check(!!drug, "沙箱里有可卖的药品", drug ? drug.id : "无");

  const equipId = equipmentIds[0];
  const otherEquipId = equipmentIds[1] ?? equipmentIds[0];

  //#region A. collectBagRecycleEntries

  console.log("\n=== collectBagRecycleEntries：勾选判定 ===");
  {
    const bag = makeGrid();
    put(bag, 0, 0, equipId, 1);
    put(bag, 0, 1, drug.id, 5);
    put(bag, 0, 2, drug.id, 3);
    put(bag, 1, 0, "totally_unknown_id", 2); // 解析不出配置的 id

    // 只勾这一种药：药品收齐且合并，装备 / 未勾的东西 / 未知 id 一个不动
    const onlyDrug = collectBagRecycleEntries(bag, { allEquipment: false, ids: new Set([drug.id]) });
    check(
      JSON.stringify(onlyDrug) === JSON.stringify([{ goodId: drug.id, count: 8 }]),
      "勾一种药 → 只收该药且两格合并",
      JSON.stringify(onlyDrug),
    );
    check(
      collectBagRecycleEntries(bag, { allEquipment: false, ids: new Set() }).length === 0,
      "全不勾 → 空清单（未勾选永不回收）",
    );
    // 装备只认整类开关：把装备变体 id 塞进 ids 也收不到
    const equipInIds = collectBagRecycleEntries(bag, { allEquipment: false, ids: new Set([equipId]) });
    check(equipInIds.length === 0, "装备 id 塞进逐项清单不生效（装备只看整类开关）", JSON.stringify(equipInIds));
    // 未知 id 不替玩家决定
    const withUnknown = collectBagRecycleEntries(bag, { allEquipment: false, ids: new Set([drug.id, "totally_unknown_id"]) });
    check(withUnknown.length === 1 && withUnknown[0].goodId === drug.id, "解析不出配置的 id 不收", JSON.stringify(withUnknown));
    // 整类开关：全部装备、同 id 合并、非装备不收
    const allEquipBag = makeGrid();
    put(allEquipBag, 0, 0, equipId, 1);
    put(allEquipBag, 0, 1, equipId, 1);
    put(allEquipBag, 1, 0, otherEquipId, 1);
    put(allEquipBag, 2, 0, drug.id, 9);
    const allEquip = collectBagRecycleEntries(allEquipBag, { allEquipment: true, ids: new Set() });
    check(
      JSON.stringify(allEquip) === JSON.stringify([
        { goodId: equipId, count: 2 },
        { goodId: otherEquipId, count: 1 },
      ]),
      "整类开关 → 收全部装备且同 id 合并、药品不动",
      JSON.stringify(allEquip),
    );
    // 不改入参
    check(!!bag[0][0] && bag[0][0].id === equipId && !!bag[0][1] && bag[0][1].count === 5, "入参背包原样保留（纯函数不改入参）");
  }

  //#endregion

  //#region B. summarizeBagRecycleBySelection

  console.log("\n=== summarizeBagRecycleBySelection：预览与收集同源 ===");
  {
    const bag = makeGrid();
    put(bag, 0, 0, equipId, 1);
    put(bag, 0, 1, drug.id, 5);
    const equipGood = items.get(equipId);
    const expected = getRecyclePrice(equipGood) * 1 + drug.sellPirce * 5;
    const summary = summarizeBagRecycleBySelection(bag, { allEquipment: true, ids: new Set([drug.id]) });
    check(
      summary.count === 6 && summary.totalPrice === expected,
      "预览 = 逐件单价累加（装备 recyclePrice + 药品 sellPirce）",
      `count=${summary.count} total=${summary.totalPrice}（期望 ${expected}）`,
    );
    const none = summarizeBagRecycleBySelection(bag, { allEquipment: false, ids: new Set() });
    check(none.count === 0 && none.totalPrice === 0, "空清单 → 空结算", JSON.stringify(none));
    // 价签方向（不锁数字）：装备单价是正整数
    check(getRecyclePrice(equipGood) > 0, "装备回收价出厂为正", String(getRecyclePrice(equipGood)));
  }

  //#endregion

  //#region C. findUsableCells

  console.log("\n=== findUsableCells：自动使用候选 ===");
  {
    const bag = makeGrid();
    put(bag, 2, 3, drug.id, 2);
    put(bag, 4, 5, equipId, 1);
    const hits = findUsableCells(bag, new Set([drug.id]));
    check(
      hits.length === 1 && hits[0].row === 2 && hits[0].col === 3 && hits[0].id === drug.id,
      "勾选的药 → 返回正确的格子坐标",
      JSON.stringify(hits),
    );
    // 装备即使混进 ids 也被防御性挡掉（自动穿戴走独立开关，不走使用清单）
    const withEquip = findUsableCells(bag, new Set([drug.id, equipId]));
    check(withEquip.length === 1, "装备混进勾选集也不返回", JSON.stringify(withEquip));
    check(findUsableCells(bag, new Set()).length === 0, "空集 → 无候选");
  }

  //#endregion

  //#region D. auto-bag-prefs（本机偏好）

  console.log("\n=== auto-bag-prefs：本机勾选存取 ===");
  {
    // 无记录 → 默认全不勾（默认态必须是「什么都不自动做」）
    const defaults = prefs.getRecycleSelection("role-a");
    check(defaults.allEquipment === false && defaults.ids.size === 0, "无记录 → 回收清单默认全不勾");
    check(prefs.getUseIds("role-a").size === 0, "无记录 → 使用清单默认空");
    check(prefs.getAutoWear("role-a") === false, "无记录 → 自动穿戴默认关");

    // set → get 往返
    prefs.setRecycleSelection("role-a", { allEquipment: true, ids: new Set([drug.id, "material_x"]) });
    const roundtrip = prefs.getRecycleSelection("role-a");
    check(roundtrip.allEquipment === true && roundtrip.ids.size === 2 && roundtrip.ids.has(drug.id), "回收勾选 set→get 往返", JSON.stringify([...roundtrip.ids]));
    prefs.setUseIds("role-a", new Set([drug.id]));
    check(prefs.getUseIds("role-a").has(drug.id), "使用勾选 set→get 往返");
    prefs.setAutoWear("role-a", true);
    check(prefs.getAutoWear("role-a") === true, "自动穿戴开关 set→get 往返");

    // 按角色隔离
    const other = prefs.getRecycleSelection("role-b");
    check(other.allEquipment === false && other.ids.size === 0, "两角色互不影响", JSON.stringify([...other.ids]));
    check(prefs.getAutoWear("role-b") === false, "自动穿戴按角色隔离");

    // 部分覆写不丢另一份（writeBlob 是读改写）
    prefs.setAutoWear("role-a", false);
    check(prefs.getUseIds("role-a").has(drug.id) && prefs.getAutoWear("role-a") === false, "覆写一份不丢另一份（读改写）");

    // 坏 JSON → 回落默认（不抛错）
    const cc = require(path.join(outDir, "..", "node_modules", "cc", "index.js"));
    cc.sys.localStorage.setItem("auto_bag_prefs:role-c", "{broken json!!");
    const broken = prefs.getRecycleSelection("role-c");
    check(broken.allEquipment === false && broken.ids.size === 0, "坏 JSON → 回落默认全不勾");
    check(prefs.getUseIds("role-c").size === 0 && prefs.getAutoWear("role-c") === false, "坏 JSON 三份偏好都回落默认");
  }

  //#endregion

  finish("自动回收 / 自动使用 / 偏好存取全部断言通过");
}

main();

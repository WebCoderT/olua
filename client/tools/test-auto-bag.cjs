#!/usr/bin/env node
/**
 * 背包自动化纯函数回归单测（#1278；#1289 回收判定重做为「部位 × 等级段」，
 * 跑的是**真实配置表与真实函数**，不是复刻）
 *
 * 编译沙箱（把 configs 编成 CommonJS + cc 垫片）见 client/tools/lib/configs-sandbox.cjs；
 * auto-bag-prefs 需要 `sys.localStorage`，垫片末尾补一个内存版（ccExtra）。
 *
 * 盯的不变量（改判定后必须全绿）：
 * · recycleLevelBands：首段恒为 1-10，之后 5 级一段排到装备表最高等级；段边界不随数据漂
 * · collectBagRecycleEntries：只收装备（部位勾了该等级段才收）；非装备 / 未勾段 /
 *   回收价 ≤ 0 / 解析不出配置的 id 一律不收；同 id 合并件数；不改入参背包
 * · summarizeBagRecycleBySelection：与收集结果 × 装备单价一致；空清单 → 空结算
 * · findUsableCells：只返回勾选 id 的非装备格（装备即使混进 ids 也被防御性挡掉）、坐标正确
 * · auto-bag-prefs：无记录 = 全不勾（默认安全）；**旧形状（allEquipment/ids）回落全不勾**；
 *   set→get 往返；按角色隔离；坏 JSON 回落默认；自动回收开关独立存取
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

  const { items, collectBagRecycleEntries, summarizeBagRecycleBySelection, findUsableCells, recycleBandOfLevel, hasRecycleSelection } = require(path.join(outDir, "configs/items.js"));
  const { getRecyclePrice, recycleLevelBands } = require(path.join(outDir, "configs/equipments.js"));
  const { bagRow, bagCol } = require(path.join(outDir, "configs/role.js"));
  const { isDrug, isEquipment } = require(path.join(outDir, "types/good.js"));
  const prefs = require(path.join(outDir, "ui/core/storage/auto-bag-prefs.js"));

  const makeGrid = (rows = bagRow, cols = bagCol) => Array.from({ length: rows }, () => new Array(cols).fill(null));
  const put = (grid, row, col, id, count = 1) => {
    grid[row][col] = { id, count };
  };

  // ── 真实表里的素材 id（配置表由沙箱按出厂数据灌好）──
  const goodsList = [...items.values()];
  const equipments = goodsList.filter((good) => isEquipment(good));
  const equipmentIds = equipments.map((good) => good.id).filter(Boolean);
  const drug = goodsList.find((good) => isDrug(good) && good.sellPirce > 0);
  check(!!equipmentIds.length, "沙箱里有装备（出厂数据已灌）", `${equipmentIds.length} 件`);
  check(!!drug, "沙箱里有可卖的药品", drug ? drug.id : "无");

  const equipId = equipmentIds[0];
  const equipGood = items.get(equipId);
  const sameSlot = equipments.find((good) => good.slot === equipGood.slot && good.id !== equipId);
  const otherEquipId = sameSlot ? sameSlot.id : equipmentIds[1];
  const equipSlot = equipGood.slot;
  const equipBand = recycleBandOfLevel(equipGood.level);
  check(!!equipBand, "首件装备的等级落在某个等级段里", JSON.stringify(equipBand));

  //#region A. recycleLevelBands / recycleBandOfLevel（#1289 段规则）

  console.log("\n=== 等级段：固定规则，不随数据漂 ===");
  {
    const bands = recycleLevelBands();
    check(bands.length > 0 && bands[0].min === 1 && bands[0].max === 10, "首段恒为 1-10", JSON.stringify(bands[0]));
    check(bands.every((band, index) => index === 0 || (band.min === bands[index - 1].max + 1 && band.max === band.min + 4)), "后续段 5 级一段、首尾相接");
    const maxLevel = Math.max(...equipments.map((good) => good.level));
    check(bands[bands.length - 1].max >= maxLevel, "段覆盖装备表最高等级", `表最高 ${maxLevel} / 段顶 ${bands[bands.length - 1].max}`);
    check(bands[bands.length - 1].max < maxLevel + 5, "段顶不多盖一段（只排到最高等级）");
    check(recycleBandOfLevel(1)?.min === 1 && recycleBandOfLevel(60)?.min === bands[bands.length - 1].min, "等级 → 段判定两端正确");
    check(recycleBandOfLevel(maxLevel + 5) === null, "超出装备表等级范围的等级不在任何段里（宁可不回收）");
  }

  //#endregion

  //#region B. collectBagRecycleEntries

  console.log("\n=== collectBagRecycleEntries：部位 × 等级段判定 ===");
  {
    const bag = makeGrid();
    put(bag, 0, 0, equipId, 1);
    put(bag, 0, 1, drug.id, 5);
    put(bag, 0, 2, drug.id, 3);
    put(bag, 1, 0, "totally_unknown_id", 2); // 解析不出配置的 id

    // 非装备不再进清单：勾什么物品 id 都收不到药
    const withDrugId = collectBagRecycleEntries(bag, { slots: { [drug.id]: [1] } });
    check(withDrugId.length === 0, "药品不进回收清单（#1289：只回收装备）", JSON.stringify(withDrugId));
    check(collectBagRecycleEntries(bag, { slots: {} }).length === 0, "全不勾 → 空清单（未勾选永不回收）");
    // 该部位勾了装备所在的段 → 收
    const matched = collectBagRecycleEntries(bag, { slots: { [equipSlot]: [equipBand.min] } });
    check(matched.length === 1 && matched[0].goodId === equipId && matched[0].count === 1, "部位勾了装备所在段 → 收该装备", JSON.stringify(matched));
    // 同部位勾别的段 / 别的部位 → 不收
    const otherBand = recycleLevelBands().find((band) => band.min !== equipBand.min);
    const wrongBand = collectBagRecycleEntries(bag, { slots: { [equipSlot]: [otherBand.min] } });
    check(wrongBand.length === 0, "同部位勾了别的段 → 不收", JSON.stringify(wrongBand));
    const wrongSlot = collectBagRecycleEntries(bag, { slots: { other_nonexistent_slot: [equipBand.min] } });
    check(wrongSlot.length === 0, "别的部位勾了同段 → 不收");
    // 未知 id 不替玩家决定
    check(collectBagRecycleEntries(bag, { slots: { [equipSlot]: recycleLevelBands().map((band) => band.min) } }).every((entry) => entry.goodId !== "totally_unknown_id"), "解析不出配置的 id 不收");
    // 不改入参
    check(!!bag[0][0] && bag[0][0].id === equipId && !!bag[0][1] && bag[0][1].count === 5, "入参背包原样保留（纯函数不改入参）");

    // 同 id 合并：同部位同段勾上，两格装备合一条
    const twinBag = makeGrid();
    put(twinBag, 0, 0, equipId, 1);
    put(twinBag, 0, 1, equipId, 1);
    const merged = collectBagRecycleEntries(twinBag, { slots: { [equipSlot]: [equipBand.min] } });
    check(merged.length === 1 && merged[0].count === 2, "同部位同段 → 同 id 合并件数", JSON.stringify(merged));

    // 清单判据：hasRecycleSelection
    check(hasRecycleSelection({ slots: {} }) === false, "空清单 = 没勾（自动回收一步都不做）");
    check(hasRecycleSelection({ slots: { [equipSlot]: [] } }) === false, "部位存在但没勾段 = 没勾");
    check(hasRecycleSelection({ slots: { [equipSlot]: [1] } }) === true, "勾了任意一段 = 有勾选");
  }

  //#endregion

  //#region C. summarizeBagRecycleBySelection

  console.log("\n=== summarizeBagRecycleBySelection：预览与收集同源 ===");
  {
    const bag = makeGrid();
    put(bag, 0, 0, equipId, 1);
    put(bag, 0, 1, drug.id, 5);
    const expected = getRecyclePrice(equipGood) * 1;
    const summary = summarizeBagRecycleBySelection(bag, { slots: { [equipSlot]: [equipBand.min] } });
    check(
      summary.count === 1 && summary.totalPrice === expected,
      "预览 = 逐件装备单价累加（药品不进预览）",
      `count=${summary.count} total=${summary.totalPrice}（期望 ${expected}）`,
    );
    const none = summarizeBagRecycleBySelection(bag, { slots: {} });
    check(none.count === 0 && none.totalPrice === 0, "空清单 → 空结算", JSON.stringify(none));
    // 价签方向（不锁数字）：装备单价是正整数
    check(getRecyclePrice(equipGood) > 0, "装备回收价出厂为正", String(getRecyclePrice(equipGood)));
  }

  //#endregion

  //#region D. findUsableCells

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

  //#region E. auto-bag-prefs（本机偏好）

  console.log("\n=== auto-bag-prefs：本机勾选存取 ===");
  {
    // 无记录 → 默认全不勾（默认态必须是「什么都不自动做」）
    const defaults = prefs.getRecycleSelection("role-a");
    check(Object.keys(defaults.slots).length === 0, "无记录 → 回收清单默认全不勾");
    check(prefs.getUseIds("role-a").size === 0, "无记录 → 使用清单默认空");
    check(prefs.getAutoWear("role-a") === false, "无记录 → 自动穿戴默认关");
    check(prefs.getAutoRecycle("role-a") === false, "无记录 → 自动回收开关默认关");

    // set → get 往返
    prefs.setRecycleSelection("role-a", { slots: { [equipSlot]: [1, 11], bogus: [0, -1] } });
    const roundtrip = prefs.getRecycleSelection("role-a");
    check(
      roundtrip.slots[equipSlot]?.length === 2 && roundtrip.slots[equipSlot][0] === 1 && roundtrip.slots[equipSlot][1] === 11,
      "回收勾选（部位 × 段下界）set→get 往返",
      JSON.stringify(roundtrip.slots),
    );
    check(roundtrip.slots.bogus === undefined, "非法段值（0 / 负数）落盘时丢弃", JSON.stringify(roundtrip.slots));
    prefs.setUseIds("role-a", new Set([drug.id]));
    check(prefs.getUseIds("role-a").has(drug.id), "使用勾选 set→get 往返");
    prefs.setAutoWear("role-a", true);
    check(prefs.getAutoWear("role-a") === true, "自动穿戴开关 set→get 往返");
    prefs.setAutoRecycle("role-a", true);
    check(prefs.getAutoRecycle("role-a") === true, "自动回收开关 set→get 往返");

    // 按角色隔离
    const other = prefs.getRecycleSelection("role-b");
    check(Object.keys(other.slots).length === 0, "两角色互不影响", JSON.stringify(other.slots));
    check(prefs.getAutoWear("role-b") === false && prefs.getAutoRecycle("role-b") === false, "开关按角色隔离");

    // 部分覆写不丢另一份（writeBlob 是读改写）
    prefs.setAutoWear("role-a", false);
    check(prefs.getUseIds("role-a").has(drug.id) && prefs.getAutoWear("role-a") === false, "覆写一份不丢另一份（读改写）");
    check(prefs.getRecycleSelection("role-a").slots[equipSlot]?.length === 2, "覆写开关不丢回收勾选");

    // 旧形状（#1278 的 allEquipment/ids）→ 回落全不勾：宁可让玩家重新勾，不替他多勾
    const cc = require(path.join(outDir, "..", "node_modules", "cc", "index.js"));
    cc.sys.localStorage.setItem("auto_bag_prefs:role-old", JSON.stringify({ recycle: { allEquipment: true, ids: ["drug_hp_1"] } }));
    const oldShape = prefs.getRecycleSelection("role-old");
    check(Object.keys(oldShape.slots).length === 0, "旧形状勾选 → 回落全不勾（#1289 形状变更）", JSON.stringify(oldShape.slots));

    // 坏 JSON → 回落默认（不抛错）
    cc.sys.localStorage.setItem("auto_bag_prefs:role-c", "{broken json!!");
    const broken = prefs.getRecycleSelection("role-c");
    check(Object.keys(broken.slots).length === 0, "坏 JSON → 回落默认全不勾");
    check(prefs.getUseIds("role-c").size === 0 && prefs.getAutoWear("role-c") === false && prefs.getAutoRecycle("role-c") === false, "坏 JSON 全部偏好回落默认");
  }

  //#endregion

  finish("自动回收（部位 × 等级段）/ 自动使用 / 偏好存取全部断言通过");
}

main();

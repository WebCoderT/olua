#!/usr/bin/env node
/**
 * 背包「一键回收」回归单测（跑的是**真实配置表与真实回收函数**，不是复刻）
 *
 * 编译沙箱（把 configs 编成 CommonJS + cc 垫片）见 tools/lib/configs-sandbox.cjs。
 *
 * 盯的不变量（改回收价曲线 / 改回收算法后必须全绿）：
 * · 每件装备都有回收价（> 0），药品/材料/解析不出配置的 id 一律不计价
 * · 回收只搬走**装备**：非装备格子连引用都不动、行列数不变、返回新数组不改入参
 * · 件数与合计价 = 逐格逐件累加（含「叠着的装备」这种脏数据：按 count 计价，不白拿走）
 * · 计价口径：基础价按等级从曲线取，前后缀变体乘同一个 rate（超神·神级 = ×4.2）
 * · 等级越高越值钱；同等级时前后缀越强越值钱
 * · 空背包/没有装备的背包 → 空结算（count 0 / totalPrice 0）
 * · 幂等：连续回收两次，第二次必为空结算且背包不再变化
 * · summarizeBagRecycle（按钮上的预览）与实际回收结果完全一致
 *
 * 用法：node tools/test-bag-recycle.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node tools/test-bag-recycle.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-bag-recycle");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items, getItem, summarizeBagRecycle, recycleBagEquipmentGrid } = require(path.join(outDir, "configs/items.js"));
  const { getRecyclePrice } = require(path.join(outDir, "configs/equipments.js"));
  const { equipmentRecyclePrice, equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/growth.js"));
  const { bagRow, bagCol } = require(path.join(outDir, "configs/role.js"));
  const { isEquipment } = require(path.join(outDir, "types/good.js"));

  const makeGrid = (rows = bagRow, cols = bagCol) => Array.from({ length: rows }, () => new Array(cols).fill(null));
  const put = (grid, row, col, id, count = 1) => {
    grid[row][col] = { id, count };
  };
  const flatOf = (grid) => {
    const list = [];
    grid.forEach((row) =>
      row.forEach((cell) => {
        if (cell) list.push(cell);
      }),
    );
    return list;
  };
  const sameShape = (a, b) => a.length === b.length && a.every((row, index) => row.length === b[index].length);
  const dump = (grid) => grid.map((row) => "    " + row.map((cell) => (cell ? `${cell.id}×${cell.count}` : "·")).join(" | ")).join("\n");
  /** 该格子是不是可回收的装备（解析不出配置的 id 不算） */
  const isEquipCell = (cell) => {
    const good = cell ? getItem(cell.id) : null;
    return !!good && isEquipment(good);
  };

  /** 全部装备（基础件 = 普通的·人级），按等级升序 */
  const allEquipments = [];
  const baseEquipments = [];
  items.forEach((good, id) => {
    if (!isEquipment(good)) return;
    allEquipments.push({ id, good });
    if (good.prefix === 0 && good.suffix === 0) baseEquipments.push({ id, good });
  });
  baseEquipments.sort((a, b) => a.good.level - b.good.level || (a.id < b.id ? -1 : 1));

  //#region 1. 每件装备都有回收价（需求原话：给每个装备添加回收价格）

  console.log("\n=== 1. 回收价覆盖：每件装备都有价 ===");
  const noPrice = allEquipments.filter(({ good }) => getRecyclePrice(good) <= 0);
  check(allEquipments.length > 0, "配置表里能读到装备", `${allEquipments.length} 件（含前后缀变体）`);
  check(noPrice.length === 0, "所有装备的回收价都 > 0", noPrice.length ? `无价：${noPrice.map((e) => e.id).join(", ")}` : `共 ${allEquipments.length} 件`);
  const baseNoPrice = baseEquipments.filter(({ good, id }) => getRecyclePrice(good) !== equipmentRecyclePrice(good.level) || equipmentRecyclePrice(good.level) <= 0);
  check(
    baseNoPrice.length === 0,
    "基础件（普通·人级）的价与等级曲线一致且 > 0",
    baseNoPrice.length ? `不符：${baseNoPrice.map((e) => e.id).join(", ")}` : `基础件 ${baseEquipments.length} 件，覆盖 1~${baseEquipments[baseEquipments.length - 1].good.level} 级`,
  );
  const nonEquipmentWithPrice = [];
  items.forEach((good, id) => {
    if (isEquipment(good)) return;
    // 非装备没有 recyclePrice 字段，getRecyclePrice 只接受装备，这里换个方式确认：背包回收不认它（见第 3 段）
    if (typeof good.recyclePrice === "number" && good.recyclePrice > 0) nonEquipmentWithPrice.push(id);
  });
  check(nonEquipmentWithPrice.length === 0, "药品/材料不带回收价字段", nonEquipmentWithPrice.join(", ") || "无");

  //#endregion

  //#region 2. 计价口径：等级与前后缀

  console.log("\n=== 2. 计价口径（等级 / 前后缀） ===");
  let levelMonotonic = true;
  for (let i = 1; i < baseEquipments.length; i++) {
    if (baseEquipments[i].good.level === baseEquipments[i - 1].good.level) continue;
    if (getRecyclePrice(baseEquipments[i].good) <= getRecyclePrice(baseEquipments[i - 1].good)) levelMonotonic = false;
  }
  check(levelMonotonic, "等级越高回收价越高（价只由 等级 × 前后缀 决定，与部位无关）");
  const top = baseEquipments[baseEquipments.length - 1];
  check(
    getRecyclePrice(top.good) === 39900 && equipmentRecyclePrice(60) === 39900,
    "60 级基础件回收价 = 曲线值 39,900",
    `${top.id}(lv${top.good.level}) = ${getRecyclePrice(top.good)}`,
  );

  const variantOk = allEquipments.every(({ good }) => {
    const rate = equipmentPrefixRates[good.prefix] * equipmentSuffixRates[good.suffix];
    return getRecyclePrice(good) === Math.round(equipmentRecyclePrice(good.level) * rate);
  });
  check(variantOk, "所有变体价 = 等级基础价 × 前后缀倍率", "超神·神级 = ×4.2");
  const maxVariant = allEquipments.find(({ id }) => id.endsWith("_p4s2"));
  if (maxVariant) {
    const basePrice = equipmentRecyclePrice(maxVariant.good.level);
    check(
      getRecyclePrice(maxVariant.good) === Math.round(basePrice * 4.2),
      "变体价 = 基础价 × 4.2（超神·神级）",
      `${maxVariant.id} = ${getRecyclePrice(maxVariant.good)}（基础件 ${basePrice}）`,
    );
  }

  //#endregion

  //#region 3. 混合背包：只搬走装备

  console.log("\n=== 3. 混合背包：只搬走装备，其余原样 ===");
  const grid = makeGrid(4, 5);
  put(grid, 0, 0, "cloth_1"); // 装备
  put(grid, 0, 1, "drug_hp_1", 5); // 药品
  put(grid, 0, 2, "cloth_14"); // 高等级装备
  put(grid, 0, 3, "material_iron", 3); // 材料
  put(grid, 0, 4, "ghost_item", 2); // 配置表里没有的 id
  put(grid, 1, 0, "weapon_1");
  put(grid, 1, 1, "drug_hp_3", 8);
  put(grid, 1, 2, "cloth_1_p4s2"); // 超神·神级变体
  put(grid, 2, 3, "material_hide", 4);
  console.log("  回收前：\n" + dump(grid));
  // 快照：非装备格子的引用与数量（回收必须一格不动）
  const keptBefore = [];
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell && !isEquipCell(cell)) keptBefore.push({ r, c, id: cell.id, count: cell.count, ref: cell });
    }),
  );

  const expectedCount = 4;
  const expectedTotal =
    getRecyclePrice(getItem("cloth_1")) + getRecyclePrice(getItem("cloth_14")) + getRecyclePrice(getItem("weapon_1")) + getRecyclePrice(getItem("cloth_1_p4s2"));
  const summary = summarizeBagRecycle(grid);
  check(summary.count === expectedCount, "预览件数 = 背包里的装备件数", `${summary.count} 件`);
  check(summary.totalPrice === expectedTotal, "预览合计价 = 逐件回收价之和", `${summary.totalPrice} 绑定元宝`);

  const result = recycleBagEquipmentGrid(grid);
  console.log("  回收后：\n" + dump(result.bag));
  check(result.count === expectedCount, "实际回收件数与预览一致", `${result.count} 件`);
  check(result.totalPrice === expectedTotal, "实际合计价与预览一致", `${result.totalPrice} 绑定元宝`);
  check(sameShape(grid, result.bag), "行列数与入参一致", `${result.bag.length} × ${result.bag[0].length}`);
  check(
    flatOf(result.bag).every((cell) => !isEquipCell(cell)),
    "回收后背包里不再有装备",
    `${flatOf(result.bag).length} 格`,
  );
  const keptAfter = [];
  result.bag.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell) keptAfter.push({ r, c, id: cell.id, count: cell.count, ref: cell });
    }),
  );
  check(
    JSON.stringify(keptAfter.map((k) => [k.r, k.c, k.id, k.count])) === JSON.stringify(keptBefore.map((k) => [k.r, k.c, k.id, k.count])),
    "非装备（药品/材料/无效 id）位置与数量都不变",
    keptAfter.map((k) => `${k.id}×${k.count}@(${k.r},${k.c})`).join(", "),
  );
  check(
    keptBefore.every((k) => result.bag[k.r][k.c] === k.ref),
    "非装备格子连对象引用都没换（原样保留）",
  );
  check(grid[0][0].id === "cloth_1" && grid[1][0].id === "weapon_1", "不改入参：原背包里的装备还在", "返回的是新数组");
  check(
    JSON.stringify(summarizeBagRecycle(result.bag)) === JSON.stringify({ count: 0, totalPrice: 0 }),
    "回收后的背包再结算为空（幂等）",
  );

  //#endregion

  //#region 4. 边界：空背包 / 全装备 / 只有非装备 / 脏数据

  console.log("\n=== 4. 边界情况 ===");
  const empty = makeGrid(2, 3);
  check(JSON.stringify(summarizeBagRecycle(empty)) === JSON.stringify({ count: 0, totalPrice: 0 }), "空背包 → 空结算");
  check(flatOf(recycleBagEquipmentGrid(empty).bag).length === 0 && sameShape(empty, recycleBagEquipmentGrid(empty).bag), "空背包 → 回收后仍为空且行列不变");

  const onlyGoods = makeGrid(2, 3);
  put(onlyGoods, 0, 0, "drug_hp_1", 10);
  put(onlyGoods, 0, 1, "material_iron", 6);
  put(onlyGoods, 1, 1, "ghost_item", 1);
  const onlyGoodsResult = recycleBagEquipmentGrid(onlyGoods);
  check(onlyGoodsResult.count === 0 && onlyGoodsResult.totalPrice === 0, "只有药品/材料/无效 id → 空结算（不误吞）", `${flatOf(onlyGoodsResult.bag).length} 格原样`);
  check(JSON.stringify(onlyGoodsResult.bag) === JSON.stringify(onlyGoods), "只有非装备时背包内容完全不变");

  const full = makeGrid();
  for (let row = 0; row < bagRow; row++) for (let col = 0; col < bagCol; col++) put(full, row, col, "cloth_1");
  const fullResult = recycleBagEquipmentGrid(full);
  check(fullResult.count === bagRow * bagCol, "满包装备 → 件数 = 背包容量的格数", `${fullResult.count} 件`);
  check(fullResult.totalPrice === fullResult.count * getRecyclePrice(getItem("cloth_1")), "满包合计价 = 件数 × 单件价");
  check(flatOf(fullResult.bag).length === 0 && sameShape(full, fullResult.bag), "满包装备 → 全部清空且行列不变");

  const stacked = makeGrid(1, 2);
  put(stacked, 0, 0, "cloth_1", 3); // 脏数据：装备本该不可叠加
  const stackedResult = recycleBagEquipmentGrid(stacked);
  check(
    stackedResult.count === 3 && stackedResult.totalPrice === 3 * getRecyclePrice(getItem("cloth_1")),
    "脏数据（叠着的装备）按 count 计价：宁可多给钱，也不白拿走玩家的东西",
    `${stackedResult.count} 件 / ${stackedResult.totalPrice}`,
  );

  //#endregion

  finish("PASS：每件装备都有回收价；回收只搬装备、其余原样；件数与合计价正确；前后缀与等级缩放正确；空/满/脏数据边界与幂等均符合预期。");
}

main();

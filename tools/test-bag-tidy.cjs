#!/usr/bin/env node
/**
 * 背包「一键整理」回归单测（跑的是**真实配置表与真实搬运函数**，不是复刻）
 *
 * 做法：把 `assets/configs/items.ts`（连同它依赖的 equipments / drug / material / growth）编译成
 * CommonJS 到临时目录，再用一个只实现 `Vec2` / `Vec3` / `Size` / `Color` 的 `cc` 垫片顶替引擎 ——
 * 配置表只用到这四个纯数据类，没有引擎行为，于是 node 里就能直接调用真实的
 * `getItem` / `compareBagGoods` / `tidyBagGrid` 跑断言。
 *
 * 盯的不变量（改整理算法后必须全绿）：
 * · 行列数与入参一致          · 物品一件不丢（按 id 汇总数量守恒）
 * · 装备排最前、等级降序、同等级按部位顺序（configs/equipments.equipmentSlotOrder）
 * · 非装备按大类顺序（药品 → 材料 → 其他）
 * · 同 id 可叠加物合并成一格、超过 maxStack 才拆堆
 * · 配置表里没有的 id 原样保留（不合并、不拆堆）且排在最后
 * · 幂等（连点两次整理结果不变）
 *
 * 用法：node tools/test-bag-tidy.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node tools/test-bag-tidy.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(os.tmpdir(), "olua-bag-tidy");
const OUT_DIR = path.join(SANDBOX, "out");

//#region cc 垫片（只给 node 跑 configs 用：四个纯数据类，构造 + 读字段）

const CC_SHIM = `/**
 * cc 运行时垫片（本文件由 tools/test-bag-tidy.cjs 生成，请勿手改）
 * assets/configs 只用 Vec2 / Vec3 / Size / Color 做数据构造，没有任何引擎行为，最小实现即可。
 * Color 要能吃 new Color(255,255,255) 与 new Color("#DDDDDD") 两种写法（配置表两种都用）。
 */
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
class Color {
  constructor(r = 255, g = 255, b = 255, a = 255) {
    if (typeof r === "string") { this.hex = r; this.r = 0; this.g = 0; this.b = 0; this.a = 255; return; }
    this.r = r; this.g = g; this.b = b; this.a = a;
  }
}
Color.WHITE = new Color(255, 255, 255, 255);
Color.BLACK = new Color(0, 0, 0, 255);
module.exports = { Vec2, Vec3, Size, Color };
`;

//#endregion

//#region 找 tsc（Cocos 自带的就够用，不必在工程里装 typescript）

function findTsc() {
  const candidates = [
    process.env.TSC,
    path.join(PROJECT_ROOT, "node_modules/typescript/bin/tsc"),
  ];
  // Cocos Creator 各版本自带的 typescript
  for (const creatorRoot of ["/Applications/Cocos/Creator", "/Applications/CocosCreator"]) {
    if (!fs.existsSync(creatorRoot)) continue;
    for (const version of fs.readdirSync(creatorRoot)) {
      const base = path.join(creatorRoot, version, "CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin");
      candidates.push(path.join(base, "tsc"), path.join(base, "tsc.js"));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

//#endregion

function prepareSandbox(tscPath) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, "node_modules/cc"), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, "node_modules/cc/index.js"), CC_SHIM);
  fs.writeFileSync(path.join(SANDBOX, "node_modules/cc/package.json"), JSON.stringify({ name: "cc", main: "index.js" }, null, 2));
  fs.writeFileSync(
    path.join(SANDBOX, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2019",
          module: "CommonJS",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          noEmitOnError: false,
          rootDir: path.join(PROJECT_ROOT, "assets"),
          outDir: OUT_DIR,
          baseUrl: PROJECT_ROOT,
          // 类型仍用工程自己的声明（只影响编译期），运行期走上面的垫片
          paths: { cc: [path.join(PROJECT_ROOT, "temp/declarations/cc.d.ts")] },
          types: [],
        },
        files: [path.join(PROJECT_ROOT, "assets/configs/items.ts")],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(SANDBOX, "tsconfig.json")], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`配置表编译失败（tsc 退出码 ${result.status}）`);
  }
}

//#region 断言

let failed = 0;
function check(ok, label, detail = "") {
  if (ok) console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  else {
    failed++;
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function main() {
  const tscPath = findTsc();
  if (!tscPath) {
    console.error("找不到 tsc：请在工程里装 typescript，或用环境变量指定，例如");
    console.error("  TSC=/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc node tools/test-bag-tidy.cjs");
    process.exitCode = 1;
    return;
  }
  console.log(`tsc: ${tscPath}`);
  prepareSandbox(tscPath);

  const { getItem, tidyBagGrid, bagTidyTypeOrder } = require(path.join(OUT_DIR, "configs/items.js"));
  const { equipmentSlotOrder } = require(path.join(OUT_DIR, "configs/equipments.js"));
  const { bagRow, bagCol } = require(path.join(OUT_DIR, "configs/role.js"));
  const { GOOD_TYPE, isEquipment } = require(path.join(OUT_DIR, "types/good.js"));

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
  const totalsOf = (grid) => {
    const map = new Map();
    flatOf(grid).forEach((cell) => map.set(cell.id, (map.get(cell.id) ?? 0) + cell.count));
    return map;
  };
  const totalsEqual = (a, b) => {
    if (a.size !== b.size) return false;
    for (const [id, count] of a) if (b.get(id) !== count) return false;
    return true;
  };
  const sameShape = (a, b) => a.length === b.length && a.every((row, index) => row.length === b[index].length);
  const dump = (grid) => grid.map((row) => "    " + row.map((cell) => (cell ? `${cell.id}×${cell.count}` : "·")).join(" | ")).join("\n");
  const describe = (map) => [...map.entries()].map(([id, count]) => `${id}×${count}`).join(", ");
  const labelOf = (id) => {
    const good = getItem(id);
    return good ? `${good.label}(lv${good.level}${isEquipment(good) ? "," + good.slot : ""})` : `${id}(无配置)`;
  };

  /** 装备排最前 + 等级降序 + 同等级按部位顺序 */
  const assertEquipmentOrder = (flat, label) => {
    const firstNonEquipment = flat.findIndex((cell) => {
      const good = getItem(cell.id);
      return !good || !isEquipment(good);
    });
    const equipCount = firstNonEquipment < 0 ? flat.length : firstNonEquipment;
    check(equipCount > 0 || flat.length === 0, `${label}：装备全部排在非装备之前`, `装备 ${equipCount} 件 / 共 ${flat.length} 格`);
    let levelOk = true;
    let slotOk = true;
    for (let i = 1; i < equipCount; i++) {
      const prev = getItem(flat[i - 1].id);
      const cur = getItem(flat[i].id);
      if (cur.level > prev.level) levelOk = false;
      if (prev.level === cur.level && equipmentSlotOrder.get(cur.slot) < equipmentSlotOrder.get(prev.slot)) slotOk = false;
    }
    check(levelOk, `${label}：装备按等级降序`, flat.slice(0, equipCount).map((c) => labelOf(c.id)).join(" > "));
    check(slotOk, `${label}：同等级装备按部位顺序（equipmentSlotOrder）`);
  };

  /** 非装备按 药品 → 材料 → 其他 的大类顺序 */
  const assertNonEquipmentTypeOrder = (flat, label) => {
    const types = flat
      .filter((cell) => {
        const good = getItem(cell.id);
        return good && !isEquipment(good);
      })
      .map((cell) => bagTidyTypeOrder.get(getItem(cell.id).type));
    let ok = true;
    for (let i = 1; i < types.length; i++) if (types[i] < types[i - 1]) ok = false;
    check(ok, `${label}：非装备按大类顺序（药品 → 材料 → 其他）`);
  };

  // 场景 A：乱序混合（装备 + 多种可叠加物 + 配置表里没有的 id）
  console.log("\n=== 场景 A：乱序混合背包 ===");
  const gridA = makeGrid(4, 5);
  put(gridA, 0, 0, "cloth_14"); // 高等级衣服
  put(gridA, 0, 1, "drug_hp_1", 5);
  put(gridA, 0, 2, "cloth_1"); // 低等级衣服
  put(gridA, 0, 3, "material_iron", 3);
  put(gridA, 0, 4, "ghost_item", 2); // 配置表里没有的 id
  put(gridA, 1, 0, "weapon_1");
  put(gridA, 1, 1, "drug_hp_1", 7);
  put(gridA, 1, 2, "cloth_10");
  put(gridA, 1, 3, "helmet_1");
  put(gridA, 1, 4, "drug_hp_3", 2);
  put(gridA, 2, 0, "material_hide", 4);
  put(gridA, 2, 1, "weapon_3");
  console.log("  整理前：\n" + dump(gridA));
  const beforeA = totalsOf(gridA);
  const afterA = tidyBagGrid(gridA);
  console.log("  整理后：\n" + dump(afterA));
  const flatA = flatOf(afterA);
  check(sameShape(gridA, afterA), "行列数与入参一致", `${afterA.length} × ${afterA[0].length}`);
  check(totalsEqual(beforeA, totalsOf(afterA)), "物品一件不丢（按 id 汇总数量守恒）", describe(totalsOf(afterA)));
  assertEquipmentOrder(flatA, "场景 A");
  assertNonEquipmentTypeOrder(flatA, "场景 A");
  const mergedDrug = flatA.filter((c) => c.id === "drug_hp_1");
  check(
    mergedDrug.length === 1 && mergedDrug[0].count === 12,
    "同 id 可叠加物合并成一格",
    `${mergedDrug.length} 格 / 合计 ${mergedDrug.reduce((sum, c) => sum + c.count, 0)}`,
  );
  const ghostCells = flatA.filter((c) => c.id === "ghost_item");
  check(
    ghostCells.length === 1 && ghostCells[0].count === 2,
    "配置表里没有的 id 原样保留（不合并、不拆堆）",
    `${ghostCells.length} 格 / ${ghostCells.map((c) => c.count).join("+")}`,
  );
  check(flatA[flatA.length - 1].id === "ghost_item", "配置表里没有的 id 排在最后", `末格 ${flatA[flatA.length - 1].id}`);
  check(
    flatA.map((c) => (getItem(c.id)?.type ?? "unknown")).filter((t) => t !== "equipment" && t !== "unknown").join(",") === "drug,drug,material,material",
    "非装备内部顺序为 药品 → 材料",
    flatA.map((c) => getItem(c.id)?.type ?? "unknown").join(","),
  );
  const againA = tidyBagGrid(afterA);
  check(JSON.stringify(againA) === JSON.stringify(afterA), "幂等：再整理一次结果不变");

  // 场景 B：满包合并（77 格同一种药各 1 个 → 1 格 + 76 空位）
  console.log("\n=== 场景 B：满包（7×11 全是同一种药，各 1 个） ===");
  const gridB = makeGrid();
  for (let row = 0; row < bagRow; row++) for (let col = 0; col < bagCol; col++) put(gridB, row, col, "drug_hp_1", 1);
  const afterB = tidyBagGrid(gridB);
  const flatB = flatOf(afterB);
  check(flatB.length === 1 && flatB[0].count === 77, "同种药合并成一格（数量 77）", `占 ${flatB.length} 格`);
  check(totalsEqual(totalsOf(gridB), totalsOf(afterB)), "数量守恒", describe(totalsOf(afterB)));
  check(afterB.length === bagRow && afterB[0].length === bagCol, "行列数不变");

  // 场景 C：maxStack 拆堆（合计 250 → 99 / 99 / 52）
  console.log("\n=== 场景 C：超过单格上限要拆堆 ===");
  const gridC = makeGrid(3, 4);
  put(gridC, 0, 0, "drug_hp_3", 99);
  put(gridC, 1, 2, "drug_hp_3", 99);
  put(gridC, 2, 1, "drug_hp_3", 52);
  const afterC = tidyBagGrid(gridC);
  const flatC = flatOf(afterC);
  check(flatC.length === 3 && flatC.map((c) => c.count).join(",") === "99,99,52", "按 maxStack=99 拆堆", flatC.map((c) => `${c.id}×${c.count}`).join(" , "));
  check(totalsEqual(totalsOf(gridC), totalsOf(afterC)), "拆堆后数量守恒", describe(totalsOf(afterC)));

  // 场景 D：同等级不同部位 / 同一件装备的前后缀变体
  console.log("\n=== 场景 D：部位顺序 + 前后缀强度 ===");
  const gridD = makeGrid(3, 4);
  put(gridD, 0, 0, "shoes_1");
  put(gridD, 0, 1, "necklace_1");
  put(gridD, 0, 2, "cloth_1");
  put(gridD, 0, 3, "weapon_1");
  put(gridD, 1, 0, "helmet_1");
  put(gridD, 1, 1, "belt_1");
  put(gridD, 1, 2, "ring_1");
  put(gridD, 1, 3, "cloth_1_p4s2"); // 超神·神级变体（与基础件同 level）
  const afterD = tidyBagGrid(gridD);
  const flatD = flatOf(afterD);
  console.log("  整理后：" + flatD.map((c) => labelOf(c.id)).join(" > "));
  assertEquipmentOrder(flatD, "场景 D");
  const variantIndex = flatD.findIndex((c) => c.id === "cloth_1_p4s2");
  const baseIndex = flatD.findIndex((c) => c.id === "cloth_1");
  check(variantIndex >= 0 && variantIndex < baseIndex, "同等级同部位时，前缀/后缀强的排在前面", `超神·神级 #${variantIndex} < 普通·人级 #${baseIndex}`);
  check(
    equipmentSlotOrder.get("weapon") < equipmentSlotOrder.get("necklace"),
    "部位序号来自 configs/equipments（唯一来源）",
    `weapon=${equipmentSlotOrder.get("weapon")} < necklace=${equipmentSlotOrder.get("necklace")}`,
  );

  // 场景 E：不可叠加装备一格一件（不合并）
  console.log("\n=== 场景 E：不可叠加装备一格一件 ===");
  const gridE = makeGrid(2, 3);
  put(gridE, 0, 0, "cloth_1");
  put(gridE, 0, 1, "cloth_1");
  put(gridE, 0, 2, "cloth_1");
  const afterE = tidyBagGrid(gridE);
  check(flatOf(afterE).length === 3, "同 id 装备不合并（三格三件）", `${flatOf(afterE).length} 格`);
  check(totalsEqual(totalsOf(gridE), totalsOf(afterE)), "件数守恒", describe(totalsOf(afterE)));

  console.log(
    failed
      ? `\n!! 有 ${failed} 项断言不通过`
      : "\nPASS：整理后行列不变、物品一件不丢、排序规则正确、无效 id 保留、可叠加物合并与拆堆正常、幂等。",
  );
  if (failed) process.exitCode = 1;
}

main();

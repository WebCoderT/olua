// 背包「绑定 + 掉落溯源」回归（issue #789）
//
// 口径（用户 2026-11 定）：物品是否绑定 = 是否绑定角色（绑了就不许交易）。绑定由**服务端**
// 在掉落时判定写入格子；客户端只做三件事：
//   1) 搬运 / 整理 / 读档对齐时把元数据原样带回，**绑定态不同的堆不许合并**（合并 = 凭空
//      多出一件可交易的，或把可交易的锁死）；
//   2) 拾取应答（picked 帧）把服务端那格照搬进来，本地不重算、不补默认值；
//   3) 详情弹窗显示「已绑定 · 不可交易」与三行溯源（掉落者 / 怪物 / 时间）。
//
// 断言分两层（与 test-bag-drag-drop 同一套做法）：
//   A. 数据层真实行为：借 configs-sandbox 跑真实 configs/items 的纯函数；
//   B. 接线：读源码静态断言（UI 渲染效果一律人眼看，这里只钉「读哪个字段、走哪个分支」）。

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

/**
 * 抓取方法/函数体（从签名起，到配对大括号）
 *
 * 先按括号深度跳过参数表：签名里可能出现对象字面量类型（如 `meta: { bound?: boolean }`），
 * 直接找第一个 `{` 会从类型注解里开始数，取到半截函数体。
 */
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

/** 把二维背包按「绑定态 + id」汇总数量（守恒判据，与服务端 bagGroupKeyOf 同口径） */
function groupSum(bag) {
  const sum = new Map();
  bag.forEach((row) =>
    row.forEach((cell) => {
      if (!cell) return;
      const key = `${cell.bound === true ? 1 : 0}|${cell.id}`;
      sum.set(key, (sum.get(key) || 0) + Math.max(1, cell.count));
    }),
  );
  return sum;
}

function sameGroups(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function main() {
  const outDir = prepare("olua-bag-bind", ["configs/items.ts"]);
  const { tidyBagGrid, moveBagCellGrid, normalizeBagGrid, recycleBagEquipmentGrid, bagMetaOf, withBagMeta, bagGroupKeyOf } =
    require(path.join(outDir, "configs/items.js"));

  console.log("=== 数据层：元数据读写（bagMetaOf / withBagMeta / bagGroupKeyOf）===");
  check(bagGroupKeyOf({ id: "drug_hp_1", count: 1, bound: true }) === "1|drug_hp_1", "分组键：绑定 → 1|id");
  check(bagGroupKeyOf({ id: "drug_hp_1", count: 1 }) === "0|drug_hp_1", "分组键：未绑定 → 0|id");
  check(bagGroupKeyOf({ id: "drug_hp_1", count: 1, bound: false }) === "0|drug_hp_1", "分组键：bound = false 也算未绑定（不认脏值）");
  check(bagGroupKeyOf(null) === "0|", "分组键：空格不抛异常（占位 0|）");

  const origin = { role: "张三", monster: "monster_1", at: 1700000000000 };
  const copy = bagMetaOf({ id: "weapon_1", count: 1, bound: true, from: origin });
  check(copy.bound === true && copy.from.role === "张三", "bagMetaOf 取到绑定与溯源");
  check(copy.from !== origin, "bagMetaOf 复制 from（不把引用带走，避免两格互相污染）");
  const empty = withBagMeta("weapon_1", 1, {});
  check(!("bound" in empty) && !("from" in empty), "withBagMeta：空元数据不写字段（存档里不多出 undefined 键）");
  const kept = withBagMeta("weapon_1", 1, { bound: true, from: origin });
  check(kept.bound === true && kept.from.role === "张三", "withBagMeta：有元数据时原样写入");

  console.log("\n=== 数据层：tidyBagGrid 不跨绑定态合并 ===");
  // 同种可叠加药：一堆绑定的 2 个 + 一堆未绑定的 3 个 → 整理后仍是两堆
  const bag = [
    [{ id: "drug_hp_1", count: 2, bound: true }, null],
    [null, { id: "drug_hp_1", count: 3 }],
  ];
  const tidied = tidyBagGrid(bag);
  const stacks = [];
  tidied.forEach((row) => row.forEach((cell) => cell && stacks.push(cell)));
  check(stacks.length === 2, "绑定堆与未绑定堆整理后仍是两堆（不合并）");
  check(
    stacks.some((cell) => cell.bound === true && cell.count === 2) && stacks.some((cell) => cell.bound !== true && cell.count === 3),
    "两堆各自保持「绑定 2 个 / 未绑定 3 个」",
  );
  check(sameGroups(groupSum(bag), groupSum(tidied)), "整理按「绑定态 + id」分组数量守恒（一件不丢、也不多出来）");

  // 同绑定态仍然要合并（回归：别因为加了这个判据就把普通整理也弄坏了）
  const sameBag = [
    [{ id: "drug_hp_1", count: 2 }, null],
    [null, { id: "drug_hp_1", count: 3 }],
  ];
  const sameTidied = tidyBagGrid(sameBag);
  const sameStacks = [];
  sameTidied.forEach((row) => row.forEach((cell) => cell && sameStacks.push(cell)));
  check(sameStacks.length === 1 && sameStacks[0].count === 5, "同为未绑定 → 照旧并成一堆 5 个");

  // 装备（不可叠加）的溯源跟着格子走
  const equipBag = [
    [{ id: "weapon_1", count: 1, bound: true, from: origin }, null],
    [null, null],
  ];
  const equipTidied = tidyBagGrid(equipBag);
  const equipCell = equipTidied[0][0];
  check(equipCell.bound === true && equipCell.from && equipCell.from.monster === "monster_1", "整理后装备的绑定与溯源仍在（一格一件，不并堆）");
  check(equipCell.from !== origin, "整理产出的是 from 副本（改结果不影响入参）");

  console.log("\n=== 数据层：moveBagCellGrid 不跨绑定态合并 ===");
  // 绑定的药拖到未绑定的同种药上 → 不能合并，只能交换（两堆各自整体换位置）
  const dragBag = [
    [{ id: "drug_hp_1", count: 2, bound: true }, { id: "drug_hp_1", count: 3 }],
  ];
  const dragMoved = moveBagCellGrid(dragBag, { row: 0, col: 0 }, { row: 0, col: 1 });
  check(dragMoved.moved, "绑定堆拖到未绑定堆：动作有效（交换，不是合并）");
  check(dragMoved.bag[0][0].count === 3 && dragMoved.bag[0][1].count === 2, "两格数量各自原样（没有并成 5 个）");
  check(dragMoved.bag[0][1].bound === true && dragMoved.bag[0][0].bound !== true, "绑定态跟着格子走（绑定的那堆仍在，只是换了位置）");
  check(sameGroups(groupSum(dragBag), groupSum(dragMoved.bag)), "搬运后按分组数量守恒");

  // 同绑定态 → 仍然合并
  const sameDrag = [[{ id: "drug_hp_1", count: 2 }, { id: "drug_hp_1", count: 3 }]];
  const sameDragMoved = moveBagCellGrid(sameDrag, { row: 0, col: 0 }, { row: 0, col: 1 });
  check(sameDragMoved.bag[0][1].count === 5 && !sameDragMoved.bag[0][0], "同为未绑定 → 照旧合并成 5 个、源格清空");

  // 拖到空格：元数据一起搬（否则一挪就「解绑」）
  const moveMeta = [[{ id: "weapon_1", count: 1, bound: true, from: origin }, null]];
  const movedMeta = moveBagCellGrid(moveMeta, { row: 0, col: 0 }, { row: 0, col: 1 });
  check(movedMeta.bag[0][1].bound === true && movedMeta.bag[0][1].from.role === "张三", "拖到空格：绑定与溯源一起搬过去");
  check(movedMeta.bag[0][1].from !== origin, "搬过去的 from 是副本");

  console.log("\n=== 数据层：normalizeBagGrid / recycleBagEquipmentGrid ===");
  const raw = [[{ id: "weapon_1", count: 1, bound: true, from: origin }]];
  const normalized = normalizeBagGrid(raw, 1, 2);
  check(normalized[0][0].bound === true && normalized[0][0].from.at === origin.at, "读档对齐照抄绑定与溯源（不把绑定物洗成可交易的）");
  check(normalized[0].length === 2 && normalized[0][1] === null, "读档对齐仍按目标尺寸补空格");

  const recycleBag = [
    [{ id: "weapon_1", count: 1, bound: true }, { id: "drug_hp_1", count: 2, bound: true }],
  ];
  const recycled = recycleBagEquipmentGrid(recycleBag);
  check(recycled.count === 1 && recycled.bag[0][0] === null, "绑定的装备照样可回收（口径：绑定只拦交易）");
  check(recycled.bag[0][1] && recycled.bag[0][1].bound === true && recycled.bag[0][1].count === 2, "非装备格原样保留（连绑定都不动）");

  console.log("\n=== 接线：拾取应答照搬元数据（StorageManager）===");
  const storage = readSrc("ui/core/StorageManager.ts");
  const applyBody = extractBody(storage, "static applyPickResult(");
  check(!!applyBody, "StorageManager.applyPickResult 存在");
  check(!!applyBody && /cell\.bound/.test(applyBody) && /cell\.from/.test(applyBody), "拾取应答读 bound / from（服务端写的，客户端不重算）");
  check(!!applyBody && /withBagMeta\(/.test(applyBody), "写入格子走 withBagMeta（绑定与溯源一并落格）");
  const sanitizeBody = extractBody(storage, "private static sanitizeOrigin(");
  check(!!sanitizeBody && /BAG_ORIGIN_TEXT_MAX/.test(sanitizeBody), "溯源文字按 BAG_ORIGIN_TEXT_MAX 截断（与服务端同数）");
  check(!!sanitizeBody && /from\.at > 0/.test(sanitizeBody), "时间戳只认正数（不编一个时间出来）");
  const addGoodBody = extractBody(storage, "static addGood(");
  check(
    !!addGoodBody && /\(cell\.bound === true\) === bound/.test(addGoodBody),
    "本地 addGood 只并进同绑定态的堆（存量接口，口径与搬运一致）",
  );

  console.log("\n=== 接线：详情弹窗显示绑定与溯源 ===");
  const helper = readSrc("ui/helpers/GameUiHelper.ts");
  check(/createGoodDetailDialog\(good: Goods, anchor: Node, compare: Equipment \| "hint" \| null = null, meta\?: BagCellMeta\)/.test(helper), "详情弹窗接第四参 meta（绑定与溯源）");
  check(/createGoodDetailDialog\(good, cell, comparable && holdingCtrl \? worn : comparable \? "hint" : null, options\?\.meta\)/.test(helper), "createGood 把格子元数据透传给详情弹窗");
  const dialogBody = extractBody(helper, "static createGoodDetailDialog(");
  check(!!dialogBody && /meta\.bound === true/.test(dialogBody) && /label_good_detail_bound/.test(dialogBody), "只有真绑定才加「已绑定 · 不可交易」行（未绑定不留空位）");
  check(!!dialogBody && /label_good_detail_origin_role/.test(dialogBody), "溯源行：掉落者（谁掉的）");
  check(!!dialogBody && /label_good_detail_origin_monster/.test(dialogBody) && /monsterLabelOf\(origin\.monster\)/.test(dialogBody), "溯源行：怪物（key 翻中文名）");
  check(!!dialogBody && /label_good_detail_origin_time/.test(dialogBody) && /formatOriginTime\(origin\.at\)/.test(dialogBody), "溯源行：掉落时间");
  check(!!dialogBody && /originRows\.forEach\(\(row\) => content\.addChild\(row\)\)/.test(dialogBody), "溯源行 join 进内容区（参与排版）");
  const formatBody = extractBody(helper, "static formatOriginTime(");
  check(!!formatBody && /getText\("label_good_detail_origin_time_format"/.test(formatBody), "时间格式走 configs/texts（代码里不写中文）");
  check(!!formatBody && /!Number\.isFinite\(at\) \|\| at <= 0/.test(formatBody), "非法时间戳返回空串（调用方整行不显示）");

  console.log("\n=== 接线：背包格子把元数据交给详情弹窗 ===");
  const gridSrc = readSrc("ui/components/panel/BagGridView.ts");
  check(/meta: \{ bound: bagCell\.bound, from: bagCell\.from \}/.test(gridSrc), "BagGridView 把格子的 bound / from 传给 createGood");
  const slotSrc = readSrc("ui/components/panel/EquipmentSlotGroup.ts");
  check(!/meta:/.test(slotSrc), "身上装备槽不传 meta（槽位只存 id，传不出来就是如实反映）");

  console.log("\n=== 配置层：文案与排版 ===");
  const texts = readSrc("configs/texts.ts");
  ["label_good_detail_bound", "label_good_detail_origin_role", "label_good_detail_origin_monster", "label_good_detail_origin_time", "label_good_detail_origin_time_format"].forEach(
    (key) => check(new RegExp(`^\\s*${key}:`, "m").test(texts), `configs/texts 登记了 ${key}`),
  );
  const dialogs = readSrc("configs/layout/dialogs.ts");
  // 切片到下一个同级的 export const 为止（对象字面量没有配对大括号可用，按段落切最稳）
  const layoutStart = dialogs.indexOf("export const goodDetailLayout = {");
  const layoutSlice = layoutStart === -1 ? "" : dialogs.slice(layoutStart, dialogs.indexOf("\nexport const", layoutStart + 10));
  check(/bound: \{ fontSize:/.test(layoutSlice) && /origin: \{ fontSize:/.test(layoutSlice), "goodDetailLayout 有 bound / origin 两处排版（字号与配色进配置）");

  finish("PASS：绑定态不同的堆不合并、元数据搬运/整理/读档全程带回，详情弹窗能显示「已绑定」与三行掉落溯源。");
}

main();

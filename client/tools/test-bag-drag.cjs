#!/usr/bin/env node
/**
 * 背包「拖动改变格子」的自动化验证：跑**真实的 configs/items.moveBagCellGrid、normalizeBagGrid
 * 与 StorageManager.moveBagGood**（沙箱见 client/tools/lib/storage-sandbox.cjs），
 * 再对 BagGridView 的手势接线与 configs/layout 的拖动配置做源码断言。
 *
 * 盯的不变量（改拖动逻辑后必须全绿）：
 * · 空格 = 整格移动（数量不变）        · 同种可叠加 = 合并，超上限的留在原格（部分合并）
 * · 其余情况 = 两格交换（含装备、认不出的 id）· 物品一件不丢（按 id 汇总数量守恒）
 * · 起点为空 / 起终点同格 / 越界 → 什么都不动，且不抛异常
 * · 除起点与落点外其余格子一律不动（连引用都不换）· 恒返回新数组、不改入参
 * · 互换两次回到原状（可逆）          · 搬完仍是 7 行 × 11 列、只动在线角色、不碰装备槽
 * · 手势走 touch 通道、阈值/尺寸/颜色全部来自 configs、落点用 UITransform.hitTest
 * · 拖动松手同一次按压不再算点击（否则拖完会顺手把物品用掉/穿上）
 * · 网格区域内的触摸不外传：拖物品时弹窗不跟着一起拖（格子冒泡被容器停住、空格子由容器独占）
 *
 * 用法：node client/tools/test-bag-drag.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-bag-drag.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareStorage } = require("./lib/storage-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const BAG_GRID_VIEW_FILE = path.join(PROJECT_ROOT, "assets/ui/components/panel/BagGridView.ts");
const BAG_DIALOG_FILE = path.join(PROJECT_ROOT, "assets/ui/components/dialogs/BagDialog.ts");
const DRAGGABLE_FILE = path.join(PROJECT_ROOT, "assets/ui/components/input/Draggable.ts");
const STORAGE_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/StorageManager.ts");
const ITEMS_FILE = path.join(PROJECT_ROOT, "assets/configs/items.ts");
const PANELS_FILE = path.join(PROJECT_ROOT, "assets/configs/layout/panels.ts");
const GAME_UI_HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts");
const GAME_HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/GameHelper.ts");

let sandbox;
try {
  sandbox = prepareStorage("olua-bag-drag");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { StorageManager, Role, outDir } = sandbox;
const { moveBagCellGrid, normalizeBagGrid, getItem, getItemsByType } = require(path.join(outDir, "configs/items.js"));

const equipment = getItemsByType("equipment")[0];
const drug = getItemsByType("drug")[0];
const material = getItemsByType("material")[0];
if (!equipment || !drug || !material) {
  fail("配置表里找不到装备/药品/材料样本，无法继续");
  return;
}
const maxStack = Math.max(1, getItem(drug.id).maxStack ?? 99);

//#region 造数据与断言小工具

const makeGrid = (rows = 3, cols = 4) => Array.from({ length: rows }, () => new Array(cols).fill(null));
const put = (grid, row, col, id, count = 1) => {
  grid[row][col] = { id, count };
};
const at = (grid, row, col) => grid[row][col];
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
const describe = (grid) => flatOf(grid).map((cell) => `${cell.id}×${cell.count}`).join(", ");
const dump = (grid) => grid.map((row) => "    " + row.map((cell) => (cell ? `${cell.id}×${cell.count}` : "·")).join(" | ")).join("\n");
/** 除 from / to 两格外，其余格子是否连引用都没变 */
const untouchedExcept = (before, after, from, to) => {
  let ok = true;
  before.forEach((row, rowIndex) =>
    row.forEach((cell, colIndex) => {
      const isFrom = rowIndex === from.row && colIndex === from.col;
      const isTo = rowIndex === to.row && colIndex === to.col;
      if (isFrom || isTo) return;
      if (after[rowIndex][colIndex] !== cell) ok = false;
    }),
  );
  return ok;
};

/** 造角色（Role 的 id 取时间戳，同毫秒会撞，测试里显式指定） */
function makeRole(id, name) {
  const role = new Role(name, "1", "1");
  role.id = id;
  return role;
}

/** 重置存档：只留一个在线角色，清空自带初始装备后按给定格子预置背包 */
function seed(cells) {
  const role = makeRole("r1", "测试角色");
  role.bag = role.bag.map((row) => row.map(() => null));
  cells.forEach(({ row, col, id, count }) => {
    role.bag[row][col] = { id, count };
  });
  StorageManager.clear();
  StorageManager.setRoles([role]);
  StorageManager.onlineRole("r1");
  return role;
}

const online = () => StorageManager.findOnlineRole();
const cellAt = (row, col) => online().bag[row][col];

//#endregion

console.log("— 纯函数：configs/items.moveBagCellGrid —");

// 场景 A：拖到空格 = 整格搬过去
console.log("\n=== 场景 A：拖到空格 ===");
{
  const grid = makeGrid(3, 4);
  put(grid, 0, 0, drug.id, 7);
  const before = grid.map((row) => row.slice());
  const result = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 2, col: 3 });
  console.log("  拖后：\n" + dump(result.bag));
  check(result.moved === true, "拖到空格返回 moved = true");
  check(at(result.bag, 2, 3)?.id === drug.id && at(result.bag, 2, 3)?.count === 7, "物品整格搬过去、数量不变");
  check(at(result.bag, 0, 0) === null, "起点格清空");
  check(at(grid, 0, 0) !== null && at(grid, 0, 0).count === 7, "不改入参（原背包还是原样）");
  check(totalsEqual(totalsOf(grid), totalsOf(result.bag)), "数量守恒");
  check(result.bag.length === 3 && result.bag.every((row) => row.length === 4), "行列结构不变");
  check(untouchedExcept(before, result.bag, { row: 0, col: 0 }, { row: 2, col: 3 }), "其余 10 格连引用都没动");
}

// 场景 B：拖到同种可叠加物 = 合并
console.log("\n=== 场景 B：拖到同种可叠加物（合并） ===");
{
  const grid = makeGrid(2, 3);
  put(grid, 0, 0, drug.id, 30);
  put(grid, 0, 1, drug.id, 7);
  const result = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 1 });
  console.log("  拖后：\n" + dump(result.bag));
  check(at(result.bag, 0, 1)?.count === 37, "落点数量 = 两格之和");
  check(at(result.bag, 0, 0) === null, "吃完了，起点格清空");
  check(totalsEqual(totalsOf(grid), totalsOf(result.bag)), "数量守恒");
}

// 场景 C：合并装不下 = 留在原格（部分合并）
console.log("\n=== 场景 C：合并超过单格上限 ===");
{
  const grid = makeGrid(1, 2);
  put(grid, 0, 0, drug.id, maxStack);
  put(grid, 0, 1, drug.id, 50);
  const result = moveBagCellGrid(grid, { row: 0, col: 1 }, { row: 0, col: 0 });
  console.log("  拖后：\n" + dump(result.bag));
  check(at(result.bag, 0, 0)?.count === maxStack, `落点补满到单格上限（${maxStack}）`);
  check(at(result.bag, 0, 1)?.count === 50, "吃不完的留在原格");
  check(at(result.bag, 0, 1)?.id === drug.id, "留下来的还是同一种物品");
  check(totalsEqual(totalsOf(grid), totalsOf(result.bag)), "部分合并后数量守恒");
}

// 场景 D：不同种物品 = 交换
console.log("\n=== 场景 D：不同种物品（交换） ===");
{
  const grid = makeGrid(2, 3);
  put(grid, 0, 0, equipment.id, 1);
  put(grid, 0, 1, material.id, 5);
  const result = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 1 });
  console.log("  拖后：\n" + dump(result.bag));
  check(at(result.bag, 0, 0)?.id === material.id && at(result.bag, 0, 0)?.count === 5, "起点变成落点原来的物品");
  check(at(result.bag, 0, 1)?.id === equipment.id, "落点变成拖过去的物品");
  check(totalsEqual(totalsOf(grid), totalsOf(result.bag)), "交换后数量守恒");
  const back = moveBagCellGrid(result.bag, { row: 0, col: 1 }, { row: 0, col: 0 });
  check(JSON.stringify(back.bag) === JSON.stringify(grid), "再拖回去完全回到原状（可逆）");
}

// 场景 E：不可叠加的装备不合并（同 id 两件 → 等价于交换）
console.log("\n=== 场景 E：装备一格一件（不合并） ===");
{
  const grid = makeGrid(1, 2);
  put(grid, 0, 0, equipment.id, 1);
  put(grid, 0, 1, equipment.id, 1);
  const result = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 1 });
  check(at(result.bag, 0, 0)?.count === 1 && at(result.bag, 0, 1)?.count === 1, "同 id 装备不合并（仍是两格各一件）");
  check(flatOf(result.bag).length === 2, "格子数不变");
}

// 场景 F：配置表里认不出的 id（不合并、不拆堆，整体搬／交换）
console.log("\n=== 场景 F：认不出的 id ===");
{
  const grid = makeGrid(1, 3);
  put(grid, 0, 0, "ghost_item", 2);
  put(grid, 0, 1, "ghost_item", 3);
  const swapped = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 1 });
  check(at(swapped.bag, 0, 1)?.count === 2 && at(swapped.bag, 0, 0)?.count === 3, "认不出的 id 不合并（原样交换）");
  const moved = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 2 });
  check(at(moved.bag, 0, 2)?.count === 2, "认不出的 id 也能整体搬到空格");
  check(totalsEqual(totalsOf(grid), totalsOf(moved.bag)), "认不出的 id 也不丢数量");
}

// 场景 G：无效拖动
console.log("\n=== 场景 G：无效拖动（什么都不该发生） ===");
{
  const grid = makeGrid(2, 2);
  put(grid, 0, 0, drug.id, 3);
  const emptyFrom = moveBagCellGrid(grid, { row: 1, col: 1 }, { row: 1, col: 0 });
  check(emptyFrom.moved === false, "起点是空格 → moved = false");
  const same = moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 0 });
  check(same.moved === false, "起终点同一格 → moved = false");
  check(moveBagCellGrid(grid, { row: -1, col: 0 }, { row: 0, col: 1 }).moved === false, "起点行号为负 → moved = false");
  check(moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 99, col: 0 }).moved === false, "落点越界 → moved = false");
  check(moveBagCellGrid(grid, { row: 0, col: 0 }, { row: 0, col: 99 }).moved === false, "落点列越界 → moved = false");
  check(at(emptyFrom.bag, 0, 0)?.count === 3, "无效拖动后背包内容原样");
}

console.log("\n— 纯函数：configs/items.normalizeBagGrid —");

// 场景 H：尺寸补齐 / 裁剪 / 脏数据
console.log("\n=== 场景 H：背包尺寸对齐当前配置 ===");
{
  const small = [
    [{ id: drug.id, count: 5 }, null],
    [null, { id: equipment.id, count: 1 }],
  ];
  const grown = normalizeBagGrid(small, 7, 11);
  check(grown.length === 7 && grown.every((row) => row.length === 11), "2×2 的旧存档补齐为 7×11");
  check(grown[0][0]?.count === 5 && grown[1][1]?.id === equipment.id, "原有物品按原位置保留");
  check(flatOf(grown).length === 2, "补出来的都是空格，没有凭空造物品");

  const fat = makeGrid(9, 13);
  put(fat, 0, 0, drug.id, 1);
  put(fat, 8, 12, drug.id, 9); // 超出 7×11 的那一格
  const trimmed = normalizeBagGrid(fat, 7, 11);
  check(trimmed.length === 7 && trimmed.every((row) => row.length === 11), "9×13 的超尺寸存档裁到 7×11");
  check(at(trimmed, 0, 0)?.count === 1, "范围内的物品保留");

  const dirty = normalizeBagGrid([null, [{ count: 3 }], [{ id: "", count: 2 }]], 7, 11);
  check(dirty.length === 7 && flatOf(dirty).length === 0, "脏数据（缺 id / 空行）一律当空格");

  const broken = normalizeBagGrid(undefined, 7, 11);
  check(broken.length === 7 && broken.every((row) => row.length === 11), "非数组一律当空背包（不抛异常）");
}

console.log("\n— 整理口径：散着的背包必须能被压紧（回归「点整理像没反应」） —");

// 1. 物品散在最后一个格子：整理要把它拉回第一格
seed([{ row: 6, col: 10, id: drug.id, count: 3 }]);
check(StorageManager.tidyBag() === true, "物品散在末格时，一键整理返回 true（真的动了）");
check(cellAt(0, 0)?.count === 3, "整理后物品落在第一个格子（0 行 0 列）");
check(StorageManager.tidyBag() === false, "已经紧凑整齐后再点整理 → 无变动（不重复写存储）");

// 2. 最容易踩的坑：物品「顺序没变、只是中间空着」—— 指纹若不含空格就会被判成「已经很整齐」而整理不动
seed([
  { row: 0, col: 0, id: drug.id, count: 2 },
  { row: 0, col: 5, id: material.id, count: 1 },
]);
check(StorageManager.tidyBag() === true, "顺序没变、只是中间空着 → 整理仍会把它压紧（指纹含空格）");
check(cellAt(0, 0)?.id === drug.id && cellAt(0, 1)?.id === material.id, "压紧后两件物品紧挨着排在最前");

// 3. 拖动物品后立刻点整理：位置变了但顺序没变，同样要能压紧
seed([{ row: 0, col: 0, id: drug.id, count: 1 }]);
StorageManager.moveBagGood(0, 0, 3, 3);
check(StorageManager.tidyBag() === true, "把物品拖走后再整理 → 能拉回第一个格子");
check(cellAt(0, 0)?.count === 1, "整理后回到第一个格子");

console.log("\n— 数据层：StorageManager.moveBagGood —");

// 1. 拖到空格并落盘
seed([{ row: 0, col: 0, id: drug.id, count: 6 }]);
check(StorageManager.moveBagGood(0, 0, 5, 10) === true, "拖动搬到空格返回 true");
check(cellAt(0, 0) === null && cellAt(5, 10)?.count === 6, "内存里的背包已搬运");
check(JSON.parse(sandbox.shim.__memory.get("roles"))[0].bag[5][10]?.count === 6, "搬运结果已写入存档（不是只改内存）");

// 2. 合并
seed([
  { row: 0, col: 0, id: drug.id, count: 4 },
  { row: 0, col: 1, id: drug.id, count: 9 },
]);
check(StorageManager.moveBagGood(0, 0, 0, 1) === true, "拖动合并返回 true");
check(cellAt(0, 1)?.count === 13 && cellAt(0, 0) === null, "合并后的数量已落盘");

// 3. 无效拖动返回 false
seed([{ row: 0, col: 0, id: drug.id, count: 1 }]);
check(StorageManager.moveBagGood(3, 3, 4, 4) === false, "拖空格返回 false");
check(StorageManager.moveBagGood(0, 0, 0, 0) === false, "拖回原格返回 false");
check(StorageManager.moveBagGood(-1, 0, 0, 1) === false, "越界拖动返回 false");
check(cellAt(0, 0)?.count === 1, "无效拖动不改动背包");

// 4. 结构不变
{
  const bag = online().bag;
  check(bag.length === 7 && bag.every((row) => row.length === 11), "搬运后仍是 7 行 × 11 列");
}

// 5. 只动在线角色
{
  const other = makeRole("r2", "另一个角色");
  other.bag[0][0] = { id: drug.id, count: 4 };
  const me = makeRole("r1", "在线角色");
  me.bag[0][0] = { id: drug.id, count: 4 };
  StorageManager.clear();
  StorageManager.setRoles([me, other]);
  StorageManager.onlineRole("r1");
  StorageManager.moveBagGood(0, 0, 2, 2);
  const others = StorageManager.getRoles().find((role) => role.id === "r2");
  check(others.bag[0][0]?.count === 4, "另一个角色的背包不受影响");
  check(StorageManager.getRoles().find((role) => role.id === "r1").bag[2][2]?.count === 4, "在线角色的物品已搬走");
}

// 6. 不碰装备槽
{
  const role = makeRole("r1", "测试角色");
  role.bag[0][0] = { id: equipment.id, count: 1 };
  role.equipments[equipment.slot] = equipment.id;
  StorageManager.clear();
  StorageManager.setRoles([role]);
  StorageManager.onlineRole("r1");
  StorageManager.moveBagGood(0, 0, 1, 1);
  check(online().equipments[equipment.slot] === equipment.id, "拖动背包物品后，身上的装备槽原样不动");
}

// 7. 连续拖动（拖到 B、再拖到 C）不丢东西
{
  seed([{ row: 0, col: 0, id: drug.id, count: 8 }]);
  StorageManager.moveBagGood(0, 0, 1, 1);
  StorageManager.moveBagGood(1, 1, 6, 10);
  check(cellAt(6, 10)?.count === 8, "连续拖动后物品仍在，数量不变");
  check(flatOf(online().bag).length === 1, "中间格子没有留下残影");
}

console.log("\n— 界面接线：BagGridView / BagDialog / 配置 —");

const gridViewSource = fs.readFileSync(BAG_GRID_VIEW_FILE, "utf8");
const dialogSource = fs.readFileSync(BAG_DIALOG_FILE, "utf8");
const draggableSource = fs.readFileSync(DRAGGABLE_FILE, "utf8");
const storageSource = fs.readFileSync(STORAGE_MANAGER_FILE, "utf8");
const itemsSource = fs.readFileSync(ITEMS_FILE, "utf8");
const panelsSource = fs.readFileSync(PANELS_FILE, "utf8");
const gameUiHelperSource = fs.readFileSync(GAME_UI_HELPER_FILE, "utf8");
const gameHelperSource = fs.readFileSync(GAME_HELPER_FILE, "utf8");

// 数据层接线
check(/export function moveBagCellGrid\(bag: BagCell\[\]\[\], from: BagCellPos, to: BagCellPos\): BagMoveResult \{/.test(itemsSource), "items 暴露 moveBagCellGrid 纯函数");
check(/export function normalizeBagGrid\(bag: BagCell\[\]\[\], rows: number, cols: number\): BagCell\[\]\[\] \{/.test(itemsSource), "items 暴露 normalizeBagGrid");
check(/static moveBagGood\(fromRow: number, fromCol: number, toRow: number, toCol: number\): boolean \{/.test(storageSource), "StorageManager 暴露 moveBagGood");
check(/if \(!result\.moved\) return false;/.test(storageSource), "没真的搬动就不落盘、不刷新");
check(/signature \+= cell \? `\$\{cell\.id\}x\$\{cell\.count\},` : "·";/.test(storageSource), "整理指纹把空格也算进去（否则「只挪位置不改顺序」的背包会被判成已整齐）");
check(/private static bagIsEmpty\(bag: BagCell\[\]\[\]\)/.test(storageSource), "空背包判定拆成独立方法（指纹不再用空串当空背包）");
check(/normalizeBagGrid\(role\.bag, bagRow, bagCol\)/.test(storageSource), "读档时按 bagRow × bagCol 对齐背包尺寸");

// 手势接线（走 touch 通道；鼠标环境由引擎模拟成 TOUCH_*）
check(/cell\.on\(Node\.EventType\.TOUCH_START,/.test(gridViewSource), "格子注册了 TOUCH_START（记拖动起点）");
check(/cell\.on\(Node\.EventType\.TOUCH_MOVE,/.test(gridViewSource), "格子注册了 TOUCH_MOVE（跟指针）");
check(/cell\.on\(Node\.EventType\.TOUCH_END,/.test(gridViewSource), "格子注册了 TOUCH_END（落子）");
check(/cell\.on\(Node\.EventType\.TOUCH_CANCEL, \(\) => this\.endDrag\(\)/.test(gridViewSource), "TOUCH_CANCEL 会把拖动收干净");
check(!/Node\.EventType\.MOUSE_MOVE/.test(gridViewSource), "不在节点上注册 MOUSE_MOVE（会吞掉全局指针追踪）");
check(/cell\.on\(Node\.EventType\.MOUSE_DOWN,/.test(gridViewSource), "鼠标通道记一笔按键（右键不拖动物品）");
check(/this\.rightPress = getPointerButton\(event\) === "right";/.test(gridViewSource), "按下时判断是不是右键");
check(/if \(!drag\.active && this\.rightPress\) return;/.test(gridViewSource), "右键按住不进入拖动（保持「右键只穿戴」语义）");

// 阈值与落点
check(/Vec2\.distance\(point, drag\.start\) < bagGridLayout\.drag\.threshold/.test(gridViewSource), "位移小于阈值就不算拖动（点击仍是点击）");
check(/event\.getLocation\(\)\.clone\(\)/.test(gridViewSource), "起点坐标 clone（事件里的向量会被后续事件改写）");
check(/transform\.hitTest\(screenPoint\)/.test(gridViewSource), "落点判定用 UITransform.hitTest（屏幕坐标口径）");

// 拖动后的点击拦截
check(/private pressDragged = false;/.test(gridViewSource), "有「本次按压拖动过」的标记");
check(/if \(this\.pressDragged\) return;/.test(gridViewSource), "拖动过的那次抬起不再算点击（不会顺手用掉/穿上）");
check(/this\.pressDragged = false;/.test(gridViewSource), "标记在下一次按下时复位");

// 触摸归属：网格内的触摸不外传（弹窗背景挂了 Draggable，不拦就会「拖物品连弹窗一起拖」）
check(/this\.setupTouchOwnership\(\);/.test(gridViewSource), "网格容器在构造时登记触摸归属");
check(
  /applyColumnStyle\(this, bagGridLayout\.rowSpacing[\s\S]*?this\.setupTouchOwnership\(\);/.test(gridViewSource),
  "先给容器定好尺寸（有 UITransform）再登记触摸（引擎整理命中列表要读它）",
);
["TOUCH_START", "TOUCH_MOVE", "TOUCH_END", "TOUCH_CANCEL"].forEach((type) =>
  check(
    new RegExp(`this\\.on\\(Node\\.EventType\\.${type}, this\\.stopTouchBubble, this\\)`).test(gridViewSource),
    `容器收住 ${type}（不再冒泡给弹窗）`,
  ),
);
check(/private stopTouchBubble\(event: EventTouch\) \{\s*event\.propagationStopped = true;\s*\}/.test(gridViewSource), "停住冒泡靠 propagationStopped");
check(!/MOUSE_(DOWN|MOVE|UP)[\s\S]{0,80}stopTouchBubble/.test(gridViewSource), "只收 touch 通道（鼠标通道的穿透拦截归 blockClickThrough）");

// 兜底：按下点自带拖动手势时，Draggable 不抢这次拖动
check(/this\.dragging = false;\s*\n\s*if \(event\.target/.test(draggableSource), "每次按下都从「不拖」开始（上次的残留不会让弹窗跟动）");
check(/event\.target !== this\.node/.test(draggableSource), "弹窗自己（拖拽柄）不被这条兜底拦掉");
check(/event\.target\.hasEventListener\(Node\.EventType\.TOUCH_MOVE\)/.test(draggableSource), "按下点有自己的拖动手势（注册过 TOUCH_MOVE）→ 弹窗不抢");

// 表现零件
check(/GameUiHelper\.createBagDragGhost\(drag\.icon\)/.test(gridViewSource), "拖动时建出跟随指针的幽灵图标");
check(/GameUiHelper\.createBagDragHighlight\(\)/.test(gridViewSource), "拖动时建出落点高亮框");
check(/GameUiHelper\.followScreenPoint\(drag\.ghost/.test(gridViewSource), "幽灵按屏幕坐标跟随指针");
check(/GameUiHelper\.alignNodeToNode\(drag\.highlight, targetCell\)/.test(gridViewSource), "高亮框摆到指针下的格子上");
check(/GameUiHelper\.setNodeOpacity\(drag\.sourceGood, bagGridLayout\.drag\.sourceOpacity\)/.test(gridViewSource), "拖动中源格物品压暗");
check(/GameUiHelper\.setNodeOpacity\(drag\.sourceGood, bagGridLayout\.drag\.restoreOpacity\)/.test(gridViewSource), "松手/取消后恢复透明度");
check(/StorageManager\.moveBagGood\(from\.row, from\.col, landing\.row, landing\.col\)/.test(gridViewSource), "落子调数据层 moveBagGood（组件不做规则判断）");

// 弹窗接线
check(/this\.bagGrid\?\.cancelDrag\(\);/.test(dialogSource), "关弹窗先把拖动收干净");
check(/按住物品拖到别的格子 → StorageManager\.moveBagGood/.test(dialogSource), "BagDialog 的说明里写清了拖动的归属");

// 零件实现
check(/static createBagDragGhost\(icon: string\)/.test(gameUiHelperSource), "GameUiHelper 暴露 createBagDragGhost");
check(/static createBagDragHighlight\(\)/.test(gameUiHelperSource), "GameUiHelper 暴露 createBagDragHighlight");
check(/static followScreenPoint\(node: Node, screenPoint: Vec3\)/.test(gameUiHelperSource), "GameUiHelper 暴露 followScreenPoint");
check(/static alignNodeToNode\(node: Node, target: Node\)/.test(gameUiHelperSource), "GameUiHelper 暴露 alignNodeToNode");
check(/static setNodeOpacity\(node: Node \| null, opacity: number\)/.test(gameUiHelperSource), "GameUiHelper 暴露 setNodeOpacity");
check(/static screenPositionToWorldPosition\(screenPos: Vec3\)/.test(gameHelperSource), "GameHelper 暴露 screenPositionToWorldPosition（屏幕转世界）");
check(/convertToNodeSpaceAR\(GameHelper\.screenPositionToWorldPosition\(screenPoint\)/.test(gameUiHelperSource), "屏幕坐标经世界坐标换算到父节点坐标系");

// 配置：拖动手感与表现全部来自 configs（组件里不写数值）
{
  const start = panelsSource.indexOf("export const bagGridLayout");
  const end = panelsSource.indexOf("//#endregion", start);
  const block = panelsSource.slice(start, end > start ? end : undefined);
  check(start > 0, "能定位 bagGridLayout 配置块");
  ["threshold", "ghostSize", "ghostOpacity", "sourceOpacity", "restoreOpacity", "highlightSize", "highlightLineWidth", "highlightInset", "highlightColor"].forEach((key) =>
    check(new RegExp(`${key}:`).test(block), `bagGridLayout.drag 配了 ${key}`),
  );
  check(/drag:\s*\{[\s\S]*threshold: 10/.test(block), "拖动阈值在配置里（10 像素）");
}
check(!/[\u4e00-\u9fa5]/.test(gridViewSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "BagGridView 里没有裸中文（注释之外）");

finish("PASS：拖动规则（移动/合并/交换）、尺寸对齐、存储搬运、触摸归属与界面接线全部通过。");

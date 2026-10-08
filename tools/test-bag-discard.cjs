#!/usr/bin/env node
/**
 * 背包「丢弃」功能的自动化验证：跑**真实的 StorageManager.discardBagGood / getBagDiscardPreview**
 * （沙箱见 tools/lib/storage-sandbox.cjs）+ 对 BagDialog 的关键接线与配置做源码断言
 *
 * 覆盖：
 * - 数据层：丢装备/药品/材料、整格数量一起丢、只动目标格、落盘生效、幂等、只动在线角色、
 *   不动装备槽、空格与越界防御、解析不出配置的 id 也能清掉、背包结构不变
 * - 预览：名字与数量取自配置、空格返回 null
 * - 界面接线：丢弃按钮开关模式、丢弃模式下点格子走丢弃、两步确认只在同一格生效、
 *   超时自动放弃、退出模式/点整理回收/关弹窗清状态、布局与文案配置齐备
 * - 拖出弹窗销毁：手势上报与物品扣留、全屏确认框（确定销毁 / 取消回原位）的接线与输入独占
 *
 * 用法：node tools/test-bag-discard.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareStorage } = require("./lib/storage-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const BAG_DIALOG_FILE = path.join(PROJECT_ROOT, "assets/ui/components/dialogs/BagDialog.ts");
const BAG_GRID_VIEW_FILE = path.join(PROJECT_ROOT, "assets/ui/components/panel/BagGridView.ts");
const CONFIRM_DIALOG_FILE = path.join(PROJECT_ROOT, "assets/ui/components/dialogs/ConfirmDialog.ts");
const STORAGE_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/StorageManager.ts");
const DIALOGS_FILE = path.join(PROJECT_ROOT, "assets/configs/layout/dialogs.ts");
const TEXTS_FILE = path.join(PROJECT_ROOT, "assets/configs/texts.ts");

let sandbox;
try {
  sandbox = prepareStorage("olua-bag-discard");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { StorageManager, Role, outDir } = sandbox;
// 配置表与 StorageManager 在沙箱里是同一份产物（import 链被编译进来），items 是同一个 Map
const { items, getItemsByType, getItem } = require(path.join(outDir, "configs/items.js"));

const equipment = getItemsByType("equipment")[0];
const drug = getItemsByType("drug")[0];
const material = getItemsByType("material")[0];
if (!equipment || !drug || !material) fail("配置表里找不到装备/药品/材料样本，无法继续");
check(Boolean(equipment.stackable) === false, `样本装备不可叠加（${equipment.id}）`);
check(Boolean(drug.stackable) === true, `样本药品可叠加（${drug.id}，上限 ${drug.maxStack}）`);

/** 造角色（Role 的 id 取时间戳，同毫秒会撞，测试里显式指定） */
function makeRole(id, name) {
  const role = new Role(name, "1", "1");
  role.id = id;
  return role;
}

/** 重置存档：只留一个在线角色，清空自带初始装备后按给定格子预置背包 */
function seed(cells) {
  const role = makeRole("r1", "测试角色");
  // 新建角色自带初始装备，先清空背包（保持 7×11 结构），让断言只针对预置的格子
  role.bag = role.bag.map((row) => row.map(() => null));
  cells.forEach(({ row, col, id, count }) => {
    role.bag[row][col] = { id, count };
  });
  StorageManager.clear();
  StorageManager.setRoles([role]);
  StorageManager.onlineRole("r1");
  return role;
}

/** 从存储读回（每次都是反序列化的新对象，能真实反映落盘结果） */
const online = () => StorageManager.findOnlineRole();
const cellAt = (row, col) => online().bag[row][col];
/** 背包里所有非空格子 */
function filledCells() {
  const list = [];
  online().bag.forEach((row, rowIndex) =>
    row.forEach((cell, colIndex) => {
      if (cell) list.push({ row: rowIndex, col: colIndex, id: cell.id, count: cell.count });
    }),
  );
  return list;
}

console.log("— 数据层：StorageManager.discardBagGood —");

// 0. 前提：新建角色自带初始装备（所以下面每组测试都先清空背包，断言才只针对预置格子）
check(makeRole("probe", "探针").bag.some((row) => row.some((cell) => Boolean(cell))), "新角色自带初始装备（测试需先清空背包）");

// 1. 丢装备（不可叠加，count 恒 1）
seed([{ row: 0, col: 0, id: equipment.id, count: 1 }]);
check(StorageManager.discardBagGood(0, 0) === true, "丢弃装备返回 true");
check(cellAt(0, 0) === null, "格子已被清空");
check(filledCells().length === 0, "背包里再无物品");

// 2. 落盘真的生效
check(JSON.parse(sandbox.shim.__memory.get("roles"))[0].bag[0][0] === null, "丢弃已写入存档（不是只改了内存对象）");

// 3. 可叠加物品：整格一起丢（不做数量拆分）
seed([{ row: 2, col: 3, id: drug.id, count: 37 }]);
check(StorageManager.discardBagGood(2, 3) === true, "丢弃成堆的药品返回 true");
check(cellAt(2, 3) === null, "整格 37 个一起丢弃，没有残留");
check(filledCells().length === 0, "没有留下半个格子");

// 4. 材料同样可丢（丢弃不限物品大类，与「一键回收只吃装备」不同）
seed([{ row: 1, col: 1, id: material.id, count: 5 }]);
check(StorageManager.discardBagGood(1, 1) === true, "丢弃材料返回 true");
check(cellAt(1, 1) === null, "材料格子已清空");

// 5. 只动目标格：邻格与其它行原样保留
seed([
  { row: 0, col: 0, id: equipment.id, count: 1 },
  { row: 0, col: 1, id: drug.id, count: 9 },
  { row: 6, col: 10, id: material.id, count: 2 },
]);
StorageManager.discardBagGood(0, 0);
{
  const left = filledCells();
  check(left.length === 2, "只丢掉了一格", `剩余 ${JSON.stringify(left)}`);
  check(left.some((c) => c.row === 0 && c.col === 1 && c.id === drug.id && c.count === 9), "邻格药品数量原样保留");
  check(left.some((c) => c.row === 6 && c.col === 10 && c.id === material.id), "另一角的材料原样保留");
}

// 6. 背包行列结构不变（丢失物品不能把网格改小）
{
  const bag = online().bag;
  check(bag.length === 7 && bag.every((row) => row.length === 11), "丢弃后仍是 7 行 × 11 列");
}

// 7. 幂等：同一格再丢一次返回 false（不能顺手把别人的东西丢掉）
check(StorageManager.discardBagGood(0, 0) === false, "重复丢弃同一格第二次返回 false");
check(StorageManager.discardBagGood(0, 1) === true, "确认第二次调用没有误伤邻格（邻格可正常丢弃）");

// 8. 空格 / 越界防御
seed([]);
check(StorageManager.discardBagGood(0, 0) === false, "丢空格子返回 false");
check(StorageManager.discardBagGood(-1, 0) === false, "负行号返回 false（不抛异常）");
check(StorageManager.discardBagGood(0, 99) === false, "越界的列号返回 false（不抛异常）");
check(StorageManager.discardBagGood(99, 0) === false, "越界的行号返回 false（不抛异常）");

// 9. 解析不出配置的 id：允许清掉（玩家有权清理认不出的杂物，名字用 id 兜底）
seed([{ row: 3, col: 3, id: "gone_equipment_999", count: 1 }]);
check(StorageManager.getBagDiscardPreview(3, 3)?.label === "gone_equipment_999", "未知 id 的预览用 id 当名字");
check(StorageManager.discardBagGood(3, 3) === true, "未知 id 也能被丢弃");

// 10. 不影响装备槽（身上穿着的不在背包里，丢弃碰不到它）
{
  const role = makeRole("r1", "测试角色");
  role.bag[0][0] = { id: equipment.id, count: 1 };
  role.equipments[equipment.slot] = equipment.id;
  StorageManager.clear();
  StorageManager.setRoles([role]);
  StorageManager.onlineRole("r1");
  StorageManager.discardBagGood(0, 0);
  check(online().equipments[equipment.slot] === equipment.id, "丢弃背包物品后，身上的装备槽原样不动");
}

// 11. 只动在线角色（别人的背包不受影响）
{
  const other = makeRole("r2", "另一个角色");
  other.bag[0][0] = { id: drug.id, count: 4 };
  const me = makeRole("r1", "在线角色");
  me.bag[0][0] = { id: drug.id, count: 4 };
  StorageManager.clear();
  StorageManager.setRoles([me, other]);
  StorageManager.onlineRole("r1");
  StorageManager.discardBagGood(0, 0);
  const others = StorageManager.getRoles().find((role) => role.id === "r2");
  check(others.bag[0][0]?.count === 4, "另一个角色的背包不受影响");
  check(StorageManager.getRoles().find((role) => role.id === "r1").bag[0][0] === null, "在线角色的格子已清空");
}

console.log("— 预览：StorageManager.getBagDiscardPreview —");

// 12. 预览取配置里的名字与整格数量
seed([{ row: 1, col: 2, id: drug.id, count: 12 }]);
{
  const preview = StorageManager.getBagDiscardPreview(1, 2);
  check(preview?.label === getItem(drug.id).label, "预览名字取自物品配置");
  check(preview?.count === 12, "预览数量为整格数量");
}

// 13. 空格 / 越界的预览为 null
seed([]);
check(StorageManager.getBagDiscardPreview(0, 0) === null, "空格预览为 null");
check(StorageManager.getBagDiscardPreview(9, 9) === null, "越界预览为 null");

// 14. 预览是只读的（看一眼不能把东西看没了）
seed([{ row: 0, col: 0, id: equipment.id, count: 1 }]);
StorageManager.getBagDiscardPreview(0, 0);
check(cellAt(0, 0) !== null, "取预览不会改动背包");

console.log("— 界面接线：BagDialog / 配置 —");

const dialogSource = fs.readFileSync(BAG_DIALOG_FILE, "utf8");
const storageSource = fs.readFileSync(STORAGE_MANAGER_FILE, "utf8");
const layoutSource = fs.readFileSync(DIALOGS_FILE, "utf8");
const textsSource = fs.readFileSync(TEXTS_FILE, "utf8");

check(/static getBagDiscardPreview\(row: number, col: number\)/.test(storageSource), "StorageManager 暴露了 getBagDiscardPreview");
check(/static discardBagGood\(row: number, col: number\): boolean \{/.test(storageSource), "StorageManager 暴露了 discardBagGood");
check(/role\.bag\[row\]\[col\] = null;/.test(storageSource), "丢弃实现是把格子置空（整格丢弃）");

check(/createMiddleButton\(\s*bagDialogLayout\.discardButton\.name/.test(dialogSource), "背包底部建了「丢弃」按钮");
check(/discardButton\.on\(Node\.EventType\.TOUCH_END, \(\) => this\.toggleDiscardMode\(\)/.test(dialogSource), "丢弃按钮绑定了模式开关");
check(/private toggleDiscardMode\(\)/.test(dialogSource), "有 toggleDiscardMode（进入/退出丢弃模式）");
check(/setButtonText\(this\.discardButton, getText\("label_bag_discard_exit"\)\)/.test(dialogSource), "进入丢弃模式后按钮文案变「退出丢弃」");
check(/this\.discardMode = false;\s*this\.setButtonText\(this\.discardButton, getText\("label_bag_discard"\)\)/.test(dialogSource), "退出丢弃模式后按钮文案复位");

check(/if \(this\.discardMode\) \{\s*this\.onDiscardCell\(row, col\);\s*return;\s*\}/.test(dialogSource), "丢弃模式下点格子走丢弃（不再使用/穿戴）");
check(/pending\.row === row && pending\.col === col/.test(dialogSource), "两步确认只在点同一格时生效");
check(/GameUiHelper\.createTip\("bag_discard_confirm_tip", \{ name: preview\.label, count: preview\.count \}\)/.test(dialogSource), "第一次点击只报物品名与数量，不改数据");
check(/this\.clearDiscardPending\(\);\s*StorageManager\.discardBagGood\(row, col\);/.test(dialogSource), "第二次点击先复位状态再真的丢弃");
check(/setTimeout\(\(\) => this\.clearDiscardPending\(\), bagDialogLayout\.discardButton\.confirmTimeout\)/.test(dialogSource), "待确认状态带超时自动放弃");

check(/this\.exitDiscardMode\(\);\s*(\/\/[^\n]*\n\s*)*if \(!StorageManager\.tidyBag\(\)\)/.test(dialogSource), "点「一键整理」会先退出丢弃模式");
check(/this\.exitDiscardMode\(\);\s*this\.onRecycleClick\(\)/.test(dialogSource), "点「一键回收」会先退出丢弃模式");
check(/close\(\) \{\s*this\.cancelRecycleConfirm\(\);[\s\S]{0,160}this\.clearDiscardPending\(\);/.test(dialogSource), "关弹窗会清掉丢弃待确认与定时器");
check(/isValid\(this\.dialog\)\) \{\s*this\.dialog = null;[\s\S]{0,160}this\.discardButton = null;/.test(dialogSource), "弹窗被外部销毁时清理丢弃按钮引用");

// 布局：三按钮横向错开、丢弃按钮配置齐备
{
  const start = layoutSource.indexOf("export const bagDialogLayout");
  const end = layoutSource.indexOf("//#region 技能列表弹窗");
  const block = layoutSource.slice(start, end);
  check(start > 0 && end > start, "能定位 bagDialogLayout 配置块");
  check(/discardButton:\s*\{[\s\S]*name: "bag_discard_button"[\s\S]*confirmTimeout: 3000/.test(block), "discardButton 配置齐备（名称/位置/超时）");
  const xs = Array.from(block.matchAll(/position: new Vec2\((-?\d+), -212\)/g)).map((m) => Number(m[1]));
  check(xs.length === 3 && new Set(xs).size === 3, `底部三个按钮横向错开（x = ${xs.join(" / ")}）`);
  check(xs[0] < xs[1] && xs[1] < xs[2], "三按钮按 整理 → 回收 → 丢弃 从左到右排列");
}

// 文案：全部登记在 configs/texts（组件里不写裸中文）
[
  "bag_discard_mode_tip",
  "bag_discard_confirm_tip",
  "bag_discard_done_tip",
  "bag_discard_empty_tip",
  "bag_discard_confirm_title",
  "bag_discard_confirm_text",
  "label_bag_discard",
  "label_bag_discard_exit",
  "label_bag_tidy",
  "label_bag_recycle",
  "label_bag_recycle_confirm",
  "label_confirm_ok",
  "label_confirm_cancel",
].forEach((key) => check(new RegExp(`^\\s*${key}:`, "m").test(textsSource), `configs/texts 登记了${key}`));
check(!/[\u4e00-\u9fa5]/.test(dialogSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "BagDialog 里没有裸中文（文案全部走 configs/texts）");

// —— 拖出背包弹窗销毁：手势上报与物品扣留（BagGridView）——
console.log("— 拖出弹窗销毁：手势上报与物品扣留 —");

const gridSource = fs.readFileSync(BAG_GRID_VIEW_FILE, "utf8");
const confirmSource = fs.readFileSync(CONFIRM_DIALOG_FILE, "utf8");

check(/export interface BagDropArea \{/.test(gridSource), "BagGridView 暴露 BagDropArea 接口（受理区 + 拖出上报）");
check(/constructor\(onCellAction: BagCellHandler, dropArea: BagDropArea\)/.test(gridSource), "网格构造接收受理区（由背包弹窗注入）");
check(/private isOutsideDropArea\(screenPoint: Vec2\): boolean \{/.test(gridSource), "有「松手点在受理区外」的独立判定");
check(/return !transform\.hitTest\(screenPoint\);/.test(gridSource), "受理区判定用弹窗的 UITransform.hitTest（与格子同一口径）");
check(
  /if \(active && !hit && this\.isOutsideDropArea\(point\)\) \{/.test(gridSource),
  "三个条件齐了才走销毁：拖过阈值 + 没落在格子上 + 落在弹窗外（点击与弹窗内落空都不算）",
);
check(
  /const landing = hit \?\? drag\.target;/.test(gridSource),
  "弹窗外判定优先（只看松手点本身，不受拖动途中记下的落点影响）；弹窗内才回落到最后一个落点",
);
check(/this\.heldGood = drag\.sourceGood;\s*\n\s*this\.endDrag\(true\);/.test(gridSource), "先把物品扣住（保持压暗）再收拖动");
check(/this\.dropArea\.onDropOutside\(from\);/.test(gridSource), "拖出弹窗外交由弹窗接手（组件不做销毁规则判断）");
check(/releaseDiscardHold\(\) \{/.test(gridSource), "暴露 releaseDiscardHold 供确认/取消后放开扣留");
check(/private endDrag\(keepSourceDimmed = false\)/.test(gridSource), "endDrag 支持保留压暗（拖出时物品不被悄悄恢复亮度）");
check(/if \(!keepSourceDimmed\) GameUiHelper\.setNodeOpacity\(drag\.sourceGood/.test(gridSource), "默认仍恢复透明度（落子/取消照旧）");
check(/cancelDrag\(\) \{\s*this\.releaseDiscardHold\(\);\s*this\.endDrag\(\);/.test(gridSource), "关弹窗时连扣留一起放开");
check(/StorageManager\.moveBagGood\(from\.row, from\.col, landing\.row, landing\.col\);/.test(gridSource), "落子路径未受影响（仍走数据层 moveBagGood）");
check(!/[\u4e00-\u9fa5]/.test(gridSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "BagGridView 里没有裸中文（注释之外）");

// —— 拖出背包弹窗销毁：确认框与弹窗接线 ——
console.log("— 拖出弹窗销毁：确认框与弹窗接线 —");

check(fs.existsSync(CONFIRM_DIALOG_FILE), "存在通用确认框组件 ConfirmDialog");
check(fs.existsSync(`${CONFIRM_DIALOG_FILE}.meta`), "新组件带 .meta（新 assets 必带，否则编辑器不认）");
check(/export default class ConfirmDialog extends Node \{/.test(confirmSource), "确认框自身即节点（构造建 UI，组件约定）");
check(/getVisibleSize\(\)/.test(confirmSource), "全屏遮罩用「可见区」尺寸（NO_BORDER 下不等于设计分辨率）");
check(/blockClickThrough\(this\);/.test(confirmSource), "确认框在鼠标通道登记命中拦截（下层 UI 与世界都收不到这次点击）");
["TOUCH_START", "TOUCH_MOVE", "TOUCH_END", "TOUCH_CANCEL"].forEach((type) =>
  check(new RegExp(`this\\.on\\(Node\\.EventType\\.${type}, this\\.stopTouchBubble, this\\)`).test(confirmSource), `确认框收住 ${type}（按下遮罩不被下面的背包格子拿走）`),
);
check(/event\.propagationStopped = true;/.test(confirmSource), "触摸独占靠 propagationStopped");
check(/this\.destroy\(\);\s*\n\s*handler\(\);/.test(confirmSource), "确定/取消都先关掉确认框再执行回调（顺便挡住同帧连点两次）");
check(!/\bmarkClickThrough\(/.test(confirmSource), "遮罩绝不能标成点击穿透（标了就等于没拦住下层）");
check(/UiHelper\.createSprite\(layout\.panel\.name, layout\.panel\.background/.test(confirmSource), "面板几何与背景图来自配置（组件不写尺寸与图）");
check(!/[\u4e00-\u9fa5]/.test(confirmSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "ConfirmDialog 里没有裸中文（文案由使用方从 configs/texts 传入）");

check(/\{ area: dialog, onDropOutside: \(from\) => this\.onDropOutside\(from\) \},/.test(dialogSource), "背包弹窗把自身作为受理区、拖出交由 onDropOutside");
check(/private onDropOutside\(from: BagCellPos\) \{/.test(dialogSource), "BagDialog 有拖出销毁入口");
check(/if \(!preview\) \{\s*this\.bagGrid\?\.releaseDiscardHold\(\);\s*return;\s*\}/.test(dialogSource), "没有可丢的东西就不弹框（放开扣留安静收场）");
check(/const confirm = new ConfirmDialog\(\{/.test(dialogSource), "拖出后弹全屏确认框");
check(/LayerManager\.addDialogToUILayer\(confirm\);/.test(dialogSource), "确认框挂 UI 层顶层并登记为弹窗（盖在背包弹窗之上，见 LayerManager.addDialogToUILayer）");
check(/getText\("bag_discard_confirm_text", \{ name: preview\.label, count: preview\.count \}\)/.test(dialogSource), "确认框写明物品名与整格数量（数据取自 getBagDiscardPreview）");
check(/onConfirm: \(\) => \{[\s\S]{0,120}StorageManager\.discardBagGood\(from\.row, from\.col\);/.test(dialogSource), "点「确定」真的整格丢弃");
check(/onCancel: \(\) => \{[\s\S]{0,160}this\.bagGrid\?\.releaseDiscardHold\(\);/.test(dialogSource), "点「取消」只放开扣留（数据没动过，物品回原位）");
check(!/confirm\.on\(Node\.EventType\.TOUCH_END/.test(dialogSource), "按钮逻辑不写在弹窗这层（由 ConfirmDialog 组件负责）");
check(/private closeDiscardConfirm\(\) \{/.test(dialogSource), "有统一的收框入口");
check(/close\(\) \{[\s\S]{0,320}this\.closeDiscardConfirm\(\);/.test(dialogSource), "关背包弹窗会收掉确认框（它挂在 UI 层，不随弹窗销毁）");
check(/this\.bagGrid\?\.releaseDiscardHold\(\);\s*\n\s*this\.bagGrid\?\.refresh\(/.test(dialogSource), "背包一变就放开扣留（refresh 里统一复位待确认状态）");
check(/this\.closeDiscardConfirm\(\);\s*\n\s*const confirm = new ConfirmDialog/.test(dialogSource), "重复弹之前先收掉上一个（同一时刻只留一个确认框）");

// 确认框布局配置齐备 + 从 hudLayout barrel 可达
{
  const start = layoutSource.indexOf("export const confirmDialogLayout");
  const end = layoutSource.indexOf("//#endregion", start);
  const block = layoutSource.slice(start, end > start ? end : undefined);
  check(start > 0, "能定位 confirmDialogLayout 配置块");
  check(/maskColor: new Color\(0, 0, 0, 160\)/.test(block), "遮罩颜色在配置里（黑色半透明，与死亡遮罩同款）");
  ["panel", "title", "message", "confirmButton", "cancelButton"].forEach((key) => check(new RegExp(`${key}:`).test(block), `confirmDialogLayout 配了 ${key}`));
  check(/confirmButton: \{ name: "confirm_ok_button", position: new Vec2\(-90, -58\) \}/.test(block), "「确定」在面板左侧");
  check(/cancelButton: \{ name: "confirm_cancel_button", position: new Vec2\(90, -58\) \}/.test(block), "「取消」在面板右侧（两钮左右对称、错开 180 > 按钮宽 123）");
}

void items;
finish("PASS: 背包丢弃的数据行为、界面接线与配置全部通过");

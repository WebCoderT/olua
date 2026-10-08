#!/usr/bin/env node
/**
 * 「同屏多弹窗，点哪个哪个在最上」的自动化验证
 *
 * 一半跑**真实代码**：tools/lib/layer-sandbox.cjs 把 ui/core/LayerManager.ts 编进沙箱
 * （cc 垫片只实现 Node 的父子与兄弟序号语义，照抄引擎 3.8.7 的 setSiblingIndex），
 * 于是弹窗清单与置顶算法是真跑的，不是复刻；另一半是源码断言（接线有没有齐）。
 *
 * 盯的不变量（改层级相关代码后必须全绿）：
 * · 点弹窗 → 浮到其它弹窗之上             · 已经在最上层时再点不动（不白改一次兄弟序号）
 * · 只在**已登记弹窗**之间排序：飘字提示、悬停物品详情这类临时层仍在弹窗之上
 * · 从弹窗内任意节点（含把触摸收住的网格格子）点到，都能沿祖先找到所属弹窗并提上来
 * · 不在任何弹窗里的节点（HUD）被点到保持原位 · 已销毁的弹窗从清单里清掉，不会把弹窗提到不存在的位置
 * · 两条输入通道都接管（TOUCH_START + MOUSE_DOWN），且**不注册 MOUSE_MOVE**（会吞指针移动）
 * · 所有弹窗的挂载点都走 addDialogToUILayer（漏一个 = 那个弹窗点不动）
 * · 临时层 / HUD / 死亡遮罩 / 升级特效仍走 addToUILayer（提层不能把它们卷进来）
 *
 * 用法：node tools/test-dialog-top.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node tools/test-dialog-top.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareLayer } = require("./lib/layer-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const LAYER_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/LayerManager.ts");
const GAME_UI_HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts");
const GAME_FILE = path.join(PROJECT_ROOT, "assets/ui/Game.ts");
const STORAGE_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/StorageManager.ts");
const HOVER_TIP_MANAGER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/HoverTipManager.ts");
const DIALOG_DIR = path.join(PROJECT_ROOT, "assets/ui/components/dialogs");

const read = (file) => fs.readFileSync(file, "utf8");

/** 取一个静态方法的函数体（从签名到下一个两空格缩进的闭合花括号），用于精确断言里面写了什么 */
function methodBody(source, signature) {
  const after = source.split(signature)[1];
  if (after === undefined) return "";
  return after.split("\n  }")[0];
}

let sandbox;
try {
  sandbox = prepareLayer("olua-dialog-top");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { LayerManager, Node } = sandbox;

//#region A. 行为（真实 LayerManager + 引擎语义的 Node 垫片）

console.log("— A. 弹窗层级：点哪个哪个浮到其它弹窗之上 —");

const scene = new Node("scene");
LayerManager.initLayer(scene, { visibility: 0, node: new Node("main_camera") });
const uiLayer = LayerManager.UILayer;
/** UI 层当前的子节点顺序（自下而上，最后一个是「最上层」） */
const order = () => uiLayer.children.map((child) => child.name).join(" → ");

check(uiLayer.name === "ui_layer" && uiLayer.parent === scene, "UI 层挂在场景下（垫片语义：initLayer 建出 ui_layer）");

// 常驻 HUD（不登记）→ 三个弹窗（登记）→ 飘字提示（临时层，弹窗之后创建）
const hud = new Node("bottom_bar");
LayerManager.addToUILayer(hud);
const bag = new Node("bag_dialog");
const roleInfo = new Node("role_info_dialog");
const rank = new Node("rank_upgrade_dialog");
LayerManager.addDialogToUILayer(bag);
LayerManager.addDialogToUILayer(roleInfo);
LayerManager.addDialogToUILayer(rank);
check(order() === "bottom_bar → bag_dialog → role_info_dialog → rank_upgrade_dialog", "弹窗按打开顺序叠在 HUD 之上（后开的在上）", order());

const tip = new Node("tip");
LayerManager.addToUILayer(tip);
check(order() === "bottom_bar → bag_dialog → role_info_dialog → rank_upgrade_dialog → tip", "飘字提示在弹窗之后创建（临时层本就该在最上）", order());

// 点背包 → 浮到其它弹窗之上，但要停在飘字之下
LayerManager.raiseDialog(bag);
check(order() === "bottom_bar → role_info_dialog → rank_upgrade_dialog → bag_dialog → tip", "点背包 → 浮到其它弹窗之上", order());
check(uiLayer.children[uiLayer.children.length - 1] === tip, "抬弹窗不越过最上层弹窗之上的临时层（飘字仍在最上）");

// 已经在最上层 → 不动
const beforeNoop = order();
LayerManager.raiseDialog(bag);
check(order() === beforeNoop, "已经是最上层时再点不动（不白改一次兄弟序号）", order());

// 未登记的节点被点到保持原位
LayerManager.raiseDialog(hud);
check(order() === beforeNoop && uiLayer.children[0] === hud, "未被登记的 HUD 节点被点到保持原位（提层只认已登记弹窗）");

// 悬停物品详情也是临时层（弹窗之后再点开），抬弹窗同样不越过它
const detail = new Node("good_detail_dialog");
LayerManager.addToUILayer(detail);
LayerManager.raiseDialog(roleInfo);
check(order() === "bottom_bar → rank_upgrade_dialog → bag_dialog → role_info_dialog → tip → good_detail_dialog", "点角色信息 → 浮到背包之上，仍留在飘字/悬停详情之下", order());

// 弹窗销毁后被清出清单（否则置顶会追着一个已经不存在的位置，把其它弹窗提上去）
rank.destroy();
const mall = new Node("mall_dialog");
LayerManager.addDialogToUILayer(mall);
check(LayerManager.dialogNodes.filter((item) => item.name === "rank_upgrade_dialog").length === 0, "已销毁的弹窗在下次登记时从清单里清掉（清单不会越积越长）");
check(LayerManager.dialogNodes.length === 3 && LayerManager.dialogNodes.includes(mall), "清单里只剩 3 个活着的弹窗（背包 / 角色信息 / 商城）", LayerManager.dialogNodes.map((item) => item.name).join("/"));
LayerManager.raiseDialog(roleInfo);
check(uiLayer.children[uiLayer.children.length - 1] === roleInfo && uiLayer.children.indexOf(roleInfo) > uiLayer.children.indexOf(mall), "点角色信息 → 浮到商城之上（销毁的军衔弹窗不再参与排序）", order());

// 手势区域把触摸收住（不让事件冒泡到弹窗根）时，由它自己调 raiseDialog → 沿祖先找到所属弹窗
const grid = new Node("bag_grid");
bag.addChild(grid);
const cell = new Node("cell");
grid.addChild(cell);
LayerManager.raiseDialog(cell);
check(uiLayer.children[uiLayer.children.length - 1] === bag && uiLayer.children.indexOf(bag) > uiLayer.children.indexOf(roleInfo), "在网格格子上按下 → 沿祖先把背包弹窗提上来（网格把触摸收住了，事件到不了弹窗根）", order());
LayerManager.raiseDialog(roleInfo);
LayerManager.raiseDialog(cell);
check(order() === "bottom_bar → tip → good_detail_dialog → mall_dialog → role_info_dialog → bag_dialog", "再点一次网格 → 背包重新浮到角色信息之上", order());
const loose = new Node("loose_node");
uiLayer.addChild(loose);
LayerManager.raiseDialog(loose);
check(uiLayer.children[uiLayer.children.length - 1] === loose, "不在任何弹窗里的节点被点到保持原位（找不到所属弹窗就什么都不做）", order());

//#endregion

//#region B. 接线（源码断言）

console.log("\n— B. 接线（源码断言）—");

const layerSource = read(LAYER_MANAGER_FILE);
const helperSource = read(GAME_UI_HELPER_FILE);
const gameSource = read(GAME_FILE);
const storageSource = read(STORAGE_MANAGER_FILE);
const hoverTipSource = read(HOVER_TIP_MANAGER_FILE);

check(/static addDialogToUILayer\(node: Node\)/.test(layerSource) && /static raiseDialog\(node: Node\)/.test(layerSource), "LayerManager 对外两个入口：登记挂载 + 置顶");
check(/const dialog = this\.findDialog\(node\);/.test(layerSource) && /if \(!dialog\) return;/.test(layerSource), "raiseDialog 从任意节点沿祖先找所属弹窗（手势区域把触摸收住时靠它）");
check(/private static findDialog\(node: Node\): Node \| null/.test(layerSource) && /current = current\.parent;/.test(layerSource), "findDialog 沿祖先找最近的已登记弹窗，找不到返回 null（HUD/临时层被点到不动）");
check(/item\.parent !== parent/.test(layerSource) && /getSiblingIndex\(\)/.test(layerSource) && /setSiblingIndex\(topIndex\)/.test(layerSource), "置顶按「同父兄弟里最上层的那个弹窗」定位（改兄弟序号即后绘制在上）");
check(/if \(topIndex <= index\) return;/.test(layerSource), "已在最上层时提前返回（不做无意义的重排）");
check(/dialogNodes = this\.dialogNodes\.filter\(\(item\) => isValid\(item\)\)/.test(layerSource), "登记时清掉已销毁的清单项");

const raiseBody = methodBody(helperSource, "static bindDialogRaiseOnPress(node: Node) {");
check(Boolean(raiseBody), "GameUiHelper.bindDialogRaiseOnPress 存在");
check(/TOUCH_START/.test(raiseBody) && /LayerManager\.raiseDialog\(node\)/.test(raiseBody), "触摸通道：TOUCH_START 冒泡到弹窗根即置顶（点弹窗内任何位置都算）");
check(/MOUSE_DOWN/.test(raiseBody) && /HAS_MOUSE/.test(raiseBody), "鼠标通道：MOUSE_DOWN 补一次（只在有鼠标的环境登记）");
check(!/MOUSE_MOVE/.test(raiseBody), "不注册 MOUSE_MOVE（节点一旦命中就会吞掉指针移动，指针样式与按住走路都会卡住）");
check(/trackUiPress\(node\)/.test(raiseBody), "顺带登记「按压起点」（与 blockClickThrough 同一套口径，幂等）");

const dialogBgBody = methodBody(helperSource, "static createDialogBg(name: string");
check(/this\.bindDialogRaiseOnPress\(dialog\)/.test(dialogBgBody), "createDialogBg 里挂上置顶（走 createDialog 的弹窗全部自动获得该行为）");

// 每个弹窗的挂载点都必须登记：漏一个，那个弹窗就点不动
// [文件, 登记式挂载次数（弹窗）, 普通挂载次数（临时层，如商城/背包的悬停详情）]
const dialogFiles = [
  ["RankUpgradeDialog.ts", 1, 0],
  ["WarSoulDialog.ts", 1, 0],
  ["TitleUpgradeDialog.ts", 1, 0],
  ["SkillListDialog.ts", 1, 0],
  ["SkillShortcutSettingDialog.ts", 1, 0],
  ["MapTeleportDialog.ts", 1, 0],
  ["MapPreviewDialog.ts", 1, 0],
  ["RoleInfoDialog.ts", 1, 0],
  ["MallDialog.ts", 1, 1],
  ["BagDialog.ts", 2, 0],
];
/** 数一个文件里的挂载调用：addToUILayer 是 addDialogToUILayer 的子串，用后顾把前者摘掉 */
const countMount = (source, api) => (source.match(new RegExp(`(?<!Dialog)${api}\\(`, "g")) ?? []).length;
for (const [file, registeredCount, plainCount] of dialogFiles) {
  const source = read(path.join(DIALOG_DIR, file));
  const registered = countMount(source, "addDialogToUILayer");
  const plain = countMount(source, "addToUILayer");
  check(registered === registeredCount && plain === plainCount, `${file}：弹窗全部走 addDialogToUILayer（${registeredCount} 个），临时层仍走 addToUILayer（${plainCount} 个）`, `实测 登记 ${registered} / 普通 ${plain}`);
}
const mallSource = read(path.join(DIALOG_DIR, "MallDialog.ts"));
check(/GameUiHelper\.bindDialogRaiseOnPress\(dialog\)/.test(mallSource), "商城自有底图（没走 createDialogBg）单独挂一次置顶");
const bagSource = read(path.join(DIALOG_DIR, "BagDialog.ts"));
check(/GameUiHelper\.bindDialogRaiseOnPress\(this\.bagGrid\)/.test(bagSource), "背包网格自己挂一次置顶（它在 setupTouchOwnership 里收住触摸，TOUCH_START 到不了弹窗根）");
check(/TOUCH_START, this\.stopTouchBubble/.test(read(path.join(PROJECT_ROOT, "assets/ui/components/panel/BagGridView.ts"))), "背包网格仍然停住触摸冒泡（拖动不带着弹窗一起动，这是它必须自己挂置顶的原因）");

const confirmSource = read(path.join(DIALOG_DIR, "ConfirmDialog.ts"));
check(/GameUiHelper\.bindDialogRaiseOnPress\(this\)/.test(confirmSource), "全屏确认框也登记置顶（与其它弹窗同一套口径）");
check(/propagationStopped = true/.test(confirmSource), "确认框仍然独占触摸（遮罩命中时事件不会冒泡到它下面的弹窗——兄弟不在冒泡链上）");
check(/blockClickThrough\(this\)/.test(confirmSource), "确认框仍然独占鼠标通道");

// 不该被卷进来的：HUD / 临时层 / 死亡遮罩 / 升级特效
// 飘字是临时层：游戏内仍挂 UI 图层（保持最上，不参与弹窗置顶排序）；
// 登录/选角这类没调 initLayer 的场景没有图层容器，改挂场景根（见 GameUiHelper.mountFloatingTip）
check(/private static mountFloatingTip\(tip: Node\)/.test(helperSource) && /if \(uiLayer && isValid\(uiLayer\) && uiLayer\.scene\)[\s\S]{0,80}LayerManager\.addToUILayer\(tip\)/.test(helperSource), "飘字提示：游戏内仍挂 UI 图层（临时层保持最上），非游戏场景挂场景根");
check(/LayerManager\.addToUILayer\(detailDialog\)/.test(helperSource), "悬停物品详情仍是 addToUILayer（同上）");
check(/LayerManager\.addToUILayer\(detail\)/.test(mallSource), "商城的悬停详情仍是 addToUILayer（同上）");
check(/LayerManager\.addToUILayer\(dialog\)/.test(hoverTipSource), "悬停提示仍是 addToUILayer（同上）");
check(/LayerManager\.addToUILayer\(this\.bottomBar\)/.test(gameSource) && /LayerManager\.addToUILayer\(this\.roleInfoBar\)/.test(gameSource) && /LayerManager\.addToUILayer\(this\.smallMap\)/.test(gameSource), "三个常驻 HUD 区域仍是 addToUILayer（点它们不该跑到弹窗之上）");
check(/LayerManager\.addToUILayer\(monsterInfoPanel\)/.test(gameSource), "怪物信息面板仍是 addToUILayer（同上）");
check(/LayerManager\.addToUILayer\(this\.deathDialog\)/.test(gameSource), "死亡遮罩仍是 addToUILayer：不参与置顶排序，保持盖在弹窗之上");
check(/LayerManager\.addToUILayer\(GameUiHelper\.createUpgradeEffect\(\)\)/.test(storageSource), "升级特效仍是 addToUILayer（临时特效不参与排序）");

//#endregion

finish("PASS：弹窗层级（点哪个哪个在最上）行为与接线全部通过。");

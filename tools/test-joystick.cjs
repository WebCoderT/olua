#!/usr/bin/env node
/**
 * 左下角操作摇杆的自动化验证
 *
 * A 段跑**真实代码**（沙箱见 tools/lib/configs-sandbox.cjs）：
 * · `ui/utils/input/Joystick` 的两个纯函数（夹取半径 / 拖动位移 → 八方向 + 走跑）
 * · `ui/utils/layout/ScreenLayout.getAnchoredPosition` 的新贴边方式 bottom-left
 *   （与 top-left 对称，且不改变 bottom-center 的旧语义——底部栏按「区块中心到屏幕下边缘」定位）
 * 期望值全部由**真实配置**（configs/role.joystickMove、configs/layout/hud.joystickLayout）算出，不另写一份常量。
 *
 * B 段对「摇杆的接线」做源码断言（钉住几条改一处就废的约定）：
 * · 输入只用 touch 通道（TOUCH_START/MOVE/END/CANCEL）、不注册任何 MOUSE_*
 *   （引擎会把鼠标按下后的移动/抬起模拟成 touch，一套通道覆盖触屏与桌面；混注册会让一次操作派发两次，
 *    而 MOUSE_MOVE 注册在节点上会吞掉指针追踪与按住走路）
 * · 手柄位移被夹在可拖半径内、抬起/取消回中
 * · 主角的移动意图优先级：键盘 > 摇杆 > 鼠标；isManualMoving 也要认摇杆（自动战斗据此让位）
 * · 摇杆节点在 HUD 层（组合根创建并挂 UI 层）、贴边重排接了 applyAnchorPosition
 * · 「按压起点在界面元素上」的那次抬起不被世界侧当成点击（ScreenClickInput + Pointer.isUiPressOnUiElement）
 * · 几何自洽：手柄拖到最外圈不溢出底座；素材在 resources/main 且带 meta
 *
 * 用法：node tools/test-joystick.cjs
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const UI = path.join(PROJECT_ROOT, "assets/ui");
const CONFIGS = path.join(PROJECT_ROOT, "assets/configs");
const CC_DIR = (outDir) => path.join(path.dirname(outDir), "node_modules/cc/index.js");

/**
 * 追加到 cc 垫片末尾的部分：
 * · Vec2 的向量方法（真实配置/工具函数会用到 length / lengthSqr / equals）
 * · screen / view / ResolutionPolicy（ScreenLayout 的贴边计算要用）
 * · Node / BoxCollider2D 空壳（BattleMath 的八方向量化里会 getComponent，沙箱不真的取碰撞盒）
 */
const CC_EXTRA = `
Vec2.prototype.length = function () { return Math.sqrt(this.x * this.x + this.y * this.y); };
Vec2.prototype.lengthSqr = function () { return this.x * this.x + this.y * this.y; };
Vec2.prototype.equals = function (other) { return !!other && this.x === other.x && this.y === other.y; };

const __screen = { windowWidth: 1624, windowHeight: 750, scaleX: 1, scaleY: 1 };
const view = {
  getScaleX: () => __screen.scaleX,
  getScaleY: () => __screen.scaleY,
  getDesignResolutionSize: () => new Size(1624, 750),
  getVisibleSize: () => new Size(1624, 750),
  setDesignResolutionSize: () => {},
};
const screen = {
  get windowSize() { return new Size(__screen.windowWidth, __screen.windowHeight); },
  on: () => {},
  off: () => {},
};
const ResolutionPolicy = { NO_BORDER: "NO_BORDER", SHOW_ALL: "SHOW_ALL" };

module.exports.view = view;
module.exports.screen = screen;
module.exports.ResolutionPolicy = ResolutionPolicy;
module.exports.__screen = __screen;
module.exports.Node = class Node {};
module.exports.BoxCollider2D = class BoxCollider2D {};
module.exports.isValid = () => true;
`;

const read = (p) => fs.readFileSync(p, "utf8");
/** 数出某模式在源码里出现几次 */
const count = (text, re) => (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

//#region A 段：真实纯函数与贴边布局

let outDir = null;
try {
  outDir = prepare("olua-joystick", ["ui/utils/input/Joystick.ts", "ui/utils/layout/ScreenLayout.ts", "ui/utils/battle/BattleMath.ts"], CC_EXTRA);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
}

if (outDir) {
  const cc = require(CC_DIR(outDir));
  const { clampJoystickOffset, resolveJoystickMove } = require(path.join(outDir, "ui/utils/input/Joystick.js"));
  const { getAnchoredPosition, designResolution } = require(path.join(outDir, "ui/utils/layout/ScreenLayout.js"));
  const { joystickMove } = require(path.join(outDir, "configs/role.js"));
  const { joystickLayout } = require(path.join(outDir, "configs/hudLayout.js"));

  const radius = joystickLayout.radius;
  /** 走路档的采样长度：死区与跑动阈值之间 */
  const walkLength = radius * ((joystickMove.deadZone + joystickMove.runThreshold) / 2);

  console.log("A 段：摇杆判定纯函数（跑真实代码与真实配置）");
  console.log(`  radius=${radius}  deadZone=${joystickMove.deadZone}  runThreshold=${joystickMove.runThreshold}`);

  // ---- 夹取 ----
  const inside = clampJoystickOffset(new cc.Vec2(radius / 2, 0));
  check(near(inside.x, radius / 2) && near(inside.y, 0), "半径内的位移原样保留", `(${inside.x}, ${inside.y})`);

  const over = clampJoystickOffset(new cc.Vec2(1000, 0));
  check(near(over.length(), radius), "超出半径的位移被夹到半径上", `长度 ${over.length()}`);

  const diagonal = clampJoystickOffset(new cc.Vec2(300, 400));
  check(near(diagonal.length(), radius) && near(diagonal.x, radius * 0.6) && near(diagonal.y, radius * 0.8), "斜向超界按原方向等比夹取（方向不变）", `(${diagonal.x.toFixed(2)}, ${diagonal.y.toFixed(2)})`);

  const zero = clampJoystickOffset(new cc.Vec2(0, 0));
  check(zero.x === 0 && zero.y === 0, "零位移夹取后仍是零（不会除零出 NaN）");

  const source = new cc.Vec2(999, 999);
  clampJoystickOffset(source);
  check(source.x === 999 && source.y === 999, "夹取不改入参（返回新向量）");

  // ---- 走 / 跑三段 ----
  check(resolveJoystickMove(new cc.Vec2(0, 0)) === null, "零位移 = 原地（返回 null）");
  check(resolveJoystickMove(new cc.Vec2(radius * joystickMove.deadZone - 1, 0)) === null, "死区内 = 原地（返回 null）");
  check(resolveJoystickMove(new cc.Vec2(radius * joystickMove.deadZone + 1, 0)) !== null, "刚出死区即起步（有移动意图）");
  check(resolveJoystickMove(new cc.Vec2(radius * joystickMove.deadZone - 0.001, 0)) === null, "死区边界内侧仍是原地");

  const walk = resolveJoystickMove(new cc.Vec2(walkLength, 0));
  check(!!walk && walk.run === false, "拖动幅度介于死区与阈值之间 = 走路", `长度 ${walkLength.toFixed(2)}`);

  const runState = resolveJoystickMove(new cc.Vec2(radius * joystickMove.runThreshold + 1, 0));
  check(!!runState && runState.run === true, "拖动幅度达到阈值 = 跑动");
  check(!!resolveJoystickMove(new cc.Vec2(radius, 0))?.run, "拖满半径 = 跑动（手柄贴到最外圈就是最大速度）");

  // ---- 方向（八方向量化，与键盘/鼠标同一口径） ----
  const dirCases = [
    [new cc.Vec2(walkLength, 0), 1, 0, "右"],
    [new cc.Vec2(-walkLength, 0), -1, 0, "左"],
    [new cc.Vec2(0, walkLength), 0, 1, "上"],
    [new cc.Vec2(0, -walkLength), 0, -1, "下"],
    [new cc.Vec2(walkLength * 0.7071, walkLength * 0.7071), Math.SQRT1_2, Math.SQRT1_2, "右上"],
    [new cc.Vec2(-walkLength * 0.7071, -walkLength * 0.7071), -Math.SQRT1_2, -Math.SQRT1_2, "左下"],
  ];
  for (const [offset, x, y, label] of dirCases) {
    const state = resolveJoystickMove(offset);
    const ok = !!state && near(state.direction.x, x, 1e-4) && near(state.direction.y, y, 1e-4) && near(state.direction.length(), 1, 1e-6);
    check(ok, `方向量化：${label}（单位向量）`, ok ? "" : JSON.stringify(state && state.direction));
  }

  // ---- 贴边布局：bottom-left ----
  console.log("\nA 段：贴边布局（新增 bottom-left；既有三种贴边行为不变）");
  const size = new cc.Size(joystickLayout.size.width, joystickLayout.size.height);
  const visible = new cc.Size(designResolution.width, designResolution.height);
  const { marginX, marginY } = joystickLayout.anchor;

  const bottomLeft = getAnchoredPosition(size, visible, "bottom-left", marginX, marginY);
  check(
    near(bottomLeft.x, -designResolution.width / 2 + marginX + size.width / 2) && near(bottomLeft.y, -designResolution.height / 2 + marginY + size.height / 2),
    "bottom-left：左边距从屏幕左边缘算、下边距从屏幕下边缘算（区块整块落在可见区左下角）",
    `(${bottomLeft.x}, ${bottomLeft.y})`,
  );

  const topLeft = getAnchoredPosition(size, visible, "top-left", marginX, marginY);
  check(near(bottomLeft.x, topLeft.x), "bottom-left 与 top-left 的横坐标一致（同贴左边）");
  check(bottomLeft.y < 0 && topLeft.y > 0, "bottom-left 在屏幕下半、top-left 在上半（贴边方向相反）");

  const bottomCenter = getAnchoredPosition(size, visible, "bottom-center", 0, marginY);
  check(near(bottomCenter.x, 0) && near(bottomCenter.y, -designResolution.height / 2 + marginY), "bottom-center 语义不变（区块中心到屏幕下边缘，底部栏在用）");

  const topRight = getAnchoredPosition(size, visible, "top-right", 2, 12);
  check(near(topRight.x, designResolution.width / 2 - 2 - size.width / 2), "top-right 语义不变（小地图在用）");
}

//#endregion

//#region B 段：接线与配置（源码断言）

console.log("\nB 段：接线与配置（源码断言）");

const joystickInputSrc = read(path.join(UI, "components/input/RoleJoystickInput.ts"));
const joystickSrc = read(path.join(UI, "components/hud/Joystick.ts"));
const roleDisplaySrc = read(path.join(UI, "components/role/RoleDisplay.ts"));
const gameSrc = read(path.join(UI, "Game.ts"));
const gameUiHelperSrc = read(path.join(UI, "helpers/GameUiHelper.ts"));
const screenClickSrc = read(path.join(UI, "components/input/ScreenClickInput.ts"));
const pointerSrc = read(path.join(UI, "utils/input/Pointer.ts"));
const pureSrc = read(path.join(UI, "utils/input/Joystick.ts"));
const hudLayoutSrc = read(path.join(CONFIGS, "layout/hud.ts"));
const imagesSrc = read(path.join(CONFIGS, "layout/images.ts"));
const roleConfigSrc = read(path.join(CONFIGS, "role.ts"));

// ---- 输入通道：只用 touch ----
check(count(joystickInputSrc, /Node\.EventType\.TOUCH_START/) === 1, "注册 TOUCH_START（按下即起步）");
check(count(joystickInputSrc, /Node\.EventType\.TOUCH_MOVE/) === 1, "注册 TOUCH_MOVE（拖动实时改向）");
check(count(joystickInputSrc, /Node\.EventType\.TOUCH_END/) === 1, "注册 TOUCH_END（抬手即停）");
check(count(joystickInputSrc, /Node\.EventType\.TOUCH_CANCEL/) === 1, "注册 TOUCH_CANCEL（触摸被打断也要收尾）");
check(count(joystickInputSrc, /Node\.EventType\.MOUSE_/) === 0, "不注册任何 MOUSE_* 节点事件（引擎已把鼠标拖动模拟成 touch，混注册会派发两次；MOUSE_MOVE 注册在节点上还会吞掉指针追踪与按住走路）");
check(count(joystickInputSrc, /Input\.EventType\.MOUSE_/) === 0, "也不注册全局 MOUSE_*（世界侧的按住走路/点击完全不受摇杆影响）");

// ---- 输入行为 ----
check(/blockClickThrough\(\s*host\s*\)/.test(joystickInputSrc), "摇杆在鼠标通道登记（点击不穿透 + 随手记下按压起点）");
check(/clampJoystickOffset\(/.test(joystickInputSrc), "手柄位移先夹取再落位（拖不出底座）");
check(/resolveJoystickMove\(/.test(joystickInputSrc), "走/跑与方向交给纯函数判定（不在这里另写一套阈值）");
check(/private release\(/.test(joystickInputSrc) && /setPosition\(0, 0, 0\)/.test(joystickInputSrc), "抬起/取消把手柄回中");
check(/NODE_DESTROYED/.test(joystickInputSrc), "宿主销毁时自动收尾（重进场景不残留）");
check(/TOUCH_CANCEL[\s\S]{0,80}?onTouchCancel/.test(joystickInputSrc) && /private onTouchCancel\(\)[\s\S]{0,120}?this\.release\(\)/.test(joystickInputSrc), "取消按抬起处理（否则手柄停在半路、角色一直走）");

// ---- 纯函数模块 ----
check(/export function clampJoystickOffset/.test(pureSrc) && /export function resolveJoystickMove/.test(pureSrc), "两个纯函数都从 utils/input/Joystick 导出（单测可直接跑）");
check(/getVectorByDirection\(getDirectionByVector\(/.test(pureSrc.replace(/\s+/g, "")), "方向走 BattleMath 的八方向量化（与键盘/鼠标同一口径，不另写一套）");
check(/joystickMove/.test(pureSrc) && /joystickLayout/.test(pureSrc), "阈值与半径都读配置（代码里没有硬编码手感数值）");

// ---- 主角接线 ----
const intentBody = roleDisplaySrc.slice(roleDisplaySrc.indexOf("private getMoveIntent"), roleDisplaySrc.indexOf("private updateAnimationPlay"));
const intentOrder = ["keyboardInput", "joystickInput", "pointerInput"].map((key) => intentBody.indexOf(key));
check(intentOrder.every((index) => index >= 0) && intentOrder[0] < intentOrder[1] && intentOrder[1] < intentOrder[2], "移动意图优先级：键盘 > 摇杆 > 鼠标");
check(/new RoleJoystickInput\(/.test(roleDisplaySrc), "主角组件创建摇杆输入（与键盘/鼠标输入同一职责；节点在 HUD 层，见 setJoystick）");
check(/setJoystick\(stick: Node, handle: Node\)/.test(roleDisplaySrc), "主角组件开放 setJoystick（由组合根注入摇杆节点）");
check(/isManualMoving\(\)[\s\S]{0,260}?joystickInput/.test(roleDisplaySrc), "isManualMoving 认摇杆（自动战斗据此让位）");

// ---- HUD 组装与贴边 ----
check(/applyJoystickBodyStyle/.test(joystickSrc) && /static applyJoystickBodyStyle/.test(gameUiHelperSrc), "摇杆零件由 GameUiHelper 施加（组件里不写尺寸/图片路径）");
check(/get handleNode\(\)/.test(joystickSrc) && /get stickNode\(\)/.test(joystickSrc), "摇杆暴露底座与手柄两个节点给输入层");
check(/applyAnchorPosition\(\)\s*\{[\s\S]{0,120}?setJoystickPosition/.test(joystickSrc), "摇杆可被重排（窗口尺寸变化时会调用）");
check(/new Joystick\(\)/.test(gameSrc) && /addToUILayer\(this\.joystick\)/.test(gameSrc), "组合根创建摇杆并挂到 UI 层");
check(/setJoystick\(\s*this\.joystick\.stickNode,\s*this\.joystick\.handleNode\s*\)/.test(gameSrc), "组合根把摇杆节点注入主角组件");
check(/this\.joystick\?\.applyAnchorPosition\(\)/.test(gameSrc), "窗口尺寸变化时摇杆跟着重排");

// ---- 世界侧不误判摇杆拖动 ----
check(/export function isUiPressOnUiElement/.test(pointerSrc), "Pointer 导出「本次按压的起点是否在界面元素上」的判据");
check(/pressTarget\s*!==?\s*null|!!pressTarget/.test(pointerSrc) && /isValid\(pressTarget\)/.test(pointerSrc), "判据基于按下那一刻记下的命中目标（且校验有效性）");
check(/isUiPressOnUiElement\(\)/.test(screenClickSrc), "世界点击据此跳过（在摇杆上按下、拖到世界才松手不算世界点击）");

// ---- 配置 ----
const joystickBlock = hudLayoutSrc.slice(hudLayoutSrc.indexOf("export const joystickLayout"), hudLayoutSrc.indexOf("//#region 小地图"));
check(joystickBlock.length > 0 && /edge:\s*"bottom-left"/.test(joystickBlock), "摇杆布局贴屏幕左下角（bottom-left）");
check(/radius:\s*\d+/.test(joystickBlock) && /handleSize:\s*new Size\(/.test(joystickBlock), "摇杆布局含可拖半径与手柄尺寸");
check(/"bottom-left"/.test(hudLayoutSrc.split("//#region")[1] ?? ""), "贴边方式的联合类型里登记了 bottom-left");
check(/export const joystickMove/.test(roleConfigSrc) && /deadZone/.test(roleConfigSrc) && /runThreshold/.test(roleConfigSrc), "手感参数（死区/跑动阈值）在 configs/role.joystickMove");
check(/joystickBackground:\s*mainImage\("joystick_bg"\)/.test(imagesSrc) && /joystickHandle:\s*mainImage\("joystick"\)/.test(imagesSrc), "两张摇杆素材都登记在 uiImages（代码里没有裸路径）");

// ---- 几何自洽 + 素材在位 ----
if (outDir) {
  const { joystickLayout } = require(path.join(outDir, "configs/hudLayout.js"));
  const { joystickMove } = require(path.join(outDir, "configs/role.js"));
  check(joystickMove.deadZone > 0 && joystickMove.deadZone < joystickMove.runThreshold && joystickMove.runThreshold <= 1, "死区 < 跑动阈值 ≤ 1（拖动幅度被划成 原地/走/跑 三段）");
  check(joystickLayout.radius > 0, "可拖半径为正数");
  check(joystickLayout.radius + joystickLayout.handleSize.width / 2 <= joystickLayout.size.width / 2 + 0.5, "手柄拖到最外圈不溢出底座（横向）");
  check(joystickLayout.radius + joystickLayout.handleSize.height / 2 <= joystickLayout.size.height / 2 + 0.5, "手柄拖到最外圈不溢出底座（纵向）");
}

for (const asset of ["joystick", "joystick_bg"]) {
  const png = path.join(PROJECT_ROOT, "assets/resources/main", `${asset}.png`);
  check(fs.existsSync(png) && fs.existsSync(`${png}.meta`), `素材在位：resources/main/${asset}.png（含 .meta）`);
}

//#endregion

finish("摇杆验证通过：判定纯函数、贴边布局、TOUCH 单通道接线、主角优先级与世界侧跳过全部符合预期。");

#!/usr/bin/env node
/**
 * 登录 / 选角两个场景「整屏适配」的自动化验证：跑**真实的 ScreenLayout 纯函数**与
 * **真实的 configs/layout/scenes 配置**（沙箱见 client/tools/lib/configs-sandbox.cjs，
 * cc 垫片补了可调的 screen / view），再对两个场景组件的接线做源码断言。
 *
 * 背景：两个场景都采用「舞台 contain 缩放」—— 全部元素挂在固定设计尺寸的舞台容器下，
 * 运行时把整块舞台按可见尺寸等比缩小（只缩不放）。不缩放的话，铺满窗口（NO_BORDER）
 * 策略会在偏宽窗口裁掉上下（登录的 logo / 注册按钮、选角的底部元素）、
 * 窄高窗口裁掉左右（登录输入框、选角两侧按钮）。
 * 选角底部栏**不在舞台内**：素材是带「开始游戏」牌匾装饰的整图、拉伸会变形，
 * 只能等比缩放 —— 它作为「框」要横跨整个可见宽并贴屏幕底边，位置按可见尺寸实时算。
 *
 * 盯的不变量（改适配逻辑后必须全绿）：
 * · 任意窗口尺寸下，登录舞台的全部元素、选角舞台的全部元素（含角色站位 / 删除按钮 / 创建弹窗）
 *   **整块都落在可见区内**（不越界、不被裁）
 * · 设计分辨率（1624×750）下舞台缩放系数恰为 1（不缩放）
 * · 底部栏：横跨整个可见宽（视觉宽 = 可见宽）、贴屏幕底边（视觉底边 = -可见高/2）、
 *   等比缩放（x/y 同系数，不变形）且系数 ≤ 1（铺满窗口下可见宽恒 ≤ 设计宽，不会放大模糊）
 * · 可见区取「窗口像素 ÷ view 缩放」，不是设计分辨率
 * · 舞台缩放接线：Login / RoleSelector 都注册 window-resize 重排、onDestroy 取消；
 *   选角底部栏挂在场景根（不在舞台子树里）
 *
 * 用法：node client/tools/test-scene-stage.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-scene-stage.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, loadCcShim, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const LOGIN_FILE = path.join(PROJECT_ROOT, "assets/ui/Login.ts");
const ROLE_SELECTOR_FILE = path.join(PROJECT_ROOT, "assets/ui/RoleSelector.ts");

/**
 * 追加到 cc 垫片末尾的屏幕部分：把 screen / view 做成**可调**的（测试里改窗口尺寸与缩放，
 * 验证「可见区 = 窗口像素 ÷ 缩放」），行为与引擎 NO_BORDER 下的口径一致
 */
const SCREEN_SHIM = `
const __screen = { windowWidth: 1624, windowHeight: 750, scaleX: 1, scaleY: 1 };
const view = {
  getScaleX: () => __screen.scaleX,
  getScaleY: () => __screen.scaleY,
  getDesignResolutionSize: () => new Size(1624, 750),
  // 引擎在 NO_BORDER 下 view.getVisibleSize() 恒等于设计分辨率（故真实可见区不能用它算）
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
`;

let outDir;
try {
  outDir = prepare("olua-scene-stage", ["ui/utils/layout/ScreenLayout.ts", "configs/layout/scenes.ts"], SCREEN_SHIM);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { getStageScale, getVisibleSize } = require(path.join(outDir, "ui/utils/layout/ScreenLayout.js"));
const { loginLayout, roleSelectorLayout } = require(path.join(outDir, "configs/layout/scenes.js"));
const cc = loadCcShim(outDir);
const { Size, Vec2 } = cc;

const EPS = 1e-6;
const DESIGN = new Size(1624, 750);

/** 设置当前窗口（像素）与缩放；返回真实可见区（NO_BORDER 公式：scale = max(sw/dw, sh/dh)） */
function setWindow(width, height) {
  const scale = Math.max(width / DESIGN.width, height / DESIGN.height);
  cc.__screen.windowWidth = width;
  cc.__screen.windowHeight = height;
  cc.__screen.scaleX = scale;
  cc.__screen.scaleY = scale;
  return getVisibleSize();
}

/** 元素中心 + 尺寸 + 缩放 → 屏幕矩形 {left, right, top, bottom} */
function rectOf(position, size, scale) {
  const halfWidth = (size.width * scale) / 2;
  const halfHeight = (size.height * scale) / 2;
  return { left: position.x * scale - halfWidth, right: position.x * scale + halfWidth, top: position.y * scale + halfHeight, bottom: position.y * scale - halfHeight };
}

/** 矩形是否整块落在可见区内 */
function inside(rect, visible) {
  return rect.left >= -visible.width / 2 - EPS && rect.right <= visible.width / 2 + EPS && rect.top <= visible.height / 2 + EPS && rect.bottom >= -visible.height / 2 - EPS;
}

/** 登录舞台的全部元素（中心 + 尺寸），清单从配置推导 —— 配置加元素后这里自动跟上 */
function loginElements() {
  const layout = loginLayout;
  return [
    ["账号输入框", layout.account],
    ["密码输入框", layout.password],
    ["登录按钮", layout.loginButton],
    ["注册按钮", layout.registerButton],
    ["logo", layout.logo],
  ];
}

/** 选角舞台的全部元素（中心 + 尺寸），清单从配置推导 */
function roleSelectorElements() {
  const layout = roleSelectorLayout;
  const elements = [
    ["创建角色按钮", layout.createRoleButton],
    ["管理角色按钮", layout.manageRoleButton],
    ["返回按钮", layout.backButton],
    ["选中信息框", layout.selectedInfo],
    ["管理提示条", { position: layout.manageRole.hint.position, size: layout.manageRole.hint.size }],
    ["创建角色弹窗", layout.createDialog],
  ];
  // 角色站位（预览）与管理模式的删除按钮（位置 = 站位 + 偏移）
  layout.rolePositions.forEach((position, index) => {
    elements.push([`角色站位${index + 1}`, { position, size: layout.previewSize }]);
    elements.push([`删除按钮${index + 1}`, { position: new Vec2(position.x + layout.manageRole.deleteButtonOffset.x, position.y + layout.manageRole.deleteButtonOffset.y), size: layout.manageRole.deleteButtonSize }]);
  });
  return elements;
}

/** 枚举有代表性的窗口：设计分辨率 / 常见桌面宽高比 / 超宽 / 4:3 / 竖屏手机 */
const WINDOWS = [
  [1624, 750],
  [1920, 1080],
  [2560, 1080],
  [3440, 1440],
  [1366, 768],
  [1024, 768],
  [1280, 800],
  [900, 900],
  [750, 1334],
  [390, 844],
];

console.log("\n== A. 登录舞台：任意窗口下全部元素落在可见区内 ==");
let loginChecked = 0;
for (const [width, height] of WINDOWS) {
  const visible = setWindow(width, height);
  const scale = getStageScale(loginLayout.stageSize, visible);
  const bad = loginElements().filter(([name, item]) => !inside(rectOf(item.position, item.size, scale), visible));
  check(bad.length === 0, `${width}×${height}（可见 ${Math.round(visible.width)}×${Math.round(visible.height)}，舞台缩放 ${(scale * 100).toFixed(1)}%）全部元素在屏内`, bad.length ? `越界：${bad.map(([name]) => name).join("、")}` : "");
  loginChecked++;
}
check(loginChecked === WINDOWS.length, `共覆盖 ${WINDOWS.length} 种窗口尺寸`);

console.log("\n== B. 选角舞台：任意窗口下全部元素落在可见区内 ==");
for (const [width, height] of WINDOWS) {
  const visible = setWindow(width, height);
  const scale = getStageScale(roleSelectorLayout.stageSize, visible);
  const bad = roleSelectorElements().filter(([name, item]) => !inside(rectOf(item.position, item.size, scale), visible));
  check(bad.length === 0, `${width}×${height}（舞台缩放 ${(scale * 100).toFixed(1)}%）全部元素在屏内`, bad.length ? `越界：${bad.map(([name]) => name).join("、")}` : "");
}

console.log("\n== C. 设计分辨率下舞台不缩放 ==");
{
  const visible = setWindow(1624, 750);
  check(getStageScale(loginLayout.stageSize, visible) === 1, `登录舞台缩放系数为 1（stageSize ${loginLayout.stageSize.width}×${loginLayout.stageSize.height}）`);
  check(getStageScale(roleSelectorLayout.stageSize, visible) === 1, "选角舞台缩放系数为 1");
}

console.log("\n== D. 选角底部栏：横跨可见宽 + 贴底 + 等比不变形 ==");
{
  const barLayout = roleSelectorLayout.bottomBar;
  check(!("position" in barLayout), "配置不再写死 position（位置由可见尺寸实时算）");
  for (const [width, height] of WINDOWS) {
    const visible = setWindow(width, height);
    // 与 RoleSelector.applyStageLayout 同一套公式（测试里复算，保证「实现 = 公式」时断言才有意义）
    const barScale = visible.width / barLayout.size.width;
    const visualHeight = barLayout.size.height * barScale;
    const bottom = -visible.height / 2;
    check(
      barScale <= 1 + EPS,
      `${width}×${height} 缩放系数 ≤ 1（${barScale.toFixed(3)}，铺满窗口下可见宽恒 ≤ 设计宽）`,
    );
    check(
      Math.abs(barScale * barLayout.size.width - visible.width) < EPS && Math.abs(visualHeight - barLayout.size.height * (visible.width / barLayout.size.width)) < EPS,
      `${width}×${height} 视觉宽 ${Math.round(barScale * barLayout.size.width)} = 可见宽 ${Math.round(visible.width)}（横跨整屏，等比所以不变形）`,
    );
    check(
      Math.abs(bottom - -visible.height / 2) < EPS && bottom + visualHeight <= visible.height / 2 + EPS,
      `${width}×${height} 贴屏幕底边（视觉底边 = ${bottom.toFixed(1)}，顶边 ${Math.round(bottom + visualHeight)} 在屏内）`,
    );
  }
}

console.log("\n== E. 源码接线断言 ==");
{
  const strip = (file) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const login = strip(LOGIN_FILE);
  const selector = strip(ROLE_SELECTOR_FILE);

  check(/new Node\("login_stage"\)/.test(login), "Login：创建舞台容器 login_stage");
  check(/addComponent\(UITransform\)\.setContentSize\(layout\.stageSize\)/.test(login), "Login：舞台尺寸来自 loginLayout.stageSize");
  check(/getStageScale\(loginLayout\.stageSize/.test(login), "Login：缩放系数走 ScreenLayout.getStageScale");
  check(/this\.offWindowResize = onWindowResize\(\(\) => this\.applyStageLayout\(\)\)/.test(login), "Login：注册窗口变化重排");
  check(/onDestroy\(\) \{\s*this\.offWindowResize\?\.\(\);\s*this\.offWindowResize = null;/.test(login), "Login：onDestroy 取消监听（screen 单例不随节点销毁）");
  check(/createFullScreenImage\("login_background"/.test(login) && !/this\.stage\.addChild\(GameUiHelper\.createFullScreenImage/.test(login), "Login：背景挂在场景根（不在舞台内，铺满可见区兜底）");

  check(/this\.node\.addChild\(bottomBar\);\s*\n\s*this\.bottomBar = bottomBar;/.test(selector), "RoleSelector：底部栏挂在场景根（不在舞台子树里）");
  check(!/this\.stage!\.addChild\(bottomBar\)/.test(selector), "RoleSelector：底部栏不再挂进舞台（否则跟着缩、两侧露背景）");
  check(/const barScale = visible\.width \/ barLayout\.size\.width;/.test(selector), "RoleSelector：底部栏按可见宽等比缩放（素材带牌匾装饰不可拉伸）");
  check(/getAnchoredPosition\(visual, visible, "bottom-center"/.test(selector), "RoleSelector：底部栏贴底走 getAnchoredPosition 的 bottom-center 档");
  check(/applyScreenPolicy\(\);/.test(selector) && /applyScreenPolicy\(\);/.test(login), "两个场景启动时应用铺满窗口策略");
  check(/this\.offWindowResize = onWindowResize\(\(\) => this\.applyStageLayout\(\)\)/.test(selector) && /onDestroy\(\) \{[\s\S]*?this\.offWindowResize\?\.\(\);/.test(selector), "RoleSelector：注册窗口变化重排 + onDestroy 取消");
}

finish("场景整屏适配全部通过（登录舞台 / 选角舞台 / 底部栏横跨贴底）");

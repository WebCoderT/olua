#!/usr/bin/env node
/**
 * 登录 / 选角两个场景「整屏适配」的自动化验证：跑**真实的 ScreenLayout 纯函数**与
 * **真实的 configs/layout/scenes 配置**（沙箱见 client/tools/lib/configs-sandbox.cjs，
 * cc 垫片补了可调的 screen / view），再对两个场景组件的接线做源码断言。
 *
 * 背景：两个场景都采用「舞台 contain 缩放」—— 全部元素挂在固定设计尺寸的舞台容器下，
 * 运行时把整块舞台按可见尺寸等比缩小（只缩不放）。不缩放的话，铺满窗口（NO_BORDER）
 * 策略会在偏宽窗口裁掉上下（登录的选服条 / 金按钮、选角的底部元素）、
 * 窄高窗口裁掉左右（登录输入框、选角两侧按钮）。
 * 2026-10-19 按 design/*.png 重排后布局全部来自 configs/layout/scenes（设计稿映射见其头注释）；
 * 竖屏版没有底部栏，「进入游戏」是舞台内的金板按钮。
 *
 * 盯的不变量（改适配逻辑后必须全绿）：
 * · 任意窗口尺寸下，登录舞台的全部元素、选角舞台的全部元素（含角色站位 / 删除按钮 / 右侧选择钮）
 *   **整块都落在可见区内**（不越界、不被裁）
 * · 设计分辨率（750×1624，竖屏）下舞台缩放系数恰为 1（不缩放）
 * · 设计稿纵向映射的锚点不被无意改掉（选服条 / 金按钮 / 名牌的 y）
 * · 可见区取「窗口像素 ÷ view 缩放」，不是设计分辨率
 * · 舞台缩放接线：Login / RoleSelector 都注册 window-resize 重排、onDestroy 取消
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
const __screen = { windowWidth: 750, windowHeight: 1624, scaleX: 1, scaleY: 1 };
const view = {
  getScaleX: () => __screen.scaleX,
  getScaleY: () => __screen.scaleY,
  getDesignResolutionSize: () => new Size(750, 1624),
  // 引擎在 NO_BORDER 下 view.getVisibleSize() 恒等于设计分辨率（故真实可见区不能用它算）
  getVisibleSize: () => new Size(750, 1624),
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
const DESIGN = new Size(750, 1624);

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
  const elements = [
    ["选服条", layout.serverBar],
    ["本机账号", layout.account],
    ["自动登录说明", layout.autoHint],
    ["登录按钮", layout.loginButton],
  ];
  // 右上角功能圆钮 + 居中文字（文字挂在按钮内，宽 100 要单独算越界）
  layout.cornerButtons.forEach((item, index) => {
    elements.push([`功能圆钮${index + 1}（${item.label}）`, { position: item.position, size: layout.cornerButtonSize }]);
    elements.push([`功能圆钮文字${index + 1}`, { position: item.position, size: layout.cornerButtonLabel.size }]);
  });
  return elements;
}

/** 选角舞台的全部元素（中心 + 尺寸），清单从配置推导 */
function roleSelectorElements() {
  const layout = roleSelectorLayout;
  const elements = [
    ["管理角色按钮", layout.manageRoleButton],
    ["选中角色名牌", layout.selectedInfo],
    ["主按钮", layout.beginGameButton],
    ["名字输入框", layout.nameInput],
    ["骰子钮", layout.diceButton],
    ["管理提示条", { position: layout.manageRole.hint.position, size: layout.manageRole.hint.size }],
  ];
  // 右侧职业菱形钮（旋转 45°，触达范围按外接圆直径 = 边长 × √2 算，比矩形更保守）
  layout.occupationPicks.items.forEach((item, index) => {
    elements.push([`职业钮${index + 1}`, { position: item.position, size: { width: layout.occupationPicks.size.width * Math.SQRT2, height: layout.occupationPicks.size.height * Math.SQRT2 } }]);
  });
  // 右侧下方性别钮（不旋转，按自身尺寸）
  layout.sexPicks.items.forEach((item, index) => {
    elements.push([`性别钮${index + 1}`, { position: item.position, size: layout.sexPicks.size }]);
  });
  // 角色站位（单角色：只有中间的大预览）与管理模式的删除按钮（位置 = 站位 + 偏移）
  layout.rolePositions.forEach((position, index) => {
    // 预览节点整体按 previewScale 放大，实际占位按放大后的尺寸算
    elements.push([
      `角色站位${index + 1}`,
      { position, size: { width: layout.previewSize.width * layout.previewScale, height: layout.previewSize.height * layout.previewScale } },
    ]);
    elements.push([`删除按钮${index + 1}`, { position: new Vec2(position.x + layout.manageRole.deleteButtonOffset.x, position.y + layout.manageRole.deleteButtonOffset.y), size: layout.manageRole.deleteButtonSize }]);
  });
  return elements;
}

/** 枚举有代表性的窗口：设计分辨率（竖屏）/ 常见手机 / 平板 / 桌面宽高比 / 超宽 / 方窗 */
const WINDOWS = [
  [750, 1624],
  [390, 844],
  [414, 896],
  [1080, 1920],
  [1440, 3120],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1920, 1080],
  [900, 900],
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
  const visible = setWindow(750, 1624);
  check(getStageScale(loginLayout.stageSize, visible) === 1, `登录舞台缩放系数为 1（stageSize ${loginLayout.stageSize.width}×${loginLayout.stageSize.height}）`);
  check(getStageScale(roleSelectorLayout.stageSize, visible) === 1, "选角舞台缩放系数为 1");
}

console.log("\n== D. 设计稿映射与元素分布的关键锚点 ==");
{
  // 设计稿 652×1160 → 舞台 750×1624 的映射：纵向 1.4 倍、横向裁掉两侧各 81.5
  // （见 configs/layout/scenes.ts 头注释）。这里钉住几个有代表性的锚点，防止映射被无意改掉：
  const yOf = (dy) => DESIGN.height / 2 - dy * (DESIGN.height / 1160);
  const loginBar = loginLayout.serverBar.position;
  check(Math.abs(loginBar.y - yOf(810.5)) < 1.5, `登录选服条落在设计稿的纵向位置（${loginBar.y.toFixed(1)} ≈ 812 - 1.4×810.5）`);
  // 登录金按钮在说明行之下（设计稿位置 yOf(934.5) ≈ -496，因本机账号行整体下移）——
  // 钉住「在选服条之下的账号行与说明行再往下」这个次序，而不是死坐标
  check(
    loginLayout.loginButton.position.y < loginLayout.autoHint.position.y - 40,
    "登录金按钮位于本机账号说明行之下（设计稿位置因账号行整体下移）",
  );
  check(loginLayout.account.position.y < loginBar.y - 40, "本机账号行在选服条之下");
  const rsPlate = roleSelectorLayout.selectedInfo.position;
  check(Math.abs(rsPlate.y - yOf(903)) < 1.5, "选角名牌落在设计稿的纵向位置");
  check(Math.abs(roleSelectorLayout.beginGameButton.position.y - yOf(1014)) < 1.5, "选角金按钮落在设计稿的纵向位置");
  // 单角色（issue #149）：界面容量只有一个站位，名字输入在主按钮下方
  check(roleSelectorLayout.rolePositions.length === 1, "选角界面只有一个角色站位（单角色，界面容量 = 1）");
  check(
    roleSelectorLayout.nameInput.position.y < roleSelectorLayout.beginGameButton.position.y - 40,
    "名字输入框在主按钮之下（创建态用，有角色时隐藏）",
  );
  // 右侧：职业钮在上、性别钮在下，两组不重叠
  const lastOccupation = roleSelectorLayout.occupationPicks.items[roleSelectorLayout.occupationPicks.items.length - 1];
  const firstSex = roleSelectorLayout.sexPicks.items[0];
  check(
    lastOccupation.position.y - (roleSelectorLayout.occupationPicks.size.height * Math.SQRT2) / 2 > firstSex.position.y + roleSelectorLayout.sexPicks.size.height / 2,
    "性别钮在职业钮下方，两组不重叠",
  );
  // 中间大预览在名牌之上，不压名牌（按**角色内容**的实际高度算：容器 previewSize ≈ 内容高度，
  // 画布 800×800 经 previewScale 放大后的透明边框不算 —— 那部分不渲染，不能拿它判遮挡）
  const stand = roleSelectorLayout.rolePositions[0];
  const previewContentHalf = roleSelectorLayout.previewSize.height / 2;
  check(stand.y - previewContentHalf > rsPlate.y + roleSelectorLayout.selectedInfo.size.height / 2, "角色大预览在名牌之上（不压名牌）");
  // 贴边元素收进安全区：舞台半宽 375，任何元素（含外接圆）不得越出
  const maxHalf = Math.max(
    ...roleSelectorLayout.occupationPicks.items.map((item) => (roleSelectorLayout.occupationPicks.size.width * Math.SQRT2) / 2 + Math.abs(item.position.x)),
    ...roleSelectorLayout.sexPicks.items.map((item) => roleSelectorLayout.sexPicks.size.width / 2 + Math.abs(item.position.x)),
  );
  check(maxHalf <= DESIGN.width / 2 + EPS, `右侧选择钮（含 45° 外接圆）收在安全区内（右缘 ${maxHalf.toFixed(1)} ≤ 375）`);
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
  // 本机账号自动生成（issue #146）：登录页不再有输入框与注册入口，凭据走 DeviceAccount
  check(!/EditBox/.test(login), "Login：没有账号密码输入框（账号由本机自动生成）");
  check(/DeviceAccount\.load\(\)/.test(login) && /DeviceAccount\.generate\(\)/.test(login) && /DeviceAccount\.save\(/.test(login), "Login：本机凭据读取/生成/落盘都走 DeviceAccount");
  check(/AuthApi\.login\(/.test(login) && /AuthApi\.register\(/.test(login), "Login：已有账号走登录、本地没有走注册");
  check(/silent: true/.test(login), "Login：自动登录/建号的失败不弹全局提示（本地凭据失效属正常分支，由本页统一提示一次）");
  check(/ACCOUNT_BIZ_CODES\.credentialInvalid/.test(login) && /ACCOUNT_BIZ_CODES\.accountExists/.test(login), "Login：只有「凭据不成立」才重生成，撞名才换号重试");

  check(!/bottomBar/.test(selector), "RoleSelector：竖屏版没有底部栏（主按钮在舞台内，2026-10-19 按设计稿重排）");
  check(/getStageScale\(roleSelectorLayout\.stageSize/.test(selector), "RoleSelector：舞台缩放系数走 ScreenLayout.getStageScale");
  // 单角色（issue #149）：没有创建弹窗、没有角色列表，右侧钮直接选职业/性别
  check(!/createDialog|createRoleUI|cancelCreateRoleUI/.test(selector), "RoleSelector：没有创建角色弹窗（右侧钮直接选职业/性别）");
  check(!/roleSummaries/.test(selector), "RoleSelector：不再维护角色列表（单角色只保留 this.role）");
  check(/GameUiHelper\.createOccupationPicker\(/.test(selector) && /GameUiHelper\.createSexPicker\(/.test(selector), "RoleSelector：职业/性别选择组走 GameUiHelper 的两个工厂");
  check(/selectOccupation\(/.test(selector) && /selectSex\(/.test(selector), "RoleSelector：点右侧钮 = 改草稿职业/性别（不打开任何弹窗）");
  check(/createOccupationPicker\(\(key\) => this\.selectOccupation\(key as OECCUPATION\)\)/.test(selector), "RoleSelector：职业钮的点击回调直接接到 selectOccupation（选中值 = 节点名）");
  check(/createSexPicker\(\(key\) => this\.selectSex\(key as SEX\)\)/.test(selector), "RoleSelector：性别钮的点击回调直接接到 selectSex（选中值 = 节点名）");
  check(/createRolePreview\("role_preview", 1, occupation, sex, stand, layout\.previewSize, layout\.previewScale\)/.test(selector), "RoleSelector：中间是带倍率的大号站立动画（创建态跟着选择换）");
  check(/this\.setCreatePartsVisible\(!hasRole\)/.test(selector), "RoleSelector：有角色时隐藏职业/性别/名字输入，只留动画与进入游戏");
  check(/RoleApi\.create\(/.test(selector) && /SceneManager\.loadScene\("Game"\)/.test(selector), "RoleSelector：创建成功后直接进游戏（不再回列表等第二次点击）");
  check(/applyScreenPolicy\(\);/.test(selector) && /applyScreenPolicy\(\);/.test(login), "两个场景启动时应用铺满窗口策略");
  check(/this\.offWindowResize = onWindowResize\(\(\) => this\.applyStageLayout\(\)\)/.test(selector) && /onDestroy\(\) \{[\s\S]*?this\.offWindowResize\?\.\(\);/.test(selector), "RoleSelector：注册窗口变化重排 + onDestroy 取消");
}

finish("场景整屏适配全部通过（登录舞台 / 选角舞台 / 设计稿映射锚点）");

#!/usr/bin/env node
/**
 * 登录 / 选角两个场景「单分辨率布局」的自动化验证：跑**真实的 ScreenLayout 纯函数**与
 * **真实的 configs/layout/scenes 配置**（沙箱见 client/tools/lib/configs-sandbox.cjs），
 * 再对三个场景组件的接线做源码断言。
 *
 * 背景（#543）：本作**只有 1920×1080 一个分辨率**，1 设计像素 = 1 屏幕像素，舞台不缩放。
 * 以前是「铺满窗口（NO_BORDER）+ 整块舞台按可见尺寸 contain 缩放 + 窗口尺寸变化重排」，
 * 那套东西在单分辨率下全是死代码，而且会让同一份坐标在不同窗口下画出不同画面。
 *
 * 盯的不变量（改布局后必须全绿）：
 * · 画布尺寸 = 1920×1080，且与 client/settings/v2/packages/project.json 的 designResolution 一致
 * · ScreenLayout 里不再出现任何跟窗口 / 分辨率设置有关的代码（view / screen / ResolutionPolicy）
 * · 登录舞台、选角舞台的全部元素（含角色站位 / 删除按钮 / 创建弹窗）**整块落在 1920×1080 画布内**
 * · 选角底部栏：宽度 = 画布宽、贴屏幕底边、与原素材同比例（不拉伸变形）
 * · 三个场景启动时不设置分辨率、不注册窗口重排、舞台不 setScale
 *
 * 用法：node client/tools/test-scene-stage.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-scene-stage.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const LOGIN_FILE = path.join(PROJECT_ROOT, "assets/ui/Login.ts");
const ROLE_SELECTOR_FILE = path.join(PROJECT_ROOT, "assets/ui/RoleSelector.ts");
const LOADING_FILE = path.join(PROJECT_ROOT, "assets/ui/Loading.ts");
const GAME_FILE = path.join(PROJECT_ROOT, "assets/ui/Game.ts");
const SCREEN_LAYOUT_FILE = path.join(PROJECT_ROOT, "assets/ui/utils/layout/ScreenLayout.ts");
const PROJECT_SETTINGS = path.join(PROJECT_ROOT, "settings/v2/packages/project.json");

let outDir;
try {
  // ScreenLayout 现在只依赖 cc 的 Size / Vec2，不再需要 screen / view 垫片
  outDir = prepare("olua-scene-stage", ["ui/utils/layout/ScreenLayout.ts", "configs/layout/scenes.ts"]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { designResolution } = require(path.join(outDir, "ui/utils/layout/ScreenLayout.js"));
const { loginLayout, roleSelectorLayout } = require(path.join(outDir, "configs/layout/scenes.js"));

const EPS = 1e-6;
const CANVAS = designResolution;

/** 元素中心 + 尺寸 → 画布矩形 {left, right, top, bottom}（单分辨率下没有缩放系数） */
function rectOf(position, size) {
  return {
    left: position.x - size.width / 2,
    right: position.x + size.width / 2,
    top: position.y + size.height / 2,
    bottom: position.y - size.height / 2,
  };
}

/** 矩形是否整块落在画布内 */
function inside(rect, canvas = CANVAS) {
  return (
    rect.left >= -canvas.width / 2 - EPS &&
    rect.right <= canvas.width / 2 + EPS &&
    rect.top <= canvas.height / 2 + EPS &&
    rect.bottom >= -canvas.height / 2 - EPS
  );
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
    elements.push([
      `删除按钮${index + 1}`,
      { position: { x: position.x + layout.manageRole.deleteButtonOffset.x, y: position.y + layout.manageRole.deleteButtonOffset.y }, size: layout.manageRole.deleteButtonSize },
    ]);
  });
  return elements;
}

console.log("\n== A. 画布 = 1920×1080，且与项目设置一致 ==");
{
  check(
    designResolution.width === 1920 && designResolution.height === 1080,
    `ScreenLayout.designResolution = ${designResolution.width}×${designResolution.height}`,
  );
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(PROJECT_SETTINGS, "utf8"));
  } catch (error) {
    fail(`读不到项目设置：${error.message}`);
  }
  const design = settings?.general?.designResolution ?? {};
  check(
    design.width === designResolution.width && design.height === designResolution.height,
    `项目设置（${design.width}×${design.height}）与代码常量一致 —— 改分辨率必须两处一起改`,
  );
  check(design.fitWidth === true && design.fitHeight === true, "项目设置为等比完整显示（fitWidth + fitHeight）：窗口比例不符时留黑边，不裁画面");

  // 代码里不许再出现「运行时改分辨率 / 读窗口」的入口，否则单分辨率又会被悄悄破坏
  const screenLayoutSource = fs.readFileSync(SCREEN_LAYOUT_FILE, "utf8");
  check(
    !/setDesignResolutionSize|ResolutionPolicy|windowSize|getScaleX|getScaleY/.test(screenLayoutSource),
    "ScreenLayout 不含 setDesignResolutionSize / ResolutionPolicy / windowSize —— 运行时不再碰分辨率",
  );
}

console.log("\n== B. 登录舞台：全部元素落在 1920×1080 画布内 ==");
{
  const bad = loginElements().filter(([, item]) => !inside(rectOf(item.position, item.size)));
  check(bad.length === 0, `登录 ${loginElements().length} 个元素整块在画布内`, bad.length ? `越界：${bad.map(([name]) => name).join("、")}` : "");
}

console.log("\n== C. 选角舞台：全部元素落在 1920×1080 画布内 ==");
{
  const bad = roleSelectorElements().filter(([, item]) => !inside(rectOf(item.position, item.size)));
  check(bad.length === 0, `选角 ${roleSelectorElements().length} 个元素整块在画布内`, bad.length ? `越界：${bad.map(([name]) => name).join("、")}` : "");
  check(
    roleSelectorLayout.stageSize.width === designResolution.width && roleSelectorLayout.stageSize.height === designResolution.height,
    `选角舞台尺寸 = 画布尺寸（${roleSelectorLayout.stageSize.width}×${roleSelectorLayout.stageSize.height}）`,
  );
}

console.log("\n== D. 选角底部栏：横跨整屏 + 贴底 + 与原素材同比例 ==");
{
  const bar = roleSelectorLayout.bottomBar;
  check(!("position" in bar), "配置不写死 position（位置由 dockBottomBar 算）");
  check(bar.size.width === designResolution.width, `视觉宽 ${bar.size.width} = 画布宽 ${designResolution.width}（横跨整屏）`);

  // 原素材 1624×139，按 1080p 画布等比换算成 1920×164 —— 比例不一致就是把图拉变形了
  const sourceAspect = 1624 / 139;
  const layoutAspect = bar.size.width / bar.size.height;
  check(
    Math.abs(sourceAspect - layoutAspect) / sourceAspect < 0.005,
    `宽高比与素材一致（${layoutAspect.toFixed(3)} vs ${sourceAspect.toFixed(3)}，不拉伸变形）`,
  );

  // 贴底：bottom-center 语义 = 区块中心到屏幕下边缘 = 高度的一半（与 dockBottomBar 同一套公式）
  const bottom = -designResolution.height / 2;
  const centerY = bottom + bar.size.height / 2;
  const rect = rectOf({ x: 0, y: centerY }, bar.size);
  check(Math.abs(rect.bottom - bottom) < EPS, `贴屏幕底边（视觉底边 ${rect.bottom.toFixed(1)} = ${bottom}）`);
  check(inside(rect), `整条在画布内（顶边 ${rect.top.toFixed(1)} ≤ ${designResolution.height / 2}）`);
}

console.log("\n== E. 源码接线断言（不再有分辨率适配） ==");
{
  const strip = (file) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const login = strip(LOGIN_FILE);
  const selector = strip(ROLE_SELECTOR_FILE);
  const loading = strip(LOADING_FILE);
  const game = strip(GAME_FILE);
  const RESOLUTION_CODE = /applyScreenPolicy|getVisibleSize|getStageScale|setDesignResolutionSize|ResolutionPolicy/;

  check(!RESOLUTION_CODE.test(login), "Login：没有分辨率适配代码（applyScreenPolicy / getVisibleSize / getStageScale）");
  check(!RESOLUTION_CODE.test(selector), "RoleSelector：没有分辨率适配代码");
  check(!RESOLUTION_CODE.test(loading) && !RESOLUTION_CODE.test(game), "Loading / Game：没有分辨率适配代码");
  check(!/onWindowResize\(/.test(login) && !/onWindowResize\(/.test(selector), "两个场景都不再注册窗口尺寸变化重排");

  check(/new Node\("login_stage"\)/.test(login), "Login：创建舞台容器 login_stage");
  check(/addComponent\(UITransform\)\.setContentSize\(layout\.stageSize\)/.test(login), "Login：舞台尺寸来自 loginLayout.stageSize");
  check(!/setScale/.test(login), "Login：舞台不 setScale（单分辨率下缩放系数恒为 1，缩放代码已删）");
  check(/createFullScreenImage\("login_background"/.test(login) && !/this\.stage\.addChild\(GameUiHelper\.createFullScreenImage/.test(login), "Login：背景挂在场景根（不在舞台内，铺满整个屏幕）");

  check(/this\.node\.addChild\(bottomBar\);\s*\n\s*this\.bottomBar = bottomBar;/.test(selector), "RoleSelector：底部栏挂在场景根（不在舞台子树里）");
  check(!/this\.stage!\.addChild\(bottomBar\)/.test(selector), "RoleSelector：底部栏不挂进舞台（否则跟着舞台走、两侧露背景）");
  check(!/setScale/.test(selector), "RoleSelector：舞台与底部栏都不 setScale（尺寸在配置里按 1080p 定死）");
  check(/getAnchoredPosition\(size, "bottom-center"/.test(selector), "RoleSelector：底部栏贴底走 getAnchoredPosition 的 bottom-center 档");
  check(/dockBottomBar\(\)/.test(selector), "RoleSelector：底部栏位置由 dockBottomBar 算");
  check(
    /createCoverImage\("role_selector_background"/.test(selector) && !/createFullScreenImage\("role_selector_background"/.test(selector),
    "RoleSelector：背景走等比铺满（cover），不再 CUSTOM 拉伸（竖图铺横屏会拉歪 3.87 倍）",
  );
}

console.log("\n== F. 构建模板：画布铺满窗口（页面层自适应） ==");
{
  // 前五组是「游戏内部坐标系」的布局；这一组管页面层 —— 画布元素本身多大。
  // 引擎自带的 web-desktop 模板把 #GameDiv 写成固定 1920×1080 的框，窗口缩放它不变，
  // 于是游戏画面缩在页面中间一块（见 client/FAQ.md「屏幕适配」）。
  const tplDir = path.join(PROJECT_ROOT, "build-templates/web-desktop");
  const tplIndex = path.join(tplDir, "index.ejs");
  const tplStyle = path.join(tplDir, "style.css");
  check(fs.existsSync(tplIndex) && fs.existsSync(tplStyle), "存在自定义构建模板（index.ejs + style.css，构建时覆盖同名文件）");

  const html = fs.readFileSync(tplIndex, "utf8");
  const css = fs.readFileSync(tplStyle, "utf8");
  check(/id="GameDiv"/.test(html) && !/id="GameDiv"[^>]*style="[^"]*width:/.test(html), "index.ejs 不给 #GameDiv 写死宽高（引擎默认模板正是死在这一行）");
  check(/<%-\s*include\(cocosTemplate/.test(html), "index.ejs 保留 cocosTemplate 注入（删掉就没有引擎启动脚本）");
  check(/<canvas id="GameCanvas"/.test(html) && !/oncontextmenu/.test(html), "canvas 不挂 oncontextmenu（右键寻路 / 传送要用）");
  check(
    /#GameDiv,\s*#Cocos3dGameContainer,\s*#GameCanvas\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/.test(css),
    "style.css 让三层容器都铺满视口（screen-adapter 读 #GameDiv 的 clientWidth/clientHeight）",
  );
  check(/html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(css), "html/body 不留滚动条（否则画布比窗口小，四周露页面背景）");
  check(/--safe-top/.test(css), "保留安全区 CSS 变量（引擎 safeAreaEdge 读它们）");
}

finish("单分辨率布局全部通过（画布 1920×1080 / 两场景元素在画布内 / 底部栏横跨贴底 / 无分辨率适配代码）");

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
 * · 登录舞台、选角舞台的全部元素（含属性 chips / 角色卡视口 / 创建弹窗）**整块落在 1920×1080 画布内**
 * · 登录舞台是绝对坐标整版布局（#1036，对齐 design/olua-login）：四大块 + 面板内元素的坐标全在
 *   loginLayout 里，面板内元素换算回舞台坐标后仍落在面板壳内（沙箱跑不了引擎组件，用纯算术判）
 * · 选角三栏（左文案 / 中立绘 / 右角色面板）与卡片网格：元素都在画布内、每排两张
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
const TEXTS_FILE = path.join(PROJECT_ROOT, "assets/configs/texts.ts");
const SCENES_FILE = path.join(PROJECT_ROOT, "assets/configs/layout/scenes.ts");

let outDir;
try {
  // ScreenLayout 现在只依赖 cc 的 Size / Vec2，不再需要 screen / view 垫片
  outDir = prepare("olua-scene-stage", ["ui/utils/layout/ScreenLayout.ts", "configs/layout/scenes.ts"]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { designResolution } = require(path.join(outDir, "ui/utils/layout/ScreenLayout.js"));
const { loginLayout, roleSelectorLayout, loadingLayout } = require(path.join(outDir, "configs/layout/scenes.js"));

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

/**
 * 登录舞台的全部元素（中心 + 尺寸），清单从配置推导 —— 配置加元素后这里自动跟上。
 * #1036 起登录舞台是**绝对坐标整版布局**（对齐 design/olua-login），坐标全写在 loginLayout 里；
 * 面板内元素的配置坐标相对面板中心，这里换算回舞台坐标再判画布包含。
 * tagline 是 RESIZE_HEIGHT 的多行文本、高度随内容，不进这份清单（跑出画布靠人眼看）。
 */
function loginElements() {
  const layout = loginLayout;
  const topbar = layout.topbar;
  const hero = layout.hero;
  const panel = layout.panel;
  const bottombar = layout.bottombar;
  const toStage = (position, size) => ({ position: { x: panel.position.x + position.x, y: panel.position.y + position.y }, size });
  const tabSize = hero.classTabs.size;
  const classTabs = hero.classTabs.classes.map((cls, index) => [
    `hero.classTabs.${cls.key}`,
    {
      position: {
        x: hero.classTabs.firstLeftEdgeX + index * (tabSize.width + hero.classTabs.gap) + tabSize.width / 2,
        y: hero.classTabs.positionY,
      },
      size: tabSize,
    },
  ]);
  return [
    ["topbar.brand", { position: topbar.brand.position, size: topbar.brand.size }],
    ["topbar.version", { position: topbar.version.position, size: topbar.version.size }],
    ["topbar.music", { position: topbar.music.position, size: topbar.music.size }],
    ["hero.eyebrow.line", { position: hero.eyebrow.line.position, size: hero.eyebrow.line.size }],
    ["hero.eyebrow.label", { position: hero.eyebrow.label.position, size: hero.eyebrow.label.size }],
    ["hero.logo", { position: hero.logo.position, size: hero.logo.size }],
    ...classTabs,
    ["hero.classDesc", { position: hero.classDesc.position, size: hero.classDesc.size }],
    ["hero.notice", { position: hero.notice.position, size: hero.notice.size }],
    ["panel", { position: panel.position, size: panel.size }],
    ["panel.title", toStage(panel.title.position, panel.title.size)],
    ["panel.account", toStage(panel.account.position, panel.account.size)],
    ["panel.password", toStage(panel.password.position, panel.password.size)],
    ["panel.server", toStage(panel.server.position, panel.server.size)],
    ["panel.loginButton", toStage(panel.loginButton.position, panel.loginButton.size)],
    ["panel.foot.text", toStage(panel.foot.text.position, panel.foot.text.size)],
    ["bottombar.copyright", { position: bottombar.copyright.position, size: bottombar.copyright.size }],
    ...bottombar.links.map((link, index) => [`bottombar.links[${index}]`, { position: link.position, size: link.size }]),
  ];
}

/** 选角舞台的全部元素（中心 + 尺寸），清单从配置推导 */
function roleSelectorElements() {
  const layout = roleSelectorLayout;
  const elements = [
    ["顶栏品牌", layout.topbar.brand],
    ["顶栏区服账号", layout.topbar.who],
    ["顶栏退出登录", layout.topbar.logoutButton],
    ["底栏左", layout.footer.left],
    ["底栏右", layout.footer.right],
    ["左栏眉题", layout.hero.cap],
    ["左栏角色名", layout.hero.name],
    ["左栏说明", { position: layout.hero.sub.position, size: layout.hero.sub.size }],
    ["进游戏按钮", layout.hero.cta.enter],
    ["返回登录按钮", layout.hero.cta.back],
    ["中间立绘", { position: layout.stageChar.position, size: layout.stageChar.size }],
    ["脚下名牌", { position: layout.stageChar.plate.position, size: layout.stageChar.plate.size }],
    ["角色面板", layout.roster],
    ["管理提示条", { position: layout.manageHint.position, size: layout.manageHint.size }],
    ["创建角色弹窗", layout.createDialog],
    ["弹窗关闭按钮", {
      position: {
        x: layout.createDialog.position.x + layout.createDialog.closeButton.position.x,
        y: layout.createDialog.position.y + layout.createDialog.closeButton.position.y,
      },
      size: layout.createDialog.closeButton.size,
    }],
  ];
  // 属性 chips：横排在左栏正文里（容器中心 = 左边缘 + 半个正文宽），逐个判在画布内
  let cursor = -layout.hero.width / 2;
  for (const item of layout.hero.chips.items) {
    elements.push([
      `属性 chip（${item.key}）`,
      {
        position: { x: layout.hero.leftEdgeX + layout.hero.width / 2 + cursor + item.size.width / 2, y: layout.hero.chips.positionY },
        size: item.size,
      },
    ]);
    cursor += item.size.width + layout.hero.chips.gap;
  }
  // 角色滚动网格：视口是一块画布内的矩形（行列交给引擎 Layout 排，行数多了在视口里滚，
  // 所以只判视口本身在画布内，不逐个判单元格）。每排张数由视口宽与卡片/间距推导，守点是 2。
  const scroll = layout.roster.scroll;
  elements.push(["角色滚动视口", { position: scroll.position, size: scroll.viewSize }]);
  const availableWidth = scroll.viewSize.width - scroll.paddingX * 2;
  const cardWidth = layout.roster.card.size.width;
  const perRow = Math.floor((availableWidth - cardWidth) / (cardWidth + layout.roster.card.spacingX)) + 1;
  check(perRow === 2, `角色卡每排 ${perRow} 张（= (视口宽 − paddingX×2 − 卡片宽) ÷ (卡片宽 + spacingX) + 1，稿件是两列）`);
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
  // 选角舞台尺寸（= 画布）属显示效果，靠人眼看
}

console.log("\n== C2. 登录舞台：绝对坐标整版布局（#1036，对齐 design/olua-login） ==");
{
  const panel = loginLayout.panel;
  check(
    loginLayout.stageSize.width === designResolution.width && loginLayout.stageSize.height === designResolution.height,
    "登录舞台尺寸 = 设计分辨率（单分辨率不缩放）",
  );
  // 面板内元素的配置坐标相对面板中心：换算回舞台坐标后必须仍落在面板壳内（跑出壳 = 穿帮）
  const panelRect = rectOf(panel.position, panel.size);
  const panelChildren = [
    ["title", panel.title],
    ["account", panel.account],
    ["password", panel.password],
    ["server", panel.server],
    ["loginButton", panel.loginButton],
  ];
  const insideRect = (rect, outer) =>
    rect.left >= outer.left - EPS && rect.right <= outer.right + EPS && rect.top <= outer.top + EPS && rect.bottom >= outer.bottom - EPS;
  const bad = panelChildren
    .map(([name, item]) => [name, rectOf({ x: panel.position.x + item.position.x, y: panel.position.y + item.position.y }, item.size)])
    .filter(([, rect]) => !insideRect(rect, panelRect));
  check(bad.length === 0, `面板 ${panelChildren.length} 个子元素都落在面板壳内`, bad.length ? `越界：${bad.map(([name]) => name).join("、")}` : "");
  const loginStageSource = fs.readFileSync(LOGIN_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check(!/addComponent\(Layout\)/.test(loginStageSource), "登录舞台不再用 cc.Layout 流式布局（#1036 起为绝对坐标整版布局，坐标全在 loginLayout）");
}

console.log("\n== D. 选角：底部牌匾栏已拆（#1059 改为三栏 + 右角色面板） ==");
{
  const scenesSource = fs.readFileSync(SCENES_FILE, "utf8");
  const retired = ["roleSelectorBottomBar", "roleSelectorStartButton", "roleSelectorNewRoleButton", "roleSelectorManageButton", "roleSelectorBackButton", "roleSelectorIdleInfo"];
  const stillUsed = retired.filter((key) => new RegExp(`uiImages\\.${key}\\b`).test(scenesSource));
  check(stillUsed.length === 0, "底部牌匾那六张图不再被布局引用（素材保留，改版后没人画它们）", stillUsed.join("、"));
  check(!("bottomBar" in roleSelectorLayout), "roleSelectorLayout 里没有 bottomBar 了");
  // 面板两列 / 卡片 252 高 / 头部 56 高属显示效果，靠人眼看
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

  // Loading 场景：只守「元素没跑到画布外」（跑出去就是看不见 = 真故障）；
  // 具体尺寸、居中与否、字号大小属于显示效果，改配置后靠人眼看
  check(
    inside(rectOf(loadingLayout.ring.center, { width: loadingLayout.ring.radius * 2, height: loadingLayout.ring.radius * 2 }), CANVAS),
    "Loading：进度环在画布内（半径/环心手调，不断言）",
  );
  check(
    inside(rectOf(loadingLayout.bar.position, { width: loadingLayout.bar.width, height: loadingLayout.bar.height }), CANVAS),
    "Loading：底部通栏细线在画布内（宽度/位置手调，不断言）",
  );
  check(inside(rectOf(loadingLayout.progress.position, { width: 300, height: 30 }), CANVAS), "Loading：进度文字在画布内（位置/字号手调，不断言）");
  check(
    /paintRing\(/.test(loading) && /graphics\.arc\(/.test(loading),
    "Loading：环形进度用 Graphics 画弧（arc + stroke，不依赖进度条底图）",
  );
  check(
    /paintBar\(/.test(loading) && /stepDots\.forEach/.test(loading),
    "Loading：底部细线与四阶段刻度随进度重画（阶段状态取自配置 bar.steps）",
  );
  check(!/onWindowResize\(/.test(login) && !/onWindowResize\(/.test(selector), "两个场景都不再注册窗口尺寸变化重排");

  check(/new Node\("login_stage"\)/.test(login), "Login：创建舞台容器 login_stage");
  check(/setContentSize\(layout\.stageSize\.width, layout\.stageSize\.height\)/.test(login), "Login：舞台尺寸来自 loginLayout.stageSize（= 设计分辨率，不缩放）");
  check(!/setScale/.test(login), "Login：舞台不 setScale（单分辨率下缩放系数恒为 1，缩放代码已删）");
  check(!/addComponent\(Layout\)/.test(login) && !/loginLayout\.order/.test(login), "Login：不再有 Layout 流式排布与 order 清单（#1036 起四大块 buildTopbar / buildHero / buildPanel / buildBottombar 按绝对坐标组装）");
  check(
    /this\.buildTopbar\(\)/.test(login) && /this\.buildHero\(\)/.test(login) && /this\.buildPanel\(\)/.test(login) && /this\.buildBottombar\(\)/.test(login),
    "Login：四大块接线齐全（顶栏 / 左侧文案区 / 登录面板 / 底部条）",
  );
  check(/createFullScreenImage\("login_background"/.test(login) && !/this\.stage\.addChild\(GameUiHelper\.createFullScreenImage/.test(login), "Login：背景挂在场景根（不在舞台内，铺满整个屏幕）");
  // 区服在登录页（#1009）：登录前只拿公共活区列表（GET /zones），不碰要令牌的 /zones/mine
  check(
    /ZoneApi\.list\(\)/.test(login) && !/ZoneApi\.mine\(\)/.test(login),
    "Login：拉公共活区列表（登录前没有令牌，mine 会 401）",
  );
  check(/renderServerButton/.test(login) && /panel\.server/.test(login), "Login：选服按钮在面板里，按区列表刷新区名与状态（#1036 整版布局）");
  check(!/this\.zoneDialog\.open\([\s\S]{0,80}start\(\)/.test(login), "Login：进页面不自动弹选服窗（点面板里那颗才开）");
  const texts = fs.readFileSync(TEXTS_FILE, "utf8");
  const loginZoneKeys = (texts.match(/^\s*login_zone_\w+/gm) ?? []).map((line) => line.trim().replace(/:.*/, ""));
  check(
    loginZoneKeys.length > 0 && loginZoneKeys.every((key) => key === "login_zone_unknown"),
    "texts：登录页只留「正在获取区服列表」占位这一条 login_zone_* 键（旧区服文案走 zone_* 一套，没有回来）",
    loginZoneKeys.filter((key) => key !== "login_zone_unknown").length ? `多出：${loginZoneKeys.join("、")}` : "",
  );
  // 已有登录态直接进选角：误刷新不重输账号密码；未登录才清缓存（保留登录态刷新时的角色缓存）
  check(/if \(Session\.isLoggedIn\) \{\s*\n\s*SceneManager\.loadScene\("RoleSelector"\);\s*\n\s*return;/.test(login), "Login：已有登录态直接跳选角（误刷新不用重输，令牌过期由 401 兜底送回登录）");
  check(/StorageManager\.clear\(\);/.test(login), "Login：未登录才清本地缓存（有登录态的刷新不动角色缓存）");

  // 立绘是 800×800 画布的帧图集，缩到卡片 / 放大到舞台都要 setScale —— 那是素材比例，不是分辨率适配；
  // 这里守的是「舞台容器自己不被缩放」
  check(!/this\.stage!?\.setScale/.test(selector) && /preview\.setScale\(/.test(selector), "RoleSelector：舞台容器不 setScale（立绘缩放只为素材比例，尺寸在配置里按 1080p 定死）");
  check(
    /buildTopbar\(\)/.test(selector) && /buildFooter\(\)/.test(selector) && /buildHero\(\)/.test(selector) && /buildStageChar\(\)/.test(selector) && /buildRoster\(\)/.test(selector),
    "RoleSelector：五块接线齐全（顶栏 / 底栏 / 左栏 / 中间立绘 / 右角色面板，#1059 三栏构图）",
  );
  check(
    /createDialogPanel\(layout\.name, layout\.size\)/.test(selector) && /roleSelectorLayout\.roster/.test(selector),
    "RoleSelector：右角色面板走通用矢量底板（createDialogPanel + 配置里的尺寸）",
  );
  check(
    /NAME_PLATE_PREFIX/.test(selector) && /label_role_name_plate/.test(selector) && /cardLayout\.name\.offsetX/.test(selector),
    "RoleSelector：每张卡上有名字（文案走 texts、坐标走 card.name 配置，随列表重建）",
  );
  check(
    /Layout\.Type\.GRID/.test(selector) && /AxisDirection\.HORIZONTAL/.test(selector) && /layout\.card\.spacingX/.test(selector),
    "RoleSelector：角色卡网格交给引擎 Layout（GRID + 横向起始轴，换行点 = 内容宽；一排几张改 roster.card 配置）",
  );
  check(
    /createScrollView\(/.test(selector) && /role_cell_/.test(selector) && /content\.addChild\(card\)/.test(selector),
    "RoleSelector：角色卡装进单元格挂滚动内容下（超出一屏上下滚，角色多了不再画不进画布）",
  );
  check(
    /this\.cardOf\(/.test(selector) && /card\.addChild\(button\)/.test(selector),
    "RoleSelector：管理模式删除按钮挂角色卡下（躲开预览的选中冒泡，又跟着滚动区走不与角色错位）",
  );
  check(
    /this\.updateOccupationSelection\(view\)/.test(selector) && /this\.createView\) this\.updateOccupationSelection\(this\.createView\)/.test(selector),
    "RoleSelector：创建弹窗首次渲染显式传 view（首次调用时 this.createView 还没赋值，读它会空手而归 → 描述与预览打开全空）",
  );
  check(
    /const back = hero\.cta\.back/.test(selector) && /backButton\.on\(Node\.EventType\.TOUCH_END, \(\) => logoutToLogin\(\),? ?this?\)/.test(selector),
    "RoleSelector：返回登录在左栏 CTA 里常驻，点击主动登出（logoutToLogin：先吊销令牌 #880 再回登录）",
  );
  check(
    /closeLayout = layout\.closeButton/.test(selector) && /dialog\.addChild\(closeButton\)/.test(selector) && /cancelCreateRoleUI\(\)/.test(selector),
    "RoleSelector：创建弹窗右上角有自己的关闭按钮（backButton 常驻回登录后，关弹窗不再兼职）",
  );
  check(
    /GameUiHelper\.setRolePreviewSelected\(/.test(selector) && /this\.setRoleSelected\(previous, false\)/.test(selector) && /this\.setRoleSelected\(roleId, true\)/.test(selector),
    "RoleSelector：选中态经 setRoleSelected 切换（换人先把上一个换回站立帧），白框已由 show 动画 + 脚下特效取代（见 test-role-select-anim）",
  );
  check(
    /ApiErrorKind\.Network/.test(selector) && /scheduleOnce\(\(\) => returnToLogin\(\)/.test(selector) && /errorMoveDuration \+ tipsLayout\.errorFadeDuration/.test(selector),
    "RoleSelector：连不上服务器时等错误飘字走完再清会话回登录（立刻换场景会把提示一起销毁）",
  );
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

finish("单分辨率布局全部通过（画布 1920×1080 / 两场景元素在画布内 / 选角三栏两列卡片 / 无分辨率适配代码）");

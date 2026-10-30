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
 * · 登录舞台是 cc.Layout 垂直布局：宽度固定、高度随内容自动变，间距只有 spacingY 一个数（沙箱跑不了引擎组件，纵向位置用同一条公式复算）
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
const TEXTS_FILE = path.join(PROJECT_ROOT, "assets/configs/texts.ts");

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

/** 登录舞台元素块（键 = loginLayout.order 里的 key）—— 位置不写在元素上，由 cc.Layout 统一排 */
function loginBlocks() {
  const layout = loginLayout;
  return {
    logo: layout.logo,
    account: layout.account,
    password: layout.password,
    zoneSelector: layout.zoneSelector,
    loginButton: layout.loginButton,
    registerButton: layout.registerButton,
  };
}

/**
 * 复算 cc.Layout（VERTICAL + CONTAINER + TOP_TO_BOTTOM）会排出的容器总高 ——
 * 与引擎同一条公式（cocos/ui/layout.ts _doLayoutVertically）：
 * 容器高 = paddingTop + Σ元素高 + (n-1)×spacingY + paddingBottom。
 * 沙箱跑不了引擎组件，这里用纯算术守「配置算出来的构图落在画布内」。
 */
function loginContainerHeight() {
  const blocks = loginBlocks();
  const heights = loginLayout.order.map((key) => blocks[key].size.height);
  return (loginLayout.paddingTop ?? 0) + heights.reduce((sum, h) => sum + h, 0) + (heights.length - 1) * loginLayout.spacingY + loginLayout.paddingBottom;
}

/** 登录舞台的各元素中心 y（按引擎同一条公式从容器顶边往下推：首项顶边 = 容器高/2 - paddingTop） */
function loginCenters() {
  const blocks = loginBlocks();
  let cursor = loginContainerHeight() / 2 - (loginLayout.paddingTop ?? 0);
  return loginLayout.order.map((key) => {
    const h = blocks[key].size.height;
    const center = cursor - h / 2;
    cursor = center - h / 2 - loginLayout.spacingY;
    return center;
  });
}

/** 登录舞台的全部元素（中心 + 尺寸），清单从配置推导 —— 配置加元素后这里自动跟上 */
function loginElements() {
  const blocks = loginBlocks();
  const centers = loginCenters();
  return loginLayout.order.map((key, index) => [key, { position: { x: 0, y: centers[index] }, size: blocks[key].size }]);
}

/** 选角舞台的全部元素（中心 + 尺寸），清单从配置推导 */
function roleSelectorElements() {
  const layout = roleSelectorLayout;
  // 底部栏贴屏幕底边 → 其中心在画布 (0, -画布高/2 + 栏高/2)；挂在它下面的元素配置坐标相对这个中心
  const barCenterY = -CANVAS.height / 2 + layout.bottomBar.size.height / 2;
  const elements = [
    ["创建角色按钮", layout.createRoleButton],
    ["管理角色按钮", layout.manageRoleButton],
    ["返回按钮", layout.backButton],
    // 选中信息框挂在底部栏下（见 RoleSelector.createMainView）：换算回舞台坐标再判画布包含
    ["选中信息框", { position: { x: layout.selectedInfo.position.x, y: layout.selectedInfo.position.y + barCenterY }, size: layout.selectedInfo.size }],
    ["管理提示条", { position: layout.manageRole.hint.position, size: layout.manageRole.hint.size }],
    ["创建角色弹窗", layout.createDialog],
  ];
  // 角色滚动网格：视口是一块画布内的矩形（行列交给引擎 Layout 排，行数多了在视口里滚，
  // 所以只判视口本身在画布内，不逐个判单元格）。每排个数由视口宽与单元格/间距推导，守点是 6。
  const scroll = layout.roleScroll;
  elements.push(["角色滚动视口", { position: scroll.position, size: scroll.viewSize }]);
  const availableWidth = scroll.viewSize.width - scroll.paddingX * 2;
  const perRow = Math.floor((availableWidth - scroll.cell.width) / (scroll.cell.width + scroll.spacingX)) + 1;
  check(perRow === 6, `角色滚动网格每排 ${perRow} 个（= (视口宽 − paddingX×2 − 单元格宽) ÷ (单元格宽 + spacingX) + 1，期望 6）`);
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

console.log("\n== C2. 登录舞台：cc.Layout 垂直布局（宽固定 / 高随内容 / 间距一个数） ==");
{
  const blocks = loginBlocks();
  const order = loginLayout.order;
  const centers = loginCenters();
  const centerOf = (key) => centers[order.indexOf(key)];

  // 配置形态：间距只有 spacingY 一个数，元素不写坐标也不带 gap
  check(!Object.values(blocks).some((block) => "position" in block), "配置里各元素不写死 position（纵向位置交给 Layout）");
  check(order.every((key) => !("gap" in blocks[key])), "元素不再各带一个 gap（间距只有 spacingY 一个来源）");
  check(new Set(order).size === order.length, "order 里没有重复元素");
  check(loginLayout.width === 1080, `舞台宽度固定 ${loginLayout.width}（引擎 VERTICAL 只写容器高度，宽度不会被布局改动）`);

  // 顺序与间距（数值随手动调整变化，守的是「屏幕上真的从上到下、间距统一」）
  const descending = order.every((key, index) => index === 0 || centerOf(key) < centerOf(order[index - 1]) - EPS);
  check(descending, `中心 y 从上到下严格递减：${order.map((key) => `${key}=${centerOf(key).toFixed(1)}`).join(" → ")}`);
  const paddingTop = loginLayout.paddingTop ?? 0;
  const firstTop = loginContainerHeight() / 2 - paddingTop;
  check(
    Math.abs(firstTop - blocks[order[0]].size.height / 2 - centerOf(order[0])) < EPS,
    `第一个元素（${order[0]}）从容器顶边退 paddingTop ${paddingTop} 起排`,
  );
  const spacingOk = order.every((key, index) => {
    if (index === 0) return true;
    const prevBottom = centerOf(order[index - 1]) - blocks[order[index - 1]].size.height / 2;
    const top = centerOf(key) + blocks[key].size.height / 2;
    return Math.abs(prevBottom - top - loginLayout.spacingY) < EPS;
  });
  check(spacingOk, "相邻元素的实际间距 = spacingY（全表只有一个间距来源，不再每项一个 gap）");

  // 高度随内容自动变：容器总高按上面的公式算，且整块装得进画布
  check(
    loginContainerHeight() <= designResolution.height,
    `容器总高 ${loginContainerHeight()} ≤ 画布高 ${designResolution.height}（CONTAINER 随内容伸缩也装得下）`,
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
  check(/setContentSize\(layout\.width, 0\)/.test(login), "Login：舞台宽度来自 loginLayout.width（高度初始 0，由 Layout 随内容撑开）");
  check(!/setScale/.test(login), "Login：舞台不 setScale（单分辨率下缩放系数恒为 1，缩放代码已删）");
  check(
    /addComponent\(Layout\)/.test(login) && /Layout\.Type\.VERTICAL/.test(login) && /Layout\.ResizeMode\.CONTAINER/.test(login) && /VerticalDirection\.TOP_TO_BOTTOM/.test(login),
    "Login：舞台用 cc.Layout 垂直布局（VERTICAL + CONTAINER + TOP_TO_BOTTOM，宽固定 / 高随内容 / 从上到下）",
  );
  check(
    /stageLayout\.spacingY = layout\.spacingY/.test(login) && /paddingBottom = layout\.paddingBottom/.test(login),
    "Login：间距与留白全部读配置（spacingY / paddingBottom；paddingTop 已移除，第一项直接贴容器顶）",
  );
  check(/for \(const key of layout\.order\)[\s\S]{0,260}?this\.stage\.addChild\(widget\)/.test(login), "Login：按 loginLayout.order 的顺序挂进舞台（挂载顺序 = 屏幕顺序）");
  check(/createFullScreenImage\("login_background"/.test(login) && !/this\.stage\.addChild\(GameUiHelper\.createFullScreenImage/.test(login), "Login：背景挂在场景根（不在舞台内，铺满整个屏幕）");
  check(
    /this\.widgets = \{ logo, account: account\.node, password: password\.node, zoneSelector: this\.zoneLabel, loginButton, registerButton \}/.test(login),
    "Login：元素按 key 登记（与 order 的 key 一一对应）",
  );
  check(!/getColumnCenters|stackWidgets/.test(login), "Login：不再自己算纵向坐标（交给引擎 Layout）");
  check(!/layout\.(account|password|loginButton|registerButton|logo|zoneSelector)\.position/.test(login), "Login：不再读写死坐标（位置交给 Layout）");
  // 区服位置的两态提示：连不上服务器时不是空白，玩家能看到「暂时无法连接服务器」
  check(/zoneState: "connecting" \| "ready" \| "unreachable"/.test(login), "Login：区服连接状态只有 connecting / ready / unreachable 三个值");
  check(/getText\(this\.zoneState === "connecting" \? "login_zone_connecting" : "login_zone_unreachable"\)/.test(login), "Login：连接中与无法连接的文案都来自 configs/texts（代码里不写中文）");
  check(/this\.zoneState = "ready";/.test(login) && /this\.zoneState = "unreachable";/.test(login), "Login：loadZones 拉到置 ready、拉不到置 unreachable（两个分支都刷新区服文案）");
  const texts = fs.readFileSync(TEXTS_FILE, "utf8");
  check(/login_zone_connecting: "连接中…"/.test(texts) && /login_zone_unreachable: "暂时无法连接服务器"/.test(texts), "texts：连接中 / 无法连接两条文案存在（区服位置不再是空白）");
  // 已有登录态直接进选角：误刷新不重输账号密码；未登录才清缓存（保留登录态刷新时的角色缓存）
  check(/if \(Session\.isLoggedIn\) \{\s*\n\s*SceneManager\.loadScene\("RoleSelector"\);\s*\n\s*return;/.test(login), "Login：已有登录态直接跳选角（误刷新不用重输，令牌过期由 401 兜底送回登录）");
  check(/StorageManager\.clear\(\);/.test(login), "Login：未登录才清本地缓存（有登录态的刷新不动角色缓存）");

  check(/this\.node\.addChild\(bottomBar\);\s*\n\s*this\.bottomBar = bottomBar;/.test(selector), "RoleSelector：底部栏挂在场景根（不在舞台子树里）");
  check(!/this\.stage!\.addChild\(bottomBar\)/.test(selector), "RoleSelector：底部栏不挂进舞台（否则跟着舞台走、两侧露背景）");
  check(!/setScale/.test(selector), "RoleSelector：舞台与底部栏都不 setScale（尺寸在配置里按 1080p 定死）");
  check(/getAnchoredPosition\(size, "bottom-center"/.test(selector), "RoleSelector：底部栏贴底走 getAnchoredPosition 的 bottom-center 档");
  check(/dockBottomBar\(\)/.test(selector), "RoleSelector：底部栏位置由 dockBottomBar 算");
  check(
    /bottomBar\.addChild\(selectedInfoBox\)/.test(selector) && !/this\.stage!\.addChild\(selectedInfoBox\)/.test(selector),
    "RoleSelector：选中信息框挂在底部栏下（selected_role_info_background 是 role_selector_bottom_bar 的子节点）",
  );
  check(/NAME_PLATE_PREFIX/.test(selector) && /label_role_name_plate/.test(selector) && /(namePlate|plate)\.offset/.test(selector), "RoleSelector：每个站位脚下有名字与等级名牌（文案走 texts、偏移走配置，随列表重建）");
  check(
    /Layout\.Type\.GRID/.test(selector) && /AxisDirection\.HORIZONTAL/.test(selector) && /roleScroll/.test(selector),
    "RoleSelector：角色网格交给引擎 Layout（GRID + 横向起始轴，换行点 = 内容宽；一排几个改 roleScroll 配置）",
  );
  check(
    /createScrollView\(/.test(selector) && /role_cell_/.test(selector) && /roleScrollContent!\.addChild\(cell\)/.test(selector),
    "RoleSelector：预览装进单元格挂滚动内容下（超出一屏上下滚，角色多了不再画不进画布）",
  );
  check(
    /roleScrollContent\?\.getChildByName/.test(selector) && /cell\.addChild\(button\)/.test(selector),
    "RoleSelector：管理模式删除按钮挂单元格下（躲开预览的选中冒泡，又跟着滚动区走不与角色错位）",
  );
  check(
    /sexToggleGroup\.children\[0\]\.getComponent\(Toggle\)\.isChecked = true/.test(selector) && /occupationToggleGroup\.children\[0\]\.getComponent\(Toggle\)\.isChecked = true/.test(selector),
    "RoleSelector：创建弹窗默认选中第一项性别与职业（描述与预览打开即显示，不用手动点一次才出来）",
  );
  check(
    /bottomBar\.addChild\(backToLoginButton\)/.test(selector) && /returnToLogin\(\)/.test(selector),
    "RoleSelector：返回登录按钮挂在底部栏最右侧，点击清会话回登录（走 NetworkSetup.returnToLogin，与 401 兜底同一条路）",
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

finish("单分辨率布局全部通过（画布 1920×1080 / 两场景元素在画布内 / 底部栏横跨贴底 / 无分辨率适配代码）");

import { Color, Size, Vec2 } from "cc";
import { uiImages } from "./images";

/**
 * 场景界面（登录 / 选角 / 加载）的布局与用图
 *
 * 坐标系：场景内元素坐标以「舞台中心」为原点（= 屏幕中心）。
 * 本作只有 **1920×1080** 一个分辨率（见 ui/utils/layout/ScreenLayout.designResolution）：
 * 1 设计像素 = 1 屏幕像素，舞台**不缩放**，这里写多少屏幕上就是多少，没有「按窗口尺寸换算」。
 * 背景图不在舞台内（铺满整个屏幕，始终盖住窗口）
 *
 * 两者的排版方式不同，别混用：
 * - 登录：元素**纵向从上到下排**（cc.Layout 垂直布局，间距只有 spacingY 一个数，顺序见 order）；
 * - 选角：仍是手工坐标（构图是「两侧按钮 + 中间站位」的二维布局，纵向流式排不出来）
 */

//#region 登录场景

/**
 * 登录界面布局
 *
 * 舞台就是一个 **cc.Layout 垂直布局容器**（Login.ts 里 addComponent(Layout)）：
 * - 元素**不写坐标**：纵向位置由 Layout 统一排（从上到下，间距全部 = `spacingY` 这一个数），
 *   水平方向一律居中（元素建在 x=0，Layout 的 VERTICAL 不动 x）；
 * - **高度随内容自动变**（resizeMode = CONTAINER：= paddingTop + 各元素高 + (n-1)×spacingY + paddingBottom），
 *   **宽度固定不变**（引擎在 VERTICAL 布局下只写容器高度、不碰宽度）；
 * - 屏幕顺序 = `order` 数组顺序（元素加进舞台的顺序）；加/删/换元素改 order 一行即可。
 *
 * 想调「元素之间的距离」只改 `spacingY`，想调「整块离顶/离底多远」改 paddingTop / paddingBottom。
 */
export const loginLayout = {
  /** 舞台宽度（固定值；高度由 Layout 按内容算，不在这里配） */
  width: 1080,
  /** 相邻元素的统一间距（Layout.spacingY） */
  spacingY: 30,
  /** 最后一项与舞台底边的距离（Layout.paddingBottom） */
  paddingBottom: 0,
  /**
   * 纵向排列顺序（从上到下）：元素按这个顺序挂进舞台，Layout 按挂载顺序排。
   * 每一项必须在下面有对应的元素定义（Login.ts 会校验，缺了当场报错）
   */
  order: ["logo", "account", "password", "zoneSelector", "loginButton", "registerButton"],
  background: uiImages.loginBackground,

  /** 账号输入框 */
  account: { placeholder: "请输入您的游戏账号", size: new Size(600, 80), icon: uiImages.loginAccountIcon, password: false },
  /** 密码输入框 */
  password: { placeholder: "请输入您的游戏密码", size: new Size(600, 80), icon: uiImages.loginPasswordIcon, password: true },
  /** 登录按钮 */
  loginButton: {
    name: "login_button",
    image: uiImages.loginButton,
    text: "账号登录",
    size: new Size(300, 80),
    textColor: new Color("#f4fc00"),
    fontSize: 30,
  },
  /** 注册按钮（与登录共用上方的账号/密码输入框；账号唯一性与格式由服务端校验） */
  registerButton: {
    name: "register_button",
    image: uiImages.smallButtonBackground,
    text: "注册账号",
    size: new Size(240, 56),
    textColor: new Color("#f4fc00"),
    fontSize: 24,
  },
  /** 区服选择（多开区 #295：文案节点，点按循环切换活区；排在密码框与登录按钮之间） */
  zoneSelector: { size: new Size(600, 40), color: new Color("#f4fc00"), fontSize: 22 },
  /** 顶部 logo */
  logo: { name: "game_logo", image: uiImages.gameLogo, size: new Size(600, 200) },
};

//#endregion

//#region 选角场景

/**
 * 选角界面布局（主视图 + 创建角色弹窗）
 *
 * 坐标为「舞台」坐标系（原点在舞台中心）：所有元素挂在舞台容器下，舞台 = 1920×1080 的画布
 * （不缩放，1 设计像素 = 1 屏幕像素）。
 * 新增元素按这张 1080p 画布摆坐标即可；
 * 背景图不在舞台内（铺满整个屏幕，见 RoleSelector.createBackground）
 */
export const roleSelectorLayout = {
  /** 舞台尺寸 = 设计分辨率 1920×1080（见 ScreenLayout.designResolution；容器尺寸，不缩放） */
  stageSize: new Size(1920, 1080),
  background: uiImages.roleSelectorBackground,
  /**
   * 底部栏（开始游戏按钮所在容器）：**不在舞台内** —— 素材是带「开始游戏」牌匾装饰的整图，
   * 作为「框」它要横跨整屏并贴屏幕底边。尺寸按 1080p 画布定（1920 宽 = 屏幕宽，
   * 高度按素材原比例 1624×139 等比换算，不拉伸变形），位置由 RoleSelector.dockBottomBar 算。
   * 跟着舞台走会两侧露背景，所以它挂在场景根上。
   */
  bottomBar: { name: "role_selector_bottom_bar", image: uiImages.roleSelectorBottomBar, size: new Size(1920, 164) },
  /** 开始游戏按钮（默认置灰，选中角色后可用） */
  beginGameButton: { name: "begin_game_button", image: uiImages.roleSelectorStartButton, position: new Vec2(0, -40), size: new Size(190, 48) },
  /**
   * 返回登录按钮（底部栏最右侧）：清本地会话并回登录场景（换账号 / 误进选角都能用）。
   * 用通用红底图 + 文字（同创建弹窗的确认按钮），文案见 texts（label_role_back_login）；
   * 点击行为走 NetworkSetup.returnToLogin —— 与「需要重新登录」兜底共用同一条路。
   */
  backToLoginButton: { name: "back_to_login_button", image: uiImages.middleButtonBackground, text: "label_role_back_login", position: new Vec2(855, -40), size: new Size(190, 48), fontSize: 18 },
  /** 创建角色按钮 / 管理角色按钮 / 创建弹窗返回按钮 */
  createRoleButton: { name: "show_create_role_button", image: uiImages.roleSelectorNewRoleButton, position: new Vec2(-884, 455), size: new Size(75, 79) },
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-884, 355), size: new Size(75, 79) },
  backButton: { name: "cancel_create_role_button", image: uiImages.roleSelectorBackButton, position: new Vec2(-884, -370), size: new Size(75, 79) },
  /**
   * 选中角色信息框（名称 + 等级）：挂在**底部栏**下（role_selector_bottom_bar 的子节点），
   * position 相对底部栏中心 —— 底部栏贴屏幕底边（中心在画布 (0, -540 + 82)），
   * 配置里的 y 比底部栏半高（82）大就是在栏体上方。子节点 name/level 的坐标相对信息框中心
   */
  selectedInfo: {
    name: "selected_role_info_background",
    image: uiImages.roleSelectorIdleInfo,
    position: new Vec2(-435, -35),
    size: new Size(345, 26),
    nameLabel: { name: "selected_role_name", text: "---", position: new Vec2(-35, 0), size: new Size(160, 30), fontSize: 20 },
    levelLabel: { name: "selected_role_level", text: "-", position: new Vec2(147, 0), size: new Size(40, 30), fontSize: 16 },
  },
  /**
   * 已有角色预览：**滚动网格** —— 一排 6 个，排满一行自动换行，行数超出视口在滚动区里上下滚。
   * 排布交给引擎 Layout（GRID + 横向起始轴 + CONTAINER）：换行点 = 内容宽度，CONTAINER 只撑高
   * 不改宽（见 cocos/ui/layout.ts），所以「每排几个」由 viewSize.width − paddingX×2 推导：
   * 这里 1680 − 40 = 1640 的可用宽装 (200 + 80) × 5 + 200 = 1600，第 7 个越界自动换行 = 6 个一排。
   * 调每排个数就调 viewSize.width / paddingX / spacingX；预览 + 名牌 + （管理模式）删除按钮
   * 装进同一个「单元格」节点，随内容一起滚。
   */
  roleScroll: {
    name: "role_scroll_view",
    /** 视口在舞台上的位置（视口中心；视口顶 = y + viewSize.height/2 = 475，底 = -405，都留在画布内） */
    position: new Vec2(30, 35),
    /** 视口尺寸：宽同时是滚动内容宽（换行基准），高决定一屏能看到几行 */
    viewSize: new Size(1680, 880),
    /** 单元格尺寸（预览贴单元格底部；删除按钮已压角色正中间，这里只当布局格子用，高度随便调） */
    cell: new Size(200, 400),
    /** 列距 / 行距 */
    spacingX: 80,
    spacingY: 0,
    /** 水平内边距（左右各一份，从可用宽里扣掉再换行） */
    paddingX: 20,
    paddingY: 50,
  },
  previewSize: new Size(200, 360),
  previewFrameRate: 8,
  /**
   * 角色名牌（脚下）：显示「名字 Lv.等级」，位置 = 预览中心 + 偏移（预览贴单元格底部，
   * 偏移相对预览中心，随角色列表一起重建）
   */
  namePlate: { offset: new Vec2(0, -200), size: new Size(200, 36), fontSize: 20, color: new Color("#FFFFFF") },
  /**
   * 管理角色（删除）：点「管理」按钮进入管理模式后，每个角色**正中间**出现一个删除按钮
   *
   * 删除按钮挂在**单元格**下（不在角色预览子树里）——预览自己带 TOUCH_END 选中事件，
   * 按钮若挂它下面，点删除会连带触发选中（事件冒泡）；挂单元格下既躲开冒泡又跟着滚动区走
   * （挂舞台上的话，滚动后按钮就与角色错位了）。文案见 configs/texts（label_role_delete / label_role_delete_confirm）
   */
  manageRole: {
    /** 删除按钮相对**预览中心**的位置偏移（0,0 = 压在角色正中间） */
    deleteButtonOffset: new Vec2(0, 0),
    /** 删除按钮尺寸与字号 */
    deleteButtonSize: new Size(96, 40),
    deleteButtonFontSize: 18,
    /** 待确认状态的超时（毫秒）：到点自动复位，免得「确认删除」一直挂着被误点（与背包回收同一套两步确认口径） */
    confirmTimeout: 3000,
    /** 管理模式的提示条（舞台顶部居中；文字见 configs/texts.label_role_delete_hint） */
    hint: { name: "role_manage_hint", position: new Vec2(0, 300), size: new Size(700, 40), fontSize: 22, color: new Color("#FFD700") },
  },
  /** 创建角色弹窗 */
  createDialog: {
    name: "create_role_dialog",
    image: uiImages.createRoleDialogBackground,
    position: new Vec2(770, -125),
    size: new Size(320, 580),
    title: { name: "create_role_dialog_title", image: uiImages.createRoleTitleLabel, position: new Vec2(0, 242), size: new Size(128, 28) },
    genderLabel: { name: "gender_label", image: uiImages.createRoleGenderLabel, position: new Vec2(0, 190), size: new Size(56, 25) },
    occupationLabel: { name: "occupation_label", image: uiImages.createRoleOccupationLabel, position: new Vec2(0, 100), size: new Size(56, 25) },
    /** 性别 / 职业开关组（横向容器：位置、间距、单个开关尺寸） */
    sexToggle: { position: new Vec2(0, 148), spacing: 30, toggleSize: new Size(48, 48) },
    occupationToggle: { position: new Vec2(0, 52), spacing: 30, toggleSize: new Size(48, 48) },
    /** 名称输入框 */
    nameInput: { placeholder: "输入角色名称", position: new Vec2(0, -26), size: new Size(240, 60) },
    /**
     * 创建按钮（默认置灰，输入名称后可用）
     *
     * 用通用红底按钮 + 文字（文案见 configs/texts.label_role_create）：
     * 原来复用的是"开始游戏"牌匾图（create_role/start_btn.png），字是画在图里的，
     * 于是弹窗里那颗键写着「开始游戏」——图与功能对不上，也没法改文案。
     */
    createButton: { name: "confirm_create_role_button", image: uiImages.middleRedButtonBackground, position: new Vec2(0, -238), size: new Size(190, 48), fontSize: 18 },
    /** 职业说明图（尺寸取职业配置的 descriptionSize）与角色预览 */
    occupationDescription: { position: new Vec2(0, -142) },
    occupationPreview: { position: new Vec2(-245, -95), size: new Size(200, 360) },
  },
};

//#endregion

//#region 加载场景

/** 加载界面布局 */
export const loadingLayout = {
  background: uiImages.loadingBackground,
  /** 进度文字（居中） */
  progress: { text: "加载中 0%", position: new Vec2(), fontSize: 32 },
};

//#endregion

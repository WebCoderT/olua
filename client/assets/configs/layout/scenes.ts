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
 * 三者的排版方式不同，别混用：
 * - 登录（#1036 起）：**绝对坐标整版布局**（对齐 design/olua-login 设计稿：顶栏 + 左侧文案区 +
 *   右侧登录面板 + 底部条，是二维构图，纵向流式排不出来；几何 / 配色 / 文案 key / 时长全部在
 *   loginLayout 里，ui/Login.ts 只负责按它组装）；
 * - 选角：同为绝对坐标（构图是「两侧按钮 + 中间站位」的二维布局）；
 * - 加载：绝对坐标 + 居中零件。
 */

//#region 登录场景

/**
 * 登录界面布局（#1036，按 design/olua-login/index.html 整版复刻）
 *
 * 坐标 = 舞台中心系（原点在屏幕中心，y 向上为正）；元素一律锚点居中，
 * 「左对齐文本」通过「左边缘 x + 宽度的一半」给中心坐标。
 * 四个区块：topbar（顶部品牌/版本/声音）→ hero（左侧文案区）→ panel（右侧登录面板）→
 * bottombar（底部版权/协议）。文案 key 见 configs/texts 的 login_* 段。
 */
export const loginLayout = {
  /** 舞台尺寸 = 设计分辨率（见 ScreenLayout.designResolution；容器尺寸，不缩放） */
  stageSize: new Size(1920, 1080),
  /** 背景图（#1036：设计稿 hero-bg 黄昏沙城 1600×900，与屏幕同比例，铺满不变形不裁切） */
  background: uiImages.loginBackground,

  /** 设计稿调色板（olua-login :root：暖炭褐底 / 暗褐世界 / 朱红信号 / 骨白墨 + 古铜金阶） */
  palette: {
    /** 主金（描边 / 强调字） */
    gold: new Color(194, 146, 69, 255),
    /** 深金（面板边框） */
    goldDark: new Color(140, 106, 51, 255),
    /** 弱金线（rgba(194,146,69,.24)） */
    line: new Color(194, 146, 69, 61),
    /** 骨白正文 */
    ink: new Color(237, 226, 204, 255),
    /** 骨白 82%（副文案） */
    inkSoft: new Color(237, 226, 204, 209),
    /** 暖灰棕（次要文案 / 图标） */
    muted: new Color(167, 143, 108, 255),
    /** 朱红（主按钮 / 公告条左缘） */
    accent: new Color(198, 58, 32, 255),
    /** 朱红亮阶（按钮上高光渐变） */
    accentLight: new Color(224, 86, 47, 255),
    /** 朱红描边 */
    accentBorder: new Color(232, 115, 77, 255),
    /** 主按钮文字 */
    btnText: new Color(255, 246, 232, 255),
    /** 面板底（暗褐 95%） */
    panelFill: new Color(31, 22, 14, 244),
    /** 输入框 / 选服条底（rgba(0,0,0,.34)） */
    fieldFill: new Color(0, 0, 0, 87),
    /** 公告条底（rgba(14,9,5,.55)） */
    noticeFill: new Color(14, 9, 5, 140),
    /** 顶栏版本胶囊底 */
    pillFill: new Color(22, 16, 9, 140),
    /** 职业标签选中底（暗褐世界色） */
    tabActiveFill: new Color(36, 26, 17, 255),
    /** 勾选框勾的颜色（面板底色） */
    checkMark: new Color(23, 16, 9, 255),
    /** 全透明填充（未选中的职业标签底） */
    transparent: new Color(0, 0, 0, 0),
    /** 主按钮上半高光阶（白 18%） */
    highlight: new Color(255, 255, 255, 46),
  },
  /** 圆角半径（设计稿 --r-shell / --r-control） */
  radius: { shell: 6, control: 4 },

  /** 顶栏：左品牌（真实 LOGO 图）+ 右配置版本胶囊与背景音开关 */
  topbar: {
    /** 品牌 LOGO（resources/logo.png 金色 Olua 花体，1042×404 等比缩到 176 宽） */
    brand: { name: "login_brand_logo", image: uiImages.gameLogo, position: new Vec2(-812, 494), size: new Size(176, 68) },
    /** 版本胶囊（文字 = login_version_label，值来自 GET /game-config/version；拉取失败整颗隐藏） */
    version: {
      name: "login_version_pill",
      position: new Vec2(767, 496),
      size: new Size(150, 40),
      fontSize: 16,
      textKey: "login_version_label",
    },
    /** 背景音开关（登录页 BGM on/off；喇叭图标用 Graphics 画，见 Login.drawSpeaker） */
    music: { name: "login_music_button", position: new Vec2(878, 496), size: new Size(44, 44), fontSize: 16 },
  },

  /** 首屏左列（文案区）：左边缘统一在 x=-900（屏幕左缘往里 60px），y 从上往下 */
  hero: {
    /** 左列左边缘（所有左对齐元素的起点） */
    leftEdgeX: -900,
    /** 眉题前置金线（28×2）+ 眉题文字（左对齐） */
    eyebrow: {
      line: { name: "login_eyebrow_line", position: new Vec2(-886, 172), size: new Size(28, 2) },
      label: { textKey: "login_eyebrow", position: new Vec2(-590, 172), size: new Size(520, 30), fontSize: 16 },
    },
    /** 主标题：真实 LOGO 图（1042×404 等比缩到 440 宽；设计稿的大字标题用它替换） */
    logo: { name: "login_hero_logo", image: uiImages.gameLogo, position: new Vec2(-680, 64), size: new Size(440, 171) },
    /** 一句话简介（两行内，左对齐，wrapped label） */
    tagline: { textKey: "login_tagline", position: new Vec2(-620, -68), width: 560, fontSize: 17, lineHeight: 30 },
    /** 职业预览标签（三颗胶囊，从左往右；点它切换下方说明文案） */
    classTabs: {
      /** 每颗胶囊尺寸与整排第一个的左边缘 */
      size: new Size(128, 44),
      gap: 12,
      firstLeftEdgeX: -900,
      positionY: -148,
      fontSize: 17,
      /** 与本作三职业一一对应：label = 标签字，descKey = 说明文案 key（默认选中第一颗） */
      classes: [
        { key: "warrior", labelKey: "login_class_warrior", descKey: "login_class_desc_warrior" },
        { key: "mage", labelKey: "login_class_mage", descKey: "login_class_desc_mage" },
        { key: "taoist", labelKey: "login_class_taoist", descKey: "login_class_desc_taoist" },
      ],
    },
    /** 职业说明（随选中的标签换文案） */
    classDesc: { name: "login_class_desc", position: new Vec2(-590, -206), size: new Size(620, 28), fontSize: 15 },
    /** 公告栏（滚动展示生效中的公告标题；没有公告整条隐藏） */
    notice: {
      name: "login_notice_bar",
      position: new Vec2(-590, -272),
      size: new Size(620, 48),
      /** 轮换间隔与淡入淡出时长（毫秒） */
      rollMs: 4000,
      fadeMs: 300,
      /** 标签字 / 滚动行的字号 */
      labelFontSize: 14,
      rowFontSize: 14,
    },
  },

  /** 右侧登录面板（470 宽，圆角壳 + 四角金点装饰） */
  panel: {
    name: "login_panel",
    position: new Vec2(665, -30),
    size: new Size(470, 560),
    /** 面板内宽（尺寸 470 - 左右各 32 内边距） */
    innerWidth: 406,
    /** 标题（字距已写进文案）+ 标题下金线 */
    title: { textKey: "login_panel_title", position: new Vec2(0, 208), size: new Size(300, 30), fontSize: 22 },
    titleUnderline: { name: "login_panel_title_line", position: new Vec2(0, 186), size: new Size(44, 2) },
    /** 账号 / 密码输入框（56 高；图标沿用现有 icon-account / icon-password） */
    account: { name: "login_field_account", placeholder: "请输入账号", position: new Vec2(0, 146), size: new Size(406, 56), icon: uiImages.loginAccountIcon, password: false, inputFontSize: 20, inputHeight: 44, inputInset: 96 },
    password: { name: "login_field_password", placeholder: "请输入密码", position: new Vec2(0, 76), size: new Size(406, 56), icon: uiImages.loginPasswordIcon, password: true, inputFontSize: 20, inputHeight: 44, inputInset: 96 },
    /** 密码显隐按钮（挂在密码框内右侧；眼睛图标 Graphics 画，见 Login.drawEye） */
    eye: { name: "login_password_eye", offsetX: 180, offsetY: 76, size: new Size(30, 30) },
    /** 选服按钮（点它开 ZoneSelectDialog；区名与状态来自 GET /zones） */
    server: {
      name: "login_server_button",
      position: new Vec2(0, 6),
      size: new Size(406, 56),
      /** 「区服」标签 / 区名 / 状态字 / 箭头的横向位置与宽度（相对按钮中心） */
      labelX: -170,
      labelSize: new Size(60, 56),
      nameX: -25,
      nameSize: new Size(170, 56),
      statusX: 125,
      statusSize: new Size(100, 56),
      caretX: 178,
      fontSize: 16,
      statusFontSize: 14,
    },
    /** 记住账号行：勾选框 + 文案（左）/ 忘记密码（右） */
    remember: {
      positionY: -46,
      checkbox: { name: "login_remember_checkbox", offsetX: -179, size: new Size(22, 22) },
      label: { textKey: "login_remember", offsetX: -110, size: new Size(110, 24), fontSize: 14 },
      forgot: { textKey: "login_forgot", offsetX: 130, size: new Size(140, 24), fontSize: 14 },
    },
    /** 主按钮（朱红渐变；文案 = login_enter_button） */
    loginButton: {
      name: "login_enter_button_node",
      textKey: "login_enter_button",
      position: new Vec2(0, -110),
      size: new Size(406, 62),
      fontSize: 20,
    },
    /** 次要入口行：注册新账号 / 游戏修复 */
    altRow: {
      positionY: -172,
      register: { textKey: "login_register", offsetX: -110, size: new Size(160, 24), fontSize: 14 },
      repair: { textKey: "login_repair", offsetX: 110, size: new Size(140, 24), fontSize: 14 },
    },
    /** 面板脚注（合规文案）：1px 分隔线 + 一行小字 */
    foot: {
      line: { name: "login_panel_foot_line", position: new Vec2(0, -206), size: new Size(406, 1) },
      text: { textKey: "login_foot_notice", position: new Vec2(0, -228), size: new Size(406, 22), fontSize: 12 },
    },
  },

  /** 底部条：版权（左）/ 协议入口（右，点击飘字说明） */
  bottombar: {
    positionY: -508,
    copyright: { textKey: "login_copyright", position: new Vec2(-650, -508), size: new Size(500, 24), fontSize: 14 },
    links: [
      { textKey: "login_link_agreement", position: new Vec2(565, -508), size: new Size(110, 24), fontSize: 14 },
      { textKey: "login_link_privacy", position: new Vec2(700, -508), size: new Size(110, 24), fontSize: 14 },
      { textKey: "login_link_minor", position: new Vec2(835, -508), size: new Size(130, 24), fontSize: 14 },
    ],
  },
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
  beginGameButton: { name: "begin_game_button", image: uiImages.roleSelectorStartButton, position: new Vec2(0, -44), size: new Size(220, 52) },
  /** 创建角色按钮 / 管理角色按钮 */
  createRoleButton: { name: "show_create_role_button", image: uiImages.roleSelectorNewRoleButton, position: new Vec2(-884, 455), size: new Size(75, 79) },
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-884, 355), size: new Size(75, 79) },
  /**
   * 返回按钮：**常驻**（不在弹窗里时也在），点击清本地会话回登录场景（换账号 / 误进选角都能用）。
   * 点击行为走 NetworkSetup.returnToLogin —— 与「需要重新登录」兜底共用同一条路，退出只有一条路。
   * 创建角色弹窗的关闭在弹窗自己的右上角（见 createDialog.closeButton），不走这颗按钮
   */
  backButton: { name: "back_to_login_button", image: uiImages.roleSelectorBackButton, position: new Vec2(-884, -370), size: new Size(75, 79) },
  /**
   * 选中角色信息框（名称 + 等级）：挂在**底部栏**下（role_selector_bottom_bar 的子节点），
   * position 相对底部栏中心 —— 底部栏贴屏幕底边（中心在画布 (0, -540 + 82)），
   * 配置里的 y 比底部栏半高（82）大就是在栏体上方。子节点 name/level 的坐标相对信息框中心
   */
  selectedInfo: {
    name: "selected_role_info_background",
    image: uiImages.roleSelectorIdleInfo,
    position: new Vec2(-530, -35),
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
    hint: { name: "role_manage_hint", position: new Vec2(0, 450), size: new Size(700, 40), fontSize: 22, color: new Color("#FFD700") },
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
     * 原来复用的是"开始游戏"牌匾图（ui/create-role/start-button.png），字是画在图里的，
     * 于是弹窗里那颗键写着「开始游戏」——图与功能对不上，也没法改文案。
     */
    createButton: { name: "confirm_create_role_button", image: uiImages.middleRedButtonBackground, position: new Vec2(0, -238), size: new Size(190, 48), fontSize: 18 },
    /** 职业说明图（尺寸取职业配置的 descriptionSize）与角色预览 */
    occupationDescription: { position: new Vec2(0, -142) },
    occupationPreview: { position: new Vec2(-245, -95), size: new Size(200, 360) },
    /**
     * 右上角关闭按钮：点它关弹窗（backButton 已改为常驻的「返回登录」，不再兼职关弹窗）。
     * 坐标相对弹窗中心 —— 弹窗 320×580，(138, 266) = 右上角往里缩一点
     */
    closeButton: { name: "close_create_role_button", image: uiImages.middleRedButtonBackground, position: new Vec2(138, 266), size: new Size(44, 44), fontSize: 24 },
  },
  /**
   * 选中态（不再画白色选中框，用「动画 + 脚下特效」表达选中）：
   * 选中的角色把站立帧换成**展示帧**（show，循环），并在脚底循环播 select_player@0。
   * 两套图集都是 800×800 画布、角色站姿对齐，切换时不会跳位
   */
  selection: {
    /** show 帧动画帧率（帧数 33，与站立同口径；调快慢只影响这一处） */
    showFrameRate: 8,
    /**
     * 脚下选中特效（select_player@0）：
     * - `offset` 相对预览中心（预览画布中心），负数往下；按角色脚底位置目视调
     * - `size` 显示尺寸。图集原画布只有 134×72，这里按它拉伸（非等比，椭圆会更扁宽）
     * - `frameRate` 8 帧循环的帧率
     */
    effect: { offset: new Vec2(0, -180), size: new Size(300, 100), frameRate: 12 },
  },
};

//#endregion

//#region 加载场景

/** 加载界面布局 */
export const loadingLayout = {
  background: uiImages.loadingBackground,
  /** 居中的加载帧动画（图集 7 帧循环；显示尺寸 / 位置 / 帧率在这里调） */
  loadingAnimation: { atlas: uiImages.loadingAnimationAtlas, position: new Vec2(-45, 0), size: new Size(240, 240), frameRate: 8 },
  /**
   * 底部正中的进度条：底图 + 填充图。填充图挂 Mask 下，**Mask 宽度跟进度走**（从内条左缘起裁切，
   * 图不拉伸 —— Sprite 的 FILLED 是把整张纹理压扁，不适合这种带透明边距的填充条）。
   * 显示尺寸在这里调（当前 1920×300 是拉满全宽的）
   */
  bar: {
    name: "loading_bar",
    position: new Vec2(0, -390),
    size: new Size(1920, 300),
    background: uiImages.loadingProgressBackground,
    fill: uiImages.loadingProgressFill,
    /**
     * 填充区（**素材原生占比**，从 fill 图实测：不透明内条占整图 x[28,1067] y[60,188]，整图 1136×227）。
     * 用占比而非显示坐标 —— 条改大小这里不用动，显示尺寸在代码里按条宽/高现算；换素材才要重测
     */
    fillArea: { leftFrac: 28 / 1136, widthFrac: 1039 / 1136, yCenterFrac: 124 / 227, heightFrac: 128 / 227 },
  },
  /** 加载进度文字：一行小字放进度条右下角（坐标相对画布中心） */
  progress: { text: "加载中 0%", position: new Vec2(0, -100), fontSize: 12 },
  /**
   * 运营配置拉不到时的失败面板（#604）：明细一行红字 + 一个重试按钮
   *
   * 位置在进度条上方一点（y 向下为负）。明细宽度给足 1000 并自动换行 ——
   * 报错文案会带「缺了哪几段」，一行 12 号字塞不下。颜色只在布局里定义（ui/ 里不写色值）。
   */
  failure: {
    detailPosition: new Vec2(0, -140),
    detailWidth: 1000,
    detailFontSize: 20,
    detailColor: new Color("#FF6060"),
    retryPosition: new Vec2(0, -230),
  },
};

//#endregion

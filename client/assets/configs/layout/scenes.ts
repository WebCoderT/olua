import { Size, Vec2 } from "cc";
import { uiImages } from "./images";
import { T } from "./tokens";

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
 * 登录界面布局（#1059 起按 design/olua-ui/screens/01-login 重排几何）
 *
 * 坐标 = 舞台中心系（原点在屏幕中心，y 向上为正）；元素一律锚点居中，
 * 「左对齐文本」通过「左边缘 x + 宽度的一半」给中心坐标。
 * 四个区块：topbar（顶部品牌/版本/声音）→ hero（左侧文案区）→ panel（右侧登录面板）→
 * bottombar（底部版权/协议）。文案 key 见 configs/texts 的 login_* 段。
 *
 * 几何口径取自稿件（1920×1080 画布，稿件就是按这个基准写的，不做等比换算）：
 * - 顶栏 `padding:26px 64px`、底栏 `padding:18px 64px` → 左右边距 64，左上角 x = -896
 * - 主体栅格 `grid-template-columns:1fr 476px; gap:120px; padding:120px 64px 96px 96px`
 *   → 文案区左边缘 -864、面板宽 476 贴右边距 64（右边缘 896），纵向居中偏下 12
 * - 面板内边距 34 / 34 / 22，控件高 44（输入框与选服条同高）、主按钮 48
 */
export const loginLayout = {
  /** 舞台尺寸 = 设计分辨率（见 ScreenLayout.designResolution；容器尺寸，不缩放） */
  stageSize: new Size(1920, 1080),
  /** 背景图（#1036：设计稿 hero-bg 黄昏沙城 1600×900，与屏幕同比例，铺满不变形不裁切） */
  background: uiImages.loginBackground,
  /** 背景上的黑色半透明遮罩（设计稿 hero-scrim 的均匀层近似：压暗底图，让文案与面板可读） */
  scrim: { name: "login_background_scrim", color: T.overlay.heroScrim },

  /**
   * 设计稿调色板（#1059 起全部引用设计令牌 configs/layout/tokens；名字沿用登录页那一套，
   * 只做「登录页语义 → 令牌」的映射，方便阅读 Login.ts 的调用点）
   */
  palette: {
    /** 主金（描边 / 强调字） */
    gold: T.gold[3],
    /** 亮金（主标金文字 / 高光强调） */
    goldLight: T.gold[4],
    /** 深金（面板边框） */
    goldDark: T.gold[2],
    /** 弱金线 */
    line: T.line[2],
    /** 极弱金线（面板脚注分隔线） */
    lineFaint: T.line[1],
    /** 骨白正文 */
    ink: T.text[1],
    /** 骨白 80%（副文案） */
    inkSoft: T.text[2],
    /** 次要文案 / 图标（骨白 58%） */
    muted: T.text[3],
    /** 占位 / 脚注（骨白 34%） */
    faint: T.text[4],
    /** 朱红（主按钮 / 公告条左缘） */
    accent: T.ember[2],
    /** 朱红亮阶（按钮上高光渐变） */
    accentLight: T.ember[3],
    /** 朱红描边 */
    accentBorder: T.ember.border,
    /** 朱红文字（区服状态字） */
    accentText: T.ember[4],
    /** 主按钮文字 */
    btnText: T.text.onEmber,
    /** 面板底 */
    panelFill: T.surface[2],
    /** 输入框 / 选服条底 */
    fieldFill: T.surface.input,
    /** 公告条底 */
    noticeFill: T.surface.sunken,
    /** 顶栏版本胶囊底 */
    pillFill: T.surface.sunken,
    /** 职业标签选中底 */
    tabActiveFill: T.surface[3],
    /** 勾选框勾的颜色（面板底色） */
    checkMark: T.surface[2],
    /** 全透明填充（未选中的职业标签底） */
    transparent: T.overlay.transparent,
    /** 主按钮上半高光阶 */
    highlight: T.overlay.highlight,
  },
  /** 圆角半径（--r-3 面板 / --r-2 控件） */
  radius: { shell: T.radius.r3, control: T.radius.r2 },

  /** 顶栏（左右边距 64、上下 26）：右配置版本胶囊与背景音开关（左上品牌 LOGO 已移除） */
  topbar: {
    /** 版本胶囊（文字 = login_version_label，值来自 GET /game-config/version；拉取失败整颗隐藏） */
    version: {
      name: "login_version_pill",
      position: new Vec2(784, 495),
      size: new Size(120, 30),
      fontSize: T.fontSize.f11,
      textKey: "login_version_label",
    },
    /**
     * 背景音开关（登录页 BGM on/off）：喇叭图标用设计稿导出的 PNG（两态换图，不自绘）
     */
    music: {
      name: "login_music_button",
      position: new Vec2(877, 495),
      size: new Size(40, 40),
      fontSize: T.fontSize.f16,
      icon: uiImages.loginSpeakerIcon,
      iconOff: uiImages.loginSpeakerOffIcon,
      iconSize: new Size(20, 20),
    },
  },

  /** 首屏左列（文案区）：左边缘统一在 x=-864（屏幕左缘往里 96px），y 从上往下 */
  hero: {
    /** 左列左边缘（所有左对齐元素的起点） */
    leftEdgeX: -864,
    /** 眉题前置金线（30×1）+ 眉题文字（左对齐，线尾再空 10） */
    eyebrow: {
      line: { name: "login_eyebrow_line", position: new Vec2(-849, 186), size: new Size(30, 1) },
      label: { textKey: "login_eyebrow", position: new Vec2(-704, 186), size: new Size(240, 24), fontSize: T.fontSize.f12 },
    },
    /** 主标题：真实 LOGO 图（1042×404 等比缩到 190 宽；稿件把这里当 72px 品牌字） */
    /** 主标（金色文字「Olua」，替代原 LOGO 图；框体沿用原图 190×74，字号用品牌字档 f72） */
    logo: { name: "login_hero_logo", textKey: "login_hero_title", position: new Vec2(-769, 120), size: new Size(190, 74), fontSize: T.fontSize.f72 },
    /** 一句话简介（两行内，左对齐，wrapped label） */
    tagline: { textKey: "login_tagline", position: new Vec2(-584, 34), width: 560, fontSize: T.fontSize.f14, lineHeight: 30 },
    /** 职业预览标签（三颗胶囊，从左往右；点它切换下方说明文案） */
    classTabs: {
      /** 每颗胶囊尺寸与整排第一个的左边缘（稿件 ctab：高 40、左右各 18 内边距、13px 字） */
      size: new Size(86, 40),
      gap: T.spacing.sp5,
      firstLeftEdgeX: -864,
      positionY: -41,
      fontSize: T.fontSize.f13,
      /** 图标（设计稿 SVG 导出的 16px PNG）与文字相对胶囊左内边距 18 的位置 */
      iconSize: new Size(16, 16),
      iconInset: 18,
      iconGap: 8,
      /** 与本作三职业一一对应：label = 标签字，descKey = 说明文案 key（默认选中第一颗） */
      classes: [
        { key: "warrior", labelKey: "login_class_warrior", descKey: "login_class_desc_warrior", icon: uiImages.loginClassWarriorIcon },
        { key: "mage", labelKey: "login_class_mage", descKey: "login_class_desc_mage", icon: uiImages.loginClassMageIcon },
        { key: "taoist", labelKey: "login_class_taoist", descKey: "login_class_desc_taoist", icon: uiImages.loginClassTaoistIcon },
      ],
    },
    /** 职业说明（随选中的标签换文案；稿件 min-height 两行，换行不影响下面元素位置） */
    classDesc: { name: "login_class_desc", position: new Vec2(-554, -106), size: new Size(620, 46), fontSize: T.fontSize.f13 },
    /** 公告栏（滚动展示生效中的公告标题；没有公告整条隐藏） */
    notice: {
      name: "login_notice_bar",
      position: new Vec2(-554, -175),
      size: new Size(620, 46),
      /** 左缘朱红细条宽度 */
      edgeWidth: 2,
      /** 轮换间隔与淡入淡出时长（毫秒；稿件 4 条 12 秒走完一轮） */
      rollMs: 3000,
      fadeMs: T.duration.dur2,
      /** 「公告」标签（左内边距 16，图标 15 + 空 7 才是文字，字后空 14 才是滚动行） */
      label: { textKey: "login_notice_label", offsetX: -240, size: new Size(60, 46), fontSize: T.fontSize.f12, inset: 16 },
      /** 公告图标（设计稿 SVG 导出的 PNG，15px，左内边距 16 起） */
      icon: { name: "login_notice_icon", image: uiImages.loginNoticeIcon, offsetX: -284, size: new Size(15, 15) },
      /** 滚动行：左边缘 = 面板左 + 2(朱条) + 16 + 60 + 14 */
      row: { offsetX: 45, size: new Size(526, 46), fontSize: T.fontSize.f13 },
    },
  },

  /**
   * 右侧登录面板（476×446，矢量底板 + 四角铆钉，见 GameUiHelper.createDialogPanel）
   *
   * 面板纵向按稿件内边距 34 / 34 / 22 从上往下排：眉题 ACCOUNT 贴左上、标题居中 + 44×1 金线，
   * 之后依次是 44 高的两个输入框、选服条、「记住账号」行、48 高主按钮、次要入口、脚注。
   * 下面所有子元素坐标都相对**面板中心**（面板中心 = 舞台 (658, -20)）。
   */
  panel: {
    name: "login_panel",
    position: new Vec2(658, -20),
    size: new Size(476, 446),
    /** 面板内宽（476 - 左右各 34 内边距） */
    innerWidth: 408,
    /** 左上角小字（ACCOUNT，10px 银灰金；左边缘 = 面板左 + 34 内边距） */
    eyebrow: { textKey: "login_panel_eyebrow", position: new Vec2(-164, 205), size: new Size(80, 20), fontSize: T.fontSize.f10 },
    /** 标题（字距已写进文案）+ 标题下金线 */
    title: { textKey: "login_panel_title", position: new Vec2(0, 175), size: new Size(300, 30), fontSize: T.fontSize.f20 },
    titleUnderline: { name: "login_panel_title_line", position: new Vec2(0, 153), size: new Size(T.border.titleRuleWidth, T.border.titleRuleHeight) },
    /** 账号 / 密码输入框（44 高；图标沿用现有 icon-account / icon-password，图标距左 14、宽 17） */
    account: { name: "login_field_account", placeholder: "请输入账号", position: new Vec2(0, 104), size: new Size(408, 44), icon: uiImages.loginAccountIcon, password: false, inputFontSize: T.fontSize.f14, inputHeight: 34, inputInset: 84 },
    password: { name: "login_field_password", placeholder: "请输入密码", position: new Vec2(0, 46), size: new Size(408, 44), icon: uiImages.loginPasswordIcon, password: true, inputFontSize: T.fontSize.f14, inputHeight: 34, inputInset: 84 },
    /** 密码显隐按钮（挂在密码框内右侧，offset 相对密码框中心；眼睛图标两态换图，不自绘） */
    eye: {
      name: "login_password_eye",
      offsetX: 179,
      offsetY: 0,
      size: new Size(30, 30),
      icon: uiImages.loginEyeIcon,
      iconOn: uiImages.loginEyeOnIcon,
      iconSize: new Size(18, 18),
    },
    /**
     * 选服按钮（点它开 ZoneSelectDialog；区名与状态来自 GET /zones）
     *
     * 行高 44 与输入框一致，上下间距同样 14（与账号 / 密码的 58 中心距同一节奏）。
     * 地球与箭头都是设计稿导出的 PNG。
     */
    server: {
      name: "login_server_button",
      position: new Vec2(0, -12),
      size: new Size(408, 44),
      /** 地球小图（16px，左内边距 14 起）与区名 / 状态字 / 箭头的横向位置与宽度（相对按钮中心） */
      globeX: -178,
      globeSize: new Size(16, 16),
      globeIcon: uiImages.loginGlobeIcon,
      nameX: -30,
      nameSize: new Size(220, 44),
      statusX: 130,
      statusSize: new Size(80, 44),
      caretX: 188,
      caretSize: new Size(12, 12),
      caretIcon: uiImages.loginCaretIcon,
      fontSize: T.fontSize.f14,
      statusFontSize: T.fontSize.f11,
    },
    /** 记住账号行：勾选框 + 文案（左）/ 忘记密码（右）；与上方选服行保持同一 14px 间距 */
    remember: {
      positionY: -57,
      checkbox: {
        name: "login_remember_checkbox",
        offsetX: -193,
        size: new Size(18, 18),
        icon: uiImages.loginCheckboxIcon,
        iconChecked: uiImages.loginCheckboxCheckedIcon,
      },
      label: { textKey: "login_remember", offsetX: -132, size: new Size(110, 20), fontSize: T.fontSize.f12 },
      forgot: { textKey: "login_forgot", offsetX: 152, size: new Size(100, 20), fontSize: T.fontSize.f12 },
    },
    /** 主按钮（朱红渐变；文案 = login_enter_button） */
    loginButton: {
      name: "login_enter_button_node",
      textKey: "login_enter_button",
      position: new Vec2(0, -102),
      size: new Size(408, 48),
      fontSize: T.fontSize.f18,
    },
    /** 次要入口行：注册新账号 / 游戏修复 */
    altRow: {
      positionY: -150,
      register: { textKey: "login_register", offsetX: -100, size: new Size(150, 20), fontSize: T.fontSize.f13 },
      repair: { textKey: "login_repair", offsetX: 100, size: new Size(130, 20), fontSize: T.fontSize.f13 },
    },
    /** 面板脚注（合规文案）：1px 分隔线 + 一行小字 */
    foot: {
      line: { name: "login_panel_foot_line", position: new Vec2(0, -174), size: new Size(408, 1) },
      text: { textKey: "login_foot_notice", position: new Vec2(0, -196), size: new Size(408, 20), fontSize: T.fontSize.f10 },
    },
  },

  /** 底部条（左右边距 64、下 18）：版权（左）/ 协议入口（右，点击飘字说明） */
  bottombar: {
    positionY: -514,
    copyright: { textKey: "login_copyright", position: new Vec2(-646, -514), size: new Size(400, 20), fontSize: T.fontSize.f12 },
    links: [
      { textKey: "login_link_agreement", position: new Vec2(725, -514), size: new Size(90, 20), fontSize: T.fontSize.f12 },
      { textKey: "login_link_privacy", position: new Vec2(793, -514), size: new Size(90, 20), fontSize: T.fontSize.f12 },
      { textKey: "login_link_minor", position: new Vec2(867, -514), size: new Size(110, 20), fontSize: T.fontSize.f12 },
    ],
  },
};

//#endregion

//#region 选角场景
/**
 * 选角界面布局（#1059 起按 design/olua-ui/screens/02-role-select 重排几何）
 *
 * 坐标为「舞台」坐标系（原点在舞台中心）：所有元素挂在舞台容器下，舞台 = 1920×1080 的画布
 * （不缩放，1 设计像素 = 1 屏幕像素）。
 *
 * 稿件把这一屏改成「三栏 + 顶底条」的二维构图，不再有底部牌匾栏：
 * - 顶栏：品牌（左）/ 「区服 · 账号」胶囊 + 退出登录（右），左右边距 56、上下 24
 * - 三栏 `grid-template-columns:520px 1fr 500px; padding:104px 56px 56px`
 *   → 左栏文案（职业信息 + chips + 进游戏/返回）、中立绘（底光 + 脚下名牌）、右角色面板
 * - 右面板 500×920：头部（我的角色 / 数量 / 管理）+ 两列 228×252 角色卡（滚动）+ 创建角色卡
 * - 底栏：OLUA · ROLE SELECT（左）/ BUILD（右），左右边距 56、下 18
 *
 * 与稿件的两处**刻意保留**（功能优先，见 issue #1059）：
 * 1. 角色卡里的立绘用现有帧动画（createRolePreview）而不是静态原画 —— 素材只有帧图集；
 * 2. 卡片不带「战力」数值：角色概要用 `RoleSummary` 里没有战力字段，客户端不编数字
 *    （暂时放置，重开条件：`GET /roles` 概要里加 power）。
 */

/** 角色卡里的一项信息（职业色点 / 性别 / 等级）在左栏 chips 里的排布 */
export interface RoleChipLayout {
  /** 名称（构建时用来找节点） */
  key: string;
  size: Size;
}

export const roleSelectorLayout = {
  /** 舞台尺寸 = 设计分辨率 1920×1080（见 ScreenLayout.designResolution；容器尺寸，不缩放） */
  stageSize: new Size(1920, 1080),
  /** 背景：与登录 / 加载同一张黄昏沙城（稿件 02 用的就是它） */
  background: uiImages.loginBackground,
  /** 背景上的黑色半透明遮罩（与登录页 loginLayout.scrim 同一层：压暗底图，文字与卡片更可读） */
  scrim: { name: "role_select_scrim", color: T.overlay.heroScrim },

  /** 顶栏：「区服 · 账号」胶囊（右）+ 退出登录（左上品牌图已移除） */
  topbar: {
    /** 「雷霆一区 · player_01」胶囊（区名来自 ZoneStore，账号来自 Session） */
    who: { name: "role_select_who", position: new Vec2(704, 497), size: new Size(230, 30), fontSize: T.fontSize.f12 },
    /** 退出登录（ghost 档小按钮：先吊销令牌再回登录） */
    logoutButton: {
      name: "role_select_logout_button",
      textKey: "role_select_logout",
      position: new Vec2(860, 497),
      size: new Size(88, 28),
      fontSize: T.fontSize.f12,
    },
  },

  /** 底栏：两段小字（左右各贴边距 56） */
  footer: {
    left: { textKey: "role_select_footer_left", position: new Vec2(-830, -515), size: new Size(240, 16), fontSize: T.fontSize.f10 },
    /** 右下角复用登录页那条合规文案（不写 BUILD 号：客户端版本由 GET /game-config/version 说了算，不在这里编） */
    right: { textKey: "login_foot_notice", position: new Vec2(830, -515), size: new Size(240, 16), fontSize: T.fontSize.f10 },
  },

  /**
   * 左栏：眉题 / 角色名 / 一句话说明 / 属性 chips / 行动按钮
   *
   * 左边缘统一 -904，正文宽 496（栏宽 520 减去 24 的右侧留白）。
   * 纵向按稿件 18 的行距从上往下排，整块在内容区（y 436 ~ -484）里居中。
   */
  hero: {
    /** 左栏左边缘（所有左对齐元素的起点） */
    leftEdgeX: -904,
    /** 正文宽（角色名 / 说明 / chips 的可用宽度） */
    width: 496,
    /** 眉题 SELECT YOUR HERO */
    cap: { textKey: "role_select_cap", position: new Vec2(-716, 145), size: new Size(376, 20), fontSize: T.fontSize.f11 },
    /** 角色名（稿件 64px 品牌字 → 取令牌 f56；未选中时显示占位） */
    name: { position: new Vec2(-716, 86), size: new Size(376, 72), fontSize: T.fontSize.f56, placeholder: "选择角色" },
    /** 一句话说明（选角色后按等级填；未选中时是空列表文案） */
    /** 说明用的是「顶对齐 + 自动撑高」的 wrapped label：y 是文字块上边缘，往下长（配置里别再按中心算） */
    sub: { textKey: "role_select_sub", position: new Vec2(-716, 40), size: new Size(376, 56), width: 376, fontSize: T.fontSize.f13, lineHeight: 26, placeholderKey: "role_select_sub_empty" },
    /** 属性 chips：从左边缘依次横排（职业带色点 / 性别 / 等级） */
    chips: {
      positionY: -30,
      height: 32,
      fontSize: T.fontSize.f12,
      gap: T.spacing.sp4,
      /** 职业色点直径 */
      dot: 7,
      /** 三颗 chip 的固定宽度（够放下最长文案：魔法师 / 等级 Lv.99） */
      items: [
        { key: "class", size: new Size(110, 32) },
        { key: "sex", size: new Size(104, 32) },
        { key: "level", size: new Size(122, 32) },
      ] as RoleChipLayout[],
      /** 无角色时的占位 chip（虚线框） */
      emptyKey: "role_select_chip_empty",
    },
    /** 行动按钮（330 宽，居中摆在左栏） */
    cta: {
      /** 按钮中心 x（330 宽按钮的左边缘 = 左栏左边缘） */
      centerX: -739,
      enter: {
        name: "begin_game_button",
        textKey: "role_select_enter",
        position: new Vec2(-739, -95),
        size: new Size(330, 54),
        fontSize: T.fontSize.f18,
      },
      back: {
        name: "back_to_login_button",
        textKey: "role_select_back",
        position: new Vec2(-739, -153),
        size: new Size(330, 42),
        fontSize: T.fontSize.f13,
        /** 返回箭头（Graphics 画）与文字之间的间距 */
        arrowGap: T.spacing.sp4,
        arrowWidth: 15,
      },
    },
  },

  /**
   * 中间：选中角色的立绘（帧动画）+ 底光 + 脚下名牌
   *
   * 立绘贴内容区底部往上 96；底光用几圈同心圆叠出径向渐变（Graphics 没有 gradient），
   * 环与名牌都在立绘脚底附近，随选中角色一起显隐。
   */
  stageChar: {
    name: "role_stage_char",
    position: new Vec2(10, 12),
    /** 命中区尺寸（帧图集 800×800，角色本体约 216×372 → 放大 1.9 倍约 410×707，正好撑满中部栏） */
    size: new Size(760, 800),
    scale: 1.9,
    /** 底光：圈数 / 外半径 / 颜色 / 每圈 alpha（由外向里叠） */
    glow: { position: new Vec2(10, -74), rings: 7, radius: 260, color: T.gold[3], alpha: 14 },
    /** 脚下环（两圈细金线，稿件 .ring） */
    ring: { position: new Vec2(10, -404), radius: 96, width: T.border.width, color: T.line[3] },
    /** 脚下名牌：名字 + 等级（胶囊，金边） */
    plate: {
      name: "role_stage_plate",
      position: new Vec2(10, -393),
      size: new Size(220, 34),
      textKey: "label_role_name_plate",
      fontSize: T.fontSize.f13,
      levelFontSize: T.fontSize.f11,
      /** 名字与等级之间的间距（两段各占一半宽度） */
      gap: T.spacing.sp5,
    },
  },

  /**
   * 右侧角色面板（500×920，矢量底板 + 四角铆钉）
   *
   * 头部 56 高（标题 / 数量 / 管理按钮 + 一条分隔线），下面是两列 228×252 的角色卡滚动区：
   * 可用宽 468 = 228×2 + 12，所以一排两张，行距 12；卡片超出视口在滚动区里上下滚。
   */
  roster: {
    name: "role_roster_panel",
    position: new Vec2(654, -24),
    size: new Size(500, 920),
    head: {
      /** 标题（左对齐；文字起点 = 面板左缘 + 18 内边距 = -232，即框心 -112） */
      title: { textKey: "role_select_roster_title", position: new Vec2(-112, 430), size: new Size(240, 24), fontSize: T.fontSize.f16 },
      /** 已建角色数（只报数量，不报上限：上限在服务端，客户端零副本）；紧跟标题后空 10 */
      count: { position: new Vec2(-108, 430), size: new Size(100, 20), fontSize: T.fontSize.f11 },
      /** 管理 / 完成（切换卡片上的删除按钮） */
      manageButton: { name: "manage_role_button", position: new Vec2(196, 430), size: new Size(72, 28), fontSize: T.fontSize.f12 },
      divider: { position: new Vec2(0, 404), size: new Size(500, 1) },
    },
    /** 滚动区：视口在舞台上的绝对位置与尺寸（内容宽 = 视口宽，换行由网格配置决定）；
     *  视口底部给「创建角色」固定按钮让出 64px（按钮不随列表滚动） */
    scroll: {
      name: "role_scroll_view",
      position: new Vec2(654, -18),
      viewSize: new Size(468, 768),
      paddingX: 0,
      paddingY: 0,
    },
    /** 「创建角色」固定按钮：钉在滚动区与面板底缘之间（舞台绝对坐标，同 scroll 口径） */
    createButton: { name: "open_create_role_button", position: new Vec2(654, -443), size: new Size(240, 44), fontSize: T.fontSize.f14 },
    /** 角色卡（单元格）几何：立绘缩略图 + 名字 + 职业/等级 + 选中角标 */
    card: {
      size: new Size(228, 252),
      spacingX: T.spacing.sp6,
      spacingY: T.spacing.sp6,
      /** 立绘缩略（帧动画；与卡片同宽，向上偏出让出底部信息区） */
      /** 立绘缩略：容器尺寸只当命中区（帧图集是 800×800 画布、角色本体约 216×372），缩放取 0.5 让角色落在卡片里 */
      preview: { size: new Size(208, 208), offsetY: 20, scale: 0.5 },
      /** 底部信息区：名字（左对齐）与「职业 · 等级」一行 */
      name: { offsetX: 0, offsetY: -82, size: new Size(204, 24), fontSize: T.fontSize.f16, color: T.text[1] },
      meta: { offsetX: -30, offsetY: -106, size: new Size(130, 18), fontSize: T.fontSize.f11, color: T.text[3], dot: 6, dotGap: T.spacing.sp3 },
      level: { offsetX: 67, offsetY: -106, size: new Size(70, 18), fontSize: T.fontSize.f11, color: T.gold[4] },
      /** 选中角标（左上「已选择」金底深字） */
      badge: { textKey: "role_select_selected_badge", font: T.fontSize.f10, size: new Size(54, 18), offset: new Vec2(-79, 109) },
      /** 管理模式的删除按钮（右上角；朱红主按钮色，与卡片「已选择」角标同排） */
      deleteButton: { size: new Size(84, 34), fontSize: T.fontSize.f12, offset: new Vec2(62, 99) },
    },
  },

  /** 没有角色时右面板的空状态（标题 + 说明 + 建号按钮，替掉卡片网格） */
  empty: {
    name: "role_roster_empty",
    titleTextKey: "role_select_empty_title",
    subTextKey: "role_select_empty_sub",
    buttonTextKey: "role_select_empty_create",
    titlePosition: new Vec2(654, 60),
    subPosition: new Vec2(654, 10),
    buttonPosition: new Vec2(654, -60),
    titleFontSize: T.fontSize.f16,
    subFontSize: T.fontSize.f12,
    buttonSize: new Size(220, 44),
    buttonFontSize: T.fontSize.f14,
    subWidth: 300,
  },

  /** 管理模式提示条（顶部居中，金边胶囊） */
  manageHint: {
    name: "role_manage_hint",
    textKey: "label_role_delete_hint",
    position: new Vec2(0, 452),
    size: new Size(660, 36),
    fontSize: T.fontSize.f12,
  },

  /**
   * 创建角色弹窗（按设计语言重绘：矢量面板 + 金线标题 + **文字选项胶囊**）
   *
   * 原稿的图片标题 / 分组图 / 职业说明图 / 立绘预览全部移除：
   * - 标题与分组用文字（key 见 texts.role_create_*）；
   * - 选项是文字胶囊：性别两颗（男 / 女）、职业三颗（名取 configs/role.occupations 的 name），
   *   选中态 = 面板底 + 金描边 + 亮字（与登录页职业标签同一套两态）；
   * - 创建时不显示动画预览与说明图（无 occupationPreview / occupationDescription）。
   * 选项的枚举 key（SEX / OECCUPATION）与显示名在 RoleSelector.ts 组装，配置只管几何。
   */
  createDialog: {
    name: "create_role_dialog",
    position: new Vec2(0, 0),
    size: new Size(420, 440),
    /** 标题（文字）+ 金色下划线，同登录面板标题口径 */
    title: { textKey: "role_create_title", position: new Vec2(0, 172), size: new Size(300, 30), fontSize: T.fontSize.f20 },
    titleUnderline: { position: new Vec2(0, 152), size: new Size(T.border.titleRuleWidth, T.border.titleRuleHeight) },
    /** 分组小字（左对齐，文字起点 = 面板左缘 + 18 = -192，即框心 -137） */
    genderLabel: { textKey: "role_create_gender_label", position: new Vec2(-137, 126), size: new Size(110, 20), fontSize: T.fontSize.f14 },
    occupationLabel: { textKey: "role_create_occupation_label", position: new Vec2(-137, 44), size: new Size(110, 20), fontSize: T.fontSize.f14 },
    /** 文字选项行：胶囊尺寸 + 行 y + 间距（性别 2 颗 / 职业 3 颗，横排居中） */
    genderOptions: { positionY: 92, pillSize: new Size(96, 36), spacing: 12 },
    occupationOptions: { positionY: 10, pillSize: new Size(86, 36), spacing: 10 },
    /** 名称分组小字 + 输入框（44 高与登录页输入框一致；视觉走 UiHelper.createVectorInputField） */
    nameInputLabel: { textKey: "role_create_name_label", position: new Vec2(-137, -30), size: new Size(110, 20), fontSize: T.fontSize.f14 },
    nameInput: { placeholder: "输入角色名称", position: new Vec2(0, -68), size: new Size(320, 44) },
    /** 底部双按钮：创建（矢量朱红主按钮，默认置灰）/ 取消（ghost，关闭弹窗） */
    createButton: { name: "confirm_create_role_button", position: new Vec2(-88, -160), size: new Size(160, 44), fontSize: T.fontSize.f14 },
    cancelButton: { name: "cancel_create_role_button", position: new Vec2(88, -160), size: new Size(160, 44), fontSize: T.fontSize.f14 },
  },

  /** 帧动画帧率（角色卡缩略与中间立绘共用） */
  previewFrameRate: 8,
  /**
   * 选中态：选中的角色把站立帧换成**展示帧**（show，循环），并在脚底循环播 select_player@0。
   * 两套图集都是 800×800 画布、角色站姿对齐，切换时不会跳位
   */
  selection: {
    /** show 帧动画帧率 */
    showFrameRate: 8,
    /** 脚下选中特效（select_player@0）相对立绘中心的偏移、尺寸与帧率 */
    effect: { offset: new Vec2(0, -180), size: new Size(300, 100), frameRate: 12 },
  },
};
//#endregion

//#region 加载场景

/** 加载界面布局（#1059 对齐 design/olua-ui/screens/03-loading：环形进度 + 底部通栏细线 + 四阶段刻度） */
export const loadingLayout = {
  /** 背景：与登录 / 选角同一张黄昏沙城（设计稿 03 用的就是它，压暗后当场景底） */
  background: uiImages.loginBackground,
  /**
   * 中央环形进度：外圈断续刻度（缓慢旋转）+ 一圈底色轨 + 一段金色进度弧
   *
   * 半径 / 线宽 / 刻度数量都在这里；角度从 12 点方向顺时针走（-90 度起）。
   * 环心偏上一点（y=40），给下方的阶段说明留位置。
   */
  ring: {
    center: new Vec2(0, 40),
    /** 进度弧半径与线宽（设计稿 r=130 / 3px；底色轨 2px 紧随其内） */
    radius: 130,
    barWidth: 3,
    trackWidth: 2,
    trackColor: T.line[2],
    /** 进度弧颜色（亮金） */
    barColor: T.gold[4],
    /** 外圈刻度：段数、每段独自占的角度步长、刻度内 / 外半径、颜色、一转时长（毫秒） */
    ticks: { count: 60, stepDeg: 6, inner: 148, outer: 154, color: T.line[3], rotateMs: 26000 },
  },
  /** 中央百分比（大数字 + 小的 % 号）与下方的阶段说明 */
  percent: { position: new Vec2(0, 52), fontSize: T.fontSize.f56, color: T.gold[5], unitText: "%", unitSize: T.fontSize.f18, unitColor: T.gold[2] },
  phase: {
    /** 阶段名（衬线味的大字）与它下面的明细行 */
    title: { position: new Vec2(0, -50), size: new Size(560, 24), fontSize: T.fontSize.f16, color: T.text[1] },
    detail: { position: new Vec2(0, -78), size: new Size(720, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  },
  /**
   * 底部通栏细线进度（设计稿 .pbar：左右各内缩 56，2px 高，金线填充 + 末端一颗亮点）
   * 宽度 = 1920 - 2×56 = 1808；位置在屏幕底往上 68（刻度行在它下面 18）
   */
  bar: {
    name: "loading_bar",
    position: new Vec2(0, -472),
    width: 1808,
    height: 2,
    trackColor: T.line[2],
    fillColor: T.gold[4],
    /** 末端亮点（直径） */
    knobSize: 8,
    /** 四阶段刻度：文案 key + 该阶段结束时的进度百分比（走完即算「已完成」） */
    steps: [
      { textKey: "progress_config", until: 10 },
      { textKey: "progress_stage_scene", until: 50 },
      { textKey: "progress_frames_short", until: 100 },
      { textKey: "progress_world", until: 100 },
    ],
    stepsPositionY: -500,
    stepFontSize: T.fontSize.f11,
    /** 阶段圆点直径 / 未完成色 / 已完成色 / 进行中色 */
    stepDot: 5,
    stepIdleColor: T.text[4],
    stepDoneColor: T.gold[3],
    stepNowColor: T.gold[5],
  },
  /** 进度文字（屏幕下方居中，与环形百分比同源；失败时显示失败文案） */
  progress: { text: "加载中 0%", position: new Vec2(0, -430), fontSize: T.fontSize.f12, color: T.text[3] },
  /**
   * 运营配置拉不到时的失败面板（#604）：面板 + 标题 + 明细 + 重试
   *
   * 面板用通用矢量弹窗底板（configs/layout/dialogs.dialogFrame.panel），
   * 明细一行红字 + 自动换行，重试是主行动档按钮。
   */
  failure: {
    panel: { name: "loading_failure_panel", position: new Vec2(0, 40), size: new Size(720, 300) },
    title: { position: new Vec2(0, 104), size: new Size(600, 30), fontSize: T.fontSize.f24, color: T.ember[4], textKey: "progress_failed_title" },
    detailPosition: new Vec2(0, 40),
    detailWidth: 620,
    detailFontSize: T.fontSize.f13,
    detailColor: T.ember.note, // #F0B4A2 朱底上的说明字
    retryPosition: new Vec2(0, -84),
    retrySize: new Size(160, 44),
  },
};

//#endregion

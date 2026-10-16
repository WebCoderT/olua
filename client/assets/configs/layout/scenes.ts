import { Color, Size, Vec2 } from "cc";
import { uiImages } from "./images";

/**
 * 场景界面（登录 / 选角 / 加载）的布局与用图
 *
 * 坐标系：场景内元素坐标以「舞台中心」为原点（= 屏幕中心）。登录与选角都采用同一套
 * 「舞台」适配：全部元素挂在舞台容器下按设计坐标摆放，运行时把整块舞台按可见尺寸
 * 等比缩放（contain、只缩不放，见 ui/utils/layout/ScreenLayout.getStageScale），
 * 于是任意窗口宽高比下构图都完整可见；背景图不在舞台内（铺满可见区，始终盖住窗口）
 */

//#region 登录场景

/** 登录界面布局 */
export const loginLayout = {
  /**
   * 舞台尺寸：登录构图的包围盒加少量余量（最宽元素 600；纵向范围 -373 ~ 350）
   * 竖屏设计分辨率（750×1624）下缩放系数恰为 1（不缩放），元素坐标改动过大时这里要同步
   */
  stageSize: new Size(680, 750),
  background: uiImages.loginBackground,
  /** 账号输入框 */
  account: { placeholder: "请输入您的游戏账号", position: new Vec2(0, -20), size: new Size(600, 80), icon: uiImages.loginAccountIcon, password: false },
  /** 密码输入框 */
  password: { placeholder: "请输入您的游戏密码", position: new Vec2(0, -120), size: new Size(600, 80), icon: uiImages.loginPasswordIcon, password: true },
  /** 登录按钮 */
  loginButton: {
    name: "login_button",
    image: uiImages.loginButton,
    text: "账号登录",
    position: new Vec2(0, -260),
    size: new Size(300, 80),
    textColor: new Color("#f4fc00"),
    fontSize: 30,
  },
  /** 注册按钮（与登录共用上方的账号/密码输入框；账号唯一性与格式由服务端校验） */
  registerButton: {
    name: "register_button",
    image: uiImages.middleButtonBackground,
    text: "注册账号",
    position: new Vec2(0, -345),
    size: new Size(240, 56),
    textColor: new Color("#f4fc00"),
    fontSize: 24,
  },
  /** 顶部 logo */
  logo: { name: "game_logo", image: uiImages.gameLogo, position: new Vec2(0, 200), size: new Size(600, 300) },
};

//#endregion

//#region 选角场景

/**
 * 选角界面布局（主视图 + 创建角色弹窗）
 *
 * 坐标为「舞台」坐标系（原点在舞台中心）：所有元素挂在舞台容器下，
 * 由 RoleSelector.applyStageLayout 按当前可见尺寸把整块舞台等比缩放后再居中
 * （舞台 = 按本文件坐标摆好的完整构图，缩放算法见 ui/utils/layout/ScreenLayout.getStageScale）。
 * 于是新增元素只需按这张「设计尺寸的画布」摆坐标，不必关心窗口宽高比；
 * 背景图不在舞台内（铺满可见区，始终盖住窗口，见 RoleSelector.createBackground）
 */
export const roleSelectorLayout = {
  /**
   * 舞台尺寸（= 竖屏设计分辨率 750×1624，见 ScreenLayout.designResolution；改分辨率时两处同步）
   *
   * 2026-10-15 由横屏 1624×750 **转成竖屏**：舞台就是这张「设计画布」，
   * 所有元素必须落在画布内（|x| ≤ 375、|y| ≤ 812），否则 contain 缩放也救不回来
   * （元素越界 = 恒在屏外）。下面各元素的坐标即按竖屏重排的第一版：
   * 顶部是操作按钮与管理提示条，中部横排三个角色站位，下中是选中信息框，创建弹窗落在下方。
   * 回归见 client/tools/test-scene-stage.cjs（10 种窗口尺寸下逐个断言元素在屏内）
   */
  stageSize: new Size(750, 1624),
  background: uiImages.roleSelectorBackground,
  /**
   * 底部栏（开始游戏按钮所在容器）：**不在舞台内** —— 素材是带「开始游戏」牌匾装饰的整图，
   * 不能拉伸变形，只能等比缩放；作为「框」它要横跨整个可见宽并贴屏幕底边，
   * 位置/缩放由 RoleSelector.applyStageLayout 按当前可见尺寸实时算（舞台缩放救不了这两件事：
   * 跟着舞台缩会两侧露背景，且舞台下沿不贴屏幕底边）。
   * 素材原始 1624×139，竖屏可见宽 ≤ 750 → 缩放系数 ≤ 0.46、视觉高度只有 ~64px
   */
  bottomBar: { name: "role_selector_bottom_bar", image: uiImages.roleSelectorBottomBar, size: new Size(1624, 139) },
  /**
   * 开始游戏按钮（默认置灰，选中角色后可用）。
   * 竖屏下底部栏整体缩到 0.46，按钮若跟着缩只剩 ~22px 高、点不着 ——
   * applyStageLayout 会把它的缩放**反向补偿**回设计尺寸（190×48，恒大于缩后的牌匾，
   * 恰好整块盖住牌匾上的「开始游戏」槽位），并居中在底栏（缩后的底栏只剩 ~64px 高，
   * 原本偏下的按钮槽与中心的偏差可忽略）。位置因此固定在底栏中心
   */
  beginGameButton: { name: "begin_game_button", image: uiImages.roleSelectorStartButton, position: new Vec2(0, 0), size: new Size(190, 48) },
  /** 创建角色按钮 / 管理角色按钮 / 创建弹窗返回按钮（竖屏：贴着左边缘竖排在上部） */
  createRoleButton: { name: "show_create_role_button", image: uiImages.roleSelectorNewRoleButton, position: new Vec2(-320, 640), size: new Size(75, 79) },
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-320, 520), size: new Size(75, 79) },
  backButton: { name: "cancel_create_role_button", image: uiImages.roleSelectorBackButton, position: new Vec2(-320, -560), size: new Size(75, 79) },
  /** 选中角色信息框（名称 + 等级；竖屏：横排在角色站位下方居中） */
  selectedInfo: {
    name: "selected_role_info_background",
    image: uiImages.roleSelectorIdleInfo,
    position: new Vec2(0, -210),
    size: new Size(345, 26),
    nameLabel: { name: "selected_role_name", text: "---", position: new Vec2(-35, 0), size: new Size(160, 30), fontSize: 20 },
    levelLabel: { name: "selected_role_level", text: "-", position: new Vec2(147, 0), size: new Size(40, 30), fontSize: 16 },
  },
  /**
   * 已有角色预览：站位（最多 3 个，按角色顺序）、预览尺寸、站立帧动画帧率（每秒帧数）
   *
   * 竖屏下一排三个（3 × 200 = 600 < 750），保留原来「略错落」的站姿；y 的错落沿用旧值风格
   */
  rolePositions: [new Vec2(-210, 100), new Vec2(0, 40), new Vec2(210, 70)],
  previewSize: new Size(200, 360),
  previewFrameRate: 8,
  /**
   * 管理角色（删除）：点「管理」按钮进入管理模式后，每个角色站位上方出现一个删除按钮
   *
   * 删除按钮挂在**舞台**上（不在角色预览子树里）——预览自己带 TOUCH_END 选中事件，
   * 按钮若挂它下面，点删除会连带触发选中（事件冒泡）；按钮另有一层好处是位置由站位 + 偏移推导，
   * 角色数量变化时跟着重建即可。文案见 configs/texts（label_role_delete / label_role_delete_confirm）
   */
  manageRole: {
    /** 删除按钮相对角色站位的位置偏移（放角色头顶上方，避免与预览主体重叠） */
    deleteButtonOffset: new Vec2(0, 215),
    /** 删除按钮尺寸与字号 */
    deleteButtonSize: new Size(96, 40),
    deleteButtonFontSize: 18,
    /** 待确认状态的超时（毫秒）：到点自动复位，免得「确认删除」一直挂着被误点（与背包回收同一套两步确认口径） */
    confirmTimeout: 3000,
    /** 管理模式的提示条（舞台顶部居中；文字见 configs/texts.label_role_delete_hint） */
    hint: { name: "role_manage_hint", position: new Vec2(0, 300), size: new Size(700, 40), fontSize: 22, color: new Color("#FFD700") },
  },
  /** 创建角色弹窗（竖屏：落在角色站位下方，不遮住站位；职业预览挂在它左侧，见 occupationPreview） */
  createDialog: {
    name: "create_role_dialog",
    image: uiImages.createRoleDialogBackground,
    position: new Vec2(95, -430),
    size: new Size(320, 580),
    title: { name: "create_role_dialog_title", image: uiImages.createRoleTitleLabel, position: new Vec2(0, 242), size: new Size(128, 28) },
    genderLabel: { name: "gender_label", image: uiImages.createRoleGenderLabel, position: new Vec2(0, 190), size: new Size(56, 25) },
    occupationLabel: { name: "occupation_label", image: uiImages.createRoleOccupationLabel, position: new Vec2(0, 100), size: new Size(56, 25) },
    /** 性别 / 职业开关组（横向容器：位置、间距、单个开关尺寸） */
    sexToggle: { position: new Vec2(0, 148), spacing: 30, toggleSize: new Size(48, 48) },
    occupationToggle: { position: new Vec2(0, 52), spacing: 30, toggleSize: new Size(48, 48) },
    /** 名称输入框 */
    nameInput: { placeholder: "输入角色名称", position: new Vec2(0, -26), size: new Size(240, 60) },
    /** 创建按钮（默认置灰，输入名称后可用） */
    createButton: { name: "confirm_create_role_button", image: uiImages.roleSelectorStartButton, position: new Vec2(0, -238), size: new Size(190, 48) },
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

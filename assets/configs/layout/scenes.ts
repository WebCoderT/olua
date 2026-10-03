import { Color, Size, Vec2 } from "cc";
import { uiImages } from "./images";

/**
 * 场景界面（登录 / 选角 / 加载）的布局与用图
 *
 * 坐标系：场景内元素坐标以屏幕中心为原点（进入场景时已应用铺满窗口的适配策略，
 * 见 ui/utils/layout/ScreenLayout.applyScreenPolicy）
 */

//#region 登录场景

/** 登录界面布局 */
export const loginLayout = {
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
  /** 顶部 logo */
  logo: { name: "game_logo", image: uiImages.gameLogo, position: new Vec2(0, 200), size: new Size(600, 300) },
};

//#endregion

//#region 选角场景

/** 选角界面布局（主视图 + 创建角色弹窗，坐标为屏幕中心系） */
export const roleSelectorLayout = {
  background: uiImages.roleSelectorBackground,
  /** 底部栏（开始游戏按钮所在容器） */
  bottomBar: { name: "role_selector_bottom_bar", image: uiImages.roleSelectorBottomBar, position: new Vec2(0, -305), size: new Size(1624, 139) },
  /** 开始游戏按钮（默认置灰，选中角色后可用） */
  beginGameButton: { name: "begin_game_button", image: uiImages.roleSelectorStartButton, position: new Vec2(0, -40), size: new Size(190, 48) },
  /** 创建角色按钮 / 管理角色按钮 / 创建弹窗返回按钮 */
  createRoleButton: { name: "show_create_role_button", image: uiImages.roleSelectorNewRoleButton, position: new Vec2(-740, 300), size: new Size(75, 79) },
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-740, 200), size: new Size(75, 79) },
  backButton: { name: "cancel_create_role_button", image: uiImages.roleSelectorBackButton, position: new Vec2(-740, -210), size: new Size(75, 79) },
  /** 选中角色信息框（名称 + 等级） */
  selectedInfo: {
    name: "selected_role_info_background",
    image: uiImages.roleSelectorIdleInfo,
    position: new Vec2(-435, -335),
    size: new Size(345, 26),
    nameLabel: { name: "selected_role_name", text: "---", position: new Vec2(-35, 0), size: new Size(160, 30), fontSize: 20 },
    levelLabel: { name: "selected_role_level", text: "-", position: new Vec2(147, 0), size: new Size(40, 30), fontSize: 16 },
  },
  /** 已有角色预览：站位（最多 3 个，按角色顺序）、预览尺寸、站立帧动画帧率（每秒帧数） */
  rolePositions: [new Vec2(-485, -25), new Vec2(-250, -75), new Vec2(-10, -40)],
  previewSize: new Size(200, 360),
  previewFrameRate: 8,
  /** 创建角色弹窗 */
  createDialog: {
    name: "create_role_dialog",
    image: uiImages.createRoleDialogBackground,
    position: new Vec2(630, 35),
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

import { Color, Size, Vec2 } from "cc";
import { uiImages } from "./images";

/**
 * 场景界面（登录 / 选角 / 加载）的布局与用图
 *
 * 坐标系：场景内元素坐标以「舞台中心」为原点（= 屏幕中心）。登录与选角都采用同一套
 * 「舞台」适配：全部元素挂在舞台容器下按设计坐标摆放，运行时把整块舞台按可见尺寸
 * 等比缩放（contain、只缩不放，见 ui/utils/layout/ScreenLayout.getStageScale），
 * 于是任意窗口宽高比下构图都完整可见；背景图不在舞台内（铺满可见区，始终盖住窗口）。
 *
 * 2026-10-19 按 design/*.png 设计稿重排（issue #143）：设计稿是竖屏 652×1160（9:16），
 * 坐标映射 ≈ 纵向 1.4 倍（812 - 1.4×dy）、横向 1.4×dx - 81.5（两侧超出 750 的部分裁掉，
 * 贴边元素向内收进安全区）。设计稿自带的烘焙按钮已从背景图里修掉（见
 * client/tools/gen-ui-assets.py），活动 UI 摆在哪都不受底图约束
 */

//#region 登录场景

/** 登录界面布局（对应 design/login.png） */
export const loginLayout = {
  /** 舞台尺寸 = 竖屏设计分辨率（750×1624，见 ScreenLayout.designResolution） */
  stageSize: new Size(750, 1624),
  background: uiImages.loginBackground,
  /**
   * 选服条（装饰 + 入口）：暗板金边 + 左侧红宝石（都烘在 server_bar 一张图里），
   * 服务器名与「选服」用 Label 叠加 —— 名字换服只改文案，不动图
   */
  serverBar: {
    name: "login_server_bar",
    image: uiImages.loginServerBar,
    position: new Vec2(0, -323),
    size: new Size(479, 63),
    serverName: { name: "login_server_name", text: "打金1服", position: new Vec2(-80, 0), size: new Size(220, 40), fontSize: 26, color: new Color("#F2E4C8") },
    selectServer: { name: "login_server_select", text: "选服", position: new Vec2(155, 0), size: new Size(100, 40), fontSize: 28, color: new Color("#4FD25C") },
  },
  /**
   * 本机账号（只读展示，替代原来的账号输入框）
   *
   * 账号由本机自动生成（见 ui/utils/net/DeviceAccount），玩家不需要输入；亮出来只是让人认得出
   * 这台设备用的是哪个号（找客服/后台查存档都靠它）。文本由 Login.renderAccount 填，不在这里写死。
   */
  account: { name: "login_device_account", position: new Vec2(0, -404), size: new Size(560, 40), fontSize: 24, color: new Color("#F2E4C8") },
  /** 自动登录说明（原密码输入框位置）：讲清楚「为什么没有输入框、账号存在哪」 */
  autoHint: { name: "login_auto_hint", position: new Vec2(0, -452), size: new Size(600, 32), fontSize: 20, color: new Color("#9A8663") },
  /** 进入游戏（金板主按钮，自动登录入口：首次进入会先自动建号） */
  loginButton: {
    name: "login_button",
    image: uiImages.buttonGold,
    text: "进 入 游 戏",
    position: new Vec2(0, -570),
    size: new Size(335, 100),
    textColor: new Color("#FFFFFF"),
    fontSize: 42,
  },
  /**
   * 右上角功能圆钮列（公告 / 协议 / 隐私协议 / 清除缓存）：
   * 球体是生成的 corner_button，文字用 Label 叠在球心（4 字以内都放得下）；
   * action 是分发键（见 Login.onCornerButtonClick），代码里不出现中文判断
   */
  cornerButtonSize: new Size(88, 88),
  cornerButtons: [
    { label: "公告", action: "announcement", position: new Vec2(300, 619) },
    { label: "协议", action: "terms", position: new Vec2(300, 475) },
    { label: "隐私协议", action: "privacy", position: new Vec2(300, 330) },
    { label: "清除缓存", action: "clear_cache", position: new Vec2(300, 186) },
  ],
  cornerButtonLabel: { size: new Size(100, 30), fontSize: 18, color: new Color("#ECD28A") },
};

//#endregion

//#region 选角场景

/**
 * 选角界面布局（对应 design/role_selector.png：主视图 + 创建角色弹窗）
 *
 * 坐标为「舞台」坐标系（原点在舞台中心）：所有元素挂在舞台容器下，
 * 由 RoleSelector.applyStageLayout 按当前可见尺寸把整块舞台等比缩放后再居中。
 * 新增元素只需按这张「设计尺寸的画布」摆坐标，不必关心窗口宽高比；
 * 背景图不在舞台内（铺满可见区，始终盖住窗口，见 RoleSelector.start）
 */
export const roleSelectorLayout = {
  /** 舞台尺寸 = 竖屏设计分辨率（750×1624，见 ScreenLayout.designResolution；改分辨率时两处同步） */
  stageSize: new Size(750, 1624),
  background: uiImages.roleSelectorBackground,
  /** 左上按钮列：创建角色 / 管理角色（竖排）。返回按钮平时隐藏，进入创建弹窗时顶替管理钮的位置（见 RoleSelector） */
  createRoleButton: { name: "show_create_role_button", image: uiImages.roleSelectorNewRoleButton, position: new Vec2(-300, 680), size: new Size(96, 96) },
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-300, 560), size: new Size(96, 96) },
  backButton: { name: "cancel_create_role_button", image: uiImages.roleSelectorBackButton, position: new Vec2(-300, 560), size: new Size(96, 96) },
  /** 右侧职业菱形钮（设计稿样式：方钮旋转 45°）：点击 = 打开创建弹窗并预选该职业 */
  occupationShortcuts: {
    size: new Size(96, 96),
    rotation: 45,
    items: [
      { occupation: "zhan", image: uiImages.occupationToggle.zhan.off, position: new Vec2(290, 603) },
      { occupation: "fa", image: uiImages.occupationToggle.fa.off, position: new Vec2(290, 417) },
      { occupation: "dao", image: uiImages.occupationToggle.dao.off, position: new Vec2(290, 231) },
    ],
  },
  /** 选中角色名牌（生成的暗板金边名牌，名称与等级用 Label 叠加） */
  selectedInfo: {
    name: "selected_role_plate",
    image: uiImages.namePlate,
    position: new Vec2(-60, -452),
    size: new Size(400, 64),
    nameLabel: { name: "selected_role_name", text: "---", position: new Vec2(-50, 0), size: new Size(200, 32), fontSize: 26, color: new Color("#F2E4C8") },
    levelLabel: { name: "selected_role_level", text: "-", position: new Vec2(110, 0), size: new Size(80, 28), fontSize: 22, color: new Color("#E8C56A") },
  },
  /** 骰子钮（名牌右侧）：掷一个随机角色名，填进创建弹窗的名称输入框（弹窗没开就先打开） */
  diceButton: { name: "random_name_dice", image: uiImages.dice, position: new Vec2(240, -452), size: new Size(90, 90) },
  /** 随机名素材（骰子用）：姓 + 名各随机取一段拼接 */
  nameParts: {
    surnames: ["萧", "林", "叶", "秦", "陆", "苏", "顾", "沈", "楚", "慕容", "上官", "夜"],
    givens: ["辰", "惊鸿", "无衣", "归尘", "长歌", "清歌", "北辰", "昭雪", "拂衣", "听澜", "折剑", "凌霄"],
  },
  /**
   * 已有角色预览：站位（最多 3 个，按角色顺序）、预览尺寸、站立帧动画帧率（每秒帧数）
   *
   * 横排三个摆在主视觉（背景立绘）脚下、名牌上方，不遮名牌与金按钮
   */
  rolePositions: [new Vec2(-170, -180), new Vec2(0, -180), new Vec2(170, -180)],
  previewSize: new Size(150, 270),
  previewFrameRate: 8,
  /** 进入游戏（金板主按钮，默认置灰，选中角色后可用；不在底栏里 —— 竖屏版没有底栏） */
  beginGameButton: {
    name: "begin_game_button",
    image: uiImages.buttonGold,
    text: "进 入 游 戏",
    position: new Vec2(0, -607),
    size: new Size(372, 100),
    textColor: new Color("#FFFFFF"),
    fontSize: 42,
  },
  /**
   * 管理角色（删除）：点「管理」按钮进入管理模式后，每个角色站位上方出现一个删除按钮
   *
   * 删除按钮挂在**舞台**上（不在角色预览子树里）——预览自己带 TOUCH_END 选中事件，
   * 按钮若挂它下面，点删除会连带触发选中（事件冒泡）；按钮另有一层好处是位置由站位 + 偏移推导，
   * 角色数量变化时跟着重建即可。文案见 configs/texts（label_role_delete / label_role_delete_confirm）
   */
  manageRole: {
    /** 删除按钮相对角色站位的位置偏移（放角色头顶上方，避免与预览主体重叠） */
    deleteButtonOffset: new Vec2(0, 165),
    /** 删除按钮尺寸与字号 */
    deleteButtonSize: new Size(96, 40),
    deleteButtonFontSize: 18,
    /** 待确认状态的超时（毫秒）：到点自动复位，免得「确认删除」一直挂着被误点（与背包回收同一套两步确认口径） */
    confirmTimeout: 3000,
    /** 管理模式的提示条（舞台顶部居中；文字见 configs/texts.label_role_delete_hint） */
    hint: { name: "role_manage_hint", position: new Vec2(0, 740), size: new Size(700, 40), fontSize: 22, color: new Color("#FFD700") },
  },
  /** 创建角色弹窗（竖排居中偏下，不遮右侧职业钮与左上按钮列；内部摆设沿用原版） */
  createDialog: {
    name: "create_role_dialog",
    image: uiImages.createRoleDialogBackground,
    position: new Vec2(0, -100),
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
    createButton: { name: "confirm_create_role_button", image: uiImages.buttonGold, position: new Vec2(0, -238), size: new Size(190, 48), text: "创 建", textColor: new Color("#FFFFFF"), fontSize: 22 },
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

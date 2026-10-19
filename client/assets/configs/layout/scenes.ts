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
 * 选角界面布局（对应 design/role_selector.png）
 *
 * **单角色**（issue #149）：一个账号只有一个角色。
 * - 没有角色 = 创建态：右侧选职业、右侧下方选性别、中间跟着切换的大号站立动画、
 *   名字输入在「创建角色」按钮下方，点一次即建号并进游戏；
 * - 已有角色 = 游戏态：只留大动画 + 名牌 + 「进入游戏」，职业/性别/名字输入全部隐藏。
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
  /** 左上「管理」按钮（只在有角色时显示：进去后角色头顶出现删除按钮，删掉回到创建态） */
  manageRoleButton: { name: "manage_role_button", image: uiImages.roleSelectorManageButton, position: new Vec2(-300, 680), size: new Size(96, 96) },
  /**
   * 右侧职业选择（3 个菱形钮 = 方钮转 45°，与设计稿一致）：
   * 点击即选中（on 图），中间的大预览立刻换成该职业 —— 没有「确认」，选择本身就是结果
   */
  occupationPicks: {
    size: new Size(96, 96),
    rotation: 45,
    items: [
      { occupation: "1", on: uiImages.occupationToggle.zhan.on, off: uiImages.occupationToggle.zhan.off, position: new Vec2(290, 603) },
      { occupation: "2", on: uiImages.occupationToggle.fa.on, off: uiImages.occupationToggle.fa.off, position: new Vec2(290, 417) },
      { occupation: "3", on: uiImages.occupationToggle.dao.on, off: uiImages.occupationToggle.dao.off, position: new Vec2(290, 231) },
    ],
  },
  /** 右侧下方性别选择（男 / 女）：同样点一下即选中，预览随之切换 */
  sexPicks: {
    size: new Size(76, 76),
    items: [
      { sex: "1", on: uiImages.sexToggle.boy.on, off: uiImages.sexToggle.boy.off, position: new Vec2(290, 45) },
      { sex: "2", on: uiImages.sexToggle.girl.on, off: uiImages.sexToggle.girl.off, position: new Vec2(290, -60) },
    ],
  },
  /**
   * 角色站位（**单角色，只有一个**）：中间的大号站立动画
   *
   * 位置对齐设计稿的底座面：动画角色站在底座上（脚 ≈ 舞台 y -330），
   * 头顶到 y ≈ 230，删除按钮（站位 + 320 偏移）正好悬在头顶上方。
   * 这个数组同时也是「界面容量」——服务端 `ROLE_MAX_PER_ACCOUNT` 不得超过它的长度
   * （守卫见 tools/audit-shared-data.cjs）。现在容量是 1，业务上限也是 1。
   */
  rolePositions: [new Vec2(0, -50)],
  /** 预览容器尺寸（仅用于布局断言与命中范围；实际视觉大小 = 帧原始尺寸 × previewScale） */
  previewSize: new Size(320, 576),
  /** 大预览倍率：帧画布 800×800、角色本体约 216×372，×1.5 后视觉约 324×558，正好填满中间 */
  previewScale: 1.5,
  previewFrameRate: 8,
  /** 选中角色名牌（生成的暗板金边名牌，名称与等级用 Label 叠加） */
  selectedInfo: {
    name: "selected_role_plate",
    image: uiImages.namePlate,
    position: new Vec2(-60, -452),
    size: new Size(400, 64),
    nameLabel: { name: "selected_role_name", text: "---", position: new Vec2(-50, 0), size: new Size(200, 32), fontSize: 26, color: new Color("#F2E4C8") },
    levelLabel: { name: "selected_role_level", text: "-", position: new Vec2(110, 0), size: new Size(80, 28), fontSize: 22, color: new Color("#E8C56A") },
  },
  /** 名字输入框（进入游戏按钮**下方**；只在创建态显示，已有角色时不出现） */
  nameInput: { placeholder: "输入角色名", position: new Vec2(-10, -700), size: new Size(360, 70) },
  /** 骰子钮（名字输入框右侧）：掷一个随机角色名填进输入框 */
  diceButton: { name: "random_name_dice", image: uiImages.dice, position: new Vec2(250, -700), size: new Size(76, 76) },
  /** 随机名素材（骰子用）：姓 + 名各随机取一段拼接 */
  nameParts: {
    surnames: ["萧", "林", "叶", "秦", "陆", "苏", "顾", "沈", "楚", "慕容", "上官", "夜"],
    givens: ["辰", "惊鸿", "无衣", "归尘", "长歌", "清歌", "北辰", "昭雪", "拂衣", "听澜", "折剑", "凌霄"],
  },
  /**
   * 主按钮：创建态文案「创 建 角 色」、游戏态「进 入 游 戏」（由 RoleSelector 按状态改 Label）
   * 不在底栏里 —— 竖屏版没有底栏
   */
  beginGameButton: {
    name: "begin_game_button",
    image: uiImages.buttonGold,
    text: "进 入 游 戏",
    createText: "创 建 角 色",
    position: new Vec2(0, -607),
    size: new Size(372, 100),
    textColor: new Color("#FFFFFF"),
    fontSize: 42,
  },
  /**
   * 管理角色（删除）：点「管理」按钮进入管理模式后，角色头顶出现一个删除按钮
   *
   * 删除按钮挂在**舞台**上（不在角色预览子树里）——预览自带点击事件，按钮挂它下面会被冒泡吞掉。
   * 文案见 configs/texts（label_role_delete / label_role_delete_confirm / label_role_delete_hint）
   */
  manageRole: {
    /** 删除按钮相对角色站位的位置偏移（放角色头顶上方，避免与预览主体重叠） */
    deleteButtonOffset: new Vec2(0, 320),
    /** 删除按钮尺寸与字号 */
    deleteButtonSize: new Size(96, 40),
    deleteButtonFontSize: 18,
    /** 待确认状态的超时（毫秒）：到点自动复位，免得「确认删除」一直挂着被误点（与背包回收同一套两步确认口径） */
    confirmTimeout: 3000,
    /** 管理模式的提示条（舞台顶部居中；文字见 configs/texts.label_role_delete_hint） */
    hint: { name: "role_manage_hint", position: new Vec2(0, 740), size: new Size(700, 40), fontSize: 22, color: new Color("#FFD700") },
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

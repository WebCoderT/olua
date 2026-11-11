/**
 * 图片与字体地址的唯一来源
 *
 * 约定：
 * - 资源按 resources 下的文件夹收敛成取图函数（uiCommon / uiHud / ...），
 *   同一文件夹里的图统一走对应那一个函数按名字取，不在各处拼字符串
 * - 界面里 eui 用到的具体图统一登记在 uiImages，代码里**不允许再出现裸路径字符串**
 *   （如 "ui/common/bg"、"ui/create-role/bg-dialog"），换图只改这里
 * - 玩法数据自带的图标（装备/技能/怪物/NPC/状态等）属于各自配置表的数据字段，
 *   由服务端快照下发（见 configs/game-config.ts），不往这里搬
 *
 * 目录口径见 client/RESOURCES.md：**界面零件全部收在 ui/ 下**，实体（monster / npc /
 * item / equipment / title / soul / wing…）与特效（effect/）按域平铺，方便一眼找到。
 */

//#region 取图函数（resources 下的文件夹 → 按名字取图）

/** resources/ui/common：通用框、底图、血条底/填充、格子、圆点等 */
export const uiCommon = (name: string) => `ui/common/${name}`;
/** resources/ui/hud：主界面 HUD（摇杆、挂机开关、头顶血条、飘字数字等） */
export const uiHud = (name: string) => `ui/hud/${name}`;
/** resources/ui/money：货币与 VIP 图标 */
export const uiMoney = (name: string) => `ui/money/${name}`;
/** resources/ui/nav：底部功能按键图标与底图 */
export const uiNav = (name: string) => `ui/nav/${name}`;
/** resources/ui/minimap：小地图整套资源（底图/名称条/线路/排行榜/坐标条/功能入口图标） */
export const uiMinimap = (name: string) => `ui/minimap/${name}`;
/** resources/ui/tips：屏幕中间的提示图集（plist + png） */
export const uiTips = (name: string) => `ui/tips/${name}`;
/** resources/ui/button：按钮背景 */
export const uiButton = (name: string) => `ui/button/${name}`;
/** resources/ui/login：登录界面资源 */
export const uiLogin = (name: string) => `ui/login/${name}`;
/** resources/ui/loading：加载界面资源 */
export const uiLoading = (name: string) => `ui/loading/${name}`;
/** resources/ui/dialog：通用弹窗背景的九宫拆块（见 dialogs.dialogFrame.background 的切线依据） */
export const uiDialog = (name: string) => `ui/dialog/${name}`;
/** resources/ui/mall：商城界面资源（背景图） */
export const uiMall = (name: string) => `ui/mall/${name}`;
/** resources/ui/create-role：选角 / 创建角色界面资源（预览图集在 preview/ 下） */
export const uiCreateRole = (name: string) => `ui/create-role/${name}`;
/** resources/effect：特效图集（border / background / light / skill / status / aura / select / upgrade） */
export const effectImage = (name: string) => `effect/${name}`;
/** resources/map/<地图id>/preview：地图预览图（小地图弹窗底图，每个地图文件夹下一张） */
export const mapPreviewImage = (id: string) => `map/${id}/preview`;
/** resources/ui/avatar：角色头像（按「职业-性别」取图） */
export const avatarImage = (occupation: string, sex: string) => `ui/avatar/${occupation}-${sex}`;
/** 选角界面的角色站立帧动画图集（按「职业-性别」取图；未选中时循环播放） */
export const createRolePreviewImage = (occupation: string, sex: string) => uiCreateRole(`preview/${occupation}-${sex}-stand@0`);
/** 选角界面的角色展示帧动画图集（按「职业-性别」取图；选中时循环播放，与站立图集同一块 800×800 画布，切换不位移） */
export const createRoleShowImage = (occupation: string, sex: string) => uiCreateRole(`preview/${occupation}-${sex}-show@0`);
/**
 * 选中光标图集：**角色选中与怪物选中放在一起**（`effect/select/`），
 * 一个 `player@0`（选角界面脚下一圈地面光标）、一个 `monster@0`（地图上点中的怪）
 */
export const effectSelectImage = (name: string) => effectImage(`select/${name}`);
/** 选角界面的「已选中」脚下特效图集（effect/select/player@0：一圈地面光标） */
export const roleSelectEffectImage = effectSelectImage("player@0");

//#endregion

//#region 具名图片表（全部由上面的取图函数生成）

export const uiImages = {
  // ---------------- 通用 ----------------
  /** 默认字体（Label 未指定字体时使用） */
  defaultFont: "font/msyh",
  /** 通用弹窗背景 · 九宫拆块（头行/角块原样摆放，中列/中行拉伸；拼装见 GameUiHelper.createDialogPanel） */
  dialogHeaderLeft: uiDialog("popup-header-left"),
  dialogHeaderCenter: uiDialog("popup-header-center"),
  dialogHeaderRight: uiDialog("popup-header-right"),
  dialogBodyLeft: uiDialog("popup-body-left"),
  dialogBodyCenter: uiDialog("popup-body-center"),
  dialogBodyRight: uiDialog("popup-body-right"),
  dialogFooterLeft: uiDialog("popup-footer-left"),
  dialogFooterCenter: uiDialog("popup-footer-center"),
  dialogFooterRight: uiDialog("popup-footer-right"),
  /** 通用关闭按钮 */
  closeButton: uiCommon("close-button"),
  /** 物品详情弹窗背景 */
  goodDetailBackground: uiCommon("bg"),
  /** 小圆点（说明性图标） */
  dot: uiCommon("dot"),
  /** 背包格底图 */
  bagSlotGrid: uiCommon("grid"),
  /** 游戏 logo（resources 根目录） */
  gameLogo: "logo",
  /** 界面特效：升级/强化 */
  upgradeEffect: effectImage("upgrade"),

  // ---------------- 角色信息栏 ----------------
  /** 信息栏背景框 */
  roleInfoBackground: uiCommon("user-info-frame"),
  /** 战斗力图标 */
  combatIcon: uiCommon("combat"),
  /** 绑定元宝（唯一货币） */
  bindGold: uiMoney("bind-gold"),

  // ---------------- 底部栏 ----------------
  /** 底部栏背景 */
  bottomBarBackground: uiNav("bg"),
  /** 经验条填充 */
  expBarFill: uiNav("exp"),
  /** 通用血条：底图 / 填充 */
  hpBarBackground: uiCommon("bg-gray"),
  hpBarFill: uiCommon("bg-white"),
  /** 圆形血球：底图 / 血量填充 */
  hpOrbBase: uiCommon("max"),
  hpOrbFill: uiCommon("hp"),
  /** 圆形魔法球填充（hp 图的蓝色转色副本：红球直接染蓝色会发黑，故离线转色生成） */
  mpOrbFill: uiCommon("mp"),
  /** 挂机开关图标（关=收剑 / 开=举剑） */
  autoFightOff: uiHud("auto-fight-close"),
  autoFightOn: uiHud("auto-fight-open"),
  /** 操作摇杆：底座底图 / 可拖动手柄 */
  joystickBackground: uiHud("joystick-bg"),
  joystickHandle: uiHud("joystick"),

  // ---------------- 怪物信息面板 ----------------
  /** 面板背景 */
  monsterInfoBackground: uiCommon("monster-bg"),

  // ---------------- 屏幕中间的提示 ----------------
  /** 自动战斗提示图集（自动战斗中 / 自动寻路中） */
  autoAttackTip: uiTips("auto-attack@0"),
  autoPathTip: uiTips("auto-path@0"),

  // ---------------- 小地图 ----------------
  /** 底图（暂为空图占位） / 名称条 / 线路 / 排行榜 / 坐标条 */
  smallMapFrame: uiMinimap("map-frame"),
  smallMapNameBar: uiMinimap("map-name-bar"),
  smallMapServerLine: uiMinimap("server-line"),
  smallMapRankingList: uiMinimap("ranking-list"),
  smallMapPosition: uiMinimap("position"),

  // ---------------- 按钮背景（大/中/小） ----------------
  bigButtonBackground: uiButton("big"),
  middleButtonBackground: uiButton("middle"),
  /** 中按钮·红色（危险操作，如删除角色） */
  middleRedButtonBackground: uiButton("middle-red"),
  smallButtonBackground: uiButton("small"),

  // ---------------- 角色信息弹窗 ----------------
  /** 装饰背景（含内观区与属性区底图） */
  roleInfoDialogBackground: uiCommon("personal-information-bg"),

  // ---------------- 登录界面 ----------------
  loginBackground: uiLogin("bg"),
  loginInputBackground: uiLogin("input-bg"),
  loginAccountIcon: uiLogin("icon-account"),
  loginPasswordIcon: uiLogin("icon-password"),
  loginButton: uiLogin("button"),

  // ---------------- 选角 / 创建角色界面 ----------------
  roleSelectorBackground: uiCreateRole("bg"),
  roleSelectorBottomBar: uiCreateRole("bg-bottom"),
  roleSelectorStartButton: uiCreateRole("start-button"),
  roleSelectorNewRoleButton: uiCreateRole("new-role"),
  roleSelectorManageButton: uiCreateRole("manage"),
  roleSelectorIdleInfo: uiCreateRole("idle-info"),
  roleSelectorBackButton: uiCreateRole("back-button"),
  createRoleDialogBackground: uiCreateRole("bg-dialog"),
  createRoleTitleLabel: uiCreateRole("label-title"),
  createRoleGenderLabel: uiCreateRole("label-gender"),
  createRoleOccupationLabel: uiCreateRole("label-class"),
  /** 创建角色弹窗的开关：性别 男/女、职业 战/法/道（on = 选中图、off = 未选中图） */
  sexToggle: {
    boy: { on: uiCreateRole("sex-boy-on"), off: uiCreateRole("sex-boy-off") },
    girl: { on: uiCreateRole("sex-girl-on"), off: uiCreateRole("sex-girl-off") },
  },
  occupationToggle: {
    zhan: { on: uiCreateRole("class-warrior-on"), off: uiCreateRole("class-warrior-off") },
    fa: { on: uiCreateRole("class-mage-on"), off: uiCreateRole("class-mage-off") },
    dao: { on: uiCreateRole("class-taoist-on"), off: uiCreateRole("class-taoist-off") },
  },

  // ---------------- 加载界面 ----------------
  loadingBackground: uiLoading("loading-bg"),
  /** 底部进度条：底图 + 填充图（填充图按进度横向 FILLED 裁切） */
  loadingProgressBackground: uiLoading("progress-bg"),
  loadingProgressFill: uiLoading("progress-content"),
  /** 居中的加载帧动画图集（loading@0.plist，7 帧循环） */
  loadingAnimationAtlas: uiLoading("loading@0"),

  // ---------------- 商城 ----------------
  /** 商城弹窗背景（resources/ui/mall/bg，门面样式底图，商品列表摆它的橱窗开口里） */
  mallBackground: uiMall("bg"),
};

//#endregion

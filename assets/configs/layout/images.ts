/**
 * 图片与字体地址的唯一来源
 *
 * 约定：
 * - 资源按 resources 下的文件夹收敛成取图函数（commonImage / loginImage / ...），
 *   同一文件夹里的图统一走对应那一个函数按名字取，不在各处拼字符串
 * - 界面里 eui 用到的具体图统一登记在 uiImages，代码里**不允许再出现裸路径字符串**
 *   （如 "common/popup-bg"、"create_role/bg_dialog"），换图只改这里
 * - 玩法数据自带的图标（装备/技能/怪物/NPC/状态等）属于各自配置表的数据字段，
 *   仍写在 configs/{equipments,skill,monster,npc,status}.ts 里，不往这里搬
 */

//#region 取图函数（resources 下的文件夹 → 按名字取图）

/** resources/common：通用框、底图、血条底/填充等 */
export const commonImage = (name: string) => `common/${name}`;
/** resources/main：主界面按钮等 */
export const mainImage = (name: string) => `main/${name}`;
/** resources/money：货币与 VIP 图标 */
export const moneyImage = (name: string) => `money/${name}`;
/** resources/bottom-nav-bar：底部功能按键图标与底图 */
export const bottomNavImage = (name: string) => `bottom-nav-bar/${name}`;
/** resources/small-map：小地图整套资源（底图/名称条/线路/排行榜/坐标条/功能入口图标） */
export const smallMapImage = (name: string) => `small-map/${name}`;
/** resources/tips：屏幕中间的提示图集（plist + png） */
export const tipsImage = (name: string) => `tips/${name}`;
/** resources/buttons：按钮背景 */
export const buttonImage = (name: string) => `buttons/${name}`;
/** resources/login：登录界面资源 */
export const loginImage = (name: string) => `login/${name}`;
/** resources/loading：加载界面资源 */
export const loadingImage = (name: string) => `loading/${name}`;
/** resources/create_role：选角 / 创建角色界面资源 */
export const createRoleImage = (name: string) => `create_role/${name}`;
/** resources/effect：界面特效图 */
export const effectImage = (name: string) => `effect/${name}`;
/** resources/avatars：角色头像（按「职业-性别」取图） */
export const avatarImage = (occupation: string, sex: string) => `avatars/${occupation}-${sex}`;
/** 选角界面的角色站立帧动画图集（按「职业-性别」取图） */
export const createRolePreviewImage = (occupation: string, sex: string) => createRoleImage(`plist/create_role_${occupation}_${sex}_stand@0`);

//#endregion

//#region 具名图片表（全部由上面的取图函数生成）

export const uiImages = {
  // ---------------- 通用 ----------------
  /** 默认字体（Label 未指定字体时使用） */
  defaultFont: "fonts/msyh",
  /** 通用弹窗背景 */
  dialogBackground: commonImage("popup-bg"),
  /** 通用关闭按钮 */
  closeButton: commonImage("close-button"),
  /** 物品详情弹窗背景 */
  goodDetailBackground: commonImage("bg"),
  /** 小圆点（说明性图标） */
  dot: commonImage("dot"),
  /** 背包格底图 */
  bagSlotGrid: commonImage("grid"),
  /** 游戏 logo（resources 根目录） */
  gameLogo: "logo",
  /** 界面特效：升级/强化 */
  upgradeEffect: effectImage("upgrade"),

  // ---------------- 角色信息栏 ----------------
  /** 信息栏背景框 */
  roleInfoBackground: commonImage("user-info-frame"),
  /** 战斗力图标 */
  combatIcon: commonImage("combat"),
  /** 战斗力数字图集字体 */
  combatFont: "fonts/combat",
  /** 金币 / 绑定金币 / 银币 */
  gold: moneyImage("gold"),
  bindGold: moneyImage("bind-gold"),
  silver: moneyImage("silver"),

  // ---------------- 底部栏 ----------------
  /** 底部栏背景 */
  bottomBarBackground: bottomNavImage("bg"),
  /** 经验条填充 */
  expBarFill: bottomNavImage("exp"),
  /** 通用血条：底图 / 填充 */
  hpBarBackground: commonImage("bg_gray"),
  hpBarFill: commonImage("bg_white"),
  /** 圆形血球：底图 / 血量填充 */
  hpOrbBase: commonImage("max"),
  hpOrbFill: commonImage("hp"),
  /** 圆形魔法球填充（hp 图的蓝色转色副本：红球直接染蓝色会发黑，故离线转色生成） */
  mpOrbFill: commonImage("mp"),
  /** 挂机开关图标（关=收剑 / 开=举剑） */
  autoFightOff: mainImage("auto_fight_close"),
  autoFightOn: mainImage("auto_fight_open"),

  // ---------------- 怪物信息面板 ----------------
  /** 面板背景 */
  monsterInfoBackground: commonImage("monster_bg"),

  // ---------------- 屏幕中间的提示 ----------------
  /** 自动战斗提示图集（自动战斗中 / 自动寻路中） */
  autoAttackTip: tipsImage("auto_attack@0"),
  autoPathTip: tipsImage("auto_path@0"),

  // ---------------- 小地图 ----------------
  /** 底图（暂为空图占位） / 名称条 / 线路 / 排行榜 / 坐标条 */
  smallMapFrame: smallMapImage("map-frame"),
  smallMapNameBar: smallMapImage("map-name-bar"),
  smallMapServerLine: smallMapImage("server-line"),
  smallMapRankingList: smallMapImage("ranking-list"),
  smallMapPosition: smallMapImage("position"),

  // ---------------- 按钮背景（大/中/小） ----------------
  bigButtonBackground: buttonImage("big"),
  middleButtonBackground: buttonImage("middle"),
  smallButtonBackground: buttonImage("small"),

  // ---------------- 角色信息弹窗 ----------------
  /** 装饰背景（含内观区与属性区底图） */
  roleInfoDialogBackground: commonImage("personal-information-bg"),

  // ---------------- 登录界面 ----------------
  loginBackground: loginImage("login_bg"),
  loginInputBackground: loginImage("input_bg"),
  loginAccountIcon: loginImage("icon_user"),
  loginPasswordIcon: loginImage("icon_pwd"),
  loginButton: loginImage("button"),

  // ---------------- 选角 / 创建角色界面 ----------------
  roleSelectorBackground: createRoleImage("bg"),
  roleSelectorBottomBar: createRoleImage("bg_bottom"),
  roleSelectorStartButton: createRoleImage("start_btn"),
  roleSelectorNewRoleButton: createRoleImage("new_role"),
  roleSelectorManageButton: createRoleImage("manage"),
  roleSelectorIdleInfo: createRoleImage("idlv"),
  roleSelectorBackButton: createRoleImage("back_btn"),
  createRoleDialogBackground: createRoleImage("bg_dialog"),
  createRoleTitleLabel: createRoleImage("label_title"),
  createRoleGenderLabel: createRoleImage("label_1"),
  createRoleOccupationLabel: createRoleImage("label_2"),
  /** 创建角色弹窗的开关：性别 男/女、职业 战/法/道（on = 选中图、off = 未选中图） */
  sexToggle: {
    boy: { on: createRoleImage("1_1"), off: createRoleImage("1_0") },
    girl: { on: createRoleImage("2_1"), off: createRoleImage("2_0") },
  },
  occupationToggle: {
    zhan: { on: createRoleImage("3_1"), off: createRoleImage("3_0") },
    fa: { on: createRoleImage("4_1"), off: createRoleImage("4_0") },
    dao: { on: createRoleImage("5_1"), off: createRoleImage("5_0") },
  },

  // ---------------- 加载界面 ----------------
  loadingBackground: loadingImage("loading_bg"),
};

//#endregion

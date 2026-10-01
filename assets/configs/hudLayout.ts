import { Color, Size, Vec2 } from "cc";

/**
 * 全局 UI（常驻 HUD）的布局与图片来源集中配置
 * 所有常驻界面元素的位置、尺寸、图片来源统一写在这里，组件与 GameUiHelper 只引用、不硬编码：
 * - 位置/尺寸：每块的坐标系见各自注释（组件自身坐标以屏幕中心为原点，子件坐标以所在容器中心为原点）
 * - 图片来源：资源按 resources 下的文件夹收敛成取图函数（commonImage / bottomNavImage / ...），
 *   同一个文件夹里的图统一走对应那一个函数按名字取，不再各处拼字符串
 * 范围：角色信息栏、底部栏（功能按键区/经验条/血量/快捷键栏/挂机开关）、小地图、怪物信息面板、
 * 屏幕中间的浮动提示与自动战斗提示；弹窗等临时界面仍由各自组件管理
 */

//#region 图片来源（resources 下的文件夹 → 取图函数）

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
/** resources/avatars：角色头像（按「职业-性别」取图） */
export const avatarImage = (occupation: string, sex: string) => `avatars/${occupation}-${sex}`;

/** 全局 UI 用到的具体图片（全部由上面的取图函数生成，换图只改这里） */
export const hudImages = {
  /** 角色信息栏背景框 */
  roleInfoBackground: commonImage("user-info-frame"),
  /** 战斗力图标与其数字图集字体 */
  combatIcon: commonImage("combat"),
  combatFont: "fonts/combat",
  /** 金币 / 绑定金币 / 银币 */
  gold: moneyImage("gold"),
  bindGold: moneyImage("bind-gold"),
  silver: moneyImage("silver"),
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
  /** 怪物信息面板背景 */
  monsterInfoBackground: commonImage("monster_bg"),
  /** 挂机开关图标（关=收剑 / 开=举剑） */
  autoFightOff: mainImage("auto_fight_close"),
  autoFightOn: mainImage("auto_fight_open"),
  /** 自动战斗提示图集（自动战斗中 / 自动寻路中） */
  autoAttackTip: tipsImage("auto_attack@0"),
  autoPathTip: tipsImage("auto_path@0"),
  /** 小地图：底图（暂为空图占位） / 名称条 / 线路 / 排行榜 / 坐标条 */
  smallMapFrame: smallMapImage("map-frame"),
  smallMapNameBar: smallMapImage("map-name-bar"),
  smallMapServerLine: smallMapImage("server-line"),
  smallMapRankingList: smallMapImage("ranking-list"),
  smallMapPosition: smallMapImage("position"),
};

//#endregion

//#region 角色信息栏（左上角常驻）

/** 角色信息栏布局（坐标以信息栏中心为原点） */
export const roleInfoBarLayout = {
  /** 信息栏自身尺寸 */
  size: new Size(300, 70),
  /** 自己固定在左上角 */
  selfPosition: new Vec2(-648, 324),
  /** 其他玩家（屏幕中心） */
  otherPosition: new Vec2(0, 0),
  /** 背景框尺寸（与原图一致） */
  backgroundSize: new Size(300, 70),
  /** 名称（左对齐） */
  name: { position: new Vec2(17, -20), size: new Size(190, 20), fontSize: 14 },
  /** 等级 */
  level: { position: new Vec2(-138, -17.5), size: new Size(24, 24), fontSize: 16 },
  /** 头像（按职业/性别取图） */
  portrait: { position: new Vec2(-109.5, 7.5), size: new Size(51, 60) },
  /** 三种货币（同一个横向布局容器，子件均分容器宽度且内部左对齐） */
  currencyBar: { position: new Vec2(20, 24), size: new Size(200, 14), spacing: 0 },
  /** 战斗力（图标尺寸；数值文本紧随图标右边缘，间隔 labelGap） */
  combat: { position: new Vec2(-38, 1), iconSize: new Size(60, 30), labelGap: 3 },
  /** 状态图标条（头像正下方，横向布局；图标来源为 configs/status 各状态的 icon） */
  statusBar: { position: new Vec2(-100, -46), size: new Size(220, 24), spacing: 4, iconSize: new Size(24, 24) },
};

//#endregion

//#region 底部栏（底部常驻容器）

/** 底部栏布局（自身坐标以屏幕中心为原点，子件坐标以底部栏中心为原点） */
export const bottomBarLayout = {
  /** 底部栏主体 */
  size: new Size(1100, 210),
  position: new Vec2(0, -324),
  /** 功能按键区（横向布局容器，按钮排列交给 Layout） */
  navBar: { spacing: 6, position: new Vec2(153.5, -10), size: new Size(400, 40) },
  /** 单个功能按键：图标尺寸 + 右下角快捷键名 */
  navButton: {
    size: new Size(40, 40),
    key: { position: new Vec2(15, -15), size: new Size(20, 20), fontSize: 10 },
  },
  /** 经验条 */
  expBar: { position: new Vec2(0, -44.5), size: new Size(724, 8) },
  /** 血量文字 */
  hpText: { position: new Vec2(-421, -39), size: new Size(120, 10), fontSize: 12 },
  /** 圆形血球（底图与填充同尺寸，竖向进度） */
  hpOrb: { position: new Vec2(-420, 12.5), size: new Size(90, 90) },
  /** 魔法值文字（与血量文字同款式，镜像到底部栏右侧） */
  mpText: { position: new Vec2(421, -39), size: new Size(120, 10), fontSize: 12 },
  /** 圆形魔法球（与血球同款式同尺寸，镜像到底部栏右侧） */
  mpOrb: { position: new Vec2(420, 12.5), size: new Size(90, 90) },
  /** 快捷键栏（横向布局容器，6 格 = 6×40 + 5×6 = 270；居中在血球与功能按键区之间的空档） */
  shortcutBar: { spacing: 6, position: new Vec2(-210, -9), size: new Size(270, 40) },
  /** 单个快捷键槽：图标尺寸 + 右下角按键名 + 居中冷却倒计时 */
  shortcutSlot: {
    size: new Size(40, 40),
    key: { position: new Vec2(20, -15), size: new Size(20, 10), fontSize: 10 },
    cooldown: { position: new Vec2(0, 0), size: new Size(40, 20), fontSize: 16 },
  },
  /** 自动挂机开关（底部栏中段空档，图标下方带文字） */
  autoFight: {
    size: new Size(44, 44),
    position: new Vec2(-338, 62),
    label: { text: "挂机", position: new Vec2(0, -14), size: new Size(44, 12), fontSize: 10 },
  },
};

//#endregion

//#region 小地图（右上角常驻）

/**
 * 小地图布局
 * 组件主体坐标以屏幕中心为原点；其余子件坐标以「地图内容区中心」为原点
 * （功能入口按钮列贴地图内容区左侧，名称条贴内容区上方，线路/排行榜贴内容区下方）
 */
export const smallMapLayout = {
  /** 组件主体（尺寸需容纳整块内容，位置贴屏幕右上角） */
  size: new Size(280, 250),
  position: new Vec2(665, 238),
  /** 功能入口图标：单列竖排，图标资源即 names 里的名字（small-map 目录） */
  entryIcons: ["world", "achievement", "mail", "config", "sound", "屏蔽 副本"],
  entryIconSize: 28,
  entryIconGap: 6,
  /** 按钮列的位置 */
  entryColumnPosition: new Vec2(-130, -10),
  /** 地图内容区底图（暂为空图占位，其中心即子件坐标原点） */
  mapFrameSize: new Size(232, 211),
  /** 地图内容区的可绘制区域（黑点/红点画在这里） */
  contentSize: new Size(200, 180),
  /** 地图名称条（贴在内容区正上方） */
  nameBar: { position: new Vec2(0, 106), size: new Size(272, 43), fontSize: 14, color: new Color(255, 223, 170) },
  /** 线路 / 排行榜标签行（横向布局容器，排行榜在左、线路在右） */
  tagRow: { position: new Vec2(0, -112), size: new Size(85, 24), gap: 0 },
  /** 世界坐标条 */
  positionBar: { position: new Vec2(0, -88), size: new Size(115, 21), fontSize: 12 },
};

//#endregion

//#region 怪物信息面板（屏幕上方，选中怪物时显示）

/** 怪物信息面板布局（坐标以面板中心为原点） */
export const monsterInfoPanelLayout = {
  size: new Size(238, 71),
  position: new Vec2(0, 330),
  /** 左侧头像（取怪物图标） */
  avatar: { position: new Vec2(-75, 0), size: new Size(60, 66) },
  /** 名称（左对齐） */
  name: { position: new Vec2(26, 17.5), size: new Size(135, 16), fontSize: 14 },
  /** 血量条与血量文字 */
  hpBar: { position: new Vec2(29.5, 1.7), size: new Size(140, 12) },
  hpText: { position: new Vec2(-1, -18), size: new Size(80, 12), fontSize: 12 },
  /** 技能行（未配置技能则不渲染） */
  skillRow: { position: new Vec2(65, -18), slotSize: 20, spacing: 4 },
};

//#endregion

//#region 屏幕中间的提示

/** 浮动提示（消息/错误）：居中显示后上浮淡出 */
export const tipsLayout = {
  size: new Size(300, 20),
  fontSize: 12,
  /** 上浮目标位置（纵坐标）与上浮时长（秒） */
  risePositionY: 40,
  messageMoveDuration: 0.5,
  errorMoveDuration: 0.3,
  /** 淡出时长（秒） */
  messageFadeDuration: 3,
  errorFadeDuration: 1.5,
  messageColor: Color.GREEN,
  errorColor: Color.RED,
  /** 自动战斗提示图集动画：节点自定义尺寸（图集源画布等比缩放到该尺寸）、每秒帧数、两个提示同显时寻路提示向下让位的偏移（像素） */
  autoTipSize: new Size(500, 500),
  autoTipFrameRate: 20,
  autoTipPathOffsetY: -100,
};

//#endregion

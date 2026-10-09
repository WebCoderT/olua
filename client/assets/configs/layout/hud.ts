import { Color, Size, Vec2 } from "cc";
import { roleBody } from "../role";

/**
 * 常驻 HUD 与游戏内固定表现元素的布局
 *
 * 位置/尺寸的坐标系见各自注释：组件自身坐标以屏幕中心为原点，子件坐标以所在容器中心为原点
 * 常驻 HUD 四区域（左上角色信息栏 / 右上小地图 / 底部栏 / 左下操作摇杆）不写死坐标，
 * 而是按「贴哪条边 + 边距」由当前可见尺寸实时算出（计算见 ui/utils/layout/ScreenLayout）
 *
 * 图片来源见 configs/layout/images（uiImages）；公共尺寸见 configs/layout/sizes（uiSize）
 */

//#region 贴边布局（常驻 HUD 四区域）

/**
 * 常驻 HUD 区块的贴边方式
 * 区块位置不再写死坐标，而是按「贴哪条边 + 边距」由当前可见尺寸实时算出
 * （计算见 ui/utils/layout/ScreenLayout.getAnchoredPosition，窗口尺寸变化时会重排）
 */
export interface HudAnchor {
  /** 贴哪条边（左上 / 右上 / 左下 / 底部居中） */
  edge: "top-left" | "top-right" | "bottom-left" | "bottom-center";
  /** 水平边距：区块边缘到屏幕左/右边缘的距离（bottom-center 忽略，恒居中） */
  marginX: number;
  /** 垂直边距：top-* 为区块上边缘到屏幕上边缘；bottom-left 为区块下边缘到屏幕下边缘；bottom-center 为区块中心到屏幕下边缘 */
  marginY: number;
}

//#endregion

//#region 角色信息栏（左上角常驻）

/** 角色信息栏布局（坐标以信息栏中心为原点） */
export const roleInfoBarLayout = {
  /** 信息栏自身尺寸 */
  size: new Size(300, 70),
  /** 自己固定在左上角（贴边方式与边距：按可见尺寸实时计算位置） */
  anchor: { edge: "top-left", marginX: 19, marginY: 16 } as HudAnchor,
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
  /** 状态图标条（首个图标中心对齐头像中心、向右排开，横向布局；图标来源为 configs/status 各状态的 icon） */
  statusBar: { position: new Vec2(-109.5, -46), size: new Size(220, 24), spacing: 4, iconSize: new Size(24, 24) },
};

//#endregion

//#region 底部栏（底部常驻容器）

/** 底部栏布局（自身坐标以屏幕中心为原点，子件坐标以底部栏中心为原点） */
export const bottomBarLayout = {
  /** 底部栏主体 */
  size: new Size(1100, 210),
  /** 贴屏幕底部居中（marginY = 主体中心到屏幕下边缘的距离；背景下沿本就溢出屏幕，故按中心定位） */
  anchor: { edge: "bottom-center", marginX: 0, marginY: 51 } as HudAnchor,
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
  shortcutBar: { spacing: 6, position: new Vec2(-224.7, -9), size: new Size(270, 40) },
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

//#region 操作摇杆（左下角常驻）

/**
 * 操作摇杆布局（自身坐标以屏幕中心为原点，子件坐标以摇杆中心为原点）
 *
 * 结构：底座（背景图）+ 手柄（可拖动手柄，拖动位移被夹在 radius 之内）。
 * 「拖得少 = 走路、拖得多 = 跑动」的判定见 components/input/RoleJoystickInput，
 * 两个阈值是**占 radius 的比例**（configs/role.joystickMove）——
 * 所以 radius 同时是手感的分母，调它要一并复核那两个阈值。
 */
export const joystickLayout = {
  /** 摇杆主体（= 底座底图尺寸，同时也是按下时的命中范围） */
  size: new Size(175, 172),
  /** 贴屏幕左下角（边距为区块边缘到屏幕左/下边缘的距离） */
  anchor: { edge: "bottom-left", marginX: 24, marginY: 18 } as HudAnchor,
  /** 手柄显示尺寸（素材 98×99 略缩，给拖动留出空间） */
  handleSize: new Size(72, 73),
  /** 手柄中心可离底座中心的最大距离（拖动幅度按它归一化；取值使手柄贴到最外圈时恰好不溢出底座） */
  radius: 48,
};

//#endregion

//#region 小地图（右上角常驻）

/**
 * 小地图布局
 * 组件主体坐标以屏幕中心为原点；其余子件坐标以「地图内容区中心」为原点
 * （功能入口按钮列贴地图内容区左侧，名称条贴内容区上方，线路/排行榜贴内容区下方）
 */
export const smallMapLayout = {
  /** 组件主体（尺寸需容纳整块内容，位置贴屏幕右上角——按可见尺寸实时计算） */
  size: new Size(280, 250),
  /** 贴屏幕右上角（边距为区块边缘到屏幕上/右边缘的距离） */
  anchor: { edge: "top-right", marginX: 2, marginY: 12 } as HudAnchor,
  /** 功能入口图标：单列竖排，图标资源即 names 里的名字（small-map 目录） */
  entryIcons: ["world", "achievement", "mail", "config", "sound", "屏蔽 副本"],
  /** 哪个入口开公告板（其余入口仍是占位），以及它的未读红点（有未读公告才显示） */
  announcementEntry: "mail",
  announcementDot: { position: new Vec2(9, 9), size: new Size(9, 9) },
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

//#region 地面掉落物（世界内，挂在掉落点上）

/**
 * 地面掉落物布局（子件坐标以掉落物节点中心为原点；节点锚点即图标中心）
 *
 * 名称行由若干「段」横向拼成（拼装见 ui/helpers/GameUiHelper.createDropItem）：
 * 装备 = 前缀 + 名称 + 后缀 三段着色，其余物品单行白字，可叠加物品再追加「x{数量}」段。
 * 装备的段文案与配色**与详情弹窗同源**（同走 configs/equipments.getEquipmentNameParts）——
 * 即前缀/名称用前缀色、后缀用后缀色，两处永远一致，不各写一份色表。
 */
export const dropItemLayout = {
  /** 图标默认尺寸 */
  iconSize: new Size(40, 40),
  /** 节点高度 = 图标高度 + 该值（下方多出的空间留给名称行） */
  nodeExtraHeight: 14,
  /** 图标相对节点中心的纵向偏移（= nodeExtraHeight / 2：图标偏上、名称落在下方） */
  iconOffsetY: 7,
  /** 名称行：位置相对图标下沿再往下偏 offsetY；字号 / 行高 / 各段之间的横向间距 */
  name: {
    offsetY: 3,
    fontSize: 10,
    lineHeight: 12,
    spacing: 2,
  },
  /** 非装备物品的名称颜色（装备按前后缀着色，见 configs/equipments 的两张配色表） */
  nameColor: Color.WHITE,
  /** 数量段颜色（可叠加物品的「x{数量}」） */
  countColor: Color.WHITE,
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

//#region 角色身上的挂件（世界内，坐标随角色、不参与屏幕适配）

/**
 * 主角身上的挂件布局（子件坐标以主角节点原点为原点：锚点 (0.5, 0)、内容 40×70，原点在脚底）
 */
export const roleShowLayout = {
  /**
   * 角色名称：显示在**人物区域正中间**，与怪物名称同一套口径（见 GameUiHelper.createMonsterName /
   * createRoleName），不进头顶信息栏。纵坐标取 roleBody 高度的一半 = 身体几何中心，
   * 由推导保证「正中间」；roleBody 改尺寸时自动跟随
   */
  name: { position: new Vec2(0, roleBody.size.height / 2), size: new Size(100, 12), fontSize: 10, color: new Color(255, 255, 255) },
  /** 战魂外显（勾选「外显」时挂载，随主角移动；动画帧自带大量透明边距，实际视觉尺寸更小） */
  soul: { position: new Vec2(26, 62), size: new Size(72, 72), scale: { x: 0.1, y: 0.1 } },
/**
 * 称号名牌（解锁后**常显**头顶，无开关；取代头部信息栏里写死的文字称号占位）。
 * 节点直接挂在**头部信息栏容器**里（与军衔红字/血条同一个 FlexCol，见 RoleDisplay.updateTitleShow；
 * 角色名称不在这个容器里 —— 它显示在人物区域正中间，见 roleShowLayout.name）：
 * 位置由该容器的纵向布局自动排列 —— 故这里不配坐标、也不缩放（按素材原始尺寸显示，帧原始 156×91 ~ 256×107）。
 * · siblingIndex：名牌在头部容器里的插入位置（0 = 最上）
 * · size：仅加载首帧前的占位尺寸（RAW 模式，帧到达后会被素材原始尺寸覆盖；进图前已预加载，通常一帧内就换掉）
 */
  title: { siblingIndex: 0, size: new Size(260, 140) },
  /**
   * 军衔红字（头顶信息栏里的一行红字，排在血条之上 —— 即最早那版写死的文字称号占位所在的
   * 位置，见 GameUiHelper.createHead 的子节点顺序）。
   * 军衔没有素材，头顶这份就是它的全部外观：未授衔（rank = 0）时整行清空、不留视觉。
   * 颜色刻意用红：军衔是「杀出来的功名」，与白色的角色名称、白色的血量文字区分开。
   */
  rank: { fontSize: 10, size: new Size(100, 12), color: new Color(255, 60, 60) },
};

//#endregion

import { Color, Size, Vec2 } from "cc";
import { uiImages } from "./images";
import { uiSize } from "./sizes";

/**
 * 各类弹窗的布局与用图
 *
 * 坐标系：弹窗自身坐标以屏幕中心为原点；弹窗内子件坐标以**弹窗中心**为原点
 * （弹窗由 GameUiHelper.createDialog 生成，尺寸即 dialogFrame.size 或本文件各弹窗的 size）
 * 数值直接改这里即可，组件只引用不自带坐标
 */

//#region 通用弹窗框（createDialog 系列零件的缺省几何）

/** 通用弹窗框几何（所有弹窗共用：位置跟随拖动，尺寸可被各弹窗覆盖） */
export const dialogFrame = {
  /** 缺省弹窗尺寸（createDialog 不传尺寸时使用） */
  size: new Size(600, 500),
  /** 标题：距弹窗上边缘的内缩、文本高度、宽度两侧内缩、字号与颜色 */
  title: {
    insetTop: 15,
    height: 30,
    widthPadding: 60,
    fontSize: 14,
    color: new Color("#FF8B8B"),
    /** 独立使用 createDialogTitle 时的缺省位置与文本框尺寸（按缺省弹窗尺寸推得） */
    defaultPosition: new Vec2(0, 228),
    defaultSize: new Size(300, 30),
  },
  /** 关闭按钮：尺寸（公共尺寸，见 sizes.uiSize）+ 距弹窗上/右边缘的内缩 */
  closeButton: { size: uiSize.closeButtonSize, inset: 15 },
  /** 背景图 */
  background: uiImages.dialogBackground,
  /** 关闭按钮图 */
  closeImage: uiImages.closeButton,
};

//#endregion

//#region 战魂弹窗（左中右三栏）

/** 战魂弹窗布局 */
export const warSoulDialogLayout = {
  name: "war_soul_dialog",
  title: "战魂",
  size: new Size(880, 560),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分） */
  list: {
    name: "soul_list",
    position: new Vec2(-320, -5),
    size: new Size(210, 490),
    cardSize: new Size(192, 44),
    cardFontSize: 13,
    stateFontSize: 11,
    /** 卡片文字颜色：选中 / 未激活 / 已激活 */
    selectedColor: new Color(255, 214, 102),
    lockedColor: new Color(140, 140, 140),
    activeColor: new Color(120, 220, 120),
  },
  /** 中：战魂动画（帧率取各等级配置 configs/soul 的 animationFrameRate） */
  animation: { position: new Vec2(0, 30), size: new Size(300, 300) },
  /** 中：名称 / 描述 / 当前战魂 / 外显勾选框（槽位坐标，子件坐标以槽位中心为原点） */
  info: {
    position: new Vec2(0, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: new Color(170, 170, 170) },
    current: { position: new Vec2(0, -22), size: new Size(320, 18), fontSize: 12, color: new Color(255, 223, 170) },
    /** 外显勾选框（勾选后当前等级动画挂到主角右上角，位置见 hud.roleShowLayout.soul） */
    toggle: { position: new Vec2(0, -48), size: new Size(90, 22), fontSize: 13, text: "外显", boxSize: 16, textGap: 18 },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: {
    position: new Vec2(250, 240),
    width: 210,
    spacing: 6,
    fontSize: 12,
    titleColor: new Color(255, 214, 102),
    rowNameColor: new Color(170, 170, 170),
    rowDiffColor: new Color(120, 220, 120),
  },
  /** 右：绑定元宝余额 */
  bindGold: { position: new Vec2(250, -160), size: new Size(200, 16), fontSize: 12 },
  /** 右：升级按钮（满级时文案与置灰） */
  upgradeButton: { position: new Vec2(250, -205), text: "升 级", maxedText: "已满级" },
};

//#endregion

//#region 大陆传送官弹窗

/** 弹窗尺寸为 dialogFrame.size（600×500） */
export const mapTeleportDialogLayout = {
  name: "map_teleport_dialog",
  title: "大陆传送官",
  /** 内容列（纵向容器，高度自适应）：顶部位置与宽度（弹窗 600，左右各留 10） */
  content: { name: "map_teleport_content", width: 580, top: 215, groupSpacing: 16 },
  /** 分组标题 */
  groupTitle: { fontSize: 14, height: 20, color: new Color(255, 214, 102) },
  /** 地图按钮网格：每行 4 个（4 × 123 + 3 × 20 = 552，在 580 容器内水平居中） */
  grid: { spacingX: 20, spacingY: 12 },
};

//#endregion

//#region 小地图弹窗（当前地图的整图预览）

/** 弹窗尺寸为 dialogFrame.size（600×500） */
export const mapPreviewDialogLayout = {
  name: "map_preview_dialog",
  /** 标题兜底文案（正常显示当前地图名，见 SmallMap 传入） */
  title: "小地图",
  /** 预览区：地图 preview.jpg 整图铺满；点击按比例换算成世界坐标（左键寻路 / 右键传送） */
  preview: { name: "map_preview", position: new Vec2(0, -18), size: new Size(560, 392) },
  /** 预览区下方的操作提示 */
  hint: { text: "左键点击自动寻路，右键点击直接传送", position: new Vec2(0, -226), size: new Size(420, 20), fontSize: 14, color: new Color(255, 223, 170) },
  /**
   * 预览图上的静态文字标记（开窗时按地图对象组建一次，随预览图一起移动/缩放）
   * 三类标记：NPC 白点 + 点上方紧挨着的名称、刷怪区中心的怪物名称
   */
  marker: {
    /** 名称文字框尺寸（宽 × 高；宽给足避免名称被截断，各标记居中显示） */
    labelSize: new Size(140, 16),
    /** NPC 白点半径（像素） */
    npcDotRadius: 3,
    /** NPC 白点颜色 */
    npcDotColor: Color.WHITE,
    /** NPC 名称文字颜色与字号 */
    npcLabelColor: new Color(255, 255, 255),
    npcLabelFontSize: 12,
    /** NPC 名称与白点的间距（像素：文字底边到白点边缘的距离） */
    npcLabelGap: 2,
    /** 刷怪区怪物名称文字颜色与字号 */
    monsterLabelColor: new Color(255, 217, 138),
    monsterLabelFontSize: 12,
  },
  /**
   * 预览图上的路线指示线样式（自动寻路期间画出的「角色 → 目标」路线）
   * 白色点状线，单位是预览区像素（与黑点/红点同一坐标系，见 MapPreviewDialog.createPreviewMapper）；
   * 预览区比常驻小地图大得多，故点半径/间距单独配置，不共用 configs/smallMap 的 route*
   */
  route: {
    /** 点与终点圆点的颜色 */
    color: new Color(255, 255, 255, 235),
    /** 单个点半径（像素） */
    dotRadius: 2.5,
    /** 相邻点间距（像素） */
    dotGap: 12,
    /** 终点圆点半径（像素）：比途中的点大一圈 */
    endDotRadius: 7,
  },
};

//#endregion

//#region 角色信息弹窗

/** 弹窗尺寸为 dialogFrame.size（600×500） */
export const roleInfoDialogLayout = {
  name: "role_info_dialog",
  title: "角色信息",
  /** 装饰背景（含属性区底图） */
  background: { image: uiImages.roleInfoDialogBackground, position: new Vec2(-78, -19), size: new Size(431, 452) },
  /** 战斗力图标（贴在装饰背景左下） */
  combatIcon: { image: uiImages.combatIcon, position: new Vec2(-7, -225), size: new Size(100, 50) },
};

//#endregion

//#region 背包弹窗

/**
 * 弹窗尺寸为 dialogFrame.size（600×500）
 * 底部按钮的文案统一见 configs/texts（label_bag_tidy / label_bag_recycle / label_bag_discard…），这里只放几何与超时
 */
export const bagDialogLayout = {
  name: "bag_dialog",
  title: "背包",
  /**
   * 底部三个操作按钮（子件坐标以弹窗中心为原点；背包网格底边在 -167，三钮并排落在网格下方）
   * 中号按钮宽 123（见 sizes.uiSize.middleButtonSize），各错开 140 → 两两间距 17，整体左右各留 98
   */
  tidyButton: { name: "bag_tidy_button", position: new Vec2(-140, -212) },
  /**
   * 「一键回收」：把背包里的装备整格换成绑定元宝（身上穿着的不算）
   * 回收不可撤销，所以按钮是**两步确认**：第一次点击先看数（件数 + 可得绑定元宝）并变成「确认回收」，
   * 再点一次才真的回收；超时或关掉弹窗自动复位（不会误回收，也不需要额外的确认弹窗）
   */
  recycleButton: {
    name: "bag_recycle_button",
    position: new Vec2(0, -212),
    /** 待确认状态保持时间（毫秒），到点自动变回「一键回收」 */
    confirmTimeout: 3000,
  },
  /**
   * 「丢弃」：**开关式**按钮 —— 点一下进入丢弃模式，再点退出（按钮文案随之在「丢弃 / 退出丢弃」间切换）
   *
   * 为什么用模式开关而不是「长按物品」「选中格子 + 确认框」：背包没有选中态，也不新增节点与鼠标监听
   * （确认框盖在弹窗上要处理层级与穿透，见 utils/input 的按压归属）；模式开启后点击目标就是格子本身，最直观。
   * 丢弃不可恢复，所以仍是**两步确认**：第一次点击只报物品名与数量并记住该格，再点同一格才真的丢；
   * 超时、点了别的格子、点整理/回收、关弹窗都会放弃待确认状态
   */
  discardButton: {
    name: "bag_discard_button",
    position: new Vec2(140, -212),
    /** 待确认状态保持时间（毫秒），到点自动放弃（与回收、删除角色同一套口径） */
    confirmTimeout: 3000,
  },
};

//#endregion

//#region 技能列表弹窗

/** 技能列表弹窗布局 */
export const skillListDialogLayout = {
  name: "skill_list_dialog",
  title: "技能",
  size: new Size(280, 400),
  /** 技能滚动列表（子件坐标以弹窗中心为原点） */
  list: { name: "skill_list", position: new Vec2(0, -15), size: new Size(260, 350) },
};

//#endregion

//#region 技能快捷键设置弹窗

/** 技能快捷键设置弹窗布局（尺寸按「快捷键格数」留足：每格 56.5 宽 + 间距 10） */
export const skillShortcutSettingDialogLayout = {
  name: "skill_shortcut_setting_dialog",
  title: "设置快捷键",
  size: new Size(370, 200),
  /** 快捷键选项行（横向布局容器） */
  optionsRow: { name: "shortcut_key_options", spacing: 10, position: new Vec2(), size: new Size(350, 50) },
};

//#endregion

//#region 死亡弹窗（全屏遮罩）

/** 死亡遮罩弹窗布局（自身即全屏节点，坐标为全屏节点中心） */
export const deathDialogLayout = {
  name: "death_dialog",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住世界点击） */
  maskColor: new Color(0, 0, 0, 160),
  /** 标题「您已死亡」 */
  title: { text: "您已死亡", position: new Vec2(0, 90), size: new Size(400, 60), fontSize: 36, color: Color.WHITE },
  /** 两个复活按钮（居中偏下对称排布） */
  reviveInPlaceButton: { name: "revive_in_place_button", text: "原地复活", position: new Vec2(-140, -30) },
  reviveSafeButton: { name: "revive_safe_button", text: "安全复活", position: new Vec2(140, -30) },
};

//#endregion

//#region 物品详情弹窗（鼠标悬停在物品图标上时显示）

/** 物品详情弹窗（跟随鼠标，坐标为屏幕中心系） */
export const goodDetailLayout = {
  name: "good_detail",
  size: new Size(240, 200),
  background: uiImages.goodDetailBackground,
  /** 内容区：纵向网格排版的内边距与行间距（头部 / 基础信息 / 回收价 / 标签 / 介绍依次排） */
  padding: 10,
  rowSpacing: 8,
  /** 头部行间距（图标与名称行） */
  headerSpacing: 10,
  /** 基础信息行（等级与部位）：字号与配色（灰字，弱于正文） */
  info: { fontSize: 12, size: new Size(220, 18), color: new Color("#9A9A9A") },
  /** 回收价行：字号与配色（金色，与绑定元宝呼应） */
  recycle: { fontSize: 12, size: new Size(220, 18), color: new Color("#FFD700") },
  /** 介绍文本 */
  description: { fontSize: 12, size: new Size(220, 50), lineHeight: 16 },
  /** 标题（装备为三段着色，其他物品单行可换行） */
  title: { fontSize: 14, size: new Size(170, 40), lineHeight: 20 },
  /** 装备标签行（占名称下方一整行；标签按字数给宽，避免被截断） */
  tag: {
    rowSize: new Size(220, 18),
    /** 标签文字颜色（与白色正文区分，突出标签） */
    color: new Color(255, 214, 102),
    fontSize: 11,
    /** 标签之间的横向间距 */
    spacing: 6,
    /** 单条标签的最小宽度与左右留白 */
    minWidth: 24,
    paddingX: 8,
  },
  /** 底部装饰 logo（复用游戏 logo 图，尺寸比登录页小一圈） */
  footerLogo: { image: uiImages.gameLogo, size: new Size(220, 120) },
};

//#endregion

//#region 悬停详情弹窗（鼠标悬停在状态图标/技能图标上时显示，见 ui/core/HoverTipManager）

/** 悬停详情弹窗布局（宽度固定，高度由内容自适应；坐标为屏幕中心系） */
export const hoverTipLayout = {
  name: "hover_tip",
  /** 初始尺寸（高度只是占位，Layout 会按内容自适应） */
  size: new Size(240, 40),
  background: uiImages.goodDetailBackground,
  /** 内容区内边距与行间距 */
  padding: 10,
  rowSpacing: 6,
  /** 弹窗与锚点图标的间距（上下两侧通用） */
  anchorGap: 6,
  /** 弹窗距屏幕边缘的最小边距（夹在屏内用） */
  screenMargin: 8,
  /** 标题（名称行，可带图标） */
  title: { fontSize: 14, iconSize: new Size(28, 28) },
  /** 信息行（「名称：值」单行） */
  row: { fontSize: 12, size: new Size(220, 16) },
  /** 描述（自动换行，高度按内容自适应） */
  description: { fontSize: 12, lineHeight: 16, size: new Size(220, 0) },
};

//#endregion

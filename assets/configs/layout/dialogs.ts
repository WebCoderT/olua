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

/** 弹窗尺寸为 dialogFrame.size（600×500） */
export const bagDialogLayout = {
  name: "bag_dialog",
  title: "背包",
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
  /** 底部装饰 logo（复用游戏 logo 图，尺寸比登录页小一圈） */
  footerLogo: { image: uiImages.gameLogo, size: new Size(220, 120) },
};

//#endregion

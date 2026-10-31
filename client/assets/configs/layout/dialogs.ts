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

/**
 * 三栏养成弹窗（战魂 / 称号 / 军衔）的公共几何 —— 一处改、三窗同变
 *
 * 三个弹窗的结构与坐标完全同源（左列表 + 中展示 + 右属性列），差异只在文案、
 * 列表名与中间栏的内容（动画 / 徽记）。数值直接改这里。
 */
const growthCardList = (name: string, extra?: { borderWidth: number }) => ({
  name,
  position: new Vec2(-320, -5),
  size: new Size(210, 490),
  cardSize: new Size(192, 44),
  cardFontSize: 13,
  stateFontSize: 11,
  /** 卡片文字颜色：选中 / 未激活 / 已激活 */
  selectedColor: new Color(255, 214, 102),
  lockedColor: new Color(140, 140, 140),
  activeColor: new Color(120, 220, 120),
  ...extra,
});
const growthAnimation = { position: new Vec2(0, 30), size: new Size(300, 300) };
const growthAttribute = {
  position: new Vec2(250, 240),
  width: 210,
  spacing: 6,
  fontSize: 12,
  titleColor: new Color(255, 214, 102),
  rowNameColor: new Color(170, 170, 170),
  rowDiffColor: new Color(120, 220, 120),
};
const growthBindGold = { position: new Vec2(250, -160), size: new Size(200, 16), fontSize: 12 };

/** 战魂弹窗布局 */
export const warSoulDialogLayout = {
  name: "war_soul_dialog",
  title: "战魂",
  size: new Size(880, 560),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分） */
  list: growthCardList("soul_list"),
  /** 中：战魂动画（帧率取各等级配置 configs/soul 的 animationFrameRate） */
  animation: growthAnimation,
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
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：升级按钮（满级时文案与置灰） */
  upgradeButton: { position: new Vec2(250, -205), text: "升 级", maxedText: "已满级" },
};

//#endregion

//#region 称号升级弹窗

/**
 * 称号升级弹窗布局（三栏结构与战魂弹窗一致，几何坐标直接沿用；入口在角色信息弹窗的「称号」按钮）
 * 差异：称号解锁后**常显**头顶，没有「外显」勾选框
 */
export const titleUpgradeDialogLayout = {
  name: "title_upgrade_dialog",
  title: "称号",
  size: new Size(880, 560),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分；34 个称号与战魂 37 个同容器尺寸） */
  list: growthCardList("title_list"),
  /** 中：称号动画（名牌帧原始宽 156~245，弹窗内按 RAW 原尺寸展示） */
  animation: growthAnimation,
  /** 中：名称 / 描述 / 当前称号（槽位坐标，子件坐标以槽位中心为原点；比战魂少一行——没有外显勾选框） */
  info: {
    position: new Vec2(0, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: new Color(170, 170, 170) },
    current: { position: new Vec2(0, -8), size: new Size(320, 18), fontSize: 12, color: new Color(255, 223, 170) },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：升级按钮（满级时文案与置灰） */
  upgradeButton: { position: new Vec2(250, -205), text: "升 级", maxedText: "已满级" },
};

//#endregion

//#region 军衔进阶弹窗

/**
 * 军衔进阶弹窗布局（三栏结构与称号/战魂弹窗一致，几何坐标直接沿用；入口在角色信息弹窗的「军衔」按钮）
 * 差异：军衔**没有素材动画**，中间那栏是一枚「军衔徽记」（文字牌，见 GameUiHelper.createRankBadge）；
 * 阶数是三条成长线里最多的（100 阶 = 10 大段 × 10 阶），左列表仍用同一套卡片滚动列表。
 */
export const rankUpgradeDialogLayout = {
  name: "rank_upgrade_dialog",
  title: "军衔",
  size: new Size(880, 560),
  /** 左：阶数卡片竖向滚动列表（100 阶从上到下，状态用颜色区分） */
  list: growthCardList("rank_list", { borderWidth: 2 }),
  /** 中：军衔徽记（文字牌：段名 + 红色军衔名 + 阶数进度） */
  badge: {
    position: new Vec2(0, 30),
    size: new Size(320, 210),
    fill: new Color(26, 18, 14, 220),
    borderColor: new Color(255, 214, 102),
    borderWidth: 2,
    /** 段名（如「王爵」） */
    tier: { position: new Vec2(0, 62), size: new Size(290, 22), fontSize: 14, color: new Color(255, 214, 102) },
    /** 军衔名（红字，与头顶那行同一个色） */
    label: { position: new Vec2(0, 4), size: new Size(290, 40), fontSize: 26, color: new Color(255, 60, 60) },
    /** 阶数进度（第 N 阶 / 共 100 阶） */
    progress: { position: new Vec2(0, -56), size: new Size(290, 18), fontSize: 12, color: new Color(170, 170, 170) },
  },
  /** 中：名称 / 描述 / 当前军衔（槽位坐标，子件坐标以槽位中心为原点） */
  info: {
    position: new Vec2(0, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: new Color(170, 170, 170) },
    current: { position: new Vec2(0, -8), size: new Size(320, 18), fontSize: 12, color: new Color(255, 223, 170) },
  },
  /** 右：属性列表（含下一阶增量） */
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：晋升按钮（满衔时文案与置灰） */
  upgradeButton: { position: new Vec2(250, -205), text: "晋 升", maxedText: "已满衔" },
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
  /**
   * 「军衔」「称号」「战魂」三个入口按钮（弹窗右侧竖排相邻三格，几何按中号按钮 123×36 推导）：
   * 称号在右下空区（y -215），战魂紧贴其上一格（-215 + 36 + 10 间距 = -169），
   * 军衔再往上一格（-169 + 36 + 10 = -123）；三者横坐标同为 x 200 → 按钮占 x 138.5~261.5，
   * 与右列装备槽（x 55~105）、底部装备槽（x -160~10）都不相交。
   * 三个系统都走这里，不走 NPC（战魂使者 NPC 仍保留，见 configs/npc）。
   */
  titleButton: { name: "role_title_button", position: new Vec2(200, -215), text: "称 号" },
  soulButton: { name: "role_soul_button", position: new Vec2(200, -169), text: "战 魂" },
  rankButton: { name: "role_rank_button", position: new Vec2(200, -123), text: "军 衔" },
  /** 时装（衣柜）入口，继续往上排一格（-123 + 36 + 10 = -77），四格同列等距 */
  fashionButton: { name: "role_fashion_button", position: new Vec2(200, -77), text: "时 装" },
  /** 社交（帮会 / 好友）入口，再往上排一格（-77 + 36 + 10 = -31），五格同列等距 */
  socialButton: { name: "role_social_button", position: new Vec2(200, -31), text: "社 交" },
};

/**
 * 时装弹窗（#377，衣柜）
 *
 * 弹窗尺寸取 dialogFrame.size（600×500）；卡片 4 列网格、竖向滚动。
 * 卡片 = 外观图标 + 名称 + 状态角标（已穿戴/点击穿上），点卡片即穿脱。
 * 「当前穿戴」一行放在列表上方，脱掉入口也在这里（点已穿戴的卡片也会脱）。
 */
export const fashionDialogLayout = {
  name: "fashion_dialog",
  title: "衣 柜",
  /** 顶部「当前穿戴」提示 */
  current: { position: new Vec2(0, 205), fontSize: 16 },
  /** 列表（卡片区，四列） */
  list: { name: "fashion_list", position: new Vec2(0, -20), size: new Size(556, 396) },
  /** 单张卡片（相对列表内容左上角逐格排布） */
  card: {
    size: new Size(130, 104),
    /** 卡片间距（横 / 纵） */
    gap: new Vec2(12, 10),
    /** 一行几列 */
    columns: 4,
    /** 外观图标（尺寸与在卡片内的位置） */
    iconSize: new Size(64, 64),
    iconPosition: new Vec2(0, 16),
    /** 名称（字号与在卡片内的位置、尺寸） */
    labelFontSize: 14,
    labelPosition: new Vec2(0, -38),
    labelSize: new Size(122, 20),
    /** 状态角标（已穿戴 / 可穿戴） */
    stateFontSize: 12,
    statePosition: new Vec2(0, -56),
    /** 卡片底色（Graphics 自绘，不依赖底图） */
    fill: new Color(24, 20, 16, 220),
    /** 已穿戴卡片的描边色 */
    activeBorder: new Color(214, 174, 96, 255),
    /** 普通卡片描边色 */
    border: new Color(92, 78, 52, 255),
    /** 未穿戴卡片的角标颜色 */
    stateColor: new Color(170, 170, 170, 255),
  },
  /** 卡片上的状态文案 */
  stateText: { equipped: "已穿戴", wearable: "点击穿上", unsupported: "无外观" },
  /** 顶部提示文案（{label} 替换为时装名） */
  currentText: { worn: "当前穿戴：{label}", none: "当前没有穿时装" },
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

//#region 商城弹窗

/**
 * 商城弹窗布局（组件见 ui/components/dialogs/MallDialog）
 *
 * 弹窗即商城背景图（resources/mall/bg，门面样式）：商品卡片区摆在背景图的「橱窗开口」里
 * （图中暗色门面区域，避开门面两侧的灯笼与龙柱），分页页脚压在开口下沿，绑定元宝余额落在柜台（橱窗下方）。
 * 换背景图时：size 要跟着图片实际尺寸改，各部件几何对着新图重新调。
 */
export const mallDialogLayout = {
  name: "mall_dialog",
  /** 背景图（CUSTOM 按下面的尺寸铺，当前图就是这个尺寸；换图同步改） */
  background: uiImages.mallBackground,
  size: new Size(850, 542),
  closeButton: { position: new Vec2(357, 171), size: uiSize.closeButtonSize },
  /** 绑定元宝余额（柜台正中） */
  bindGold: { position: new Vec2(0, -182), size: new Size(220, 18), fontSize: 12, color: new Color(255, 214, 102) },
  /** 商品卡片区（橱窗开口内；分页显示，每页只建 columns × rowsPerPage 张卡片） */
  list: { name: "mall_list", position: new Vec2(0, -33), size: new Size(395, 248) },
  /** 商品卡片（一行 columns 张均分列表宽：图标 → 名称 → 前后缀 → 购买按钮，几何都由这里推） */
  card: {
    columns: 3,
    gapX: 10,
    gapY: 6,
    height: 100,
    paddingTop: 4,
    /** 卡片底：Graphics 自绘的填充与金边（橱窗底色深，描一圈细金边出层次；不依赖底图拉伸） */
    fill: new Color(24, 20, 16, 220),
    borderColor: new Color("#8A6A2F"),
    borderWidth: 1,
    paddingX: 6,
    iconSize: new Size(40, 40),
    /** 名称两段式：本体一行（前缀色大字，超长自动缩字）+ 前缀+后缀一行（同色小字）；gapY = 与上一行的间距 */
    name: { fontSize: 12, lineHeight: 16, gapY: 2 },
    extra: { fontSize: 10, lineHeight: 12, gapY: 2 },
    /**
     * 价格（与「前缀+后缀」同一行，右侧贴边、金色）
     *
     * 卡片上没有第二行空间（高 100 = 4 + 40 图标 + 2 + 16 名称 + 2 + 12 品质 + 2 + 20 按钮 + 4），
     * 所以价格挤在品质行右侧：品质行让出 `reserve` 宽给价格，两段互不重叠（`client/tools/test-mall.cjs` 算过）。
     * 取价一律走 `configs/mall.getMallPrice`（特殊价优先、未定价走统一价），**卡片不自己算钱**。
     * `reserve` 50 = 4 位数字 + 空格 + 2 个全角「绑元」（10 号字 ≈ 22 + 5 + 20 = 47，留 3 余量），
     * 光秃秃一个数字会被误读成数量，所以带单位。
     */
    price: { fontSize: 10, reserve: 50, color: new Color(255, 214, 102) },

    /** 购买按钮（居中）：尺寸、字号与间距 */
    buyButton: { size: new Size(64, 20), fontSize: 12, gapY: 2 },
  },
  /**
   * 分页：每页行数（每页件数 = columns × rowsPerPage）+ 页脚翻页控件
   *
   * 页脚是卡片区的子节点（坐标以卡片区中心为原点，卡片区挪位页脚跟着走）：
   * 卡片区高 248、2 行卡片占 206，页脚落在下方空当（局部 y = -105：距卡片下缘 11、距区底 7）。
   * 横向一个整行排满：首/末页贴两侧，上/下一页靠中间，页码居中，相邻间距一律 8
   * （395 = 19.5 + 56 + 8 + 56 + 8 + 100 + 8 + 56 + 8 + 56 + 19.5）—— 按这个算式改按钮或页码宽度时，位置要一起重算。
   */
  pagination: {
    rowsPerPage: 2,
    /** 页码（第 X / Y 页） */
    pageIndicator: { name: "mall_page_indicator", position: new Vec2(0, -105), size: new Size(100, 20), fontSize: 12, color: new Color(255, 214, 102) },
    /** 四个翻页按钮（首 / 上 / 下 / 末） */
    firstButton: { name: "mall_first_page_button", position: new Vec2(-150, -105), size: new Size(56, 24), fontSize: 12 },
    prevButton: { name: "mall_prev_page_button", position: new Vec2(-86, -105), size: new Size(56, 24), fontSize: 12 },
    nextButton: { name: "mall_next_page_button", position: new Vec2(86, -105), size: new Size(56, 24), fontSize: 12 },
    lastButton: { name: "mall_last_page_button", position: new Vec2(150, -105), size: new Size(56, 24), fontSize: 12 },
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
  /**
   * 技能行：图标 + （名称 / 说明）两行文字。
   *
   * 说明必须**换行**：205 宽 × 10 号字一行只放得下 ~20 字，而 `configs/skill-data.ts` 里的说明
   * 普遍 40~73 字 —— 单行 CLAMP 会把后半句直接切掉（#481，真机上看就是「说到一半」）。
   * 行高按估算行数自适应（`TextLayout.wrappedHeight`），最多 `maxLines` 行（实测最长 73 字 → 4 行）。
   */
  row: {
    /** 行宽 = 图标 + 间距 + 说明列（250 = 40 + 5 + 205） */
    width: 250,
    iconSize: 40,
    gap: 5,
    desc: {
      /** 说明列宽（= 行宽 − 图标 − 间距） */
      width: 205,
      /** 名称行与说明之间的间距 */
      gap: 3,
      nameHeight: 20,
      nameFontSize: 12,
      fontSize: 10,
      lineHeight: 14,
      maxLines: 4,
      /** 行上下内边距（行高 = 名称 + 间距 + 说明高度 + 2×padding，且不小于图标边长） */
      paddingY: 3,
    },
  },
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

//#region 通用确认框（模态：盖住整个屏幕的「确定 / 取消」二选一）

/**
 * 通用确认框布局（组件见 ui/components/dialogs/ConfirmDialog，自身即全屏模态节点）
 *
 * 与死亡遮罩（deathDialogLayout）同一套做法：全屏黑遮罩 + 居中面板；
 * 文案不进这里 —— 玩家文案的唯一来源是 configs/texts，由使用方取好后传进组件
 * （首个使用方是背包的「拖出弹窗销毁」，见 ui/components/dialogs/BagDialog）
 */
export const confirmDialogLayout = {
  name: "confirm_dialog",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住下层点击；与死亡遮罩同色） */
  maskColor: new Color(0, 0, 0, 160),
  /** 居中面板：尺寸与背景图（复用通用弹窗背景） */
  panel: { name: "confirm_panel", size: new Size(420, 210), background: uiImages.dialogBackground },
  /** 标题（面板上部，配色与通用弹窗标题一致） */
  title: { name: "confirm_title", position: new Vec2(0, 68), size: new Size(360, 26), fontSize: 16, color: new Color("#FF8B8B") },
  /** 正文：宽度固定、高度按内容自适应（可换行，锚点居中故向上下对称撑开） */
  message: { name: "confirm_message", position: new Vec2(0, 18), width: 340, fontSize: 14, lineHeight: 20, color: Color.WHITE },
  /** 两个按钮（中号按钮宽 123：x 错开 90 → 间隙 57，整体在面板内居中） */
  confirmButton: { name: "confirm_ok_button", position: new Vec2(-90, -58) },
  cancelButton: { name: "confirm_cancel_button", position: new Vec2(90, -58) },
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
  /**
   * 「按住 Ctrl 与身上穿戴对比」段（悬停背包装备、按住左 Ctrl 时出现在属性列表下方）
   * 逐项行的排版沿用上面的属性行（图标 + 属性名 50 + 值区），这里只管配色与提示行
   */
  compare: {
    /** 段标题（「对比 · 身上穿戴」）配色（金色，与回收价行同调） */
    titleColor: new Color(255, 214, 102),
    /** 差值着色：变强绿 / 变弱红 / 持平灰（绿与战魂弹窗的增量色一致） */
    gainColor: new Color(120, 220, 120),
    lossColor: new Color(255, 80, 80),
    sameColor: new Color(170, 170, 170),
    /** 未按 Ctrl 时的发现提示行（灰字，弱于正文） */
    hintColor: new Color(150, 150, 150),
    hintFontSize: 11,
  },
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
  /**
   * 摆放（鼠标悬停在物品上时弹窗的位置，规则见 ui/utils/layout/ScreenLayout.getPopupPosition）
   * 弹窗锚点恒为 0.5/0.5（内容排版交给自身 Layout），位置按「物品中心 + 这些间距」算：
   * 竖直与物品同高居中、水平放物品靠屏幕中间那一侧，最后整块夹进可见区
   */
  placement: {
    /** 弹窗边缘与物品格边缘的间距（不遮住物品本身） */
    gap: 8,
    /** 弹窗到可见区边缘的最小留白（窗口比设计分辨率小时不会被裁掉） */
    screenMargin: 8,
  },
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

//#region 公告（玩家侧展示，见 ui/components/dialogs/Announcement*）

/**
 * 游戏内公告板（左列表 + 右详情）
 *
 * 为什么分两栏而不是把正文摊在列表里：一条公告正文可以到两千字，逐条摊开后
 * 「到底有哪几条公告」这件事就被淹掉了。左栏固定行高只给「标题 + 级别 · 时间窗」（快速扫），
 * 右栏展示选中那条的完整正文。
 */
export const announcementBoardDialogLayout = {
  name: "announcement_board_dialog",
  title: "公告",
  size: new Size(720, 500),
  /** 左：公告条目滚动列表（行高固定，正文在右栏） */
  list: {
    name: "announcement_list",
    position: new Vec2(-215, -20),
    size: new Size(280, 400),
    itemSize: new Size(268, 58),
    /** 条目间距（条目内部的两行文字几何见下面两项） */
    itemGap: 4,
    itemTitleFontSize: 13,
    itemMetaFontSize: 11,
    /** 条目的标题与第二行（左对齐；左侧留出未读圆点的位置，所以左边界不贴条目边） */
    itemTitle: { position: new Vec2(4, 12), size: new Size(244, 18) },
    itemMeta: { position: new Vec2(4, -11), size: new Size(244, 16) },
    /** 未读条目用亮色标题 + 左侧圆点，已读压暗（一眼看出哪几条是新的） */
    unreadTitleColor: new Color(255, 214, 102),
    readTitleColor: new Color(150, 150, 150),
    itemMetaColor: new Color(130, 130, 130),
    /** 选中条目的底色（Graphics 自绘，不依赖底图） */
    selectedFill: new Color(70, 60, 44, 220),
    /** 未读圆点（相对条目中心；用 uiImages.dot） */
    itemDot: { position: new Vec2(-126, 13), size: new Size(8, 8) },
  },
  /** 右：选中公告的详情（标题 / 级别 · 时间窗 / 正文滚动区） */
  detail: {
    title: { name: "announcement_detail_title", position: new Vec2(140, 172), size: new Size(368, 24), fontSize: 15, color: new Color(255, 214, 102) },
    /** 级别 · 时间窗（没有选中公告时这里显示空态 / 失败提示） */
    meta: { name: "announcement_detail_meta", position: new Vec2(140, 148), size: new Size(368, 18), fontSize: 11, color: new Color(150, 150, 150) },
    scroll: { name: "announcement_body_scroll", position: new Vec2(140, -28), size: new Size(372, 330) },
    /** 正文：宽度固定、高度按内容自适应（可换行） */
    body: { name: "announcement_body", fontSize: 13, lineHeight: 20, width: 364, color: new Color(226, 226, 226) },
  },
};

/**
 * 登录页公告提醒（全屏模态）
 *
 * 与公告板的分工：这里只摊开「生效中的重要公告」（停机维护这类玩家进游戏前最需要看到的），
 * 内容少且是必读，所以直接一篇篇纵向摊开，不做左右分栏。
 * 尺寸与遮挡口径与确认框一致（见 confirmDialogLayout）：全屏遮罩取可见区，任意窗口比例都盖满。
 */
export const announcementNoticeDialogLayout = {
  name: "announcement_notice_dialog",
  title: "公告",
  maskColor: new Color(0, 0, 0, 170),
  panel: { name: "announcement_notice_panel", size: new Size(640, 460), background: uiImages.dialogBackground },
  /** 标题文本的位置与样式（配色与通用弹窗标题一致） */
  titleLabel: { name: "announcement_notice_title", position: new Vec2(0, 200), size: new Size(560, 26), fontSize: 16, color: new Color("#FF8B8B") },
  /** 公告列表（纵向滚动，每一条自己撑高） */
  list: { name: "announcement_notice_list", position: new Vec2(0, 20), size: new Size(576, 350) },
  /** 单条公告：标题 / 级别 · 时间窗 / 正文，纵向排列且高度按内容自适应 */
  item: {
    width: 568,
    /** 条目之间与条目内部的纵向间距 */
    itemGap: 22,
    rowGap: 6,
    title: { fontSize: 15, lineHeight: 21, color: new Color(255, 214, 102) },
    meta: { fontSize: 11, lineHeight: 16, color: new Color(140, 140, 140) },
    body: { fontSize: 13, lineHeight: 20, color: new Color(226, 226, 226) },
  },
  /** 「我知道了」按钮（中号按钮，面板底部居中） */
  confirmButton: { name: "announcement_notice_confirm_button", text: "我知道了", position: new Vec2(0, -200) },
};

//#endregion

//#region 社交 · 帮会（#388）

/**
 * 帮会弹窗（社交面板的第一页；好友 / 敌人 / 附近在 #389 补成同框多页）
 *
 * 两种形态共用一个弹窗，按「有没有帮会」切换：
 * - **未加入**：创建帮会（输入框 + 按钮）+ 全部帮会列表（每行一个「申请」）
 * - **已加入**：帮会信息头 + 公告（干部可改）+ 成员名单 + 待审批（干部可见）+ 退出 / 解散
 *
 * 列表行是「整行一条」的横排（不是网格）：滚动区 content 自带纵向 Layout，
 * 直接 addChild 就按行往下排，行内位置以**行中心**为原点（见 row.*）。
 */
export const guildDialogLayout = {
  name: "guild_dialog",
  title: "社 交",
  // ---- 未加入帮会 ----
  guest: {
    hint: { position: new Vec2(0, 208), size: new Size(560, 22), fontSize: 15, color: new Color(226, 226, 226) },
    nameInput: { position: new Vec2(-60, 170), size: new Vec2(360, 34), placeholder: "输入帮会名（2~12 字）" },
    createButton: { name: "guild_create_button", text: "创建帮会", position: new Vec2(195, 170) },
    listTitle: { position: new Vec2(0, 138), size: new Size(560, 20), fontSize: 13, color: new Color(255, 214, 102) },
    list: { name: "guild_list", position: new Vec2(0, -56), size: new Size(556, 340) },
  },
  // ---- 已加入帮会 ----
  member: {
    header: { position: new Vec2(-110, 208), size: new Size(340, 24), fontSize: 16, color: new Color(255, 214, 102) },
    summary: { position: new Vec2(140, 208), size: new Size(280, 22), fontSize: 12, color: new Color(180, 190, 205) },
    notice: { position: new Vec2(0, 176), size: new Size(548, 22), fontSize: 12, color: new Color(200, 208, 220) },
    noticeInput: { position: new Vec2(-60, 146), size: new Vec2(360, 30), placeholder: "输入新公告（0~200 字）" },
    saveButton: { name: "guild_notice_save_button", text: "保存公告", position: new Vec2(195, 146), small: true },
    memberTitle: { position: new Vec2(0, 116), size: new Size(560, 20), fontSize: 13, color: new Color(255, 214, 102) },
    memberList: { name: "guild_member_list", position: new Vec2(0, 14), size: new Size(556, 168) },
    applicantTitle: { position: new Vec2(0, -88), size: new Size(560, 20), fontSize: 13, color: new Color(255, 214, 102) },
    applicantList: { name: "guild_applicant_list", position: new Vec2(0, -158), size: new Size(556, 116) },
    leaveButton: { name: "guild_leave_button", text: "退出帮会", position: new Vec2(-70, -232), small: true },
    disbandButton: { name: "guild_disband_button", text: "解散帮会", position: new Vec2(70, -232), small: true },
    /** 只剩一个按钮时（帮主只能解散、成员只能退出）居中摆放，避免偏在一边 */
    singleButtonPosition: new Vec2(0, -232),
  },
  /** 列表行（三种行共用同一套几何与配色） */
  row: {
    size: new Size(556, 48),
    /** 行底色 / 描边 / 自己的那一行的高亮描边 */
    fill: new Color(22, 26, 34, 190),
    border: new Color(64, 74, 90, 255),
    selfBorder: new Color(255, 200, 80, 255),
    /** 行内文字：主名 / 次要信息 */
    nameFontSize: 14,
    metaFontSize: 11,
    metaColor: new Color(160, 172, 190, 255),
    radius: 6,
    /** 行内各列的中心 x（相对行中心） */
    columns: {
      name: -180,
      meta: -40,
      extra: 90,
      action: 210,
      action2: 150,
    },
  },
  /** 文案（状态提示与按钮，集中在这里避免散在组件里） */
  texts: {
    guestHint: "你还没有加入帮会：可以自己创建一个，或申请加入下面任意一个",
    listTitle: "全部帮会（{count}）",
    listEmpty: "还没有人创建帮会，你可以是第一个",
    nameRule: "帮会名要 {min}~{max} 个字",
    rowLeader: "帮主 {leader}",
    rowMembers: "{count} 人",
    applyButton: "申请",
    applyDone: "已申请",
    memberTitle: "成员（{count}/{limit}）",
    memberEmpty: "（没有成员）",
    memberMeta: "{level} 级 · {rank}",
    applicantTitle: "待审批（{count}）",
    applicantTitleLocked: "待审批（只有帮主和副帮主能看到）",
    applicantEmpty: "（没有待审批的申请）",
    applicantEmptyLocked: "（你的职位看不到申请）",
    applicantMeta: "{level} 级",
    applicantMetaWithMessage: "{level} 级 · {message}",
    noticePrefix: "公告：{notice}",
    noticeNone: "公告：（暂无）",
    summary: "{count}/{limit} 人 · 我的职位：{rank}",
    accept: "通过",
    reject: "拒绝",
    kick: "踢出",
    transfer: "转让",
    noticeSaved: "公告已更新",
    createdTip: "帮会创建成功",
    appliedTip: "申请已提交，等待帮主审批",
    leftTip: "已退出帮会",
    disbandedTip: "帮会已解散",
    kickedTip: "已把对方踢出帮会",
    transferredTip: "帮主已转让",
    /** 二次确认（不可恢复 / 影响他人的操作都要先问一句） */
    confirmLeaveTitle: "退出帮会",
    confirmLeaveText: "确定退出「{name}」吗？退出后要重新申请才能回来",
    confirmDisbandTitle: "解散帮会",
    confirmDisbandText: "确定解散「{name}」吗？成员与待审批申请会一并清除，不可恢复",
    confirmKickTitle: "踢出成员",
    confirmKickText: "确定把「{name}」踢出帮会吗？",
    confirmTransferTitle: "转让帮主",
    confirmTransferText: "确定把帮主转给「{name}」吗？你会变成普通成员，且自己无法撤回",
  },
};

//#endregion

//#region 社交弹窗（#389：帮会 / 好友 / 敌人 / 附近四个页签）

/**
 * 社交弹窗布局
 *
 * **四页共用一个框**：页签在标题下方一行，内容区由 SocialDialog 按页挂载 ——
 * 「帮会」页沿用 `guildDialogLayout` 的坐标（那份坐标是按 500 高的框调的，
 * 这里把框加到 560 高，页签正好塞进多出来的 60 里，帮会页一个字都不用挪）。
 *
 * 好友页有**三段列表**（别人加我 / 我的好友 / 我发出的），所以每段都给了固定高度；
 * 行高与帮会列表一致（48），一眼看上去是同一套东西。
 */
export const socialDialogLayout = {
  name: "social_dialog",
  title: "社 交",
  /** 比通用弹窗高 60：多出来的一行放页签（帮会页的坐标因此可以原样复用） */
  size: new Size(600, 560),
  /** 页签栏（选中金色底、未选中暗色底；x 是各页签中心，从「帮会」到「附近」） */
  tabs: {
    y: 232,
    size: new Size(104, 32),
    columns: [-208, -104, 0, 104, 208],
    /** 与 texts.tabs 一一对应，别只改一处 */
    radius: 6,
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 200),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    fontSize: 13,
  },
  /** 列表行（与帮会列表同一套几何与配色） */
  row: {
    size: new Size(556, 48),
    fill: new Color(22, 26, 34, 190),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    nameFontSize: 14,
    metaFontSize: 11,
    metaColor: new Color(160, 172, 190, 255),
    columns: {
      name: -180,
      meta: -40,
      /** 行尾按钮，从右往左：主动作 210 → 150 → 90 → 30（小按钮宽 56.5，间隙 3.5） */
      action: 210,
      action2: 150,
      action3: 90,
      action4: 30,
    },
    /** 行内「关系」标签（右对齐的小字，颜色按关系走） */
    relationSize: new Size(64, 18),
    relationX: -86,
  },
  /** 好友页：三段列表各占一块（标题 + 滚动区） */
  friends: {
    incomingTitle: { position: new Vec2(0, 200), size: new Size(560, 20) },
    incomingList: { name: "social_incoming_list", position: new Vec2(0, 150), size: new Size(556, 96) },
    listTitle: { position: new Vec2(0, 96), size: new Size(560, 20) },
    list: { name: "social_friend_list", position: new Vec2(0, 18), size: new Size(556, 148) },
    outgoingTitle: { position: new Vec2(0, -60), size: new Size(560, 20) },
    outgoingList: { name: "social_outgoing_list", position: new Vec2(0, -110), size: new Size(556, 96) },
  },
  /** 敌人页：一整块列表 */
  enemies: {
    title: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_enemy_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 附近页：一行说明 + 一整块列表（数据源是当前互见帧的内存态） */
  nearby: {
    hint: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_nearby_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 黑名单页（#398）：与敌人页同构 —— 一整块列表 + 底部「按名拉黑」 */
  blocks: {
    title: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_block_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 加人/标人一行（好友页与敌人页共用，贴在框底） */
  addRow: {
    input: { position: new Vec2(-70, -232), size: new Vec2(400, 30) },
    button: { position: new Vec2(195, -232) },
  },
  /** 小字（段落标题用金色，空态用灰） */
  titleColor: new Color(255, 214, 102, 255),
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["帮 会", "好 友", "敌 人", "附 近", "黑名单"],
    friendsTitle: "我的好友（{count}）",
    friendsEmpty: "（还没有好友：在「附近」点「加好友」，或按名字申请）",
    incomingTitle: "别人加我（{count}）",
    incomingEmpty: "（没有等你处理的申请）",
    outgoingTitle: "我发出的申请（{count}）",
    outgoingEmpty: "（没有等对方处理的申请）",
    enemiesTitle: "我标的敌人（{count}）",
    enemiesEmpty: "（还没标过谁：把名字标成敌人后，你看到他的名字就是红的）",
    nearbyHint: "附近的人（{count}；同图可见，只显示此刻看得见的人）",
    nearbyEmpty: "（附近没有其他玩家）",
    blocksTitle: "黑名单（{count}）",
    blocksEmpty: "（黑名单是空的：在「附近」点「拉黑」，屏蔽他的人与消息）",
    blockInput: "输入角色名拉黑",
    addBlock: "拉黑",
    removeBlock: "解除",
    block: "拉黑",
    blocked: "已拉黑",
    report: "举报",
    blockAddedTip: "已拉黑（他的消息与位置不再出现，对方不会收到通知）",
    blockRemovedTip: "已解除拉黑",
    reportSubmittedTip: "举报已提交，管理端会人工处理",
    confirmBlockTitle: "拉黑",
    confirmBlockText: "确定拉黑「{name}」吗？拉黑后你收不到他的聊天、看不到他的位置；他那边不会收到任何提示",
    confirmRemoveBlockTitle: "解除拉黑",
    confirmRemoveBlockText: "确定解除对「{name}」的拉黑吗？他的消息与位置会重新出现",
    friendInput: "输入角色名加好友",
    enemyInput: "输入角色名标敌人",
    addFriend: "加好友",
    addEnemy: "标敌人",
    accept: "同意",
    reject: "拒绝",
    removeFriend: "删除",
    removeEnemy: "解除",
    cancel: "撤回",
    friendMeta: "{level} 级 · {occupation}",
    guildMeta: "「{guild}」",
    noGuild: "无帮会",
    friendRequestedTip: "好友申请已发出",
    friendAcceptedTip: "已加为好友",
    friendRejectedTip: "已拒绝",
    friendRemovedTip: "已删除好友",
    enemyAddedTip: "已标为敌人（对方不会收到通知）",
    enemyRemovedTip: "已解除",
    ambiguousTip: "有多个同名角色，请在「附近」里点选添加",
    nameEmptyTip: "先输入角色名",
    confirmRemoveFriendTitle: "删除好友",
    confirmRemoveFriendText: "确定删除好友「{name}」吗？对方那边也会同时消失（可以重新加）",
    confirmRemoveEnemyTitle: "解除敌人",
    confirmRemoveEnemyText: "确定解除对「{name}」的敌意吗？他的名字会变回普通颜色",
  },
};

//#endregion

//#region 举报弹窗（#398）

/**
 * 举报弹窗布局
 *
 * 与确认框同款（全屏遮罩 + 居中面板），但多三样东西：**类别选择**（四个小按钮，选中变金）、
 * 补充说明输入框、提交按钮。为什么不做成「几个文件对话框套娃」：
 * 举报是一次性的低频操作，弹一次、填完就走，不需要常驻面板。
 */
export const reportDialogLayout = {
  name: "report_dialog",
  maskColor: new Color(0, 0, 0, 170),
  panel: { name: "report_panel", size: new Size(460, 320), background: uiImages.dialogBackground },
  title: { name: "report_title", position: new Vec2(0, 122), size: new Size(400, 26), fontSize: 16, color: new Color("#FF8B8B") },
  /** 提示行（被举报人 + 一句话说明举报只落库） */
  hint: { name: "report_hint", position: new Vec2(0, 86), size: new Size(400, 20), fontSize: 13, color: new Color("#C8C8C8") },
  /** 类别小按钮：一行四个（中心 x 从 -135 到 135，间隔 90） */
  category: {
    y: 44,
    columns: [-135, -45, 45, 135],
    size: new Size(84, 28),
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 220),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    radius: 6,
    fontSize: 13,
  },
  /** 补充说明输入框（单行，200 字上限在服务端 DTO 里） */
  reason: { name: "report_reason", position: new Vec2(0, -14), size: new Vec2(400, 30) },
  /** 底部两个按钮（与确认框同位） */
  submitButton: { name: "report_submit_button", position: new Vec2(-90, -110) },
  cancelButton: { name: "report_cancel_button", position: new Vec2(90, -110) },
  texts: {
    title: "举报「{name}」",
    hint: "举报只提交给管理端人工处理，不会通知对方",
    reasonPlaceholder: "补充说明（可留空）",
    submit: "提交举报",
    cancel: "取消",
    categories: ["骚扰辱骂", "外挂刷资源", "名字违规", "其他"],
  },
};

//#endregion

//#region 聊天窗（#395；#469 起为常驻左下角小窗）

/**
 * 聊天窗布局（世界 / 帮会 / 私聊三页签）
 *
 * **#469 起不再是居中大弹窗**：按主流网游的习惯改成**常驻左下角的小窗**（440×280），
 * 进游戏自动打开（引导进行中除外），底部入口 / Enter 仍是开关。
 *
 * 停靠位置算过两侧邻居：左下角摇杆 175×172（margin 24/18，顶到 y=-185），
 * 任务追踪栏三行到 y=124 —— 本窗 marginY 205（下缘 y=-170）到 y=110，两头都不叠。
 *
 * 气泡（bubbles）不是窗体的一部分：它是屏幕左上角的常驻演出（窗关着的时候新消息往上冒），
 * 布局放在这里只是因为「聊天的长相关什么」都归这一块管。
 */
export const chatDialogLayout = {
  name: "chat_box",
  size: new Size(440, 280),
  /** 常驻停靠：屏幕左下角（屏幕坐标，原点在屏幕中心；固定值直接手调 —— 旧实现按「贴左下 + 边距 24/205」算出） */
  position: new Vec2(-730, -395),
  /** 窗体底板（半透明深色 + 金色细边；颜色必须在配置里，组件不写字面量） */
  box: {
    fill: new Color(16, 20, 32, 215),
    border: new Color(255, 214, 102, 170),
    radius: 10,
    borderWidth: 1.5,
    padding: 20,
  },
  /** 页签（三个：世界 / 帮会 / 私聊；贴窗顶一排） */
  tabs: {
    y: 116,
    size: new Size(124, 26),
    columns: [-136, 0, 136],
    radius: 6,
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 200),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    fontSize: 12,
  },
  /** 消息列表（窗体主体） */
  list: { name: "chat_message_list", position: new Vec2(0, 2), size: new Size(392, 196) },
  /** 消息行：发送者名（按关系上色）+ 正文 */
  row: {
    size: new Size(388, 26),
    fill: new Color(22, 26, 34, 150),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    nameFontSize: 11,
    textFontSize: 11,
    metaColor: new Color(160, 172, 190, 255),
    /**
     * 名字列 / 正文列（文本列吃剩下的宽度）。
     * 两列都左对齐，bbox 左缘 = 中心 x − 宽/2 必须落在行内（留白 16，半宽 194 → 限 −178），
     * 且名字 bbox 右缘与正文 bbox 左缘衔接不重叠（守卫：test-dialog-row-bounds.cjs）：
     *   名字 −178..−58（nameX −118 / 宽 120），正文 −58..178（textX 60 / 宽 236）
     */
    nameX: -118,
    nameSize: new Size(120, 18),
    textX: 60,
    textSize: new Size(236, 20),
  },
  /** 输入行（贴窗底；私聊有对象时旁边多一枚「返回」） */
  inputRow: {
    /**
     * 输入条：26 高的窄框必须有底板 + 小字号 —— 默认 24 号字的字形就 24 高，
     * 在 26 高的框里会顶出上下边、贴到窗体边框上（#477 顺带发现）
     */
    input: {
      position: new Vec2(-85, -122),
      size: new Vec2(220, 26),
      fontSize: 13,
      fill: new Color(10, 13, 20, 220),
      border: new Color(64, 74, 90, 255),
      radius: 6,
    },
    send: { position: new Vec2(65, -122) },
    back: { position: new Vec2(130, -122) },
  },
  /** 私聊选人页：一行说明 + 候选列表（聊天记录里出现过的 + 附近的人） */
  privatePick: {
    hint: { position: new Vec2(0, 84), size: new Size(380, 18) },
    list: { name: "chat_private_pick_list", position: new Vec2(0, -10), size: new Size(392, 170) },
  },
  /**
   * 选人行的行内几何（行高 / 底色 / 描边复用上面的 row，只是名字列不同）：
   * 选人行只有「名字 + 一枚按钮」，名字列按消息行的窄列摆会几乎贴到行左缘，
   * 且 120 宽装不下最长 12 字的角色名 —— 这里把名字列居中放宽到 220，按钮挪到行尾
   */
  pickRow: {
    nameX: -70,
    nameSize: new Size(220, 18),
    buttonX: 140,
  },
  /** 屏幕气泡（弹窗关着时新消息在左上角冒一下；最多同时三条，逐条下移） */
  bubbles: {
    /** 首条气泡位置（横屏 1920×1080，屏幕坐标原点在中心） */
    position: new Vec2(-660, 290),
    size: new Size(430, 30),
    spacing: 34,
    maxCount: 3,
    fontSize: 12,
    fill: new Color(16, 20, 26, 200),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    /** 停留毫秒（到了自己消失；新消息来了重置计时） */
    lifetimeMs: 6000,
    /** 正文截断（气泡里只求「知道有人说话」，全量在面板里看） */
    textMaxLength: 40,
  },
  /** 小字 */
  titleColor: new Color(255, 214, 102, 255),
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["世 界", "帮 会", "私 聊"],
    worldEmpty: "（还没有人说第一句——输入框在下面）",
    guildEmpty: "（帮会频道还没有消息；没有帮会时发不出去）",
    /** 私聊**选人页**的空态（还没挑对象） */
    privateEmpty: "（还没有私聊：先点「选人」挑一个对象）",
    /**
     * 私聊**会话页**的空态（已经挑好对象、只是还没聊过）
     *
     * 不能复用 privateEmpty：那句是「先点选人挑一个对象」，而这时玩家已经挑好了，
     * 再让他去挑就是自相矛盾（#495，与 #491 的组队空态同一类错误）。
     */
    privateChatEmpty: "（还没有私聊消息，说点什么吧）",
    inputWorld: "对同图的人说点什么…",
    inputGuild: "对帮会的伙伴说点什么…",
    inputPrivate: "对「{name}」说…",
    send: "发送",
    back: "返回",
    pickHint: "选择私聊对象（聊过的 + 附近的人）",
    pickEmpty: "（附近没有其他玩家，也还没聊过天）",
    privateChat: "私 聊",
    disconnectedTip: "实时通道未连接，暂时不能发言",
    guildPrefix: "［{guild}］",
    privateTo: "→ {name}",
  },
};

//#endregion

//#region 任务弹窗（#396）

/**
 * 任务弹窗布局（与聊天弹窗同框：600×560）
 *
 * 两个页签（进行中 / 可接）—— 「已完成」不列：主线领奖后只是链门控的一行数据，
 * 日常领奖即删行，玩家真正要看的是「现在能做什么」。
 *
 * 行内左侧是任务名 + 进度 / 目标描述，右侧一枚动作按钮（接取 / 交付 / 灰掉）。
 */
export const questDialogLayout = {
  name: "quest_dialog",
  title: "任 务",
  size: new Size(600, 560),
  /** 页签（两枚，比聊天弹窗的三枚更宽一点） */
  tabs: {
    y: 232,
    size: new Size(140, 32),
    columns: [-76, 76],
    radius: 6,
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 200),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    fontSize: 13,
  },
  /** 任务列表（框体主体） */
  list: { name: "quest_list", position: new Vec2(0, -6), size: new Size(556, 420) },
  /** 任务行：名称 + 进度（左）+ 动作按钮（右） */
  row: {
    size: new Size(552, 56),
    fill: new Color(22, 26, 34, 150),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    nameFontSize: 13,
    textFontSize: 11,
    nameColor: new Color(232, 238, 246, 255),
    metaColor: new Color(160, 172, 190, 255),
    readyColor: new Color(120, 220, 140, 255),
    /**
     * 两行文字的 x 是**文本框中心**，且 `UiHelper.createLabel` 是 CLAMP + 左对齐 → 文字从
     * 文本框左缘（nameX − 宽/2）起排。所以 x 必须让「左缘 = 行左缘 + 16」：
     * 行宽 552（半宽 276）→ 左缘 −260 → 宽 360 时 x = −80。
     * 曾经写 −180（左缘 −360，跑出行外 84px），被 ScrollView 遮罩裁掉，任务名整行看不见（#477）。
     */
    nameX: -80,
    nameSize: new Size(360, 20),
    metaX: -80,
    metaSize: new Size(360, 18),
    buttonX: 214,
  },
  /** 页签角标（可交付数 / 可接数）用的小字 */
  titleColor: new Color(255, 214, 102, 255),
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["进行中", "可 接"],
    activeEmpty: "（没有进行中的任务：去「可接」看一眼）",
    availableEmpty: "（暂时没有能接的任务：升级或先完成前置）",
    accept: "接 取",
    submit: "交 付",
    accepted: "进行中",
    ready: "可交付",
    /** 进度行：{done} / {total} */
    progress: "进度 {done}/{total}",
    /** 目标行：{type} · {target} ×{count} */
    objective: "{type} · {target} ×{count}",
    /** 交接奖励行 */
    rewards: "奖励：金币 {gold} · 经验 {exp}",
    /** 接取 / 交付失败的兜底提示（服务端的错误文案更具体，走请求层统一提示） */
    acceptFailed: "接取失败",
    submitFailed: "交付失败",
    /** 接取成功的飘字（{name} = 任务名） */
    acceptedTip: "已接取「{name}」",
  },
};

//#endregion

//#region 队伍弹窗（#399）

/**
 * 队伍弹窗布局（与聊天 / 任务弹窗同框：600×560）
 *
 * 两个页签：**成员**（含待处理邀请）与**邀请**（附近的人）。
 * 「成员」页是默认页 —— 打开队伍面板的人十次有九次是想看「队里现在有谁、谁不在线」，
 * 而不是来拉人；邀请是主动动作，翻一页的成本可以接受。
 *
 * 行内按钮的数量随身份变（队长多「转让」「踢人」两枚），几何在这里定死，
 * 组件只决定画哪几枚 —— 这样队长与队员的行高一致，列表不会跳。
 */
export const partyDialogLayout = {
  name: "party_dialog",
  title: "队 伍",
  size: new Size(600, 560),
  /** 页签（两枚，与任务弹窗同宽） */
  tabs: {
    y: 232,
    size: new Size(140, 32),
    columns: [-76, 76],
    radius: 6,
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 200),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    fontSize: 13,
  },
  /** 顶部小结（「3 / 4 人 · 同图 2 人」；没队伍时显示一句引导） */
  summary: { position: new Vec2(0, 200), size: new Size(556, 20), fontSize: 12, color: new Color(160, 172, 190, 255) },
  /** 成员 / 候选列表（框体主体） */
  list: { name: "party_member_list", position: new Vec2(0, -8), size: new Size(556, 392) },
  /** 成员行：名字 + 等级/状态（左）+ 动作按钮（右，最多两枚） */
  row: {
    size: new Size(552, 56),
    fill: new Color(22, 26, 34, 150),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    nameFontSize: 13,
    metaFontSize: 11,
    nameColor: new Color(232, 238, 246, 255),
    metaColor: new Color(160, 172, 190, 255),
    leaderColor: new Color(255, 209, 102, 255),
    offlineColor: new Color(140, 148, 162, 255),
    /**
     * 动作按钮的水平中心（两枚时左右各一；一枚时用 actionX）
     * 小按钮宽 56.5：184 / 244 → 155.75~212.25 与 215.75~272.25，两枚间距 3.5、右缘留 3.75 不越行（#477）
     */
    actionX: 184,
    action2X: 244,
    /** 名字 / 次行的 x 见 quest 行的注释：文本框左缘 + 16 = 行内左缘（552 宽 → x = −100，宽 320） */
    nameX: -100,
    nameSize: new Size(320, 20),
    metaX: -100,
    metaSize: new Size(320, 18),
  },
  /** 邀请行（队伍页顶部的「某人邀请你」，高一点点放两枚按钮） */
  inviteRow: {
    size: new Size(552, 52),
    fill: new Color(38, 33, 22, 190),
    border: new Color(120, 100, 52, 255),
    radius: 6,
    acceptX: 150,
    declineX: 232,
    /** 同上：文本框左缘 + 16 = 行内左缘（x = −100，宽 320），两枚小按钮落在 121.75~260.25 不越行 */
    nameX: -100,
    nameSize: new Size(320, 20),
    textFontSize: 12,
  },
  /** 底部按钮（邀请 / 退出 / 解散；不是队长的「解散」不画） */
  footer: {
    invite: new Vec2(-150, -244),
    leave: new Vec2(0, -244),
    disband: new Vec2(150, -244),
  },
  titleColor: new Color(255, 214, 102, 255),
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["队 员", "邀 请"],
    /** 顶部小结：{count} / {limit} 人 · 同图 {sameMap} 人 */
    summary: "{count} / {limit} 人 · 同图 {sameMap} 人",
    /** 没队伍时的一句引导（面板空着也要说清「怎么开始」） */
    solo: "你还没有队伍：去「邀请」拉一个人，顺手就建队",
    /** 成员行第二行：Lv{level} · 状态 */
    memberMeta: "Lv {level} · {state}",
    stateLeader: "队长",
    stateOnline: "在线",
    stateOffline: "离线",
    stateOtherMap: "异图",
    memberEmpty: "（队伍里只有你一个人：去「邀请」再拉几个）",
    /**
     * 没队伍时成员区的占位（**不要**复用 memberEmpty）
     *
     * memberEmpty 说的是「队伍里只有你一个人」—— 没队伍时它和顶部的 solo（「你还没有队伍」）
     * 同屏出现就是自相矛盾（#491）。这里只做中性说明，不宣称任何队伍状态。
     */
    noPartyEmpty: "（队伍成员会显示在这里）",
    inviteEmpty: "（附近没有别的玩家 —— 同图的人才拉得到）",
    /** 候选行第二行：只有关系（互见帧不下发对方等级，写死一个 Lv 会骗人） */
    inviteMeta: "{relation}",
    /** 邀请行：{name} 邀请你加入队伍（{count}/{limit}） */
    inviteTitle: "{name} 邀请你加入队伍（{count}/{limit}）",
    inviteHint: "同意后就能一起打怪分经验（30 秒内有效）",
    accept: "同 意",
    decline: "拒 绝",
    invite: "邀 请",
    invited: "已邀请",
    /**
     * 已经邀请过、等对方回应（候选行右侧的**灰字**状态）
     *
     * 不能复用 `invite`（「邀 请」）：那和旁边真正可点的按钮长得一模一样，
     * 玩家分不清「这个还能点」和「已经发出去在等」（#498 顺带发现的）。
     */
    invitePending: "等待回应",
    kick: "踢 出",
    transfer: "转 让",
    leave: "退出队伍",
    disband: "解散队伍",
    /** 飘字 / 提示 */
    invitedTip: "已邀请「{name}」",
    inviteReceivedTip: "「{name}」邀请你组队（G 键查看）",
    expGainTip: "队友击杀 +{exp} 经验",
    joinTip: "「{name}」加入了队伍",
    /**
     * 进队 / 离队的通用提示（离队那一句服务端不下发原因：被踢、解散、自己退都是一份空快照）
     *
     * 没有单独的「你已退出队伍」了（#498）：退队的提示统一由 `endedTip` 承担 ——
     * 它由**服务端快照变化**驱动，天然不会在「退队被拒」时说假话；两处都写就是一句重复飘字。
     */
    joinedTip: "已加入「{name}」的队伍",
    endedTip: "你已不在队伍中",
    kickedTip: "你被移出了队伍",
    disbandedTip: "队伍已解散",
    fullTip: "队伍已满（{limit} 人）",
    transferTip: "队长已转给「{name}」",
    disconnectedTip: "实时通道未连接，暂时不能组队",
  },
};

//#endregion

//#region 排行榜弹窗（#400）

/**
 * 排行榜弹窗布局（与聊天 / 任务 / 队伍同框：600×560）
 *
 * 三个页签就是三个榜（等级 / 战力 / 击杀）—— 它们是同一份数据的三种排法，
 * 分成三个弹窗会让玩家在打开之前就得先想清楚「我要看哪个」。
 *
 * 底部固定一条「我的名次」：榜只留前 N 条（默认 100），排在后面的人翻不到自己，
 * 那一行是**唯一**能让人确认「我到底第几」的地方。
 */
export const leaderboardDialogLayout = {
  name: "leaderboard_dialog",
  title: "排 行 榜",
  size: new Size(600, 560),
  /** 页签（三枚，与任务 / 队伍弹窗同款式） */
  tabs: {
    y: 232,
    size: new Size(120, 32),
    columns: [-130, 0, 130],
    radius: 6,
    activeFill: new Color(255, 200, 80, 230),
    activeText: new Color(38, 30, 12, 255),
    idleFill: new Color(28, 33, 42, 200),
    idleText: new Color(190, 200, 214, 255),
    idleBorder: new Color(64, 74, 90, 255),
    fontSize: 13,
  },
  /** 顶部小结（共几人上榜 + 这份快照的时刻） */
  summary: {
    position: new Vec2(0, 200),
    size: new Size(556, 20),
    fontSize: 12,
    color: new Color(160, 172, 190, 255),
    /** 「刚刚更新」的界线（毫秒）：快照比这个还新就不写时分 */
    freshMs: 60_000,
  },
  /** 榜单列表（可滚动） */
  list: { name: "leaderboard_list", position: new Vec2(0, 6), size: new Size(556, 372) },
  /** 一条名次：名次（左）+ 名字 + 关键数值（右） */
  row: {
    size: new Size(552, 44),
    fill: new Color(22, 26, 34, 150),
    border: new Color(64, 74, 90, 255),
    radius: 6,
    rankX: -252,
    rankSize: new Size(44, 20),
    rankFontSize: 14,
    rankColor: new Color(160, 172, 190, 255),
    /** 前三名的名次数字用金色（一眼看出榜头） */
    topRankColor: new Color(255, 209, 102, 255),
    /** 金色名次的界线：名次 ≤ 这个数就用金色（第 4 名开始是普通灰） */
    topRankThreshold: 3,
    /**
     * 名次列（−274~−230）之后接名字列：名字 bbox 从 −222 起（留 8px 间隙），宽 220 → x = −112；
     * 再往右是数值列（14~254）。原来写 −186（bbox 左缘 −296，跑出行外 20px，被遮罩裁掉，见 #477）
     */
    nameX: -112,
    nameSize: new Size(220, 20),
    nameFontSize: 13,
    nameColor: new Color(232, 238, 246, 255),
    metaX: 134,
    metaSize: new Size(240, 18),
    metaFontSize: 11,
    metaColor: new Color(160, 172, 190, 255),
    /** 我自己那一行的底色与边框（滚到哪都认得出来） */
    selfFill: new Color(46, 40, 24, 210),
    selfBorder: new Color(255, 200, 80, 255),
  },
  /** 底部固定的「我的名次」条 */
  selfRow: {
    position: new Vec2(0, -238),
    size: new Size(552, 40),
    fill: new Color(32, 30, 22, 220),
    border: new Color(120, 100, 52, 255),
    radius: 6,
    textFontSize: 12,
    textColor: new Color(255, 214, 102, 255),
  },
  /** 文案 */
  texts: {
    tabs: ["等 级", "战 力", "击 杀"],
    /** 顶部小结：共 {total} 人上榜 · {updated} 更新 */
    summary: "共 {total} 人上榜 · {updated} 更新",
    /** 我的名次：第 {rank} 名 */
    selfIn: "我的名次：第 {rank} 名",
    /** 没有名次（没有在线角色 / 还没上榜） */
    selfOut: "你还没有名次 —— 进游戏后自动上榜",
    /** 三个榜各自的数值行（同一行里展示另外两个维度，免得玩家来回切页） */
    levelMeta: "Lv {level} · 战力 {combat} · 击杀 {kills}",
    combatMeta: "战力 {combat} · Lv {level} · 击杀 {kills}",
    killsMeta: "{kills} 杀 · Lv {level} · 战力 {combat}",
    emptyList: "（榜上还没有人 —— 先去打两只怪）",
    loading: "正在取榜…",
    failed: "榜单没取到，稍后再试",
    /** 时刻格式：{time} 更新（今天）/ 不是今天就不显示时分，只写「刚刚更新」 */
    updatedNow: "刚刚",
    updatedAt: "{time}",
  },
};

//#endregion

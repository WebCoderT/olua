/**
 * 物品与经营弹窗（背包 / 商城 / 物品详情 / 悬停详情）布局
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

export const bagDialogLayout = {
  name: "bag_dialog",
  title: "背包",
  eyebrow: "快捷键 · B",
  /**
   * 弹窗尺寸 600×540
   *
   * 稿（05-bag）标的是 600×500，但把稿里的四段内容竖排真实累加是 ~518：
   * 头部 45（sp7 + 标题 23 + 金线 6+1）+ 计数行 14 + 10 + 网格 368 + 按钮区 16+36 + 页脚 29。
   * 稿的面板没有固定高度（`.wrap` 给了 500 但内容溢出可见），客户端弹窗有硬边界，
   * 所以取内容实际高度 540 —— 与 06/11/12/15 同档，**格子仍是 11×7=77、尺寸仍 50×50**。
   */
  size: new Size(600, 540),
  /**
   * 格子计数行（稿 05-bag 的 `.count-line`）：左「已用 / 总数 格」，右操作提示，
   * f11 + text-4；两端坐标是**标签中心**（宽 250，内缘距面板边 20）
   */
  countLine: {
    /** 稿 05-bag 实测：计数行 675..1245 × 326..343，面板 660..1260 × 270..810 → 中心 y = +206 */
    y: 206,
    leftX: -160,
    rightX: 160,
    width: 250,
    height: 14,
    fontSize: T.fontSize.f11,
    color: T.text[4],
  },
  /**
   * 页脚（稿 05-bag 的 `.panel-foot`）：顶部 1px 分隔线 + 两端各一行小字
   * 几何由面板尺寸算（见 dialogFootLayout）：540 高 → 线 -246、字 -262
   */
  foot: dialogFootLayout(new Size(600, 540), 250),
  /**
   * 底部四个操作按钮（#1278：三键改四键 —— 「一键回收」移入自动回收弹窗，
   * 原位改「自动回收」开关弹窗，新增「自动使用」开关弹窗；子件坐标以弹窗中心为原点）
   *
   * 118×36 键四枚 + 间距 14：中心 ±198 / ±66（四键总宽 514，面板 600 内边距 20 各留余量）；
   * 按钮条中心距面板顶 485 → y = -215，与稿三键版一致
   */
  buttonSize: new Size(118, 36),
  tidyButton: { name: "bag_tidy_button", position: new Vec2(-198, -215) },
  /**
   * 「自动回收」：开关自动回收弹窗（勾选清单 + 弹窗内一键回收，见 AutoRecycleDialog）
   * 背包满时的自动回收只收勾选的东西，未勾选的永远不会被自动回收
   */
  autoRecycleButton: { name: "bag_auto_recycle_button", position: new Vec2(-66, -215) },
  /** 「自动使用」：开关自动使用弹窗（勾选后背包里有就自动用，见 AutoUseDialog） */
  autoUseButton: { name: "bag_auto_use_button", position: new Vec2(66, -215) },
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
    position: new Vec2(198, -215),
    /** 待确认状态保持时间（毫秒），到点自动放弃（与回收、删除角色同一套口径） */
    confirmTimeout: 3000,
  },
};

//#endregion

//#region 自动回收弹窗

/**
 * 自动回收弹窗布局（组件见 ui/components/dialogs/AutoRecycleDialog；#1278，#1289 重做）
 *
 * 面板走标准弹窗框（createDialog），420×540：说明行 → 部位×等级段清单（滚动）→ 底部一排
 * 「一键回收」按钮 + 「自动回收」开关。
 * 清单按部位分节：节标题 = 部位名（装备槽配置的 label），节内 = 等级段勾选行
 * （1-10级、11-15级……，段规则见 configs/equipments.recycleLevelBands）；
 * 非装备物品不再进清单（#1289：药品 / 卷轴不进自动回收）。
 */
export const autoRecycleDialogLayout = {
  name: "auto_recycle_dialog",
  title: "自动回收",
  eyebrow: "自动 · 背包",
  size: new Size(420, 540),
  /** 顶部说明行（勾选语义一句话） */
  hint: { y: 226, fontSize: T.fontSize.f11, color: T.text[4], width: 380, height: 16 },
  /** 部位×等级段滚动清单（#1104 坑：滚动区四边留 3px，防首行贴上裁剪线） */
  list: { name: "auto_recycle_list", position: new Vec2(0, 24), size: new Size(380, 320), padding: 3, rowHeight: 24, rowSpacing: 3, fontSize: T.fontSize.f12, color: T.text[1], nameWidth: 240 },
  /** 部位节标题行（标题 = 部位名，勾选行都归在它下面） */
  sectionTitle: { height: 26, fontSize: T.fontSize.f13, color: T.gold[3] },
  /** 「一键回收」按钮：按当前勾选清单立即执行（两步确认保留；与开关同一排，按钮在左） */
  recycleButton: { name: "auto_recycle_now_button", position: new Vec2(-98, -206), confirmTimeout: 3000 },
  /** 「自动回收」开关：开启后持续扫描背包，回收勾选的部位 × 等级段（按钮在左、开关在右） */
  autoToggle: { name: "auto_recycle_toggle_row", position: new Vec2(102, -206), width: 150, height: 36, fontSize: T.fontSize.f12, color: T.text[1] },
};

//#endregion

//#region 自动使用弹窗

/**
 * 自动使用弹窗布局（组件见 ui/components/dialogs/AutoUseDialog；#1278）
 *
 * 420×480：说明行 → 可使用物品勾选清单（滚动；药品 / 货币道具 / 升级卷轴逐项，
 * 装备不进清单 —— 自动穿戴是角色信息弹窗里的独立开关）。
 */
export const autoUseDialogLayout = {
  name: "auto_use_dialog",
  title: "自动使用",
  eyebrow: "自动 · 背包",
  size: new Size(420, 480),
  hint: { y: 196, fontSize: T.fontSize.f11, color: T.text[4], width: 380, height: 16 },
  list: { name: "auto_use_list", position: new Vec2(0, 28), size: new Size(380, 330), padding: 3, rowHeight: 24, rowSpacing: 3, fontSize: T.fontSize.f12, color: T.text[1], nameWidth: 240 },
  emptyTip: { position: new Vec2(0, 28), size: new Size(300, 20), fontSize: T.fontSize.f12, color: T.text[3] },
};

//#endregion

//#region 商城弹窗

/**
 * 商城弹窗布局（组件见 ui/components/dialogs/MallDialog；08-mall 稿）
 *
 * 面板走标准弹窗框（createDialog：眉题 MALL · M / 标题「商城」/ 矢量 ×），850×540。
 * 纵向节奏（自顶向下）：余额胶囊 → 分类页签 → 3 列商品卡（两页行）→ 分页页脚 → 面板页脚。
 */

export const mallDialogLayout = {
  name: "mall_dialog",
  title: "商城",
  eyebrow: "快捷键 · M",
  size: new Size(850, 540),
  /** 绑定元宝余额胶囊（稿 .balance：金点 + 文字，右上角） */
  balance: { position: new Vec2(289, 195), size: new Size(200, 30), fontSize: T.fontSize.f12, color: T.gold[4], dot: 10, /** 金点/文字块在胶囊内的 x 与宽（#1115 批次 3 收编组件内联） */ dotX: -84, labelX: 10, labelWidth: 166 },
  /**
   * 分类页签（#758：一排横排按钮，居中均分；挂在弹窗上、卡片区外 —— 换分类时页签不重建）
   *
   * 分类个数不定（运营随时增删），页签从中心向两侧均分（index − (n−1)/2) × (宽 + gap)；
   * 总宽超过 `maxWidth` 时按个数压缩单页签宽度，**最窄不低于 `minWidth`** —— 文字由 SHRINK 兜。
   * 选中页签 = 金描边金字，未选中 = 灰描边 + 压暗（refreshTabs 重描）。
   */
  tabs: {
    position: new Vec2(0, 154),
    size: new Size(88, 28),
    /** 页签宽度上限（= 配置宽度）与下限：分类多到排不下时先压到这个宽度，再窄名字就认不出了 */
    maxWidth: 380,
    minWidth: 40,
    fontSize: T.fontSize.f12,
    gap: 8,
    inactiveOpacity: 140,
  },
  /** 商品卡片区（分页显示，每页只建 columns × rowsPerPage 张卡片；区中心即卡片坐标原点） */
  list: { name: "mall_list", position: new Vec2(0, 7), size: new Size(802, 238) },
  /** 分类下没有商品时的空提示（居中，与页签/卡片同层） */
  emptyTip: { name: "mall_empty_tip", position: new Vec2(0, 7), size: new Size(300, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  /**
   * 商品卡片（一行 columns 张均分列表宽；单卡 260×114 = 稿 .gcard）
   *
   * 卡内自上而下：顶行（46 图标 + 名称/类别两行）→ 限购/库存行 → 购买行（价格左、购买按钮右），
   * 几何全部由布局推导（padding → 顶行 → stats → buy 行贴底），界面里不写死像素。
   */
  card: {
    columns: 3,
    gapX: 10,
    gapY: 10,
    height: 114,
    padding: 12,
    /** 顶行左侧图标（稿 .fig：46×46 圆角小图，装备/物品图标按快照取图） */
    iconSize: new Size(46, 46),
    /** 图标右缘到文字块左缘的间距（#1115 批次 3 收编组件内联的 10） */
    textGap: 10,
    /** 名称（本体一行，前缀色，超长缩字）与类别行（前缀+后缀 / 药品，灰小字） */
    name: { fontSize: T.fontSize.f13, lineHeight: 18, plainColor: T.text[1] },
    kind: { fontSize: T.fontSize.f10, lineHeight: 13, kindColor: T.text[4] },
    /** 限购 / 库存行（#846：今日 2/3 · 剩 5；无限制时不占位） */
    stats: { fontSize: T.fontSize.f10, lineHeight: 13, color: T.text[3], /** 限购行的偏移与文本框（#1115 批次 3 收编组件内联） */ offset: new Vec2(60, -6), size: new Size(120, 13) },
    /** 购买行：价格（金，左对齐块）+ 购买按钮（金键，右贴边） */
    price: { fontSize: T.fontSize.f12, color: T.gold[4], blockWidth: 120 },
    buyButton: { size: new Size(56, 24), fontSize: T.fontSize.f12 },
    /** 置灰态（等级不足 / 售罄 / 买满）：整卡压暗到该不透明度 */
    lockedOpacity: 160,
  },
  /**
   * 分页：每页行数（每页件数 = columns × rowsPerPage）+ 页脚翻页控件（稿 .pager：ghost 键 + 页码胶囊）
   *
   * 页脚是卡片区的子节点（坐标以卡片区中心为原点，卡片区挪位页脚跟着走）：
   * 五件一排居中 —— 首页 / 上一页 / 页码 / 下一页 / 末页，相邻间距 8。
   */
  pagination: {
    rowsPerPage: 2,
    buttonSize: new Size(64, 24),
    gap: 8,
    /** 页码（第 X / Y 页） */
    pageIndicator: { name: "mall_page_indicator", position: new Vec2(0, -138), size: new Size(100, 24), fontSize: T.fontSize.f12, color: T.text[3] },
    /** 四个翻页按钮（首 / 上 / 下 / 末） */
    firstButton: { name: "mall_first_page_button", position: new Vec2(-162, -138) },
    prevButton: { name: "mall_prev_page_button", position: new Vec2(-90, -138) },
    nextButton: { name: "mall_next_page_button", position: new Vec2(90, -138) },
    lastButton: { name: "mall_last_page_button", position: new Vec2(162, -138) },
  },
  /** 面板页脚（稿 .panel-foot）：顶部 1px 分隔线 + 两端各一行小字 */
  foot: dialogFootLayout(new Size(850, 540)),
};

//#endregion

//#region 技能列表弹窗

/** 技能列表弹窗布局 */

export const goodDetailLayout = {
  name: "good_detail",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径）：物品详情 = ITEM */
  eyebrow: "物品",
  size: new Size(240, 200),
  /** 内容区：纵向网格排版的内边距与行间距（头部 / 基础信息 / 回收价 / 标签 / 介绍依次排） */
  padding: 10,
  rowSpacing: 8,
  /** 头部行间距（图标与名称行） */
  headerSpacing: 10,
  /** 基础信息行（等级与部位）：字号与配色（灰字，弱于正文） */
  info: { fontSize: T.fontSize.f12, size: new Size(220, 18), color: T.text[3] },
  /** 回收价行：字号与配色（金色，与绑定元宝呼应） */
  recycle: { fontSize: T.fontSize.f12, size: new Size(220, 18), color: T.amber },
  /**
   * 绑定标记行（「已绑定 · 不可交易」，#789）
   *
   * 只在**这件物品确实绑定**时出现：颜色取琥珀色（与标签行同调但更醒目），排版占一行。
   * 不绑定时不占位 —— 多数掉落物没绑定，留一行空位会让详情弹窗白白变高。
   */
  bound: { fontSize: T.fontSize.f12, size: new Size(220, 18), color: T.gold[4] },
  /**
   * 掉落溯源段（谁掉的 / 哪个怪 / 什么时间，#789；只有装备带溯源）
   *
   * 三行弱灰字，排在回收价下方：颜色比正文淡（它是背景信息，不是玩家要拿它做决策的数据）。
   * 行高 15 与字号 11 配套，三行合计约 45 像素，弹窗仍在一块可见区内。
   */
  origin: { fontSize: T.fontSize.f11, lineHeight: 15, size: new Size(220, 15), color: T.text[4] },
  /** 介绍文本 */
  description: { fontSize: T.fontSize.f12, size: new Size(220, 50), lineHeight: 16 },
  /**
   * 「按住 Ctrl 与身上穿戴对比」段（悬停背包装备、按住左 Ctrl 时出现在属性列表下方）
   * 逐项行的排版沿用上面的属性行（图标 + 属性名 50 + 值区），这里只管配色与提示行
   */
  compare: {
    /** 段标题（「对比 · 身上穿戴」）配色（金色，与回收价行同调） */
    titleColor: T.gold[4],
    /** 差值着色：变强绿 / 变弱红 / 持平灰（绿与战魂弹窗的增量色一致） */
    gainColor: T.jade,
    lossColor: T.ember[4],
    sameColor: T.text[3],
    /** 未按 Ctrl 时的发现提示行（灰字，弱于正文） */
    hintColor: T.text[4],
    hintFontSize: 11,
  },
  /** 标题（装备为三段着色，其他物品单行可换行） */
  title: { fontSize: T.fontSize.f14, size: new Size(170, 40), lineHeight: 20 },
  /** 装备标签行（占名称下方一整行；标签按字数给宽，避免被截断） */
  tag: {
    rowSize: new Size(220, 18),
    /** 标签文字颜色（与白色正文区分，突出标签） */
    color: T.gold[4],
    fontSize: T.fontSize.f11,
    /** 标签之间的横向间距 */
    spacing: 6,
    /** 单条标签的最小宽度与左右留白 */
    minWidth: 24,
    paddingX: 8,
  },
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
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径）：状态/技能悬停框 = TIP */
  eyebrow: "提示",
  /** 初始尺寸（高度只是占位，Layout 会按内容自适应） */
  size: new Size(240, 40),
  /** 内容区内边距与行间距 */
  padding: 10,
  rowSpacing: 6,
  /** 弹窗与锚点图标的间距（上下两侧通用） */
  anchorGap: 6,
  /** 弹窗距屏幕边缘的最小边距（夹在屏内用） */
  screenMargin: 8,
  /** 标题（名称行，可带图标） */
  title: { fontSize: T.fontSize.f14, iconSize: new Size(28, 28) },
  /** 信息行（「名称：值」单行） */
  row: { fontSize: T.fontSize.f12, size: new Size(220, 16) },
  /** 描述（自动换行，高度按内容自适应） */
  description: { fontSize: T.fontSize.f12, lineHeight: 16, size: new Size(220, 0) },
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

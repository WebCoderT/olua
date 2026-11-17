import { Color, Size, Vec2 } from "cc";
import { uiSize } from "./sizes";
import { T } from "./tokens";

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
  /** 缺省弹窗尺寸（createDialog 不传尺寸时使用；ui.css --dlg-w-md / --dlg-h-md） */
  size: new Size(T.stage.dlgWidthMd, T.stage.dlgHeightMd),
  /**
   * 面板本体（ui.css `.panel--rivet`）：
   * 暖炭褐底 + 顶部略亮的明暗过渡 + 1px 古铜金线 + 四角铆钉，全部 Graphics 现画，
   * 不再用九宫拼图 —— 弹窗尺寸变化时金线始终是 1px、铆钉始终是同一个圆，不会跟着拉伸变形。
   */
  panel: {
    /** 底板主色（surface-2） */
    fill: T.surface[2],
    /**
     * 顶部明暗过渡带（模拟 `.panel{background:linear-gradient(165deg,var(--surface-3),var(--surface-2) 62%,#150F08)}`
     * 的亮端）：稿的亮端是 surface-3 —— 早前误配成与主色同档，等于没有渐变，面板一片死平
     */
    fillTop: T.surface[3],
    /** 过渡带占面板高度的比例（自顶向下；稿里 62% 处已到 surface-2，故取 0.42 让亮端止于上半区） */
    fillTopRatio: 0.42,
    /** 外框金线（line-3）与线宽 */
    border: T.line[3],
    borderWidth: T.border.width,
    /** 渐变收尾色（稿 `.panel` 165deg 渐变的最底端 #150F08） */
    gradientBottom: T.surface.panelDeep,
    /** 渐变条数（Graphics 无渐变 API，用等高色带插值；40 条在高 540 的面板上肉眼无缝） */
    gradientSteps: 40,
    /** 内侧一圈极弱高光（模拟 inset 0 1px 0 rgba(255,255,255,.06)） */
    innerHighlight: T.overlay.highlight,
    /** 圆角（--r-3） */
    radius: T.radius.r3,
    /** 四角铆钉：直径、金色、距面板边缘的内缩、铆钉旁的小拖尾点（直径与偏移） */
    rivet: {
      size: T.border.rivet,
      color: T.gold[3],
      inset: 9,
      trailSize: 3,
      trailOffset: 14,
    },
  },
  /**
   * 头部眉题（ui.css `.panel-eyebrow`）：左上角一行小字（`BAG · B` 这类英文缩写），
   * 距弹窗左边缘 `padDialog`、中心距顶边 26（用户拍板 2026-11-18：bag_dialog 540 高时 Y=244），
   * 字号 f10、金色、字距加大
   *
   * 与标题（居中）分工：眉题给键盘快捷键与分区信息，标题才是中文名。
   * 宽高只决定文本对齐框（LEFT + CENTER），不动不影响排版。
   */
  eyebrow: {
    left: T.spacing.padDialog,
    top: 19,
    width: 240,
    height: 14,
    fontSize: T.fontSize.f10,
    color: T.gold[2],
  },
  /** 标题：距弹窗上边缘的内缩、文本高度、宽度两侧内缩、字号与颜色（摆放见 GameUiHelper.createDialog） */
  title: {
    /**
     * 标题中心距弹窗顶边的距离（用户拍板 2026-11-18：以 bag_dialog 实测为准 ——
     * 弹窗 540 高时标题中心 Y=245，即距顶 25；全弹窗统一按此距离）
     */
    insetTop: 25,
    height: 24,
    widthPadding: 60,
    /** 用户拍板（2026-11-18）：全弹窗标题统一 12 号 */
    fontSize: T.fontSize.f12,
    color: T.text[1],
    /** 标题下的短金线（ui.css .panel-title::after，44×1）；gap = 标题下沿到金线中心的距离（Y=226 → 距顶 44） */
    rule: { width: T.border.titleRuleWidth, height: T.border.titleRuleHeight, color: T.gold[3], gap: 7 },
  },
  /**
   * 标题栏拖拽柄（#1090：只有标题栏可拖动弹窗，内容区拖动不影响弹窗位置）
   *
   * 通栏透明条带，从弹窗顶边覆盖到标题金线之下（标题距顶 25 + 高 24 + 金线区 ≈ 56），
   * 垫在标题/眉题/关闭键之下 —— 按标题文字、眉题都是拖拽，按关闭键是关窗。
   */
  headDrag: { height: 56 },
  /**
   * 关闭按钮：尺寸（公共尺寸，见 sizes.uiSize）+ 距弹窗右/上边缘的内缩 + 矢量化 × 的字号与色
   *
   * 内缩按 ui.css `.panel-close` 的 `top:10px; right:12px` 反推中心点（按钮 30×30 居中，故各加 15）。
   */
  closeButton: {
    size: uiSize.closeButtonSize,
    insetX: 27,
    insetY: 25,
    text: "×",
    fontSize: T.fontSize.f18,
    color: T.text[3],
    hoverColor: T.text[1],
  },
};

/**
 * 弹窗页脚几何（ui.css `.panel-foot`）：顶部 1px 分隔线 + 两端各一行小字
 *
 * 16 个弹窗里 13 个有页脚，几何只随面板尺寸变，所以按尺寸算而不是逐屏手抄：
 * 线距面板底 24（`--sp-6` + 字高的一半）、字中心距底 8；两端文字块宽 `textWidth`，
 * 内缘距面板边 `inset`（= `--pad-dialog` 20）→ 左块中心 = -半宽 + inset + 半宽文字块。
 *
 * @param size 弹窗尺寸（页脚按**面板高度**贴底，不含外框）
 * @param textWidth 单侧文字块宽（两端各一块，居中会让长句截断，所以给足）
 */
export function dialogFootLayout(size: Size, textWidth = 300, inset = T.spacing.padDialog) {
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  return {
    lineY: -halfHeight + 24,
    textY: -halfHeight + 8,
    leftX: -halfWidth + inset + textWidth / 2,
    rightX: halfWidth - inset - textWidth / 2,
    width: textWidth,
    height: 14,
    fontSize: T.fontSize.f11,
    color: T.text[4],
    lineColor: T.line[1],
  };
}

//#endregion

//#region 战魂弹窗（左中右三栏）

/**
 * 三栏养成弹窗（战魂 / 称号 / 军衔）的公共几何 —— 一处改、三窗同变
 *
 * 三个弹窗的结构与坐标完全同源（左列表 + 中展示 + 右属性列），差异只在文案、
 * 列表名与中间栏的内容（动画 / 徽记）。数值直接改这里。
 */
/**
 * 成长线三窗（军衔 / 称号 / 战魂）共用的左栏卡片列表
 *
 * 稿 17-growth 是三栏：左 216 列表 / 中 1fr / 右 224，栏间距 col-gap，整体左右各留 18。
 * 面板 880×540 → 内容宽 844，中栏 380；左栏中心 -244、中栏 4、右栏 310。
 * 列表顶 225（头部 45 下沿）、高 392 → 中心 29。
 */
const growthCardList = (name: string, extra?: { borderWidth: number }) => ({
  name,
  position: new Vec2(-244, 29),
  size: new Size(216, 392),
  cardSize: new Size(200, 44),
  cardFontSize: 13,
  stateFontSize: 11,
  /** 卡片文字颜色：选中 / 未激活 / 已激活 */
  selectedColor: T.gold[4],
  lockedColor: T.text[4],
  activeColor: T.jade,
  ...extra,
});
const growthAnimation = { position: new Vec2(4, 30), size: new Size(300, 300) };
const growthAttribute = {
  position: new Vec2(310, 205),
  width: 216,
  spacing: 6,
  fontSize: 12,
  titleColor: T.gold[4],
  rowNameColor: T.text[3],
  rowDiffColor: T.jade,
};
const growthBindGold = { position: new Vec2(310, -150), size: new Size(216, 16), fontSize: 12 };

/** 战魂弹窗布局 */
export const warSoulDialogLayout = {
  name: "war_soul_dialog",
  title: "战魂",
  /** 眉题 = 17-growth 稿原文（军衔/称号/战魂共用一张稿，稿的眉题含三者全称） */
  eyebrow: "成长",
  size: new Size(880, 540),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分） */
  list: growthCardList("soul_list"),
  /** 中：战魂动画（帧率取各等级配置 configs/soul 的 animationFrameRate） */
  animation: growthAnimation,
  /** 中：名称 / 描述 / 当前战魂 / 外显勾选框（槽位坐标，子件坐标以槽位中心为原点） */
  info: {
    position: new Vec2(4, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: T.text[3] },
    current: { position: new Vec2(0, -22), size: new Size(320, 18), fontSize: 12, color: T.gold[4] },
    /** 外显勾选框（勾选后当前等级动画挂到主角右上角，位置见 hud.roleShowLayout.soul） */
    toggle: { position: new Vec2(0, -48), size: new Size(90, 22), fontSize: 13, text: "外显", boxSize: 16, textGap: 18 },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：升级按钮（满级 / 当前阶不在成长链上时都置灰，文案分别走 maxedText、lockedText） */
  upgradeButton: { position: new Vec2(310, -205), text: "升 级", maxedText: "已满级", lockedText: "不可续升" },
  foot: dialogFootLayout(new Size(880, 540), 300),
  footTexts: { left: "左栏列出全部等级 · 点一档看差异", right: "升级消耗绑定元宝，由服务端结算" },
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
  /** 眉题 = 17-growth 稿原文（军衔/称号/战魂共用一张稿） */
  eyebrow: "成长",
  size: new Size(880, 540),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分；34 个称号与战魂 37 个同容器尺寸） */
  list: growthCardList("title_list"),
  /** 中：称号动画（名牌帧原始宽 156~245，弹窗内按 RAW 原尺寸展示） */
  animation: growthAnimation,
  /** 中：名称 / 描述 / 当前称号（槽位坐标，子件坐标以槽位中心为原点；比战魂少一行——没有外显勾选框） */
  info: {
    position: new Vec2(4, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: T.text[3] },
    current: { position: new Vec2(0, -8), size: new Size(320, 18), fontSize: 12, color: T.gold[4] },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：升级按钮（满级 / 当前称号不在成长链上时都置灰，文案分别走 maxedText、lockedText） */
  upgradeButton: { position: new Vec2(310, -205), text: "升 级", maxedText: "已满级", lockedText: "不可续升" },
  foot: dialogFootLayout(new Size(880, 540), 300),
  footTexts: { left: "左栏列出全部等级 · 点一档看差异", right: "升级消耗绑定元宝，由服务端结算" },
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
  /** 眉题 = 17-growth 稿原文（军衔/称号/战魂共用一张稿） */
  eyebrow: "成长",
  size: new Size(880, 540),
  /** 左：阶数卡片竖向滚动列表（100 阶从上到下，状态用颜色区分） */
  list: growthCardList("rank_list", { borderWidth: 2 }),
  /** 中：军衔徽记（文字牌：段名 + 红色军衔名 + 阶数进度） */
  badge: {
    position: new Vec2(4, 30),
    size: new Size(320, 210),
    fill: T.surface[2],
    borderColor: T.gold[4],
    borderWidth: 2,
    /** 段名（如「王爵」） */
    tier: { position: new Vec2(0, 62), size: new Size(290, 22), fontSize: 14, color: T.gold[4] },
    /** 军衔名（红字，与头顶那行同一个色） */
    label: { position: new Vec2(0, 4), size: new Size(290, 40), fontSize: 26, color: T.ember[3] },
    /** 阶数进度（第 N 阶 / 共 100 阶） */
    progress: { position: new Vec2(0, -56), size: new Size(290, 18), fontSize: 12, color: T.text[3] },
  },
  /** 中：名称 / 描述 / 当前军衔（槽位坐标，子件坐标以槽位中心为原点） */
  info: {
    position: new Vec2(4, -145),
    name: { position: new Vec2(0, 42), size: new Size(320, 22), fontSize: 16, color: Color.WHITE },
    description: { position: new Vec2(0, 20), size: new Size(330, 16), fontSize: 11, color: T.text[3] },
    current: { position: new Vec2(0, -8), size: new Size(320, 18), fontSize: 12, color: T.gold[4] },
  },
  /** 右：属性列表（含下一阶增量） */
  attribute: growthAttribute,
  /** 右：绑定元宝余额 */
  bindGold: growthBindGold,
  /** 右：晋升按钮（满衔时文案与置灰） */
  upgradeButton: { position: new Vec2(310, -205), text: "晋 升", maxedText: "已满衔", lockedText: "不可进阶" },
  foot: dialogFootLayout(new Size(880, 540), 300),
  footTexts: { left: "左栏列出全部阶位 · 点一档看差异", right: "晋升消耗绑定元宝，由服务端结算" },
};

//#endregion

//#region 大陆传送官弹窗

/** 弹窗尺寸为 dialogFrame.size（600×500） */
export const mapTeleportDialogLayout = {
  name: "map_teleport_dialog",
  title: "大陆传送官",
  eyebrow: "世界地图",
  /** 内容列（纵向容器，高度自适应）：顶部位置与宽度（弹窗 600，左右各留 10） */
  content: { name: "map_teleport_content", width: 580, top: 215, groupSpacing: 16 },
  /** 分组标题 */
  groupTitle: { fontSize: 14, height: 20, color: T.gold[4] },
  /** 地图按钮网格：每行 4 个（4 × 123 + 3 × 20 = 552，在 580 容器内水平居中） */
  grid: { spacingX: 20, spacingY: 12 },
};

//#endregion

//#region 小地图弹窗（当前地图的整图预览）

/** 弹窗尺寸 720×520（ui.css --dlg-w-lg 一级；19-world-map 稿） */
export const mapPreviewDialogLayout = {
  name: "map_preview_dialog",
  eyebrow: "世界地图",
  size: new Size(720, 520),
  /** 标题兜底文案（正常显示当前地图名，见 SmallMap 传入） */
  title: "小地图",
  /**
   * 预览区：地图 preview.jpg 整图铺满；点击按比例换算成世界坐标（左键寻路 / 右键传送）
   *
   * 稿 19-map 的 `.mview`：内容宽 680、高 330，顶边 205（头部下沿）→ 中心 40、底 -125。
   * 点击换算按**这个尺寸**的比例走，改尺寸不用动代码。
   */
  preview: { name: "map_preview", position: new Vec2(0, 40), size: new Size(680, 330) },
  /** 操作提示（稿的 `.hint` 叠在预览区底部内侧的渐变带上） */
  hint: { text: "左键点击自动寻路，右键点击直接传送", position: new Vec2(0, -108), size: new Size(660, 20), fontSize: T.fontSize.f11, color: T.gold[4] },
  /**
   * 预览图上的静态文字标记（开窗时按配置快照的点位 / 区域建一次，随预览图一起移动/缩放）
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
    npcLabelColor: T.text[1],
    npcLabelFontSize: 12,
    /** NPC 名称与白点的间距（像素：文字底边到白点边缘的距离） */
    npcLabelGap: 2,
    /** 刷怪区怪物名称文字颜色与字号 */
    monsterLabelColor: T.gold[4],
    monsterLabelFontSize: 12,
  },
  /**
   * 预览图上的路线指示线样式（自动寻路期间画出的「角色 → 目标」路线）
   * 白色点状线，单位是预览区像素（与黑点/红点同一坐标系，见 MapPreviewDialog.createPreviewMapper）；
   * 预览区比常驻小地图大得多，故点半径/间距单独配置，不共用 configs/smallMap 的 route*
   */
  route: {
    /** 点与终点圆点的颜色 */
    color: T.text[1],
    /** 单个点半径（像素） */
    dotRadius: 2.5,
    /** 相邻点间距（像素） */
    dotGap: 12,
    /** 终点圆点半径（像素）：比途中的点大一圈 */
    endDotRadius: 7,
  },
  /** 页脚（稿 19-map 的 .panel-foot） */
  foot: dialogFootLayout(new Size(720, 520), 300),
  footTexts: { left: "左键寻路 · 右键直接传送", right: "传送有冷却，战斗中不可用" },
};

//#endregion

//#region 角色信息弹窗

/**
 * 角色信息弹窗（06-role-info 稿）
 *
 * 面板 660×520：五列结构 = 左装备列 / 内观 / 右装备列 / 属性列 / 六入口列
 * （装备列与属性列的几何在 layout/panels，内观是服务端 `equip_in_aligns` 的对齐数据，不在这里摆）。
 */
export const roleInfoDialogLayout = {
  name: "role_info_dialog",
  title: "角色信息",
  eyebrow: "快捷键 · C",
  /** 弹窗尺寸 660×520（06-role-info 稿） */
  size: new Size(660, 520),
  /** 中区底板（稿的内衬区：矢量玻璃底板，尺寸/位置见下；不再用装饰贴图） */
  background: { position: new Vec2(-58, -19), size: new Size(431, 452) },
  /**
   * 六入口按钮的公共外观（稿 `.entries .btn`：76 宽、f12、ghost 档）
   * 宽度取 84（= 稿的列宽），六个按钮等距排成一列，靠右缘留 3
   */
  entryButton: { size: new Size(84, 32), fontSize: T.fontSize.f12 },
  /**
   * 六入口（最右一列，从上到下 = 属性 / 社交 / 时装 / 军衔 / 称号 / 战魂，与稿一致）
   *
   * 六个按钮 32 高 + 8 间距 → 总高 232，纵向居中（中心 100 / 60 / 20 / -20 / -60 / -100）。
   * 横坐标 285 → 占 x 243~327（面板半宽 330）；属性列右缘 244，**间距 1**，改列宽时两处一起看。
   * 三个系统（军衔/称号/战魂）都走这里，不走 NPC（战魂使者 NPC 仍保留，见 configs/npc）。
   */
  attrButton: { name: "role_attr_button", position: new Vec2(285, 100), text: "属 性" },
  socialButton: { name: "role_social_button", position: new Vec2(285, 60), text: "社 交" },
  fashionButton: { name: "role_fashion_button", position: new Vec2(285, 20), text: "时 装" },
  rankButton: { name: "role_rank_button", position: new Vec2(285, -20), text: "军 衔" },
  titleButton: { name: "role_title_button", position: new Vec2(285, -60), text: "称 号" },
  soulButton: { name: "role_soul_button", position: new Vec2(285, -100), text: "战 魂" },
  /**
   * 页脚（稿 `.panel-foot`）：顶部 1px 分隔线 + 两端各一行小字
   * 几何由面板尺寸算（见 dialogFootLayout），文案进 configs/texts
   */
  foot: dialogFootLayout(new Size(660, 520)),
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
  eyebrow: "时装",
  /** 弹窗尺寸 600×500（18-fashion 稿） */
  size: new Size(600, 500),
  /** 顶部「当前穿戴」提示（稿 `.fcur`：头条一个绿点 + 一句，f12；头部下沿 205 − 半行高 10 = 195） */
  current: { position: new Vec2(0, 195), fontSize: T.fontSize.f12 },
  /** 列表（卡片区，四列；稿 `.fgrid` 330 高，中心 8） */
  list: { name: "fashion_list", position: new Vec2(0, 8), size: new Size(560, 330) },
  /** 单张卡片（相对列表内容左上角逐格排布；稿 `.fcard` 152 高，四列宽 132.5） */
  card: {
    size: new Size(132, 152),
    /** 卡片间距（横 / 纵） */
    gap: new Vec2(T.spacing.sp3, T.spacing.sp3),
    /** 一行几列 */
    columns: 4,
    /** 外观图标（尺寸与在卡片内的位置） */
    iconSize: new Size(64, 64),
    iconPosition: new Vec2(0, 36),
    /** 名称（字号与在卡片内的位置、尺寸） */
    labelFontSize: T.fontSize.f13,
    labelPosition: new Vec2(0, -20),
    labelSize: new Size(120, 20),
    /** 状态角标（已穿戴 / 可穿戴） */
    stateFontSize: T.fontSize.f10,
    statePosition: new Vec2(0, -50),
    /** 卡片底色（Graphics 自绘，不依赖底图） */
    fill: T.surface[2],
    /** 已穿戴卡片的描边色 */
    activeBorder: T.gold[3],
    /** 普通卡片描边色 */
    border: T.gold[1],
    /** 未穿戴卡片的角标颜色 */
    stateColor: T.text[3],
    /** 可购买卡片的价格角标色（与绑定元宝同色系） */
    buyColor: T.gold[4],
    /** 未拥有卡片的底色 / 描边 / 图标与名称置灰色（#596：没有的看得到、穿不了） */
    lockedFill: T.surface[1],
    lockedBorder: T.surface[3],
    lockedTint: T.text[4],
  },
  /** 卡片上的状态文案（#596：未拥有的按获取渠道分流 —— 可购买的显示价格，其余置灰） */
  stateText: {
    equipped: "已穿戴",
    wearable: "点击穿上",
    unsupported: "无外观",
    /** 未拥有但可购买（upgrade 渠道且 sellPrice > 0），{price} = 售价 */
    buyable: "{price} 绑定元宝",
    /** 未开放获取渠道（grant / unavailable / 0 价 upgrade） */
    locked: "未开放",
  },
  /** 顶部提示文案（{label} 替换为时装名） */
  currentText: { worn: "当前穿戴：{label}", none: "当前没有穿时装" },
  /** 页脚（稿 18-fashion 的 .panel-foot） */
  foot: dialogFootLayout(new Size(600, 500), 250),
  footTexts: { left: "点卡片即穿脱 · 未拥有的看得到穿不了", right: "时装只改外观，不影响属性" },
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
   * 底部三个操作按钮（子件坐标以弹窗中心为原点；稿 05-bag 实测：118×36、两两间距 14、中心 ±132、
   * 按钮条中心距面板顶 485 → y = -215）—— 与稿一致，不再用 123 宽的中号档
   */
  buttonSize: new Size(118, 36),
  tidyButton: { name: "bag_tidy_button", position: new Vec2(-132, -215) },
  /**
   * 「一键回收」：把背包里的装备整格换成绑定元宝（身上穿着的不算）
   * 回收不可撤销，所以按钮是**两步确认**：第一次点击先看数（件数 + 可得绑定元宝）并变成「确认回收」，
   * 再点一次才真的回收；超时或关掉弹窗自动复位（不会误回收，也不需要额外的确认弹窗）
   */
  recycleButton: {
    name: "bag_recycle_button",
    position: new Vec2(0, -215),
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
    position: new Vec2(132, -215),
    /** 待确认状态保持时间（毫秒），到点自动放弃（与回收、删除角色同一套口径） */
    confirmTimeout: 3000,
  },
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
  balance: { position: new Vec2(289, 195), size: new Size(200, 30), fontSize: T.fontSize.f12, color: T.gold[4], dot: 10 },
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
    /** 名称（本体一行，前缀色，超长缩字）与类别行（前缀+后缀 / 药品，灰小字） */
    name: { fontSize: 13, lineHeight: 18, plainColor: T.text[1] },
    kind: { fontSize: 10, lineHeight: 13, kindColor: T.text[4] },
    /** 限购 / 库存行（#846：今日 2/3 · 剩 5；无限制时不占位） */
    stats: { fontSize: 10, lineHeight: 13, color: T.text[3] },
    /** 购买行：价格（金，左对齐块）+ 购买按钮（金键，右贴边） */
    price: { fontSize: 12, color: T.gold[4], blockWidth: 120 },
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
export const skillListDialogLayout = {
  name: "skill_list_dialog",
  title: "技能",
  eyebrow: "快捷键 · K",
  /** 弹窗尺寸 380×440（07-skill 稿） */
  size: new Size(380, 440),
  /**
   * 剩余技能点（#828，稿 07-skill 的 `.pt-line`）：一行两端 = 左标签「技能点」+ 右数值，
   * 行底一条通栏 1px 分隔线，下面紧接技能列表。
   *
   * 几何按面板 440 高算：头部下沿 175 − 上内距 2 − 半行高 8 → 行中心 165，
   * 分隔线 147，列表顶 139（间距 8）。
   * 升级成功后就地改这一行的数字，不重开弹窗（重开会把滚动位置弹回顶部）。
   */
  points: {
    name: "skill_points",
    y: 165,
    height: 20,
    /** 左标签（左对齐）与右数值（右对齐）：各自 120 宽，内缘距面板边 20 */
    label: { x: -110, width: 120, fontSize: T.fontSize.f12, color: T.text[3] },
    value: { x: 110, width: 120, fontSize: T.fontSize.f16, color: T.gold[4] },
    /** 行底分隔线（通栏 = 内容宽 340） */
    rule: { y: 147, color: T.line[1] },
  },
  /** 技能滚动列表（子件坐标以弹窗中心为原点） */
  list: { name: "skill_list", position: new Vec2(0, -22), size: new Size(340, 322) },
  /**
   * 技能行：图标 + （名称 / 说明）两行文字 + 升级按钮（#828）。
   *
   * 说明必须**换行**：说明列 223.5 宽 × 10 号字一行只放得下 ~20 字，而 `configs/skill-data.ts`
   * 里的说明普遍 40~73 字 —— 单行 CLAMP 会把后半句直接切掉（#481，真机上看就是「说到一半」）。
   * 行高按估算行数自适应（`TextLayout.wrappedHeight`），最多 `maxLines` 行（实测最长 73 字 → 4 行）。
   */
  row: {
    /** 行宽 = 图标 + 间距 + 说明列 + 间距 + 升级按钮（340 = 40 + 10 + 198 + 10 + 56 + 右内距 26） */
    width: 340,
    iconSize: 40,
    gap: 10,
    /** 图标行内左内距（07 稿：图标左缘距行左缘 8） */
    iconInsetLeft: 8,
    /** 行右内距（07 稿：升级按钮右缘距行右缘 12） */
    insetRight: 12,
    desc: {
      /** 说明列宽（= 稿 .mid 的 198） */
      width: 198,
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
    /**
     * 升级按钮（#828）：贴行右缘、与图标同一水平线
     *
     * 尺寸用公共小按钮（56.5 × 24，九宫格不会被压变形）；标注「升级」，
     * **不显示花费** —— `当前等级` 这条公式只在服务端，写到这里就是第二个真相。
     */
    upgrade: { width: 56.5, height: 24, gap: 10, label: "升级" },
    /** 名称行右端的快捷键标注（07 稿 `.key`：右对齐、f10、暗字；没绑键位时不画） */
    shortcut: { width: 90, fontSize: 10 },
  },
  /** 页脚（稿 `.panel-foot`）：左操作提示 / 右升级说明；两块各 160 宽不重叠 */
  foot: dialogFootLayout(new Size(380, 440), 160),
};

//#endregion

//#region 属性加点弹窗（#833）

/**
 * 属性加点弹窗布局
 *
 * 四行固定（力量 / 敏捷 / 体质 / 精神），所以不用 ScrollView —— 四行还要滚是给自己找麻烦。
 * 行内从左到右：名称、已分配点数、作用说明、「+」按钮；底部一枚「洗点」。
 *
 * 说明列故意只写「物理攻击」这类短语而不是百分比：系数在服务端
 * （`growth_scalars.attrPointRatio`，运营随时能改），界面上写死「每点 +0.5%」
 * 就是第二个真相 —— 改配置那天它会开始骗人。
 */
export const attrAllocateDialogLayout = {
  name: "attr_allocate_dialog",
  title: "属性点",
  eyebrow: "加点",
  size: new Size(320, 300),
  /** 剩余点数（与技能面板同一条：紧贴标题下沿，加完就地改数字，不重开弹窗） */
  points: { name: "attr_points", position: new Vec2(0, 102), size: new Size(300, 18), fontSize: 12 },
  /** 四行的容器（锚点左上，子件按行序往下排） */
  list: { name: "attr_list", position: new Vec2(0, 86), size: new Size(300, 168), gap: 8 },
  row: {
    width: 296,
    height: 34,
    /** 名称列（左对齐）：力量 / 敏捷 / 体质 / 精神 */
    nameWidth: 70,
    nameFontSize: 13,
    /** 已分配点数（居中，等宽一格，避免数字位数变化时整行跳） */
    valueWidth: 54,
    valueFontSize: 13,
    /** 作用说明（左对齐、小字） */
    descWidth: 118,
    descFontSize: 10,
    /** 「+」按钮：贴行右缘 */
    add: { width: 30, height: 24, label: "+" },
  },
  /** 洗点按钮（四行下方居中） */
  reset: { name: "attr_reset_button", position: new Vec2(0, -112), width: 120, height: 30, label: "洗 点" },
};

//#endregion

//#region 技能快捷键设置弹窗

/** 技能快捷键设置弹窗布局（尺寸按「快捷键格数」留足：每格 56.5 宽 + 间距 10） */
export const skillShortcutSettingDialogLayout = {
  name: "skill_shortcut_setting_dialog",
  title: "设置快捷键",
  eyebrow: "技能 · 键位",
  /** 弹窗尺寸 370×140（07-skill 稿的 .key-dlg，四角带 bracket 角标） */
  size: new Size(370, 140),
  /** 副标题（稿 .key-hint）：标题下方一行灰字，居中 */
  hint: { y: 15, width: 328, height: 16, fontSize: T.fontSize.f11, color: T.text[3] },
  /**
   * 键位卡片行（稿 .keys）：5 张 56×52 卡片，间距 10（中心距 66），行中心 −23。
   * 卡片上「数字」大、「技能名」小；选中键位 = 金框金字（稿 .keybtn.on）。
   */
  optionsRow: {
    name: "shortcut_key_options",
    spacing: 10,
    y: -23,
    width: 328,
    height: 52,
    keySize: new Size(56, 52),
    number: { fontSize: T.fontSize.f16, offsetY: 8, color: T.text[1] },
    label: { fontSize: T.fontSize.f10, offsetY: -14, color: T.text[3] },
    selected: { border: T.gold[2], number: T.gold[5], label: T.gold[4] },
  },
};

//#endregion

//#region 死亡弹窗（全屏遮罩）

/**
 * 死亡遮罩弹窗布局（自身即全屏节点，坐标为全屏节点中心）
 *
 * 稿 20-overlay 的 `.death`：560 宽的主面板（暗朱径向渐变压在纯色上，Graphics 用
 * 「整块深底 + 上半一条暗朱亮带」近似）+ 标题 36 + 一句说明 + 两枚 196×46 的按钮。
 */
export const deathDialogLayout = {
  name: "death_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "复活",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住世界点击） */
  maskColor: T.surface.scrim,
  /** 主面板（稿 `.death`：560 宽，内容 44/40 内距；这里给固定外框） */
  panel: {
    name: "death_panel",
    position: new Vec2(0, 0),
    size: new Size(560, 260),
    fill: T.surface[0],
    fillTop: T.ember[1],
    fillTopRatio: 0.5,
    border: T.line[2],
    radius: T.radius.r3,
  },
  /** 标题「您已死亡」（稿 38px → 收敛到令牌 f40，不为单屏造新档） */
  title: { text: "您已死亡", position: new Vec2(0, 64), size: new Size(520, 48), fontSize: T.fontSize.f40, color: T.ember[4] },
  /** 标题下的一句说明（复活代价与去处） */
  subtitle: {
    text: "可原地复活（消耗一枚还魂丹），或回到城内安全复活",
    position: new Vec2(0, 20),
    size: new Size(500, 20),
    fontSize: T.fontSize.f12,
    color: T.text[3],
  },
  /** 两个复活按钮（稿 `.acts`：196×46、间距 16、居中 → 中心 ±106） */
  buttonSize: new Size(196, 46),
  buttonFontSize: T.fontSize.f16,
  reviveInPlaceButton: { name: "revive_in_place_button", text: "原地复活", position: new Vec2(-106, -62) },
  reviveSafeButton: { name: "revive_safe_button", text: "安全复活", position: new Vec2(106, -62) },
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
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "提示",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住下层点击；与死亡遮罩同色） */
  maskColor: T.surface.scrim,
  /** 居中面板：尺寸（矢量底板 + 四角铆钉，见 createDialogPanel） */
  panel: { name: "confirm_panel", size: new Size(420, 210) },
  /** 标题（稿 20-overlay .panel-title：亮字居中 + 44×1 金下划线；字号随 2026-11-18 拍板统一 12 号） */
  title: { name: "confirm_title", position: new Vec2(0, 72), size: new Size(360, 26), fontSize: T.fontSize.f12, color: T.text[1] },
  titleUnderline: { position: new Vec2(0, 47), size: new Size(44, 1) },
  /** 右上角关闭按钮（稿 .panel-close：30×30，右缘 12 / 顶缘 10；点它 = 取消） */
  closeButton: { name: "confirm_close_button", position: new Vec2(183, 80), size: new Size(30, 30), fontSize: T.fontSize.f18 },
  /** 正文：宽度固定、高度按内容自适应（稿 .body p：f14 居中、行高 26 ≈ 1.9） */
  message: { name: "confirm_message", position: new Vec2(0, 6), width: 336, fontSize: T.fontSize.f14, lineHeight: 26, color: T.text[2] },
  /** 双按钮（稿 .acts：各宽 110 高 40、间隙 14、整体距底缘约 21；确定 = 危险朱红，取消 = ghost） */
  confirmButton: { name: "confirm_ok_button", position: new Vec2(-62, -64), size: new Size(110, 40), fontSize: T.fontSize.f14 },
  cancelButton: { name: "confirm_cancel_button", position: new Vec2(62, -64), size: new Size(110, 40), fontSize: T.fontSize.f14 },
};

//#endregion

//#region 物品详情弹窗（鼠标悬停在物品图标上时显示）

/** 物品详情弹窗（跟随鼠标，坐标为屏幕中心系） */
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
  info: { fontSize: 12, size: new Size(220, 18), color: T.text[3] },
  /** 回收价行：字号与配色（金色，与绑定元宝呼应） */
  recycle: { fontSize: 12, size: new Size(220, 18), color: T.amber },
  /**
   * 绑定标记行（「已绑定 · 不可交易」，#789）
   *
   * 只在**这件物品确实绑定**时出现：颜色取琥珀色（与标签行同调但更醒目），排版占一行。
   * 不绑定时不占位 —— 多数掉落物没绑定，留一行空位会让详情弹窗白白变高。
   */
  bound: { fontSize: 12, size: new Size(220, 18), color: T.gold[4] },
  /**
   * 掉落溯源段（谁掉的 / 哪个怪 / 什么时间，#789；只有装备带溯源）
   *
   * 三行弱灰字，排在回收价下方：颜色比正文淡（它是背景信息，不是玩家要拿它做决策的数据）。
   * 行高 15 与字号 11 配套，三行合计约 45 像素，弹窗仍在一块可见区内。
   */
  origin: { fontSize: 11, lineHeight: 15, size: new Size(220, 15), color: T.text[4] },
  /** 介绍文本 */
  description: { fontSize: 12, size: new Size(220, 50), lineHeight: 16 },
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
  title: { fontSize: 14, size: new Size(170, 40), lineHeight: 20 },
  /** 装备标签行（占名称下方一整行；标签按字数给宽，避免被截断） */
  tag: {
    rowSize: new Size(220, 18),
    /** 标签文字颜色（与白色正文区分，突出标签） */
    color: T.gold[4],
    fontSize: 11,
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
  eyebrow: "资讯",
  size: new Size(720, 500),
  /**
   * 左右两栏（稿 10-announcement 的 `.board-body`）：左 280 列表 + 14 间距 + 右 390 详情，
   * 两栏同高 388（面板 500 − 头部 45 − 页脚下留白），顶边 205。
   * 左列中心 -202、右列中心 147。
   */
  /** 左：公告条目滚动列表（行高固定，正文在右栏） */
  list: {
    name: "announcement_list",
    position: new Vec2(-202, 11),
    size: new Size(280, 388),
    /** 条目：上下 10 内距 + 标题两行 36 + 4 + 来源行 16 + 10 = 76 */
    itemSize: new Size(268, 76),
    /** 条目间距（条目内部的两行文字几何见下面两项） */
    itemGap: T.spacing.sp3,
    itemTitleFontSize: T.fontSize.f13,
    itemMetaFontSize: T.fontSize.f10,
    /** 条目的标题（两行，可换行）与来源行（左对齐） */
    itemTitle: { position: new Vec2(4, 14), size: new Size(244, 36), lineHeight: 18 },
    itemMeta: { position: new Vec2(4, -22), size: new Size(244, 16) },
    /** 未读条目用亮色标题 + 左上圆点，已读压暗（一眼看出哪几条是新的） */
    unreadTitleColor: T.gold[4],
    readTitleColor: T.text[4],
    itemMetaColor: T.text[4],
    /** 条目底（稿 `.bi`：深底 + 一圈弱线 + 圆角；选中时再叠一层金底） */
    itemFill: T.surface.sunken,
    itemBorder: T.line[1],
    itemRadius: T.radius.r2,
    /** 选中条目的底色（Graphics 自绘，不依赖底图） */
    selectedFill: T.gold[1],
    /** 未读圆点（稿 `.dot` 在条目右上角；相对条目中心） */
    itemDot: { position: new Vec2(118, 22), size: new Size(8, 8) },
  },
  /** 右：选中公告的详情（外框 + 标题 / 级别 · 时间窗 / 分隔线 / 正文滚动区） */
  detail: {
    /** 右栏外框（稿 `.br`：一圈弱线 + 深底 + 圆角） */
    frame: {
      name: "announcement_detail_frame",
      position: new Vec2(147, 11),
      size: new Size(390, 388),
      fill: T.surface.sunken,
      border: T.line[1],
      radius: T.radius.r2,
    },
    title: { name: "announcement_detail_title", position: new Vec2(147, 179), size: new Size(354, 24), fontSize: T.fontSize.f16, color: T.gold[5] },
    /** 级别 · 时间窗（没有选中公告时这里显示空态 / 失败提示） */
    meta: { name: "announcement_detail_meta", position: new Vec2(147, 154), size: new Size(354, 16), fontSize: T.fontSize.f11, color: T.text[4] },
    /** 头部与正文之间的分隔线（稿 `.br-head` 的 border-bottom） */
    divider: { y: 136, color: T.line[1] },
    scroll: { name: "announcement_body_scroll", position: new Vec2(147, -24), size: new Size(354, 290) },
    /** 正文：宽度固定、高度按内容自适应（可换行） */
    body: { name: "announcement_body", fontSize: T.fontSize.f13, lineHeight: 22, width: 346, color: T.text[2] },
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
  /** 眉题：与公告列表弹窗（ANNOUNCEMENT）同一分区 */
  eyebrow: "资讯",
  title: "公告",
  maskColor: T.surface.scrim,
  panel: { name: "announcement_notice_panel", size: new Size(640, 460) },
  /** 标题文本的位置与样式（配色与通用弹窗标题一致） */
  titleLabel: { name: "announcement_notice_title", position: new Vec2(0, 200), size: new Size(560, 26), fontSize: 16, color: T.ember[4] },
  /** 公告列表（纵向滚动，每一条自己撑高） */
  list: { name: "announcement_notice_list", position: new Vec2(0, 20), size: new Size(576, 350) },
  /** 单条公告：标题 / 级别 · 时间窗 / 正文，纵向排列且高度按内容自适应 */
  item: {
    width: 568,
    /** 条目之间与条目内部的纵向间距 */
    itemGap: 22,
    rowGap: 6,
    title: { fontSize: 15, lineHeight: 21, color: T.gold[4] },
    meta: { fontSize: 11, lineHeight: 16, color: T.text[4] },
    body: { fontSize: 13, lineHeight: 20, color: T.text[1] },
  },
  /** 「我知道了」按钮（中号按钮，面板底部居中） */
  confirmButton: { name: "announcement_notice_confirm_button", text: "我知道了", position: new Vec2(0, -200) },
};

/**
 * 选服弹窗（全屏模态，#962）
 *
 * 从**选角页顶部**的「区服：X（点击切换）」手动打开 —— 登录时不自动弹：
 * 绝大多数登录都是回自己那个区，每次都逼人点一次确认只会变成肌肉记忆。
 *
 * 列出**全部未合并的区**（含维护中 / 已关闭，置灰点不动）：玩家要看到「这区还在、
 * 只是进不去」，而不是让它从列表里凭空消失。进过哪些区由服务端给
 * （`GET /zones/mine` 的 `roleCount` / `current`），客户端不自己记一份。
 *
 * 行内三列：区名（左）/ 角色数 · 状态（中）/ 角标「上次在」「推荐」（右）。
 */
export const zoneSelectLayout = {
  name: "zone_select_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "分区",
  maskColor: T.surface.scrim,
  panel: { name: "zone_select_panel", size: new Size(560, 500) },
  /** 标题文本的位置与样式（配色与通用弹窗标题一致） */
  titleLabel: { name: "zone_select_title", position: new Vec2(0, 220), size: new Size(480, 28), fontSize: 18, color: T.ember[4] },
  /** 说明行：为什么必须先选一个区（不同区的角色互不相通） */
  hint: { position: new Vec2(0, 188), size: new Size(500, 20), fontSize: 12, color: T.text[3] },
  /** 区列表（纵向滚动，每行固定高、行间距见 row.gap） */
  list: { name: "zone_select_list", position: new Vec2(0, -20), size: new Size(500, 356) },
  row: {
    size: new Size(496, 58),
    /** 行间距（滚动区 content 的 Layout.spacingY） */
    gap: 10,
    fill: T.surface[1],
    border: T.surface[3],
    /** 当前浏览区的高亮描边（与帮会列表「自己那一行」同一口径） */
    currentBorder: T.gold[4],
    /** 进不去的区（维护中 / 已关闭）：底色压暗、区名变灰。点它有提示，不是静默无反应 */
    disabledFill: T.surface[1],
    radius: 6,
    /** 区名（左列，相对行中心） */
    nameX: -178,
    nameSize: new Size(200, 22),
    nameFontSize: 16,
    nameColor: T.text[1],
    disabledNameColor: T.text[4],
    /** 角色数 · 状态（中列） */
    metaX: -18,
    metaSize: new Size(220, 18),
    metaFontSize: 12,
    metaColor: T.text[3],
    /** 角标：从 tagRightX 起往左一个个摆（最多两个：「上次在」「推荐」） */
    tagRightX: 226,
    tagGap: 6,
    tagSize: new Size(56, 20),
    tagFontSize: 11,
    tagFill: T.line[2],
    tagBorder: T.line[3],
    tagColor: T.gold[4],
  },
  /** 取消按钮（面板底部居中）：打开选服窗不等于必须换区 */
  closeButton: { name: "zone_select_close_button", text: "取消", position: new Vec2(0, -218) },
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
  /**
   * 页面坐标（#389 起本面板内嵌在社交弹窗 600×560 的「帮会」页里，自己不开弹窗）
   *
   * 社交弹窗顶部多出一条页签栏（tabs.y 219 / 高 32 → 占 203~235），原来的顶部行
   * 必须整体下移 60 才不压在页签上（y 208 → 148）。底部到 −236 为止，留出面板下沿。
   */
  guest: {
    hint: { position: new Vec2(0, 148), size: new Size(560, 22), fontSize: 15, color: T.text[1] },
    nameInput: { position: new Vec2(-60, 110), size: new Vec2(360, 34), placeholder: "输入帮会名（2~12 字）" },
    createButton: { name: "guild_create_button", text: "创建帮会", position: new Vec2(195, 110) },
    listTitle: { position: new Vec2(0, 78), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    list: { name: "guild_list", position: new Vec2(0, -86), size: new Size(556, 300) },
  },
  // ---- 已加入帮会 ----
  member: {
    header: { position: new Vec2(-110, 148), size: new Size(340, 24), fontSize: 16, color: T.gold[4] },
    summary: { position: new Vec2(140, 148), size: new Size(280, 22), fontSize: 12, color: T.text[3] },
    notice: { position: new Vec2(0, 116), size: new Size(548, 22), fontSize: 12, color: T.text[2] },
    noticeInput: { position: new Vec2(-60, 86), size: new Vec2(360, 30), placeholder: "输入新公告（0~200 字）" },
    saveButton: { name: "guild_notice_save_button", text: "保存公告", position: new Vec2(195, 86), small: true },
    memberTitle: { position: new Vec2(0, 56), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    memberList: { name: "guild_member_list", position: new Vec2(0, -34), size: new Size(556, 160) },
    applicantTitle: { position: new Vec2(0, -126), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    applicantList: { name: "guild_applicant_list", position: new Vec2(0, -184), size: new Size(556, 104) },
    /** 退出 / 解散二选一（帮主只能解散、成员只能退出），一律摆 singleButtonPosition */
    leaveButton: { name: "guild_leave_button", text: "退出帮会", small: true },
    disbandButton: { name: "guild_disband_button", text: "解散帮会", small: true },
    /** 只剩一个按钮时（帮主只能解散、成员只能退出）居中摆放，避免偏在一边 */
    singleButtonPosition: new Vec2(0, -254),
  },
  /** 列表行（三种行共用同一套几何与配色） */
  row: {
    size: new Size(556, 48),
    /** 行底色 / 描边 / 自己的那一行的高亮描边 */
    fill: T.surface[1],
    border: T.surface[3],
    selfBorder: T.gold[4],
    /** 行内文字：主名 / 次要信息 */
    nameFontSize: 14,
    metaFontSize: 11,
    metaColor: T.text[3],
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
    guestHintWithCost: "建帮需 {need}，也可以直接申请加入下面的帮会",
    /** 建帮门槛的两个分句 + 连接符（门槛数值来自快照，单位词留在这里） */
    createNeedLevel: "{level} 级",
    createNeedBindGold: "{amount} 绑定元宝",
    createNeedJoin: " + ",
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
    /** 任命 / 卸任副帮主（#871；同一个按钮按目标当前职位换字，所以两个字都得短） */
    appoint: "任命",
    demote: "卸任",
    appointedTip: "已任命为副帮主",
    demotedTip: "已卸任副帮主",
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
  eyebrow: "好友 · 帮会",
  /** 比通用弹窗高 60：多出来的一行放页签（帮会页的坐标因此可以原样复用） */
  size: new Size(600, 560),
  /**
   * 页签栏（选中金色底、未选中暗色底；x 是各页签中心，从「帮会」到「附近」）
   * 稿 13-social：五枚 96 宽 + 6 间距 = 504（内容宽 560），整行居中 → ±102 步进
   */
  tabs: {
    y: 219,
    size: new Size(96, 32),
    columns: [-204, -102, 0, 102, 204],
    /** 与 texts.tabs 一一对应，别只改一处 */
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 列表行（与帮会列表同一套几何与配色） */
  row: {
    size: new Size(556, 52),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    nameFontSize: T.fontSize.f13,
    metaFontSize: T.fontSize.f11,
    metaColor: T.text[3],
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
    input: { position: new Vec2(-70, -226), size: new Vec2(400, 30) },
    button: { position: new Vec2(195, -226) },
  },
  /** 小字（段落标题用金色，空态用灰） */
  titleColor: T.gold[4],
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
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "反馈",
  maskColor: T.surface.scrim,
  panel: { name: "report_panel", size: new Size(460, 320) },
  title: { name: "report_title", position: new Vec2(0, 122), size: new Size(400, 26), fontSize: 16, color: T.ember[4] },
  /** 提示行（被举报人 + 一句话说明举报只落库） */
  hint: { name: "report_hint", position: new Vec2(0, 86), size: new Size(400, 20), fontSize: 13, color: T.text[2] },
  /** 类别小按钮：一行四个（中心 x 从 -135 到 135，间隔 90） */
  category: {
    y: 44,
    columns: [-135, -45, 45, 135],
    size: new Size(84, 30),
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    radius: T.radius.r2,
    fontSize: T.fontSize.f12,
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
 * 进游戏自动打开（引导进行中除外）。**常驻不可关闭**（2026-11-18 用户拍板）：
 * 稿里的两颗工具钮（清屏 / 收起）已删，窗体没有关闭入口。
 *
 * 停靠位置算过两侧邻居：左下角摇杆 175×172（margin 24/18，顶到 y=-185），
 * 任务追踪栏三行到 y=124 —— 本窗 marginY 205（下缘 y=-170）到 y=110，两头都不叠。
 *
 * 气泡（bubbles）不是窗体的一部分：它是屏幕左上角的常驻演出（窗关着的时候新消息往上冒），
 * 布局放在这里只是因为「聊天的长相关什么」都归这一块管。
 */
export const chatDialogLayout = {
  name: "chat_box",
  /** 稿 `.chat{width:424px;height:302px}` */
  size: new Size(424, 302),
  /** 常驻停靠：屏幕左下角（稿 left 20 / bottom 18 → 中心 (-960+20+212, -540+18+151)） */
  position: new Vec2(-728, -371),
  /**
   * 窗体底板（稿 `.chat .panel` 是 `panel panel--rivet`：暖炭褐半透明 + 古铜金发丝线 + r-3 + 四角铆钉）
   *
   * **必须与其它 HUD 面板同一套**：早前这里是 `scrim`（纯黑 62%）+ `surface[0]` 描边，
   * 在小地图与底栏旁边看就是「一个没有边框的黑洞」—— 暖褐面板之间夹一块冷黑，
   * 三处 UI 各说各话（2026-11-17 用户指出）。面板类统一 `surface.glass` + `line[3]`。
   */
  box: {
    /** 稿 `.chat .panel` = `panel--rivet`：linear-gradient(160deg,rgba(28,20,12,.94),rgba(16,11,7,.9)) */
    fill: new Color(19, 13, 8, 240),
    /** 渐变亮端（顶）与过渡带占比：Graphics 没有渐变，用「底 + 顶带」近似 */
    fillTop: new Color(28, 20, 12, 240),
    fillTopRatio: 0.5,
    border: T.line[3],
    radius: T.radius.r3,
    borderWidth: T.border.width,
    padding: 12,
  },
  /**
   * 页签（四个：世界 / 同图 / 帮会 / 私聊；贴窗顶左侧一格排开）
   *
   * 稿 `.chat-tabs{display:flex;gap:5px}` + `button{height:22px;padding:0 9px;font-size:11px}`：
   * 四个页签只占头部左半（约 175px），不是四条通栏；选中 = 金渐变底 + `text-on-gold` 字，
   * 未选中 = 半透明黑底 + `line-2` 描边 + `text-3` 字。
   */
  tabs: {
    y: 131,
    size: new Size(50, 22),
    columns: [-175, -120, -65, -10],
    radius: T.radius.r2,
    /** 稿是 `linear-gradient(180deg,gold-4,gold-3)`：平涂取中间档 gold-3，文字用深色 */
    activeFill: T.gold[3],
    activeText: T.text.onGold,
    idleFill: T.surface.sunken,
    idleText: T.text[3],
    idleBorder: T.line[2],
    fontSize: T.fontSize.f11,
  },
  /**
   * 头/底的 1px 暗分隔线（稿 `.chat-head{border-bottom:1px solid rgba(0,0,0,.55)}`、
   * `.chat-in{border-top:1px solid rgba(0,0,0,.55)}`）
   * 位置是分隔线在面板内的中心 y：头部下沿 = 151 - (9+22+8) = 112，输入行上沿 = -151 + 44 = -107
   */
  dividers: { color: new Color(0, 0, 0, 140), headY: 112, inputY: -107 },
  /** 消息列表（窗体主体，位于两条分隔线之间） */
  list: { name: "chat_message_list", position: new Vec2(0, 2), size: new Size(400, 210) },
  /**
   * 消息行：时间戳 + 发送者名（按关系上色）+ 正文
   *
   * 稿 `.msg` 是**纯文字行**（没有行底板）：`[19:58] [世界] 铁头: 收 40 级武器`。
   * 早前每行一块 `surface[1]` 深底 + 看不见的 `surface[3]` 描边，聊天气泡区看着像一排黑条；
   * 这里底板与描边都置透明（组件据此跳过绘制），文字色单独给 `text`。
   */
  row: {
    size: new Size(376, 22),
    fill: T.overlay.transparent,
    border: T.overlay.transparent,
    radius: 6,
    nameFontSize: T.fontSize.f11,
    textFontSize: T.fontSize.f11,
    /** 时间戳（稿 `.msg .t`：9.5px、text-4、等宽） */
    timeX: -172,
    timeSize: new Size(34, 16),
    timeFontSize: T.fontSize.f10,
    /** 名字列（时间戳右侧；名字 bbox 右缘与正文左缘留 2px 缝） */
    nameX: -104,
    nameSize: new Size(96, 16),
    /** 正文列（吃剩下的宽度） */
    textX: 54,
    textSize: new Size(208, 18),
    metaColor: T.text[3],
    /** 正文色（稿 `--text-2`） */
    text: T.text[2],
  },
  /**
   * 输入行（贴窗底；私聊有对象时旁边多一枚「返回」）
   *
   * 稿 `.chat-in{padding:8px 12px 10px}`：左侧频道 chip（26 高）｜ 输入框（26 高，吃满剩余）｜
   * 金色发送键（26 高、最小 56 宽）。
   */
  inputRow: {
    /** 当前频道 chip（稿 `.chat-in .chip`：26 高、`line-2` 边、金-4 字 + ▾） */
    chip: { position: new Vec2(-172, -122), size: new Vec2(56, 26), fontSize: T.fontSize.f11, fill: T.surface.input, border: T.line[2], radius: T.radius.r1 },
    /**
     * 输入条：26 高的窄框必须有底板 + 小字号 —— 默认 24 号字的字形就 24 高，
     * 在 26 高的框里会顶出上下边、贴到窗体边框上（#477 顺带发现）
     */
    input: {
      position: new Vec2(-26, -122),
      size: new Vec2(220, 26),
      fontSize: T.fontSize.f11,
      /** 稿 `.chat-in .input`：rgba(0,0,0,.42) 沉底 + `line-2` 发丝线 */
      fill: T.surface.input,
      border: T.line[2],
      radius: T.radius.r2,
    },
    /** 发送键（稿 `.btn--gold`：金渐变底 + 深字，min-width 56） */
    send: {
      position: new Vec2(112, -122),
      size: new Vec2(56, 26),
      fontSize: T.fontSize.f11,
      fill: T.gold[3],
      fillTop: T.gold[4],
      border: T.gold[5],
      text: T.text.onGold,
    },
    back: { position: new Vec2(176, -122), size: new Vec2(44, 26) },
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
    fill: T.surface[1],
    border: T.surface[3],
    radius: 6,
    /** 停留毫秒（到了自己消失；新消息来了重置计时） */
    lifetimeMs: 6000,
    /** 正文截断（气泡里只求「知道有人说话」，全量在面板里看） */
    textMaxLength: 40,
  },
  /** 小字 */
  titleColor: T.gold[4],
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["世界", "同图", "帮会", "私聊"],
    worldEmpty: "（还没有人说第一句——输入框在下面）",
    mapEmpty: "（同图频道还没有消息；跟眼前的人打个招呼）",
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
    inputWorld: "对全世界说点什么…",
    inputMap: "对同图的人说点什么…",
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
  eyebrow: "冒险",
  size: new Size(600, 540),
  /** 页签（两枚，与聊天弹窗同款式；角标直接在页签文案后追加「·N」，不另设小字样式） */
  tabs: {
    /** 头部下沿 225 − 半行高 16 = 209（下边距 12 之后是列表顶 181） */
    y: 209,
    size: new Size(96, 32),
    columns: [-51, 51],
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 任务列表（框体主体；稿 `.qlist` 396 高，中心 -17） */
  list: { name: "quest_list", position: new Vec2(0, -17), size: new Size(556, 396) },
  /** 任务行：名称 + 进度（左）+ 动作按钮（右） */
  row: {
    size: new Size(552, 64),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    nameFontSize: T.fontSize.f14,
    textFontSize: T.fontSize.f11,
    nameColor: T.gold[5],
    metaColor: T.text[3],
    readyColor: T.jade,
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
    rewards: "奖励：绑定元宝 {bindGold} · 经验 {exp}",
    /** 接取 / 交付失败的兜底提示（服务端的错误文案更具体，走请求层统一提示） */
    acceptFailed: "接取失败",
    submitFailed: "交付失败",
    /** 接取成功的飘字（{name} = 任务名） */
    acceptedTip: "已接取「{name}」",
  },
  /** 页脚（稿 11-quest 的 .panel-foot）：左入口说明 / 右结算说明 */
  foot: dialogFootLayout(new Size(600, 540), 250),
  footTexts: { left: "左侧任务追踪整块可点打开本窗", right: "交付奖励由服务端结算" },
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
  eyebrow: "快捷键 · G",
  size: new Size(600, 540),
  /** 页签（两枚 96 宽，与任务弹窗同款；头部下沿 225 − 小结 30 − 半行高 16 = 179） */
  tabs: {
    y: 179,
    size: new Size(96, 32),
    columns: [-51, 51],
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 顶部小结（「3 / 4 人 · 同图 2 人」；没队伍时显示一句引导）—— 稿 `.psum` 在页签上方 */
  summary: { position: new Vec2(0, 215), size: new Size(556, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  /** 成员 / 候选列表（稿 `.plist` 360 高，中心 -27） */
  list: { name: "party_member_list", position: new Vec2(0, -27), size: new Size(556, 360) },
  /** 成员行：名字 + 等级/状态（左）+ 动作按钮（右，最多两枚） */
  row: {
    size: new Size(552, 56),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    nameFontSize: T.fontSize.f13,
    metaFontSize: T.fontSize.f11,
    nameColor: T.text[1],
    metaColor: T.text[3],
    leaderColor: T.gold[4],
    offlineColor: T.text[4],
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
    fill: T.surface[2],
    border: T.gold[2],
    radius: T.radius.r2,
    acceptX: 150,
    declineX: 232,
    /** 同上：文本框左缘 + 16 = 行内左缘（x = −100，宽 320），两枚小按钮落在 121.75~260.25 不越行 */
    nameX: -100,
    nameSize: new Size(320, 20),
    textFontSize: T.fontSize.f12,
  },
  /** 底部按钮（邀请 / 退出 / 解散；不是队长的「解散」不画）—— 列表底 -207 − 12 − 半高 15 = -234 */
  footer: {
    invite: new Vec2(-150, -234),
    leave: new Vec2(0, -234),
    disband: new Vec2(150, -234),
  },
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
  eyebrow: "荣誉",
  size: new Size(600, 540),
  /** 页签（三枚 96 宽 + 6 间距，整行居中；头部下沿 225 − 半行高 16 = 209） */
  tabs: {
    y: 209,
    size: new Size(96, 32),
    columns: [-102, 0, 102],
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 顶部小结（共几人上榜 + 这份快照的时刻；稿 `.rsum` 在页签下居中） */
  summary: {
    position: new Vec2(0, 175),
    size: new Size(556, 20),
    fontSize: T.fontSize.f11,
    color: T.text[4],
    /** 「刚刚更新」的界线（毫秒）：快照比这个还新就不写时分 */
    freshMs: 60_000,
  },
  /** 榜单列表（稿 `.rlist` 330 高，中心 -10） */
  list: { name: "leaderboard_list", position: new Vec2(0, -10), size: new Size(556, 330) },
  /** 一条名次：名次（左）+ 名字 + 关键数值（右）；稿 `.rrow` 46 高 */
  row: {
    size: new Size(552, 46),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    rankX: -252,
    rankSize: new Size(44, 20),
    rankFontSize: 14,
    rankColor: T.text[3],
    /** 前三名的名次数字用金色（一眼看出榜头） */
    topRankColor: T.gold[4],
    /** 金色名次的界线：名次 ≤ 这个数就用金色（第 4 名开始是普通灰） */
    topRankThreshold: 3,
    /**
     * 名次列（−274~−230）之后接名字列：名字 bbox 从 −222 起（留 8px 间隙），宽 220 → x = −112；
     * 再往右是数值列（14~254）。原来写 −186（bbox 左缘 −296，跑出行外 20px，被遮罩裁掉，见 #477）
     */
    nameX: -112,
    nameSize: new Size(220, 20),
    nameFontSize: 13,
    nameColor: T.text[1],
    metaX: 134,
    metaSize: new Size(240, 18),
    metaFontSize: 11,
    metaColor: T.text[3],
    /** 我自己那一行的底色与边框（滚到哪都认得出来） */
    selfFill: T.surface[3],
    selfBorder: T.gold[4],
  },
  /** 底部固定的「我的名次」条（稿 `.rself` 42 高，列表底 -175 − 10 − 21 = -206） */
  selfRow: {
    position: new Vec2(0, -206),
    size: new Size(552, 42),
    fill: T.surface[2],
    border: T.gold[2],
    radius: T.radius.r2,
    textFontSize: T.fontSize.f11,
    textColor: T.gold[4],
  },
  /** 页脚（稿 15-rank 的 .panel-foot） */
  foot: dialogFootLayout(new Size(600, 540), 250),
  footTexts: { left: "每小时刷新一次 · 只列在线过的角色", right: "点击页签切换维度" },
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

//#region 选线弹窗（#1016）

/**
 * 选线弹窗（小地图的「N 线」标签打开，#1016）
 *
 * 列出这张图的**全部线**（0..maxChannels-1，玩家视角 1..N 线；服务端口径公共线 = 0，
 * 显示时 +1），当前线高亮并标「当前」。点一行发一次 `changeChannel`：成功关窗飘字，
 * 失败按 `field` 提示并留在弹窗里（换线是可逆操作，服务端总是回帧）。
 *
 * 数据是**纯本地**的：线数读配置快照的 `maps`（#812 已下发），当前线读 `world` 帧
 * 带回的 `channel` —— 不需要为开一个弹窗拉接口。行数就是 maxChannels，通常 ≤ 3，
 * 滚动区只是防「运营把某张图开到十几条线」的保底。
 */
export const channelSelectLayout = {
  name: "channel_select_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "频道",
  maskColor: T.surface.scrim,
  panel: { name: "channel_select_panel", size: new Size(420, 400) },
  /** 标题（配色与选服弹窗同一套） */
  titleLabel: { name: "channel_select_title", position: new Vec2(0, 170), size: new Size(360, 28), fontSize: 18, color: T.ember[4] },
  /** 说明行：告诉玩家换线意味着什么（各线怪物与掉落独立，人挤就换线） */
  hint: { position: new Vec2(0, 142), size: new Size(380, 20), fontSize: 12, color: T.text[3] },
  /** 线列表（纵向滚动；行高与间距见 row） */
  list: { name: "channel_select_list", position: new Vec2(0, -8), size: new Size(372, 240) },
  row: {
    size: new Size(368, 52),
    /** 行间距（滚动区 content 的 Layout.spacingY） */
    gap: 10,
    fill: T.surface[1],
    border: T.surface[3],
    /** 当前所在线的高亮描边（与选服弹窗「上次在」同一套金色） */
    currentBorder: T.gold[4],
    radius: 6,
    /** 线名（左列） */
    nameX: -120,
    nameSize: new Size(180, 22),
    nameFontSize: 16,
    nameColor: T.text[1],
    /** 「当前」角标（贴右） */
    tagX: 140,
    tagSize: new Size(52, 20),
    tagFontSize: 11,
    tagFill: T.line[2],
    tagBorder: T.line[3],
    tagColor: T.gold[4],
  },
  /** 取消按钮：打开选线窗不等于必须换 */
  closeButton: { name: "channel_select_close_button", text: "取消", position: new Vec2(0, -158) },
};

//#endregion

/**
 * 成长线三窗（战魂 / 称号 / 军衔）布局：左列表 + 中展示 + 右属性列，三窗同源
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

const growthCardList = (name: string, extra?: { borderWidth: number }) => ({
  name,
  position: new Vec2(-314, 29),
  size: new Size(216, 392),
  /** 卡片尺寸与行距（稿 .gitem 46 高、.glist gap 6；宽 = 216 − 右 4 内缩） */
  cardSize: new Size(212, 46),
  gap: 6,
  radius: T.radius.r2,
  /** 阶号圆徽（稿 .step：26 圆、字号 11） */
  stepSize: 26,
  stepFontSize: T.fontSize.f11,
  cardFontSize: T.fontSize.f13,
  stateFontSize: T.fontSize.f11,
  /** 卡片底 / 边：常态 `rgba(0,0,0,.24)` + line-1，选中金淡底 + 金边 */
  fill: T.surface.input,
  fillSelected: T.line[1],
  borderColor: T.line[1],
  borderSelected: T.gold[3],
  /** 卡片文字颜色：选中 / 已激活 / 未激活 */
  selectedColor: T.gold[4],
  activeColor: T.jade,
  lockedColor: T.text[4],
  /** 圆徽：环 / 底 / 字（选中 = 金底深字） */
  stepRing: T.line[2],
  stepFill: T.surface[3],
  stepText: T.text[3],
  stepFillSelected: T.gold[3],
  stepTextSelected: T.text.onGold,
  ...extra,
});

/** 中栏容器（稿 `.gcenter`：line-1 边框 + 深底 + 圆角 r2，撑满三栏高度） */

const growthCenter = {
  position: new Vec2(-4, 29),
  size: new Size(368, 392),
  fill: T.surface.sunken,
  border: T.line[1],
  radius: T.radius.r2,
};


const growthAttribute = {
  /** 属性列顶边贴内容区顶（稿 .gside 的 padding-top 8）：纵向容器锚点顶对齐，位置即顶边 */
  position: new Vec2(310, 213),
  width: 224,
  spacing: 6,
  fontSize: T.fontSize.f12,
  titleFontSize: T.fontSize.f13,
  titleColor: T.gold[4],
  rowNameColor: T.text[3],
  rowDiffColor: T.jade,
};

/**
 * 右栏底部「消耗 / 余额」两行（稿 `.gcost`：分隔线 + 两行 kv + 块级按钮）
 * 行两侧对齐：名称贴右栏左缘、数值贴右栏右缘。
 */

const growthCost = {
  line: { y: -8, width: 224, color: T.line[1] },
  costY: -26,
  balanceY: -50,
  leftX: 198,
  rightX: 422,
  fontSize: T.fontSize.f11,
  valueFontSize: T.fontSize.f12,
  nameColor: T.text[3],
  valueColor: T.text[1],
};

/** 升级/晋升按钮（稿 `.gbtn.btn--block`：通栏 224×46、16 号字） */

const growthUpgradeButton = {
  size: new Size(224, 46),
  fontSize: T.fontSize.f16,
  position: new Vec2(310, -90),
};

/**
 * 按钮下的提示行（稿 `.showline`：半透明底 + line-1 边 + r2 的框，金勾 + 小字两行内）
 * 高度按「2 行 11 号字 + 上下 8 内边距」定，文字块在框内垂直居中（1 行也居中）
 */

const growthShowline = {
  position: new Vec2(310, -140),
  size: new Size(224, 44),
  radius: T.radius.r2,
  fill: T.surface.input,
  border: T.line[1],
  padding: 8,
  gap: 8,
  fontSize: T.fontSize.f11,
  color: T.text[3],
  checkColor: T.gold[3],
  checkSize: 15,
};

/** 中栏名称下的描述文字块高度：固定 2 行（稿 `.gdesc` line-height 1.8），1 行也按 2 行占位保证纵向节奏 */

const growthDescHeight = 34;

/** 战魂弹窗布局 */

export const warSoulDialogLayout = {
  name: "war_soul_dialog",
  title: "战魂",
  /** 眉题 = 17-growth 稿原文（军衔/称号/战魂共用一张稿，稿的眉题含三者全称） */
  eyebrow: "成长",
  size: new Size(880, 540),
  /** 左：等级卡片竖向滚动列表（卡片按等级从上到下，状态用颜色区分） */
  list: growthCardList("soul_list"),
  /** 中：三栏容器底（边框 + 深底），垫在动画与文字之下 */
  center: growthCenter,
  /** 中：战魂动画（帧率取各等级配置 configs/soul 的 animationFrameRate；按槽位等比缩放） */
  animation: { position: new Vec2(-4, 102), size: new Size(300, 224) },
  /**
   * 中：名称 / 描述 / 当前战魂 / 外显勾选框（子件坐标以弹窗中心为原点）
   * 纵向节奏按稿 `.gcenter`（flex 居中、gap 12）：整组在 392 高的中栏里上下留白相等（中栏绝对范围 225 ~ -167，中心 29），
   * 自顶向下 = 动画 224 → 12 → 名称 26 → 12 → 描述 34 → 10 → 当前 18 → 12 → 外显 22。
   */
  info: {
    name: { position: new Vec2(-4, -35), size: new Size(340, 26), fontSize: T.fontSize.f20, color: T.gold[5] },
    /** 描述是换行文本，定高 2 行、position 是**文字块中心**（1 行时也在块内居中） */
    description: { position: new Vec2(-4, -77), width: 340, height: growthDescHeight, lineHeight: 15, fontSize: T.fontSize.f11, color: T.text[3] },
    current: { position: new Vec2(-4, -113), size: new Size(340, 18), fontSize: T.fontSize.f11, color: T.gold[4] },
    /** 外显勾选框（勾选后当前等级动画挂到主角右上角，位置见 hud.roleShowLayout.soul） */
    toggle: { position: new Vec2(-4, -145), size: new Size(120, 22), fontSize: T.fontSize.f12, text: "外显", boxSize: 16, textGap: 18 },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: growthAttribute,
  /** 右：消耗 / 余额两行 */
  cost: growthCost,
  /** 右：绑定元宝余额 */
  bindGold: { fontSize: T.fontSize.f11 },
  /** 右：升级按钮（满级 / 当前阶不在成长链上时都置灰，文案分别走 maxedText、lockedText） */
  upgradeButton: { ...growthUpgradeButton, text: "升 级", maxedText: "已满级", lockedText: "不可续升", tone: "gold" },
  /** 按钮下提示行文案（稿 .showline） */
  showline: { ...growthShowline, text: "勾选「外显」后，当前战魂挂在主角右上角" },
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
  /** 中：三栏容器底 */
  center: growthCenter,
  /** 中：称号动画（名牌帧原始宽 156~245，弹窗内按 RAW 原尺寸展示，槽位只做居中） */
  animation: { position: new Vec2(-4, 85), size: new Size(300, 110) },
  /** 中：名称 / 描述 / 当前称号（比战魂少一行——没有外显勾选框；整组在中栏内垂直居中） */
  info: {
    name: { position: new Vec2(-4, 5), size: new Size(340, 26), fontSize: T.fontSize.f20, color: T.gold[5] },
    description: { position: new Vec2(-4, -37), width: 340, height: growthDescHeight, lineHeight: 15, fontSize: T.fontSize.f11, color: T.text[3] },
    current: { position: new Vec2(-4, -73), size: new Size(340, 18), fontSize: T.fontSize.f11, color: T.gold[4] },
  },
  /** 右：属性列表（含下一级增量） */
  attribute: growthAttribute,
  /** 右：消耗 / 余额两行 */
  cost: growthCost,
  bindGold: { fontSize: T.fontSize.f11 },
  /** 右：升级按钮（满级 / 当前称号不在成长链上时都置灰，文案分别走 maxedText、lockedText） */
  upgradeButton: { ...growthUpgradeButton, text: "升 级", maxedText: "已满级", lockedText: "不可续升", tone: "gold" },
  /** 按钮下提示行文案 */
  showline: { ...growthShowline, text: "称号解锁后常显头顶，全服可见" },
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
  /** 中：三栏容器底 */
  center: growthCenter,
  /**
   * 中：军衔徽记（稿 `.emblem`：150 圆、金环 + 深底，环内一枚大字 + 段名小字；
   * 军衔没有素材动画，徽记就是它的外观）
   */
  badge: {
    position: new Vec2(-4, 85),
    size: new Size(150, 150),
    fill: T.surface[2],
    borderColor: T.gold[2],
    borderWidth: 2,
    /** 环内大字（军衔名的末字） */
    glyph: { position: new Vec2(0, 8), size: new Size(120, 52), fontSize: T.fontSize.f40, color: T.gold[4] },
    /** 段名（如「王爵」，金环内下方的小字） */
    tier: { position: new Vec2(0, -38), size: new Size(120, 16), fontSize: T.fontSize.f11, color: T.gold[2] },
    /** 稿 `.emblem::after` 的虚线外环（金环外一圈小点，圆点数 / 半径 / 点径 / 点色） */
    ring: { dots: 36, radius: 83, dotSize: 3, color: T.line[2] },
  },
  /** 中：名称 / 描述 / 当前军衔（整组在中栏内垂直居中：徽记 150 → 12 → 名称 → 12 → 描述 → 10 → 当前） */
  info: {
    name: { position: new Vec2(-4, -15), size: new Size(340, 26), fontSize: T.fontSize.f20, color: T.gold[5] },
    description: { position: new Vec2(-4, -57), width: 340, height: growthDescHeight, lineHeight: 15, fontSize: T.fontSize.f11, color: T.text[3] },
    current: { position: new Vec2(-4, -93), size: new Size(340, 18), fontSize: T.fontSize.f11, color: T.gold[4] },
  },
  /** 右：属性列表（含下一阶增量） */
  attribute: growthAttribute,
  /** 右：消耗 / 余额两行 */
  cost: growthCost,
  bindGold: { fontSize: T.fontSize.f11 },
  /** 右：晋升按钮（满衔时文案与置灰） */
  upgradeButton: { ...growthUpgradeButton, text: "晋 升", maxedText: "已满衔", lockedText: "不可进阶", tone: "gold" },
  /** 按钮下提示行（文案含当前预览的军衔名，见 texts 的 hint_rank_show） */
  showline: { ...growthShowline, text: "" },
  foot: dialogFootLayout(new Size(880, 540), 300),
  footTexts: { left: "左栏列出全部阶位 · 点一档看差异", right: "晋升消耗绑定元宝，由服务端结算" },
};

//#endregion

//#region 大陆传送官弹窗

/** 弹窗尺寸为 dialogFrame.size（600×500） */

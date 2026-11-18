/**
 * 角色线弹窗（角色信息 / 时装 / 技能列表 / 属性分配 / 技能快捷键）布局
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

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
  current: { position: new Vec2(0, 195), fontSize: T.fontSize.f12, size: new Size(540, 24) },
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
    /** 状态字文本框（#1115 批次 3 收编组件内联） */
    stateSize: new Size(122, 18),
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

//#region 属性弹窗（#833 加点；22-attributes 稿改为总览＋加点合一）

/**
 * 属性弹窗布局（22-attributes 稿：420×460，panel--rivet）
 *
 * 替换 06 稿时代的 320×300 加点小弹窗：角色信息「属性」入口改开本窗。
 * 三段自上而下（一屏看完）：剩余属性点 → 战斗属性总览（两列 10 项）→ 四维加点，
 * 底部一条说明（稿 .panel-foot）。战斗属性数值全部来自服务端 roleUpdate 下发的
 * `BattleAttributes`（装备/称号/战魂/军衔加成已汇总），客户端零计算、只展示。
 *
 * 洗点条已移除（#1113）：客户端不再提供洗点入口（服务端接口保留）；
 * 洗点区腾出后弹窗 580 → 460 收拢，底栏说明贴住加点行。
 *
 * 四行加点固定（力量 / 敏捷 / 体质 / 精神），不用 ScrollView。行内从左到右：
 * 名称、已分配点数、作用说明、「+」按钮。说明列故意只写「物理攻击」这类短语
 * 而不是百分比：系数在服务端（`growth_scalars.attrPointRatio`，运营随时能改），
 * 界面上写死「每点 +0.5%」就是第二个真相 —— 改配置那天它会开始骗人。
 *
 * y 坐标按 22 稿逐段折算（中心原点、向上为正；头部下沿距顶 44 由 createDialog 统一画）。
 */

export const attrAllocateDialogLayout = {
  /** 段标题共用几何（#1115 批次 3 收编组件内联）：贴内容左缘（points 宽 388 → x = −194 + 60）+ 文本框 */
  sectionTitle: { x: -134, size: new Size(120, 18) },
  name: "attr_allocate_dialog",
  title: "属性",
  eyebrow: "角色",
  size: new Size(420, 460),
  /** 剩余点数行（稿 .pt-row）：左灰标签 + 右金色数值，加完就地改数字，不重开弹窗 */
  points: {
    name: "attr_points",
    y: 211,
    width: 388,
    height: 18,
    label: { x: -119, width: 150, fontSize: T.fontSize.f13, color: T.text[3] },
    value: { name: "attr_points_value", x: 144, width: 100, fontSize: T.fontSize.f16, color: T.gold[4] },
    /** 行下沿细分隔线（稿 .pt-row 的 border-bottom） */
    dividerY: 194,
  },
  /** 战斗属性总览（稿 .attr-grid）：两列 × 5 行，行序见 keys；maxMp / combat 不在 BattleAttributes 显示名表里，文案键见 texts */
  overview: {
    title: { name: "attr_overview_title", y: 186, fontSize: T.fontSize.f13, color: T.gold[4] },
    dividerY: 176,
    /** 行序 = 稿序：三攻 → 三防 → 血 / 回血 / 法力 / 战力 */
    keys: [
      "physicalAttack",
      "magicAttack",
      "taoistAttack",
      "physicalDefense",
      "magicDefense",
      "taoistDefense",
      "maxHp",
      "hpRecover",
      "maxMp",
      "combat",
    ] as const,
    row: { width: 186, height: 18, pitch: 24, firstY: 158, colX: [-101, 101], labelWidth: 50, fontSize: T.fontSize.f12 },
  },
  /** 四维加点（稿 .attr-rows）：整幅容器（中心锚点），子件按 firstY − index×(行高+gap) 摆 */
  list: {
    name: "attr_rows",
    size: new Size(388, 190),
    title: { name: "attr_alloc_title", y: 22, fontSize: T.fontSize.f13, color: T.gold[4] },
    dividerY: 12,
    firstY: -9,
    gap: 9,
  },
  row: {
    width: 388,
    height: 34,
    /** 名称列（左对齐）：力量 / 敏捷 / 体质 / 精神 */
    nameWidth: 52,
    nameFontSize: T.fontSize.f13,
    /** 已分配点数（居中，等宽一格，避免数字位数变化时整行跳） */
    valueWidth: 58,
    valueFontSize: T.fontSize.f13,
    /** 作用说明（左对齐、小字） */
    descWidth: 200,
    descFontSize: T.fontSize.f10,
    /** 「+」按钮：贴行右缘 */
    add: { width: 30, height: 24, label: "+" },
  },
  /** 底部说明条（稿 .panel-foot）：两行小字（距底 36 / 18，同 580 版比例；上方即加点行末） */
  foot: {
    dividerY: -194,
    y: -212,
    /** 说明行文本框高（#1115 批次 3 收编组件内联的 16） */
    noteHeight: 16,
    left: { name: "attr_foot_left", x: -84, width: 260, fontSize: T.fontSize.f11, color: T.text[4] },
    right: { name: "attr_foot_right", x: 118, width: 150, fontSize: T.fontSize.f11, color: T.text[4] },
  },
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

//#region 设置弹窗（稿 21-settings）

/**
 * 设置弹窗布局（底部导航「设置」入口 / ESC 打开；稿 21-settings）
 *
 * 两行动作（选择角色 / 退出登录）：行是玻璃底板 + 左侧「名称 + 说明小字」+ 右侧行内按钮。
 * 标题 / 眉题 / 关闭键 / 标题栏拖拽柄全部由 createDialog 按 dialogFrame 统一画（眉题「系统」）。
 * 头部下沿（短金线中心）距顶 44 —— 本窗 220 高时即 y=66；两行从金线下方 10px 起排。
 */

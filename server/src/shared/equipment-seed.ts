/**
 * 装备出厂数据（**唯一书写处**，#603 第九域）
 *
 * 以前这份数据在客户端 `configs/equipments.ts`（7 个 `*Data` 数组，1381 行里的 1080 行），
 * 管理端只能改名称与数值 —— 图标、图集、缩放、8 向位置、职业性别限制全写死在源码里，
 * 改一次要重新打包。本域整体搬到服务端：`equipments` 表（由本文件 seed）+ 配置快照下发，
 * 客户端对应文件只剩「纯函数 + 空运行时表」。
 *
 * **什么在这里、什么不在**
 * - 在：37 件基础件的**全部显示与规则字段**（名称 / 描述 / 图标 / 图集 / 职业性别 / 标签 /
 *   内观锚点与缩放 / 外观缩放与 8 向位置 / 售卖价）+ 13 个槽位的名称与图集 +
 *   前后缀倍率 + 回收价曲线。
 * - 不在：**八项战斗属性**。它们是 `growth-seed.equipmentStats(level, slot)` 按公式算的
 *   （#590），本文件只提供 `level` / `slot` 两个输入；想调属性去调公式或等级表。
 * - 不在：**品质颜色**（`equipmentPrefixColors` / `equipmentSuffixColors`）。那是纯渲染主题色
 *   （`Color` 对象、只有客户端用），没有任何服务端消费者，与「文案」不同 —— 文案要拼
 *   `EQUIPMENT_DISPLAY_NAMES`（服务端日志与邮件里的物品名），所以文案在下面、颜色留在客户端。
 *
 * **变体不在种子里**：每件基础件由客户端 `buildEquipmentMap` 展开成 5 前缀 × 3 后缀 = 15 件，
 * 属性与回收价都乘同一个 rate（超神·神级 = 4.2 倍）。种子只写「普通的·人级」的基础件。
 *
 * **几何是「出厂值」**：`inPosition` / `outPositions` 是管理端「装备对齐 / 内观对齐」工作台
 * **没有覆盖过**时用的值，工作台的保存结果落在 `equip_aligns` / `equip_in_aligns` 表、
 * 每次进图另发（覆盖语义与 `outManual` / `inManual` 一致）。所以这里改了只在「没调过对齐」的
 * 装备上可见 —— 要改实际效果去工作台。
 */
/** 平面坐标（配置里到处是 Vec2，入库时拍平成 x / y；客户端重建时转回 Vec2） */
export interface EquipmentPoint {
  x: number;
  y: number;
}

/** 一条装备基础件（= 普通的·人级；其余 14 个变体由客户端按倍率展开） */
export interface EquipmentSeedRow {
  /** 基础件 id（如 `cloth_1`；变体 id 带 `_pXsY` 后缀，不入库） */
  id: string;
  /** 部位（`EQUIPMENT_TYPE` 的枚举值，如 `cloth`） */
  slot: string;
  /** 穿戴需求等级（装备定强的唯一锚点，属性公式按它算） */
  level: number;
  /** 名称（前缀/后缀由客户端拼在名字前后） */
  label: string;
  /** 售卖价（绑定元宝；0 = 不可售卖。字段名沿用客户端的 `sellPirce` 历史拼写之外的规范写法） */
  sellPrice: number;
  /** 描述（详情弹窗正文） */
  description: string;
  /** 职业限制（`OECCUPATION` 的枚举值：1 战士 / 2 法师 / 3 道士 / 4 不限） */
  occupation: string;
  /** 性别限制（`SEX` 的枚举值：1 男 / 2 女 / 3 不限） */
  sex: string;
  /** 图标（resources 相对路径，`clothes/icon/005`） */
  icon: string;
  /** 内观图集（角色弹窗里穿在身上的那套） */
  in: string;
  /** 外观图集（场景里跟着角色走的那个） */
  out: string;
  /** 标签（如「第一大陆」；客户端详情弹窗展示，无逻辑含义） */
  tags: string[];
  /** 内观锚点（弹窗坐标系，原点 = 弹窗中心、y 向上） */
  inPosition: EquipmentPoint;
  /** 内观横向缩放（1 = 原尺寸） */
  inScaleX: number;
  /** 内观纵向缩放 */
  inScaleY: number;
  /** 内观旋转角度（度；0 = 不转，只有 5 把武器配了） */
  inRotate?: number;
  /** 外观缩放（1 = 原尺寸） */
  outScale: number;
  /** 外观 8 向绝对位置（相对角色节点原点 = 脚底锚点，y 向上） */
  outPositions: EquipmentPoint[];
}

/** 一个装备槽位（角色弹窗的槽位排列与背包整理的部位序都用它） */
export interface EquipmentSlotSeed {
  /** 槽位 key（`EQUIPMENT_TYPE` 的枚举值） */
  key: string;
  /** 槽位中文名 */
  label: string;
  /** 槽位底图（resources 相对路径） */
  imageSrc: string;
  /** 在角色弹窗里的位置分组（left / right / bottom / custom） */
  position: "left" | "right" | "bottom" | "custom";
}

/**
 * 槽位表（**顺序即背包「一键整理」的部位序**，也是角色弹窗的槽位排列顺序）
 *
 * 13 个槽位全在这里 —— 客户端 `equipmentSlots` / `equipmentSlotOrder` 都是这张表的派生。
 */
export const EQUIPMENT_SLOT_SEEDS: EquipmentSlotSeed[] = [
  { key: "other1", label: "其他1", imageSrc: "slots/other", position: "bottom" },
  { key: "cloth", label: "衣服", imageSrc: "slots/cloth", position: "bottom" },
  { key: "other2", label: "其他2", imageSrc: "slots/other", position: "bottom" },
  { key: "weapon", label: "武器", imageSrc: "slots/weapon", position: "left" },
  { key: "necklace", label: "项链", imageSrc: "slots/necklace", position: "left" },
  { key: "ring", label: "戒指", imageSrc: "slots/ring", position: "left" },
  { key: "accessories", label: "饰品", imageSrc: "slots/accessories", position: "left" },
  { key: "shinguard", label: "护腿", imageSrc: "slots/shinguard", position: "left" },
  { key: "helmet", label: "头盔", imageSrc: "slots/helmet", position: "right" },
  { key: "scapular", label: "肩胛", imageSrc: "slots/scapular", position: "right" },
  { key: "belt", label: "腰带", imageSrc: "slots/belt", position: "right" },
  { key: "wristband", label: "护腕", imageSrc: "slots/wristband", position: "right" },
  { key: "shoes", label: "鞋子", imageSrc: "slots/shoes", position: "right" },
];

/**
 * 装备前缀属性倍率（下标 = `EQUIPMENT_PREFIX` 序号：普通的 / 强化的 / 精良的 / 极品的 / 超神的）
 *
 * 与后缀倍率相乘得到变体的总倍率（最高 1.4 × 3 = 4.2）。客户端展开 15 个变体与
 * 服务端结算装备属性用的是同一组数字 —— 改这里就是全局调强度，**不是**某件装备的特例。
 */
export const EQUIPMENT_PREFIX_RATE_SEEDS: number[] = [1, 1.1, 1.2, 1.3, 1.4];

/** 装备后缀属性倍率（下标 = `EQUIPMENT_SUFFIX` 序号：人级 / 天级 / 神级） */
export const EQUIPMENT_SUFFIX_RATE_SEEDS: number[] = [1, 2, 3];

/**
 * 装备前缀文案（与倍率同下标、同长度）
 *
 * 文案搬来这里是因为**服务端有消费者**：生成物的 `EQUIPMENT_DISPLAY_NAMES`（服务端日志 / 邮件里
 * 的「精良的·天级 屠龙」）就是「前缀文案 + 名称 + 后缀文案」拼出来的。
 * **颜色没有搬** —— 它是纯渲染主题色（`Color` 对象、只有客户端用），留在客户端
 * `configs/equipments` 的 `equipmentPrefixColors`，与这里的文案按下标对齐。
 */
export const EQUIPMENT_PREFIX_LABEL_SEEDS: string[] = ["普通的", "强化的", "精良的", "极品的", "超神的"];

/** 装备后缀文案（与倍率同下标、同长度；颜色的归属理由同上前缀） */
export const EQUIPMENT_SUFFIX_LABEL_SEEDS: string[] = ["人级", "天级", "神级"];

/** 一条分段线性曲线的一档（与 growth-seed 的 GrowthSegment 同形状，客户端也用它取样） */
export interface EquipmentCurveSegment {
  /** 起始等级（含） */
  from: number;
  /** 结束等级（含） */
  to: number;
  /** 该档起始等级的值 */
  start: number;
  /** 该档内每升一级的增量 */
  perLevel: number;
}

/**
 * 装备回收价的成长曲线（背包「一键回收」的计价，货币 = **绑定元宝**）
 *
 * 与装备属性同一口径：**只按装备自己的 level 取基础价**（普通的·人级），
 * 前后缀变体再乘倍率（最高 4.2 倍）。
 *
 * 量级参考：升满战魂合计约 527 万绑定元宝（见 `soul-seed`），角色出生带 1 万；
 * 当前曲线下 60 级基础装备回收约 4 万，1 级装备 10（新手装直接丢掉不心疼）。
 */
export const EQUIPMENT_RECYCLE_CURVE_SEED: EquipmentCurveSegment[] = [
  { from: 1, to: 10, start: 10, perLevel: 5 }, // 1 级 10 → 10 级 55
  { from: 11, to: 20, start: 60, perLevel: 20 }, // 20 级 240
  { from: 21, to: 30, start: 260, perLevel: 70 }, // 30 级 890
  { from: 31, to: 40, start: 960, perLevel: 270 }, // 40 级 3,390
  { from: 41, to: 50, start: 3600, perLevel: 840 }, // 50 级 11,160
  { from: 51, to: 60, start: 12000, perLevel: 3100 }, // 60 级 39,900
];

/**
 * 在分段线性曲线上取某等级的值（超出最后一段按最后一段斜率外推）
 *
 * 服务端结算与客户端展示共用这一个函数（生成器把曲线当数据抄进生成物，
 * 客户端从快照拿到曲线后调它），所以「回收价」只有一套算术。
 */
export function sampleEquipmentCurve(segments: EquipmentCurveSegment[], level: number): number {
  if (level <= 0 || segments.length === 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/** 取某等级装备的回收基础价（普通的·人级；前后缀倍率由调用方乘） */
export function equipmentRecyclePriceOf(level: number): number {
  return Math.max(0, Math.round(sampleEquipmentCurve(EQUIPMENT_RECYCLE_CURVE_SEED, level)));
}

/** 37 件基础件（按部位分组、组内按等级升序 —— 与客户端以前的书写顺序一致） */
export const EQUIPMENT_SEED_ROWS: EquipmentSeedRow[] = [
  {
    id: "cloth_1",
    slot: "cloth",
    level: 1,
    label: "* 唯一深爱(衣) *",
    sellPrice: 0,
    description: "葬爱家族专属衣服，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/005",
    in: "clothes/in/005",
    out: "clothes/out/005",
    tags: ["第一大陆"],
    inPosition: { x: -72.5, y: 48 },
    inScaleX: 1.3,
    inScaleY: 1.3,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_10",
    slot: "cloth",
    level: 10,
    label: "钢铁战甲",
    sellPrice: 0,
    description: "红金涂装的钢铁战甲，可以吸收星光来补充能量。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/010",
    in: "clothes/in/010",
    out: "clothes/out/010",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_14",
    slot: "cloth",
    level: 16,
    label: "青铜重甲",
    sellPrice: 0,
    description: "古战场流传下来的青铜重铠，甲片铆接、刀枪难入。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/014",
    in: "clothes/in/014",
    out: "clothes/out/014",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_15",
    slot: "cloth",
    level: 22,
    label: "紫蓑浪人",
    sellPrice: 0,
    description: "紫蓑斗笠的独行浪人，腰间铃铛与手杖随夜风轻响。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/015",
    in: "clothes/in/015",
    out: "clothes/out/015",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_17",
    slot: "cloth",
    level: 28,
    label: "苍龙宝甲",
    sellPrice: 0,
    description: "缀有龙纹的宝蓝战甲，沉稳如山，是为大将之风。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/017",
    in: "clothes/in/017",
    out: "clothes/out/017",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_21",
    slot: "cloth",
    level: 34,
    label: "紫电黑衣",
    sellPrice: 0,
    description: "一袭黑衣的沉默剑客，周身偶尔炸开细碎的紫色电弧。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/021",
    in: "clothes/in/021",
    out: "clothes/out/021",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_23",
    slot: "cloth",
    level: 38,
    label: "白霜猫灵",
    sellPrice: 0,
    description: "雪白皮毛的猫族少女，一身霜白，来自雪山之巅。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/023",
    in: "clothes/in/023",
    out: "clothes/out/023",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_26",
    slot: "cloth",
    level: 42,
    label: "幽影夜行",
    sellPrice: 0,
    description: "黑紫异形的暗影行者，夜色里掠过的一抹紫光是它唯一的痕迹。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/026",
    in: "clothes/in/026",
    out: "clothes/out/026",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_29",
    slot: "cloth",
    level: 46,
    label: "伏魔圣僧",
    sellPrice: 0,
    description: "蓝光护体的圣僧，僧袍猎猎，专降世间妖魔。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/029",
    in: "clothes/in/029",
    out: "clothes/out/029",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_30",
    slot: "cloth",
    level: 50,
    label: "夜雨黑衣",
    sellPrice: 0,
    description: "雨夜中静立的黑衣男子，紫焰在他指间明灭。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/030",
    in: "clothes/in/030",
    out: "clothes/out/030",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_31",
    slot: "cloth",
    level: 55,
    label: "鎏金圣衣",
    sellPrice: 0,
    description: "闪耀着金色光辉的圣衣，穿上它便是全场焦点。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/031",
    in: "clothes/in/031",
    out: "clothes/out/031",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "cloth_32",
    slot: "cloth",
    level: 60,
    label: "赤裙猫娘",
    sellPrice: 0,
    description: "红裙猫族少女，爪印与铃铛是她走过的记号。",
    occupation: "4",
    sex: "3",
    icon: "clothes/icon/032",
    in: "clothes/in/032",
    out: "clothes/out/032",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 7.3, y: 34.2 }, // up
      { x: 7.3, y: 34.2 }, // right_up
      { x: 7.3, y: 34.2 }, // right
      { x: 7.3, y: 34.2 }, // right_down
      { x: 7.3, y: 34.2 }, // down
      { x: 7.3, y: 34.2 }, // left_down
      { x: 7.3, y: 34.2 }, // left
      { x: 7.3, y: 34.2 }, // left_up
    ],
  },
  {
    id: "weapon_1",
    slot: "weapon",
    level: 1,
    label: "菲奥娜de蓝钢佩剑",
    sellPrice: 0,
    description: "东海龙王的宝物，送给新手冒险家的第一件武器。握紧它，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/001",
    in: "weapons/in/001",
    out: "weapons/out/001",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_2",
    slot: "weapon",
    level: 6,
    label: "暗夜雷光剑",
    sellPrice: 0,
    description: "漆黑的剑身中封存着一道白色雷霆，挥动之时雷光乍现，暗夜如昼。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/002",
    in: "weapons/in/002",
    out: "weapons/out/002",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_3",
    slot: "weapon",
    level: 10,
    label: "圣天使之剑",
    sellPrice: 0,
    description: "剑柄生有天使之翼，护手处镶着一颗心形红宝石，传说是圣天使留给凡间的馈赠。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/003",
    in: "weapons/in/003",
    out: "weapons/out/003",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_4",
    slot: "weapon",
    level: 14,
    label: "青龙破军剑",
    sellPrice: 0,
    description: "青碧剑身上盘绕着金龙与流火，出鞘之时隐有龙吟，破军之锋所指之处皆为坦途。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/004",
    in: "weapons/in/004",
    out: "weapons/out/004",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_5",
    slot: "weapon",
    level: 18,
    label: "炎狱狂刀",
    sellPrice: 0,
    description: "布满锯齿的重刃燃烧着狱蓝色的火焰，戾气极重，凡人难以掌控。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/005",
    in: "weapons/in/005",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_6",
    slot: "weapon",
    level: 22,
    label: "焚天赤金刃",
    sellPrice: 0,
    description: "通体赤金的宝刃，刀身终年缠绕着不灭的烈焰，可焚天下之物。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/006",
    in: "weapons/in/006",
    out: "weapons/out/006",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_7",
    slot: "weapon",
    level: 26,
    label: "玄铁惊雷剑",
    sellPrice: 0,
    description: "以玄铁铸就的重剑，剑锋常年缠绕惊雷，挥落之时如雷鸣贯耳。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/007",
    in: "weapons/in/007",
    out: "weapons/out/007",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_8",
    slot: "weapon",
    level: 29,
    label: "嗜血魔刃",
    sellPrice: 0,
    description: "暗红的剑身上浮现着古老的血色符文，饮血而愈，愈战愈勇。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/008",
    in: "weapons/in/008",
    out: "weapons/out/008",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_9",
    slot: "weapon",
    level: 32,
    label: "紫电青霜剑",
    sellPrice: 0,
    description: "紫蓝雷光在水晶剑身上流转，出剑快如闪电，剑气冷若寒霜。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/009",
    in: "weapons/in/009",
    out: "weapons/out/009",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    inRotate: 260,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_10",
    slot: "weapon",
    level: 35,
    label: "朱雀羽刃",
    sellPrice: 0,
    description: "刀如凤凰展翅，燃着朱雀神火，传说蕴含浴火重生之力。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/010",
    in: "weapons/in/010",
    out: "weapons/out/010",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    inRotate: 280,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_11",
    slot: "weapon",
    level: 38,
    label: "炽焰双头杖",
    sellPrice: 0,
    description: "两端燃着不灭火焰的秘法长杖，是火系法师梦寐以求的宝物。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/011",
    in: "weapons/in/011",
    out: "weapons/out/011",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_12",
    slot: "weapon",
    level: 41,
    label: "圣光十字剑",
    sellPrice: 0,
    description: "金色十字剑柄辉映着湛蓝圣光，可破一切黑暗邪祟。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/012",
    in: "weapons/in/012",
    out: "weapons/out/012",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    inRotate: 240,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_13",
    slot: "weapon",
    level: 44,
    label: "炎皇圣剑",
    sellPrice: 0,
    description: "剑身铭刻上古炎皇纹章，中央的赤红宝石封存着焚世之力。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/013",
    in: "weapons/in/013",
    out: "weapons/out/013",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_14",
    slot: "weapon",
    level: 47,
    label: "紫翼金冠刃",
    sellPrice: 0,
    description: "形似金冠、缀以紫翼的奇门兵器，唯有王者方可驾驭。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/014",
    in: "weapons/in/014",
    out: "weapons/out/014",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_15",
    slot: "weapon",
    level: 50,
    label: "屠龙金纹剑",
    sellPrice: 0,
    description: "剑身铭满屠龙金纹，曾是斩杀上古魔龙的英雄佩剑。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/015",
    in: "weapons/in/015",
    out: "weapons/out/015",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    inRotate: 280,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_16",
    slot: "weapon",
    level: 52,
    label: "青莲业火剑",
    sellPrice: 0,
    description: "剑身燃着青莲业火，焚尽业障，可斩虚空。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/016",
    in: "weapons/in/016",
    out: "weapons/out/016",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    inRotate: 280,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_17",
    slot: "weapon",
    level: 54,
    label: "紫晶魔剑",
    sellPrice: 0,
    description: "由整块紫晶雕琢而成的魔剑，剑气所过之处空间震裂。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/017",
    in: "weapons/in/017",
    out: "weapons/out/017",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_18",
    slot: "weapon",
    level: 56,
    label: "紫翼神冠刃",
    sellPrice: 0,
    description: "紫翼金冠的真正形态，觉醒之后可撕裂苍穹。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/018",
    in: "weapons/in/018",
    out: "weapons/out/018",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_19",
    slot: "weapon",
    level: 58,
    label: "燃金圣剑",
    sellPrice: 0,
    description: "圣剑通体由燃金铸成，剑焰不熄，光照千里。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/019",
    in: "weapons/in/019",
    out: "weapons/out/019",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "weapon_20",
    slot: "weapon",
    level: 60,
    label: "焚世巨剑",
    sellPrice: 0,
    description: "传闻此剑一挥，可焚尽一世。唯有真正的强者敢将它握在手中。",
    occupation: "4",
    sex: "3",
    icon: "weapons/icon/020",
    in: "weapons/in/020",
    out: "weapons/out/020",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "ring_1",
    slot: "ring",
    level: 1,
    label: "新手戒指",
    sellPrice: 0,
    description: "新手戒指，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "item/2010210",
    in: "",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "necklace_1",
    slot: "necklace",
    level: 1,
    label: "新手项链",
    sellPrice: 0,
    description: "新手项链，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "item/2010310",
    in: "",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "shoes_1",
    slot: "shoes",
    level: 1,
    label: "新手鞋子",
    sellPrice: 0,
    description: "新手鞋子，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "item/2030410",
    in: "",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "helmet_1",
    slot: "helmet",
    level: 1,
    label: "新手头盔",
    sellPrice: 0,
    description: "新手头盔，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "item/2030702",
    in: "",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
  {
    id: "belt_1",
    slot: "belt",
    level: 1,
    label: "新手腰带",
    sellPrice: 0,
    description: "新手腰带，穿上此装备，开启你的旅程吧！",
    occupation: "4",
    sex: "3",
    icon: "item/2030810",
    in: "",
    out: "",
    tags: [],
    inPosition: { x: 0, y: 0 },
    inScaleX: 1,
    inScaleY: 1,
    outScale: 1,
    outPositions: [
      { x: 0, y: 0 }, // up
      { x: 0, y: 0 }, // right_up
      { x: 0, y: 0 }, // right
      { x: 0, y: 0 }, // right_down
      { x: 0, y: 0 }, // down
      { x: 0, y: 0 }, // left_down
      { x: 0, y: 0 }, // left
      { x: 0, y: 0 }, // left_up
    ],
  },
];

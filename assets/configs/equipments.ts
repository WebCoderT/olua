import { Color, Vec2 } from "cc";
import { Equipment, EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX, EQUIPMENT_TYPE, EquipmentData, EquipmentSlot, GOOD_TYPE } from "../types/good";
import type { BattleAttributes } from "../types/common";
import { equipmentPrefixRates, equipmentRecyclePrice, equipmentStats, equipmentSuffixRates } from "./growth";
import { OECCUPATION, SEX } from "../types/role";

/** 装备槽位数据表（角色弹窗用；key 只做关联，与怪物/装备同一约定） */
const equipmentSlotData: Array<EquipmentSlot & { key: EQUIPMENT_TYPE }> = [
  { key: EQUIPMENT_TYPE.OTHER1, label: "其他1", imageSrc: "slots/other", position: "bottom" },
  { key: EQUIPMENT_TYPE.CLOTH, label: "衣服", imageSrc: "slots/cloth", position: "bottom" },
  { key: EQUIPMENT_TYPE.OTHER2, label: "其他2", imageSrc: "slots/other", position: "bottom" },

  { key: EQUIPMENT_TYPE.WEAPON, label: "武器", imageSrc: "slots/weapon", position: "left" },
  { key: EQUIPMENT_TYPE.NECKLACE, label: "项链", imageSrc: "slots/necklace", position: "left" },
  { key: EQUIPMENT_TYPE.RING, label: "戒指", imageSrc: "slots/ring", position: "left" },
  { key: EQUIPMENT_TYPE.ACCESSORIES, label: "饰品", imageSrc: "slots/accessories", position: "left" },
  { key: EQUIPMENT_TYPE.SHINGUARD, label: "护腿", imageSrc: "slots/shinguard", position: "left" },

  { key: EQUIPMENT_TYPE.HELMET, label: "头盔", imageSrc: "slots/helmet", position: "right" },
  { key: EQUIPMENT_TYPE.SCAPULAR, label: "肩胛", imageSrc: "slots/scapular", position: "right" },
  { key: EQUIPMENT_TYPE.BELT, label: "腰带", imageSrc: "slots/belt", position: "right" },
  { key: EQUIPMENT_TYPE.WRISTBAND, label: "护腕", imageSrc: "slots/wristband", position: "right" },
  { key: EQUIPMENT_TYPE.SHOES, label: "鞋子", imageSrc: "slots/shoes", position: "right" },
];

/** 装备槽位（槽位 → 槽位配置）：由 equipmentSlotData 统一构建 */
export const equipmentSlots = new Map<EQUIPMENT_TYPE, EquipmentSlot>();
for (const slot of equipmentSlotData) {
  equipmentSlots.set(slot.key, slot);
}

/**
 * 装备部位的整理序号（背包「一键整理」排部位用，见 configs/items 的 compareBagGoods）
 *
 * **唯一来源**：不另写一份部位顺序 —— 序号就是 equipmentSlotData 的先后，
 * 改装备槽位配置的顺序时，装备界面的槽位排列与背包整理顺序一起生效。
 */
export const equipmentSlotOrder = new Map<EQUIPMENT_TYPE, number>();
for (const slot of equipmentSlotData) {
  equipmentSlotOrder.set(slot.key, equipmentSlotOrder.size);
}

/** 装备前缀文案（下标 = EQUIPMENT_PREFIX 序号） */
export const equipmentPrefixLabels = ["普通的", "强化的", "精良的", "极品的", "超神的"];

/** 装备前缀文字颜色（与文案同下标）：名称与前缀文字都用该色渲染 */
export const equipmentPrefixColors = [
  new Color("#DDDDDD"), // 普通的：灰白
  new Color("#6EE86E"), // 强化的：绿
  new Color("#4DA6FF"), // 精良的：蓝
  new Color("#C77DFF"), // 极品的：紫
  new Color("#FFA640"), // 超神的：橙
];

/** 装备后缀文案（下标 = EQUIPMENT_SUFFIX 序号） */
export const equipmentSuffixLabels = ["人级", "天级", "神级"];

/** 装备后缀文字颜色（与文案同下标；只用于后缀文字，不影响名称） */
export const equipmentSuffixColors = [
  new Color("#B0B0B0"), // 人级：灰
  new Color("#4DE3FF"), // 天级：青蓝
  new Color("#FFD700"), // 神级：金
];

/** 装备名称三段式（详情弹窗按段着色显示：前缀/名称用前缀色，后缀用后缀色） */
export interface EquipmentNameParts {
  /** 前缀段（label + 颜色 = 前缀色） */
  prefix: { label: string; color: Color };
  /** 名称段（颜色 = 前缀色） */
  label: string;
  /** 后缀段（label + 颜色 = 后缀色） */
  suffix: { label: string; color: Color };
}

/** 拆装备名称三段（前缀文案、名称、后缀文案 + 各自颜色；异常前后缀回退普通/人级） */
export function getEquipmentNameParts(equipment: Equipment): EquipmentNameParts {
  const prefix = equipmentPrefixRates.length > equipment.prefix ? equipment.prefix : EQUIPMENT_PREFIX.NORMAL;
  const suffix = equipmentSuffixRates.length > equipment.suffix ? equipment.suffix : EQUIPMENT_SUFFIX.MORTAL;
  return {
    prefix: { label: equipmentPrefixLabels[prefix], color: equipmentPrefixColors[prefix] },
    label: equipment.label,
    suffix: { label: equipmentSuffixLabels[suffix], color: equipmentSuffixColors[suffix] },
  };
}

/**
 * 按前后缀倍率缩放战斗属性（六项攻防区间与 maxHp 逐项相乘后取整）
 */
function scaleEquipmentAttributes(attributes: BattleAttributes, rate: number): BattleAttributes {
  const scale = (range: [number, number]): [number, number] => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return {
    maxHp: Math.round(attributes.maxHp * rate),
    physicalAttack: scale(attributes.physicalAttack),
    magicAttack: scale(attributes.magicAttack),
    taoistAttack: scale(attributes.taoistAttack),
    physicalDefense: scale(attributes.physicalDefense),
    magicDefense: scale(attributes.magicDefense),
    taoistDefense: scale(attributes.taoistDefense),
  };
}

/**
 * 拼装备变体的物品 id（基础件 key + 前后缀序号；变体 key 的**唯一来源**，反解见 getEquipmentBaseKey）
 * 基础件（普通的·人级，前后缀全 0）沿用原 key，其余组合为 `${key}_p${前缀}s${后缀}`（如 cloth_1_p3s2）
 */
export function getEquipmentVariantKey(key: string, prefix: number, suffix: number): string {
  return prefix === 0 && suffix === 0 ? key : `${key}_p${prefix}s${suffix}`;
}

/**
 * 取装备 id 的基础件 key（`getEquipmentVariantKey` 的反解：去掉末尾的 `_pXsY` 变体段，非变体原样返回）
 * 用途：给「某件装备的全部变体」做统一配置时按基础件 key 命中（如 configs/border 的自定义边框表）
 */
export function getEquipmentBaseKey(id: string): string {
  const match = id.match(/_(p\d+s\d+)$/);
  // 掐掉的是整段命中（含前面的下划线），不是捕获组 —— 否则会留下一个悬挂的下划线
  return match ? id.slice(0, -match[0].length) : id;
}

/**
 * 装备数据表 → 装备配置 Map
 *
 * **key 只做关联**：背包 / 掉落表 / 职业初始装备（configs/role.getNewRoleEquipments）都用它引用，
 * key 可以是任意字符串（"ring_1"、"cloth_fire" 都行），**不参与任何数值计算**。
 * 数值全部按**等级**从 configs/growth 的装备曲线取：
 * - level：该装备的穿戴需求等级，也是**唯一定强入口**（想调强弱就改它）
 * - slot：部位，决定属性怎么分配（见 configs/growth 的 equipmentSlotShare）
 * - 六项攻防与 maxHp：由 equipmentStats(level, slot) 生成，条目里不用手写
 *   · 想单独给某件装备加特例（例如只加攻击不加防御）→ 直接在条目里覆盖同名字段
 *   · 想整体调强/调弱所有装备 → 改 configs/growth 的 equipmentGrowth.setPowerRate
 *
 * **前后缀变体**：每件基础装备展开成全部「前缀 × 后缀」组合（5 × 3 = 15 件），
 * 属性 = 基础属性 × 前缀倍率 × 后缀倍率（倍率见 configs/growth 的 equipmentPrefixRates / equipmentSuffixRates）：
 * - 「普通的·人级」沿用基础装备的原 key（基础件本身，倍率 1 × 1）
 * - 其余组合 key 为 `${key}_p${前缀序号}s${后缀序号}`（如 cloth_1_p3s2）
 * - 基础条目不配置前后缀（类型层已去掉该字段），变体统一由这里生成
 *
 * **回收价**同理按倍率缩放：基础价 = 条目的 recyclePrice（写了才用）或按 level 从
 * configs/growth 的回收价曲线取，变体乘同一个 rate（超神·神级 = 基础价 × 4.2）。
 *
 * 注意：等级同时是「穿戴门槛」（GameHelper.getEquipmentRejectReason 会挡「需要等级 N」），
 * 变体与基础件同 level，门槛一致；所以排等级时要想清楚这件装备应该在什么等级被拿到。
 */
export function buildEquipmentMap(data: EquipmentData[]): Map<string, Equipment> {
  const map = new Map<string, Equipment>();
  for (const entry of data) {
    const { key, ...rest } = entry; // key 只做关联，不写进最终配置对象
    // 基础属性（等级生成值 + 条目特例覆盖），变体在其上乘前后缀倍率
    const base = { ...equipmentStats(rest.level, rest.slot), ...rest } as Equipment;
    // 回收基础价（普通·人级的价）：条目里写了就用它，否则按等级从回收价曲线取（见 configs/growth）
    const baseRecyclePrice = entry.recyclePrice ?? equipmentRecyclePrice(rest.level);
    for (let p = 0; p < equipmentPrefixRates.length; p++) {
      for (let s = 0; s < equipmentSuffixRates.length; s++) {
        const rate = equipmentPrefixRates[p] * equipmentSuffixRates[s];
        const id = getEquipmentVariantKey(key, p, s);
        map.set(id, {
          ...base,
          ...scaleEquipmentAttributes(base, rate),
          // 回收价与战斗属性同一口径：前后缀越强越值钱（超神·神级 = 基础价 × 4.2）
          recyclePrice: Math.round(baseRecyclePrice * rate),
          prefix: p as EQUIPMENT_PREFIX,
          suffix: s as EQUIPMENT_SUFFIX,
        });
      }
    }
  }
  return map;
}

/**
 * 取某件装备的回收价（货币 = **绑定元宝**；背包「一键回收」按它结算，见 StorageManager.recycleBagEquipments）
 * 取值已在 buildEquipmentMap 里算好（等级曲线 × 前后缀倍率），这里只做兜底规整
 */
export function getRecyclePrice(equipment: Equipment | null | undefined): number {
  if (!equipment) return 0;
  return Math.max(0, Math.round(equipment.recyclePrice ?? 0));
}

/**
 * 取某装备 Map 的基础件（普通的·人级，prefix/suffix 全 0）
 * 新手装备、全量列表展示等只应给基础件——Map 里其余 14 个是前后缀变体（key 带 _pXsY），不该默认发放
 *
 * ⚠️ 这里必须用 `map.forEach`（或 Array.from）而**不能**写 `[...map.values()]`：
 * 打包时 babel 以 loose 模式编译，会把 `[...迭代器]` 降级成 `[].concat(迭代器)`，
 * 而 `concat` 只展开数组、不认 Map/Set 迭代器 → 结果是 `[MapIterator]` 这一个元素，
 * 过滤后恒为空数组（编辑器里不降级，所以只在打包产物上才复现，症状 = 背包/列表静默为空）
 */
export function getBaseEquipments(map: Map<string, Equipment>): Equipment[] {
  const result: Equipment[] = [];
  map.forEach((eq) => {
    if (eq.prefix === EQUIPMENT_PREFIX.NORMAL && eq.suffix === EQUIPMENT_SUFFIX.MORTAL) result.push(eq);
  });
  return result;
}

// 衣服（按名称强弱排等级 1 → 60；战斗数值由 equipmentStats(level, slot) 生成；内外观位置/缩放逐件手调）
const clothesData: EquipmentData[] = [
  {
    key: "cloth_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "* 唯一深爱(衣) *",
    sex: SEX.ALL,
    description: "葬爱家族专属衣服，穿上此装备，开启你的旅程吧！",
    sellPirce: 0,
    icon: "clothes/icon/005",
    in: "clothes/in/005",
    out: "clothes/out/005",
    inPosition: new Vec2(-72.5, 48),
    tags: ["第一大陆"],
    inScaleX: 1.3,
    inScaleY: 1.3,
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_10",
    level: 10,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "钢铁战甲",
    sex: SEX.ALL,
    description: "红金涂装的钢铁战甲，可以吸收星光来补充能量。",
    sellPirce: 0,
    icon: "clothes/icon/010",
    in: "clothes/in/010",
    out: "clothes/out/010",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_14",
    level: 16,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "青铜重甲",
    sex: SEX.ALL,
    description: "古战场流传下来的青铜重铠，甲片铆接、刀枪难入。",
    sellPirce: 0,
    icon: "clothes/icon/014",
    in: "clothes/in/014",
    out: "clothes/out/014",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_15",
    level: 22,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "紫蓑浪人",
    sex: SEX.ALL,
    description: "紫蓑斗笠的独行浪人，腰间铃铛与手杖随夜风轻响。",
    sellPirce: 0,
    icon: "clothes/icon/015",
    in: "clothes/in/015",
    out: "clothes/out/015",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_17",
    level: 28,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "苍龙宝甲",
    sex: SEX.ALL,
    description: "缀有龙纹的宝蓝战甲，沉稳如山，是为大将之风。",
    sellPirce: 0,
    icon: "clothes/icon/017",
    in: "clothes/in/017",
    out: "clothes/out/017",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_21",
    level: 34,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "紫电黑衣",
    sex: SEX.ALL,
    description: "一袭黑衣的沉默剑客，周身偶尔炸开细碎的紫色电弧。",
    sellPirce: 0,
    icon: "clothes/icon/021",
    in: "clothes/in/021",
    out: "clothes/out/021",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_23",
    level: 38,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "白霜猫灵",
    sex: SEX.ALL,
    description: "雪白皮毛的猫族少女，一身霜白，来自雪山之巅。",
    sellPirce: 0,
    icon: "clothes/icon/023",
    in: "clothes/in/023",
    out: "clothes/out/023",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_26",
    level: 42,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "幽影夜行",
    sex: SEX.ALL,
    description: "黑紫异形的暗影行者，夜色里掠过的一抹紫光是它唯一的痕迹。",
    sellPirce: 0,
    icon: "clothes/icon/026",
    in: "clothes/in/026",
    out: "clothes/out/026",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_29",
    level: 46,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "伏魔圣僧",
    sex: SEX.ALL,
    description: "蓝光护体的圣僧，僧袍猎猎，专降世间妖魔。",
    sellPirce: 0,
    icon: "clothes/icon/029",
    in: "clothes/in/029",
    out: "clothes/out/029",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_30",
    level: 50,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "夜雨黑衣",
    sex: SEX.ALL,
    description: "雨夜中静立的黑衣男子，紫焰在他指间明灭。",
    sellPirce: 0,
    icon: "clothes/icon/030",
    in: "clothes/in/030",
    out: "clothes/out/030",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_31",
    level: 55,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "鎏金圣衣",
    sex: SEX.ALL,
    description: "闪耀着金色光辉的圣衣，穿上它便是全场焦点。",
    sellPirce: 0,
    icon: "clothes/icon/031",
    in: "clothes/in/031",
    out: "clothes/out/031",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
  {
    key: "cloth_32",
    level: 60,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "赤裙猫娘",
    sex: SEX.ALL,
    description: "红裙猫族少女，爪印与铃铛是她走过的记号。",
    sellPirce: 0,
    icon: "clothes/icon/032",
    in: "clothes/in/032",
    out: "clothes/out/032",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  },
];
export const clothes = buildEquipmentMap(clothesData);

// 武器（按名称强弱排等级：weapon_1 是新手的定海神针 = 1 级，weapon_20 焚世巨剑 = 60 级）
const weaponsData: EquipmentData[] = [
  {
    key: "weapon_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "菲奥娜de蓝钢佩剑",
    sex: SEX.ALL,
    description: "东海龙王的宝物，送给新手冒险家的第一件武器。握紧它，开启你的旅程吧！",
    sellPirce: 0,
    icon: "weapons/icon/001",
    in: "weapons/in/001",
    out: "weapons/out/001",
    inPosition: new Vec2(-205.5, 194),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(5.6, 3.1), // up
      new Vec2(5.6, 3.1), // right_up
      new Vec2(5.6, 3.1), // right
      new Vec2(5.6, 3.1), // right_down
      new Vec2(5.6, 3.1), // down
      new Vec2(5.6, 3.1), // left_down
      new Vec2(5.6, 3.1), // left
      new Vec2(5.6, 3.1), // left_up
    ],
  },
  {
    key: "weapon_2",
    level: 6,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "暗夜雷光剑",
    sex: SEX.ALL,
    description: "漆黑的剑身中封存着一道白色雷霆，挥动之时雷光乍现，暗夜如昼。",
    sellPirce: 0,
    icon: "weapons/icon/002",
    in: "weapons/in/002",
    out: "weapons/out/002",
    inPosition: new Vec2(-151.5, 111),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(-10.0, 75.2), // up
      new Vec2(-10.0, 75.2), // right_up
      new Vec2(-10.0, 75.2), // right
      new Vec2(-10.0, 75.2), // right_down
      new Vec2(-10.0, 75.2), // down
      new Vec2(-10.0, 75.2), // left_down
      new Vec2(-10.0, 75.2), // left
      new Vec2(-10.0, 75.2), // left_up
    ],
  },
  {
    key: "weapon_3",
    level: 10,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "圣天使之剑",
    sex: SEX.ALL,
    description: "剑柄生有天使之翼，护手处镶着一颗心形红宝石，传说是圣天使留给凡间的馈赠。",
    sellPirce: 0,
    icon: "weapons/icon/003",
    in: "weapons/in/003",
    out: "weapons/out/003",
    inPosition: new Vec2(-178, 137),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.6, 8.0), // up
      new Vec2(7.6, 8.0), // right_up
      new Vec2(7.6, 8.0), // right
      new Vec2(7.6, 8.0), // right_down
      new Vec2(7.6, 8.0), // down
      new Vec2(7.6, 8.0), // left_down
      new Vec2(7.6, 8.0), // left
      new Vec2(7.6, 8.0), // left_up
    ],
  },
  {
    key: "weapon_4",
    level: 14,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "青龙破军剑",
    sex: SEX.ALL,
    description: "青碧剑身上盘绕着金龙与流火，出鞘之时隐有龙吟，破军之锋所指之处皆为坦途。",
    sellPirce: 0,
    icon: "weapons/icon/004",
    in: "weapons/in/004",
    out: "weapons/out/004",
    inPosition: new Vec2(-170.5, 150),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(6.6, 50.4), // up
      new Vec2(6.6, 50.4), // right_up
      new Vec2(6.6, 50.4), // right
      new Vec2(6.6, 50.4), // right_down
      new Vec2(6.6, 50.4), // down
      new Vec2(6.6, 50.4), // left_down
      new Vec2(6.6, 50.4), // left
      new Vec2(6.6, 50.4), // left_up
    ],
  },
  {
    key: "weapon_5",
    level: 18,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "炎狱狂刀",
    sex: SEX.ALL,
    description: "布满锯齿的重刃燃烧着狱蓝色的火焰，戾气极重，凡人难以掌控。",
    sellPirce: 0,
    icon: "weapons/icon/005",
    in: "weapons/in/005",
    out: "", // resources/weapons/out/005 缺失，暂无外观
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(6.6, 50.4), // up
      new Vec2(6.6, 50.4), // right_up
      new Vec2(6.6, 50.4), // right
      new Vec2(6.6, 50.4), // right_down
      new Vec2(6.6, 50.4), // down
      new Vec2(6.6, 50.4), // left_down
      new Vec2(6.6, 50.4), // left
      new Vec2(6.6, 50.4), // left_up
    ],
  },
  {
    key: "weapon_6",
    level: 22,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "焚天赤金刃",
    sex: SEX.ALL,
    description: "通体赤金的宝刃，刀身终年缠绕着不灭的烈焰，可焚天下之物。",
    sellPirce: 0,
    icon: "weapons/icon/006",
    in: "weapons/in/006",
    out: "weapons/out/006",
    inPosition: new Vec2(-141, 86),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(12.7, 36.5), // up
      new Vec2(12.7, 36.5), // right_up
      new Vec2(12.7, 36.5), // right
      new Vec2(12.7, 36.5), // right_down
      new Vec2(12.7, 36.5), // down
      new Vec2(12.7, 36.5), // left_down
      new Vec2(12.7, 36.5), // left
      new Vec2(12.7, 36.5), // left_up
    ],
  },
  {
    key: "weapon_7",
    level: 26,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "玄铁惊雷剑",
    sex: SEX.ALL,
    description: "以玄铁铸就的重剑，剑锋常年缠绕惊雷，挥落之时如雷鸣贯耳。",
    sellPirce: 0,
    icon: "weapons/icon/007",
    in: "weapons/in/007",
    out: "weapons/out/007",
    inPosition: new Vec2(-185, 102),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(6.5, 47.4), // up
      new Vec2(6.5, 47.4), // right_up
      new Vec2(6.5, 47.4), // right
      new Vec2(6.5, 47.4), // right_down
      new Vec2(6.5, 47.4), // down
      new Vec2(6.5, 47.4), // left_down
      new Vec2(6.5, 47.4), // left
      new Vec2(6.5, 47.4), // left_up
    ],
  },
  {
    key: "weapon_8",
    level: 29,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "嗜血魔刃",
    sex: SEX.ALL,
    description: "暗红的剑身上浮现着古老的血色符文，饮血而愈，愈战愈勇。",
    sellPirce: 0,
    icon: "weapons/icon/008",
    in: "weapons/in/008",
    out: "weapons/out/008",
    inPosition: new Vec2(-164, 146),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(-19.2, 80.2), // up
      new Vec2(-19.2, 80.2), // right_up
      new Vec2(-19.2, 80.2), // right
      new Vec2(-19.2, 80.2), // right_down
      new Vec2(-19.2, 80.2), // down
      new Vec2(-19.2, 80.2), // left_down
      new Vec2(-19.2, 80.2), // left
      new Vec2(-19.2, 80.2), // left_up
    ],
  },
  {
    key: "weapon_9",
    level: 32,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "紫电青霜剑",
    sex: SEX.ALL,
    description: "紫蓝雷光在水晶剑身上流转，出剑快如闪电，剑气冷若寒霜。",
    sellPirce: 0,
    icon: "weapons/icon/009",
    in: "weapons/in/009",
    out: "weapons/out/009",
    inPosition: new Vec2(-139, -9.5),
    inRotate: 260,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(14.0, 4.5), // up
      new Vec2(14.0, 4.5), // right_up
      new Vec2(14.0, 4.5), // right
      new Vec2(14.0, 4.5), // right_down
      new Vec2(14.0, 4.5), // down
      new Vec2(14.0, 4.5), // left_down
      new Vec2(14.0, 4.5), // left
      new Vec2(14.0, 4.5), // left_up
    ],
  },
  {
    key: "weapon_10",
    level: 35,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "朱雀羽刃",
    sex: SEX.ALL,
    description: "刀如凤凰展翅，燃着朱雀神火，传说蕴含浴火重生之力。",
    sellPirce: 0,
    icon: "weapons/icon/010",
    in: "weapons/in/010",
    out: "weapons/out/010",
    inPosition: new Vec2(-125, -13.5),
    inRotate: 280,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(13.0, -12.8), // up
      new Vec2(13.0, -12.8), // right_up
      new Vec2(13.0, -12.8), // right
      new Vec2(13.0, -12.8), // right_down
      new Vec2(13.0, -12.8), // down
      new Vec2(13.0, -12.8), // left_down
      new Vec2(13.0, -12.8), // left
      new Vec2(13.0, -12.8), // left_up
    ],
  },
  {
    key: "weapon_11",
    level: 38,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "炽焰双头杖",
    sex: SEX.ALL,
    description: "两端燃着不灭火焰的秘法长杖，是火系法师梦寐以求的宝物。",
    sellPirce: 0,
    icon: "weapons/icon/011",
    in: "weapons/in/011",
    out: "weapons/out/011",
    inPosition: new Vec2(-68, 15.5),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(14.0, 5.9), // up
      new Vec2(14.0, 5.9), // right_up
      new Vec2(14.0, 5.9), // right
      new Vec2(14.0, 5.9), // right_down
      new Vec2(14.0, 5.9), // down
      new Vec2(14.0, 5.9), // left_down
      new Vec2(14.0, 5.9), // left
      new Vec2(14.0, 5.9), // left_up
    ],
  },
  {
    key: "weapon_12",
    level: 41,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "圣光十字剑",
    sex: SEX.ALL,
    description: "金色十字剑柄辉映着湛蓝圣光，可破一切黑暗邪祟。",
    sellPirce: 0,
    icon: "weapons/icon/012",
    in: "weapons/in/012",
    out: "weapons/out/012",
    inPosition: new Vec2(-139, 42),
    inRotate: 240,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(11.5, 4.9), // up
      new Vec2(11.5, 4.9), // right_up
      new Vec2(11.5, 4.9), // right
      new Vec2(11.5, 4.9), // right_down
      new Vec2(11.5, 4.9), // down
      new Vec2(11.5, 4.9), // left_down
      new Vec2(11.5, 4.9), // left
      new Vec2(11.5, 4.9), // left_up
    ],
  },
  {
    key: "weapon_13",
    level: 44,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "炎皇圣剑",
    sex: SEX.ALL,
    description: "剑身铭刻上古炎皇纹章，中央的赤红宝石封存着焚世之力。",
    sellPirce: 0,
    icon: "weapons/icon/013",
    in: "weapons/in/013",
    out: "weapons/out/013",
    inPosition: new Vec2(-79, 17),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(15.5, -26.9), // up
      new Vec2(15.5, -26.9), // right_up
      new Vec2(15.5, -26.9), // right
      new Vec2(15.5, -26.9), // right_down
      new Vec2(15.5, -26.9), // down
      new Vec2(15.5, -26.9), // left_down
      new Vec2(15.5, -26.9), // left
      new Vec2(15.5, -26.9), // left_up
    ],
  },
  {
    key: "weapon_14",
    level: 47,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "紫翼金冠刃",
    sex: SEX.ALL,
    description: "形似金冠、缀以紫翼的奇门兵器，唯有王者方可驾驭。",
    sellPirce: 0,
    icon: "weapons/icon/014",
    in: "weapons/in/014",
    out: "weapons/out/014",
    inPosition: new Vec2(0, 0),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(14.5, 18.3), // up
      new Vec2(14.5, 18.3), // right_up
      new Vec2(14.5, 18.3), // right
      new Vec2(14.5, 18.3), // right_down
      new Vec2(14.5, 18.3), // down
      new Vec2(14.5, 18.3), // left_down
      new Vec2(14.5, 18.3), // left
      new Vec2(14.5, 18.3), // left_up
    ],
  },
  {
    key: "weapon_15",
    level: 50,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "屠龙金纹剑",
    sex: SEX.ALL,
    description: "剑身铭满屠龙金纹，曾是斩杀上古魔龙的英雄佩剑。",
    sellPirce: 0,
    icon: "weapons/icon/015",
    in: "weapons/in/015",
    out: "weapons/out/015",
    inPosition: new Vec2(-76, 80),
    inRotate: 280,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(-8.5, 70.4), // up
      new Vec2(-8.5, 70.4), // right_up
      new Vec2(-8.5, 70.4), // right
      new Vec2(-8.5, 70.4), // right_down
      new Vec2(-8.5, 70.4), // down
      new Vec2(-8.5, 70.4), // left_down
      new Vec2(-8.5, 70.4), // left
      new Vec2(-8.5, 70.4), // left_up
    ],
  },
  {
    key: "weapon_16",
    level: 52,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "青莲业火剑",
    sex: SEX.ALL,
    description: "剑身燃着青莲业火，焚尽业障，可斩虚空。",
    sellPirce: 0,
    icon: "weapons/icon/016",
    in: "weapons/in/016",
    out: "weapons/out/016",
    inPosition: new Vec2(-80, 80),
    inRotate: 280,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(-8.6, 71.6), // up
      new Vec2(-8.6, 71.6), // right_up
      new Vec2(-8.6, 71.6), // right
      new Vec2(-8.6, 71.6), // right_down
      new Vec2(-8.6, 71.6), // down
      new Vec2(-8.6, 71.6), // left_down
      new Vec2(-8.6, 71.6), // left
      new Vec2(-8.6, 71.6), // left_up
    ],
  },
  {
    key: "weapon_17",
    level: 54,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "紫晶魔剑",
    sex: SEX.ALL,
    description: "由整块紫晶雕琢而成的魔剑，剑气所过之处空间震裂。",
    sellPirce: 0,
    icon: "weapons/icon/017",
    in: "weapons/in/017",
    out: "weapons/out/017",
    inPosition: new Vec2(-222, 231),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 1.5), // up
      new Vec2(7.3, 1.5), // right_up
      new Vec2(7.3, 1.5), // right
      new Vec2(7.3, 1.5), // right_down
      new Vec2(7.3, 1.5), // down
      new Vec2(7.3, 1.5), // left_down
      new Vec2(7.3, 1.5), // left
      new Vec2(7.3, 1.5), // left_up
    ],
  },
  {
    key: "weapon_18",
    level: 56,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "紫翼神冠刃",
    sex: SEX.ALL,
    description: "紫翼金冠的真正形态，觉醒之后可撕裂苍穹。",
    sellPirce: 0,
    icon: "weapons/icon/018",
    in: "weapons/in/018",
    out: "weapons/out/018",
    inPosition: new Vec2(-80, 48),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(14.5, 18.3), // up
      new Vec2(14.5, 18.3), // right_up
      new Vec2(14.5, 18.3), // right
      new Vec2(14.5, 18.3), // right_down
      new Vec2(14.5, 18.3), // down
      new Vec2(14.5, 18.3), // left_down
      new Vec2(14.5, 18.3), // left
      new Vec2(14.5, 18.3), // left_up
    ],
  },
  {
    key: "weapon_19",
    level: 58,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "燃金圣剑",
    sex: SEX.ALL,
    description: "圣剑通体由燃金铸成，剑焰不熄，光照千里。",
    sellPirce: 0,
    icon: "weapons/icon/019",
    in: "weapons/in/019",
    out: "weapons/out/019",
    inPosition: new Vec2(-225, 230),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(7.4, 1.2), // up
      new Vec2(7.4, 1.2), // right_up
      new Vec2(7.4, 1.2), // right
      new Vec2(7.4, 1.2), // right_down
      new Vec2(7.4, 1.2), // down
      new Vec2(7.4, 1.2), // left_down
      new Vec2(7.4, 1.2), // left
      new Vec2(7.4, 1.2), // left_up
    ],
  },
  {
    key: "weapon_20",
    level: 60,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "焚世巨剑",
    sex: SEX.ALL,
    description: "传闻此剑一挥，可焚尽一世。唯有真正的强者敢将它握在手中。",
    sellPirce: 0,
    icon: "weapons/icon/020",
    in: "weapons/in/020",
    out: "weapons/out/020",
    inPosition: new Vec2(-172, 143),
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(11.7, 57.2), // up
      new Vec2(11.7, 57.2), // right_up
      new Vec2(11.7, 57.2), // right
      new Vec2(11.7, 57.2), // right_down
      new Vec2(11.7, 57.2), // down
      new Vec2(11.7, 57.2), // left_down
      new Vec2(11.7, 57.2), // left
      new Vec2(11.7, 57.2), // left_up
    ],
  },
];
export const weapons = buildEquipmentMap(weaponsData);

// 戒指
const ringsData: EquipmentData[] = [
  {
    key: "ring_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.RING,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手戒指",
    description: "新手戒指，穿上此装备，开启你的旅程吧！",
    icon: "item/2010210",
    sellPirce: 0,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(0.0, 0.0), // up
      new Vec2(0.0, 0.0), // right_up
      new Vec2(0.0, 0.0), // right
      new Vec2(0.0, 0.0), // right_down
      new Vec2(0.0, 0.0), // down
      new Vec2(0.0, 0.0), // left_down
      new Vec2(0.0, 0.0), // left
      new Vec2(0.0, 0.0), // left_up
    ],
  },
];
export const rings = buildEquipmentMap(ringsData);

// 项链
const nicklacesData: EquipmentData[] = [
  {
    key: "necklace_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.NECKLACE,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手项链",
    description: "新手项链，穿上此装备，开启你的旅程吧！",
    icon: "item/2010310",
    sellPirce: 0,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(0.0, 0.0), // up
      new Vec2(0.0, 0.0), // right_up
      new Vec2(0.0, 0.0), // right
      new Vec2(0.0, 0.0), // right_down
      new Vec2(0.0, 0.0), // down
      new Vec2(0.0, 0.0), // left_down
      new Vec2(0.0, 0.0), // left
      new Vec2(0.0, 0.0), // left_up
    ],
  },
];
export const nicklaces = buildEquipmentMap(nicklacesData);

// 鞋子
const shoesData: EquipmentData[] = [
  {
    key: "shoes_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.SHOES,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手鞋子",
    description: "新手鞋子，穿上此装备，开启你的旅程吧！",
    icon: "item/2030410",
    sellPirce: 0,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(0.0, 0.0), // up
      new Vec2(0.0, 0.0), // right_up
      new Vec2(0.0, 0.0), // right
      new Vec2(0.0, 0.0), // right_down
      new Vec2(0.0, 0.0), // down
      new Vec2(0.0, 0.0), // left_down
      new Vec2(0.0, 0.0), // left
      new Vec2(0.0, 0.0), // left_up
    ],
  },
];
export const shoes = buildEquipmentMap(shoesData);

// 头盔
const helmetsData: EquipmentData[] = [
  {
    key: "helmet_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.HELMET,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手头盔",
    description: "新手头盔，穿上此装备，开启你的旅程吧！",
    icon: "item/2030702",
    sellPirce: 0,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(0.0, 0.0), // up
      new Vec2(0.0, 0.0), // right_up
      new Vec2(0.0, 0.0), // right
      new Vec2(0.0, 0.0), // right_down
      new Vec2(0.0, 0.0), // down
      new Vec2(0.0, 0.0), // left_down
      new Vec2(0.0, 0.0), // left
      new Vec2(0.0, 0.0), // left_up
    ],
  },
];
export const helmets = buildEquipmentMap(helmetsData);

// 腰带
const beltsData: EquipmentData[] = [
  {
    key: "belt_1",
    level: 1,
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.BELT,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手腰带",
    description: "新手腰带，穿上此装备，开启你的旅程吧！",
    icon: "item/2030810",
    sellPirce: 0,
    tags: [],
    outScale: 1,
    outPositions: [
      new Vec2(0.0, 0.0), // up
      new Vec2(0.0, 0.0), // right_up
      new Vec2(0.0, 0.0), // right
      new Vec2(0.0, 0.0), // right_down
      new Vec2(0.0, 0.0), // down
      new Vec2(0.0, 0.0), // left_down
      new Vec2(0.0, 0.0), // left
      new Vec2(0.0, 0.0), // left_up
    ],
  },
];
export const belts = buildEquipmentMap(beltsData);

/** 各部位装备表（掉落按部位就近取件用） */
const equipmentBySlot = new Map<EQUIPMENT_TYPE, Map<string, Equipment>>([
  [EQUIPMENT_TYPE.WEAPON, weapons],
  [EQUIPMENT_TYPE.CLOTH, clothes],
  [EQUIPMENT_TYPE.HELMET, helmets],
  [EQUIPMENT_TYPE.BELT, belts],
  [EQUIPMENT_TYPE.SHOES, shoes],
  [EQUIPMENT_TYPE.NECKLACE, nicklaces],
  [EQUIPMENT_TYPE.RING, rings],
]);

/**
 * 按等级就近取一件装备的物品 id（怪物掉落分档用）
 * 规则：该部位里 level ≤ 指定等级中等级最高的那件；全都超纲时取等级最低的
 * @param slot 装备部位
 * @param level 目标等级（一般传怪物等级）
 * @returns 物品 id；该部位没有任何装备返回 null
 */
export function getNearestEquipmentId(slot: EQUIPMENT_TYPE, level: number): string | null {
  const map = equipmentBySlot.get(slot);
  if (!map) return null;
  let best: string | null = null;
  let bestLevel = -1;
  let fallback: string | null = null;
  let fallbackLevel = Infinity;
  map.forEach((item, id) => {
    if (item.level <= level && item.level > bestLevel) {
      best = id;
      bestLevel = item.level;
    }
    if (item.level < fallbackLevel) {
      fallback = id;
      fallbackLevel = item.level;
    }
  });
  return best ?? fallback;
}

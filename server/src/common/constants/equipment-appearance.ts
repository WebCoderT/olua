/**
 * 装备外观（边框 + 详情背景）的 key 口径、出厂值与取值范围（**唯一书写处**）
 *
 * ## 管的是什么
 *
 * 「**哪个前后缀组合用哪个边框 / 详情背景**」+「**哪件特殊装备单独用哪个**」。
 * 边框与背景的**素材本体**在客户端资源包里（`resources/effect/border/` 的图集、
 * `resources/effect/background/` 的图集），**资源清单**（哪些编号存在）是两端
 * 资源约定，留在客户端 `configs/border` / `configs/background`（那里有与磁盘文件
 * 一一对应的守卫）。服务端只存 key 字符串 —— 与音效「路径入库」同一取向：
 * 运营换个组合不用重打客户端包，只要新 key 指向的素材在资源包里。
 *
 * ## 出厂值为什么是常量（而不是 config-sync.sql 里手写）
 *
 * 与音效 `AUDIO_DEFAULTS` 同一取向：15 组合的映射跟着客户端的能力走
 * （前缀 5 档 × 后缀 3 档），启动 seed 按 `INSERT OR IGNORE` 补行（幂等，
 * 运营改过的整份配置不会被重启盖回来）。`config-sync.sql` 里的那份是新库
 * 自举用的同一份数据（`make config-export` 从库里导出）—— 两处同源，改默认值
 * **改这里**，再跑一次 `make config-export` 同步快照文件。
 */

/** 装备前缀档数（0~4：普通的 → 超神的；数值即 `EQUIPMENT_PREFIX` 枚举值，枚举在客户端）。**出厂值** —— 运营可在管理端增删档位（#697），运行时档数以 equipment_meta 文案长度为准 */
export const EQUIPMENT_PREFIX_MAX = 4;

/** 装备后缀档数（0~2：人级 / 天级 / 神级；数值即 `EQUIPMENT_SUFFIX` 枚举值）。**出厂值**，同上 */
export const EQUIPMENT_SUFFIX_MAX = 2;

/** 前后缀组合总数（5 × 3 = 15）。**出厂值**，运行时组合数 = 前缀档数 × 后缀档数 */
export const EQUIPMENT_COMBO_COUNT = (EQUIPMENT_PREFIX_MAX + 1) * (EQUIPMENT_SUFFIX_MAX + 1);

/**
 * 前后缀档位的硬上限（#697）
 *
 * equipment_meta 的文案 / 倍率数组长度下限 1、上限 10（DTO 同口径）——
 * 档数决定变体行数（基础件 × 组合），10 档封顶是防手滑把 555 行扩成几万行的护栏。
 */
export const EQUIPMENT_TIER_MAX = 10;

/** 装备外观配置的取值范围（DTO 校验、服务端兜底、管理端表单提示共用） */
export const EQUIPMENT_APPEARANCE_LIMITS = {
  /** 边框 key 格式（= resources/effect/border 下的图集文件名，如 border-30123） */
  borderKeySource: "^border-\\d+$",
  /** 详情背景 key 格式（= resources/effect/background 下的图集文件名，如 bg-16000） */
  backgroundKeySource: "^bg-\\d+$",
  /** key 最大长度（border-30123 这种撑死了十几字符，200 是防手滑贴一整段文本） */
  keyMaxLength: 32,
  /** 特殊装备标识最大长度（物品 id 如 weapon_20_p4s2，或基础件 key 如 weapon_20） */
  equipmentIdMaxLength: 64,
  /** 特殊装备标识格式（物品 id 的字符集：字母数字下划线短横线） */
  equipmentIdSource: "^[A-Za-z0-9_\\-]+$",
  /** 自定义表的最大条数（特殊装备是少数，200 条远够用；防手滑贴一整份表） */
  customMax: 200,
  /** 边框 / 背景清单（#714 实体注册表）的最大条数（素材是有限的，100 远够用） */
  itemMax: 100,
  /** 清单条目别名（#718）的最大长度：编号记不住，别名给人看，32 字够起名了 */
  nameMaxLength: 32,
  /** 清单条目分组名（#718）的最大长度：按素材系列 / 品质系列归组过滤用 */
  groupMaxLength: 32,
} as const;

/** 一条「前缀 × 后缀 → 边框 / 背景 key」的出厂映射 */
export interface AppearanceAssignmentSeed {
  /** 装备前缀（0~4） */
  prefix: number;
  /** 装备后缀（0~2） */
  suffix: number;
  /** 边框 / 背景 key */
  key: string;
}

/** 一条「特殊装备 → 边框 / 背景 key」的出厂映射 */
export interface CustomAppearanceSeed {
  /** 物品 id（变体 id 或基础件 key） */
  equipment: string;
  /** 边框 / 背景 key */
  key: string;
}

/**
 * 一条边框 / 背景清单条目（#714 实体注册表）
 *
 * 清单是「这个游戏里有哪些边框 / 背景」的本体：key 指向客户端资源包里的素材，
 * effect 是这条素材的显示效果（缺省 = 客户端默认适配）。棋盘（前后缀组合）与
 * 特殊装备自定义表都只是**引用**清单里的 key，属性（effect）改在清单里、
 * 服务端保存时传播进引用处。
 */
export interface AppearanceItemSeed {
  /** 边框 / 背景 key（客户端资源清单里的编号（border-30123 / bg-16000）） */
  key: string;
  /** 显示效果（缺省 = {0,0,1} 客户端默认适配） */
  effect?: AppearanceEffect;
  /** 别名（#718，可选）：给人看的名字，客户端不消费 */
  name?: string;
  /** 分组（#718，可选）：管理端按组过滤用，客户端不消费 */
  group?: string;
}

/** 装备外观的整份出厂值 */
export interface EquipmentAppearanceSeed {
  /** 前后缀组合 → 边框（15 条，恰好全覆盖） */
  borders: AppearanceAssignmentSeed[];
  /** 前后缀组合 → 详情背景（15 条，恰好全覆盖） */
  backgrounds: AppearanceAssignmentSeed[];
  /** 特殊装备 → 边框（出厂为空，留给运营） */
  customBorders: CustomAppearanceSeed[];
  /** 特殊装备 → 详情背景（出厂为空，留给运营） */
  customBackgrounds: CustomAppearanceSeed[];
}

/**
 * 出厂映射（按档数展开，#697 起参数化）
 *
 * 沿用客户端 2026-11 之前的口径：**先按后缀分档、档内按前缀递增**，依次取边框
 * （border-30123 起）与背景（bg-16000 起）—— 后缀越强整体越靠后，档内前缀越强越靠后。
 *
 * 档数扩到出厂值之外时公式照样外推（编号顺延）——新编号在客户端资源清单里
 * 多半不存在，客户端 apply 会把不认识的 key 丢掉（那个组合暂时没边框），
 * 运营在「装备外观」页把真实素材 key 填上即可。
 */
export function buildAppearanceDefaults(prefixCount: number, suffixCount: number): EquipmentAppearanceSeed {
  const borders: AppearanceAssignmentSeed[] = [];
  const backgrounds: AppearanceAssignmentSeed[] = [];
  for (let suffix = 0; suffix < suffixCount; suffix++) {
    for (let prefix = 0; prefix < prefixCount; prefix++) {
      const slot = suffix * prefixCount + prefix;
      borders.push({ prefix, suffix, key: `border-${30123 + slot}` });
      backgrounds.push({ prefix, suffix, key: `bg-${16000 + slot}` });
    }
  }
  return { borders, backgrounds, customBorders: [], customBackgrounds: [] };
}

/** 出厂值（模块加载时算一次；档数可在管理端扩，扩出来的组合按上面的公式回落） */
export const EQUIPMENT_APPEARANCE_DEFAULTS: EquipmentAppearanceSeed = buildAppearanceDefaults(
  EQUIPMENT_PREFIX_MAX + 1,
  EQUIPMENT_SUFFIX_MAX + 1,
);

/** 校验并归一化一个边框 / 背景 key，返回**人话**错误（null = 合法） */
export function appearanceKeyProblem(rawKey: string, kind: "border" | "background"): string | null {
  const key = rawKey.trim();
  const source = kind === "border" ? EQUIPMENT_APPEARANCE_LIMITS.borderKeySource : EQUIPMENT_APPEARANCE_LIMITS.backgroundKeySource;
  if (!new RegExp(source).test(key)) {
    return kind === "border"
      ? `边框 key 要形如 border-30123（resources/effect/border 下的图集文件名），拿到「${rawKey}」`
      : `背景 key 要形如 bg-16000（resources/effect/background 下的图集文件名），拿到「${rawKey}」`;
  }
  return null;
}

/**
 * 归一化一个清单条目的文字属性（#718 的别名 / 分组，同一口径）
 *
 * trim 后空串 = 没填 = undefined（落库不存空串，读出来字段干净）；超长返回 null（调用方报 400）。
 */
export function normalizeAppearanceLabel(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? null : trimmed;
}

/**
 * 单条数据显示效果（#700）：以素材**第一帧**为基准的微调
 *
 * - 边框基准 = contain 缩进 56×56 外框、中心对齐物品图标中心；`x` / `y` 是相对图标中心的
 *   偏移（y 向上，与引擎同口径）、`scale` 乘在适配后的尺寸上；
 * - 背景基准 = 详情弹窗面板（铺满面板）；`x` / `y` 相对面板中心、`scale` 乘面板尺寸。
 *
 * 缺省 `{ x: 0, y: 0, scale: 1 }` 与「没有 effect 字段」完全等价 —— 旧数据不用迁移。
 */
export interface AppearanceEffect {
  /** 水平偏移（像素，右为正） */
  x: number;
  /** 垂直偏移（像素，上为正） */
  y: number;
  /** 尺寸倍率（1 = 客户端默认适配结果） */
  scale: number;
}

/** 效果缺省值（不写 effect 字段就是这个） */
export const APPEARANCE_EFFECT_DEFAULT: AppearanceEffect = { x: 0, y: 0, scale: 1 };

/** 显示效果的取值范围（防手滑：偏移拖出两千像素没有意义，缩放 10 倍早就糊满屏了） */
export const APPEARANCE_EFFECT_LIMITS = {
  /** 偏移绝对值上限（像素） */
  offsetMax: 2000,
  /** 缩放下限 */
  scaleMin: 0.1,
  /** 缩放上限 */
  scaleMax: 10,
} as const;

/** 校验并归一化一个显示效果，返回「归一化结果 + 人话错误」（null = 合法） */
export function appearanceEffectProblem(effect: unknown): string | null {
  if (!effect || typeof effect !== "object") return "显示效果要是一个对象（{ x, y, scale }）";
  const source = effect as Record<string, unknown>;
  const x = Number(source.x);
  const y = Number(source.y);
  const scale = Number(source.scale);
  const bound = APPEARANCE_EFFECT_LIMITS.offsetMax;
  if (!Number.isFinite(x) || Math.abs(x) > bound) return `水平偏移 x 要是 −${bound} ~ ${bound} 的数字，拿到「${String(source.x)}」`;
  if (!Number.isFinite(y) || Math.abs(y) > bound) return `垂直偏移 y 要是 −${bound} ~ ${bound} 的数字，拿到「${String(source.y)}」`;
  if (!Number.isFinite(scale) || scale < APPEARANCE_EFFECT_LIMITS.scaleMin || scale > APPEARANCE_EFFECT_LIMITS.scaleMax) {
    return `尺寸倍率 scale 要是 ${APPEARANCE_EFFECT_LIMITS.scaleMin} ~ ${APPEARANCE_EFFECT_LIMITS.scaleMax} 的数字，拿到「${String(source.scale)}」`;
  }
  return null;
}

/** 归一化一个显示效果（已校验合法的前提下调用；数值保留两位小数防浮点尾巴） */
export function normalizeAppearanceEffect(effect: unknown): AppearanceEffect {
  const source = effect as Record<string, unknown>;
  const round2 = (value: number): number => Math.round(value * 100) / 100;
  return { x: round2(Number(source.x)), y: round2(Number(source.y)), scale: round2(Number(source.scale)) };
}

/** 读取一条数据里的 effect：字段缺失 / 形状不对返回 null（调用方回落缺省值），合法则归一化 */
export function effectiveAppearanceEffect(raw: unknown): AppearanceEffect | null {
  if (raw === undefined || raw === null) return null;
  return appearanceEffectProblem(raw) === null ? normalizeAppearanceEffect(raw) : null;
}

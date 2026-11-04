/**
 * 装备外观（边框 + 详情背景）的 key 口径、出厂值与取值范围（**唯一书写处**）
 *
 * ## 管的是什么
 *
 * 「**哪个前后缀组合用哪个边框 / 详情背景**」+「**哪件特殊装备单独用哪个**」。
 * 边框与背景的**素材本体**在客户端资源包里（`resources/borders/` 的图集、
 * `resources/backgrounds/` 的帧序列目录），**资源清单**（哪些 sfx 编号存在）是两端
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

/** 装备前缀档数（0~4：普通的 → 超神的；数值即 `EQUIPMENT_PREFIX` 枚举值，枚举在客户端） */
export const EQUIPMENT_PREFIX_MAX = 4;

/** 装备后缀档数（0~2：人级 / 天级 / 神级；数值即 `EQUIPMENT_SUFFIX` 枚举值） */
export const EQUIPMENT_SUFFIX_MAX = 2;

/** 前后缀组合总数（5 × 3 = 15；前后缀映射表必须恰好覆盖每一种、各一次） */
export const EQUIPMENT_COMBO_COUNT = (EQUIPMENT_PREFIX_MAX + 1) * (EQUIPMENT_SUFFIX_MAX + 1);

/** 装备外观配置的取值范围（DTO 校验、服务端兜底、管理端表单提示共用） */
export const EQUIPMENT_APPEARANCE_LIMITS = {
  /** 边框 key 格式（= resources/borders 下的图集文件名，如 sfx_30123_0） */
  borderKeySource: "^sfx_\\d+_0$",
  /** 详情背景 key 格式（= resources/backgrounds 下的帧序列目录名，如 sfx_16000） */
  backgroundKeySource: "^sfx_\\d+$",
  /** key 最大长度（sfx_ 编号撑死了十几字符，200 是防手滑贴一整段文本） */
  keyMaxLength: 32,
  /** 特殊装备标识最大长度（物品 id 如 weapon_20_p4s2，或基础件 key 如 weapon_20） */
  equipmentIdMaxLength: 64,
  /** 特殊装备标识格式（物品 id 的字符集：字母数字下划线短横线） */
  equipmentIdSource: "^[A-Za-z0-9_\\-]+$",
  /** 自定义表的最大条数（特殊装备是少数，200 条远够用；防手滑贴一整份表） */
  customMax: 200,
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
 * 出厂映射
 *
 * 沿用客户端 2026-11 之前的口径：**先按后缀分三档、档内按前缀递增**，
 * 依次取「前 15 张」边框（sfx_30123_0 ~ sfx_30137_0）与前 15 个背景
 * （sfx_16000 ~ sfx_16014）—— 后缀越强边框整体越靠后，档内前缀越强越靠后。
 */
function buildDefaults(): EquipmentAppearanceSeed {
  const borders: AppearanceAssignmentSeed[] = [];
  const backgrounds: AppearanceAssignmentSeed[] = [];
  for (let suffix = 0; suffix <= EQUIPMENT_SUFFIX_MAX; suffix++) {
    for (let prefix = 0; prefix <= EQUIPMENT_PREFIX_MAX; prefix++) {
      const slot = suffix * (EQUIPMENT_PREFIX_MAX + 1) + prefix;
      borders.push({ prefix, suffix, key: `sfx_${30123 + slot}_0` });
      backgrounds.push({ prefix, suffix, key: `sfx_${16000 + slot}` });
    }
  }
  return { borders, backgrounds, customBorders: [], customBackgrounds: [] };
}

/** 出厂值（模块加载时算一次；结构固定，不存在运行期变化） */
export const EQUIPMENT_APPEARANCE_DEFAULTS: EquipmentAppearanceSeed = buildDefaults();

/** 校验并归一化一个边框 / 背景 key，返回**人话**错误（null = 合法） */
export function appearanceKeyProblem(rawKey: string, kind: "border" | "background"): string | null {
  const key = rawKey.trim();
  const source = kind === "border" ? EQUIPMENT_APPEARANCE_LIMITS.borderKeySource : EQUIPMENT_APPEARANCE_LIMITS.backgroundKeySource;
  if (!new RegExp(source).test(key)) {
    return kind === "border"
      ? `边框 key 要形如 sfx_30123_0（resources/borders 下的图集文件名），拿到「${rawKey}」`
      : `背景 key 要形如 sfx_16000（resources/backgrounds 下的帧序列目录名），拿到「${rawKey}」`;
  }
  return null;
}

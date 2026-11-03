/**
 * 游戏枚举与**结构常量**（代码即真源，#655）
 *
 * ===========================================================================
 * 这里放什么、不放什么
 * ===========================================================================
 * **放**：客户端与服务端必须逐值一致的**枚举**（职业 / 性别码）、**结构清单**
 * （六项区间属性键、单值属性键、引导的高亮位与推 进事件白名单、军衔段位）。
 * 它们的共同点是「加一个值就要改代码」：客户端加一个高亮位要 `GuideOverlay` 认识新节点，
 * 加一个职业码要美术与技能都跟上 —— 所以它们本来就不是「运营数据」。
 *
 * **不放**：任何**数值 / 表格**（装备属性、等级经验、掉落、商城价、引导步骤本身）。
 * 那些是运营数据，唯一来源是数据库（出厂快照 `server/data/config-sync.sql`）。
 *
 * ===========================================================================
 * 为什么这些枚举不再从客户端配置生成（#655 前的做法）
 * ===========================================================================
 * 以前它们是 `server/src/shared/game-data.generated.ts` 的一部分 —— 由
 * `tools/gen-shared-data.cjs` 扫客户端 `assets/configs/*` 生成。好处是「一份来源」，
 * 代价是整个服务端为了几个常量依赖一条生成链 + 目录 `src/shared/`，而那条链同时
 * 还负责搬运真正的**数据**（那部分现在归数据库）。
 * 生成链一旦只为常量存在，就是纯负担：改一个枚举要跑生成器、`dist` 里多一份 2000 行的
 * 快照、e2e 拿它当期望值。所以枚举手写在这里，数据走库 —— 边界按「谁会变」切，不按来源切。
 *
 * 守卫：`tools/audit-game-enums.cjs` 拿这里的值与客户端 `assets/types/*` 逐值比对，
 * 两边不同步时直接红（枚举仍然只有一份「事实」，只是校验从生成变成了断言）。
 */

//#region 职业 / 性别

/** 职业码 → 名（与客户端 `types/role.OCCUPATION` 逐值一致） */
export const OCCUPATION_LABELS: Record<string, string> = {
  "1": "战士",
  "2": "魔法师",
  "3": "道士",
  "4": "全职业",
};

/** 性别码 → 名（与客户端 `types/role.SEX` 逐值一致） */
export const SEX_LABELS: Record<string, string> = {
  "1": "男",
  "2": "女",
  "3": "全性别",
};

/**
 * 职业码清单（= 上面那张表的键，顺序即配置顺序）
 *
 * 类型是 `string[]` 而不是字面量联合：**要的就是这个** —— 校验用的是「有哪些码」，
 * 字面量联合会诱使调用点另写一份清单。
 */
export const ROLE_OCCUPATION_CODES: string[] = Object.keys(OCCUPATION_LABELS);

/** 性别码清单（= 上面那张表的键） */
export const ROLE_SEX_CODES: string[] = Object.keys(SEX_LABELS);

/** 把 `码 → 名` 表渲染成一行一览（`1 战士 / 2 魔法师 / …`），给 DTO 的 description 用 */
export function enumHint(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([code, name]) => `${code} ${name}`)
    .join(" / ");
}

/** 职业一览（DTO 描述用） */
export const OCCUPATION_HINT = enumHint(OCCUPATION_LABELS);

/** 性别一览（DTO 描述用） */
export const SEX_HINT = enumHint(SEX_LABELS);

//#endregion

//#region 装备部位

/**
 * 部位码清单（13 个，键即客户端 `types/equip.EQUIPMENT_TYPE` 的枚举值）
 *
 * 这是**结构**：加一个部位意味着美术资源、穿戴逻辑、背包格子都要跟上，不是运营动作。
 * 部位的中文名 / 排序 / 图标在 `equipment_slots` 表（管理端可改），键集在这里。
 * 守卫：`tools/audit-game-enums.cjs` 断言「这张表的键 ⊆ 这里的清单」，两边不同步直接红。
 */
export const EQUIPMENT_SLOT_KEYS: string[] = [
  "other1",
  "cloth",
  "other2",
  "weapon",
  "necklace",
  "ring",
  "accessories",
  "shinguard",
  "helmet",
  "scapular",
  "belt",
  "wristband",
  "shoes",
];

//#endregion

//#region 战斗属性键

/** 六项区间型战斗属性（`[min, max]` 元组；与客户端 `configs/battle` 的属性键一致） */
export const COMBAT_RANGE_KEYS: string[] = [
  "physicalAttack",
  "magicAttack",
  "taoistAttack",
  "physicalDefense",
  "magicDefense",
  "taoistDefense",
];

/** 单值型战斗属性。`maxHp` 参与战斗力，`hpRecover` 不参与 */
export const COMBAT_SINGLE_KEYS: string[] = ["maxHp", "hpRecover"];

//#endregion

//#region 新手引导（#605）

/**
 * 引导步骤上限（= 存档里 `guide.step` 的合法上界）
 *
 * 配置里能加到多少步，存档里就必须能存多少步 —— 两处必须是同一个数（曾经是两个常量，
 * 结果配置加到 70 步时存档把第 65 步之后全丢了）。
 */
export const GUIDE_STEP_MAX = 64;

/** 高亮语义位白名单（与客户端 `types/guide.GUIDE_SPOT` 逐值一致） */
export const GUIDE_SPOTS = ["joystick", "nav:bag", "nav:skill", "nav:chat", "shortcut"] as const;

/** 推进事件白名单（与客户端 `types/guide.GUIDE_EVENT` 逐值一致） */
export const GUIDE_EVENTS = ["move", "kill", "pickup", "openBag", "openSkill", "openChat"] as const;

/** 高亮语义位 / 推进事件的取值类型（由上面两个白名单推导，写错值在编译期就红） */
export type GuideSpotValue = (typeof GUIDE_SPOTS)[number];
export type GuideEventValue = (typeof GUIDE_EVENTS)[number];

/**
 * 引导一步（`guide_settings.steps` 这一列 JSON 的元素形状，也与客户端
 * `configs/guide.GuideStepConfig` 一致）
 *
 * 表格本身（几步、顺序、文案）是运营数据，住在库里；这里只描述形状。
 */
export interface GuideStep {
  /** 步骤标识（落日志与单测用，不落存档；同一份配置里必须唯一） */
  id: string;
  /** 气泡标题（一句话的名字） */
  title: string;
  /** 气泡正文（说清「做什么」，一句话） */
  desc: string;
  /** 高亮语义位（`GuideOverlay` 按它现取节点；取不到就退化成只有气泡） */
  spot: GuideSpotValue;
  /** 推进事件：当前步收到它才前进（别的事件不越级） */
  trigger: GuideEventValue;
}

//#endregion

//#region 怪物定位

/**
 * 怪物定位码（`monsters.tier` 的取值）
 *
 * 这是**结构**而不是数据：`boss` 意味着可在刷怪区当首领、掉落走 boss 表、AI 判定主动；
 * `elite` 同理走 elite 表。加一档要改的是判定逻辑，不是运营配置。
 * 每只怪属于哪一档在 `monsters` 表里（管理端可改），码集在这里。
 */
export const MONSTER_TIERS = ["normal", "elite", "boss"] as const;

/** 定位码 → 中文名（管理端筛选与选择器分组共用） */
export const MONSTER_TIER_LABELS: Record<string, string> = {
  normal: "普通",
  elite: "精英",
  boss: "首领",
};

//#endregion

//#region 军衔段位

/**
 * 军衔段位名（10 段，自低到高）
 *
 * 段位是**结构**：每一段下挂若干级（`ranks` 表的行），段位名只是给「第 N 段」一个说法，
 * 强弱由表里的行决定。加一段意味着军衔总级数变化，那是改代码的事。
 */
export const RANK_TIERS: string[] = [
  "兵卒",
  "校尉",
  "都尉",
  "中郎将",
  "将军",
  "重号将军",
  "公卿",
  "王爵",
  "神将",
  "神话",
];

//#endregion

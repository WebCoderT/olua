/**
 * 属性点（四维加点）的纯规则（#833）
 *
 * ===========================================================================
 * 为什么这些规则要单独一个文件
 * ===========================================================================
 * 与 `skill-upgrade.util.ts` 同一个理由：**点数与加成都是数值的输入**。
 * 加点接口（`RolesService.allocateAttrs`）、洗点（`resetAttrs`）、属性汇总
 * （`role-attributes.ts`）、存量库补点（`DatabaseService.seedAttrPointsOnce`）
 * 与 e2e 都要读同一份口径 —— 抄四遍必然漂移，而漂移的表现是「面板显示 +30%、
 * 伤害按 +25% 算」，没有任何报错。
 *
 * ===========================================================================
 * 落地口径（用户 2026-11-12 拍板）
 * ===========================================================================
 * - **每级 1 点**（与技能点同频），建号 1 点 → 总点数恒等于「等级」；
 * - **加成按等级曲线的百分比**：曲线是指数型（60 级生命 98720 / 物攻 12540），
 *   固定值到高等级等于没有，所以按「曲线基础值 × 系数 × 点数」放大；
 * - **敏捷只给暴击率**，`docs/23` 里原本还写了移速 —— 服务端没有移速属性
 *   （客户端移动读 `speedRate`，那是客户端全权字段），交给四维等于开一条改包口，
 *   所以移速这一半**暂时放置**（重开条件见 `docs/23` §9.1）；
 * - **洗点扣绑定元宝**（`growth_scalars.attrResetCost`，出厂 500），四维归零、点数全退。
 *
 * ===========================================================================
 * 为什么系数只有「一个」
 * ===========================================================================
 * 四项共用一个 `attrPointRatio`（出厂 0.005 = 每点 0.5%）。分四个键看起来更灵活，
 * 但四项的语义并不对等（三项是百分比、敏捷是暴击率的绝对百分点），
 * 分别调只会让「堆哪一项」变成运营算不明白的题。一个键 + 差异写在映射表里
 * （见 `role-attributes.ts` 的 `ATTR_RANGE_KEYS`）更好解释。
 */

import { growthScalarOf } from "../runtime-config-cache";

/** 四维的键（顺序 = 客户端加点界面的行序 = 存档里的键序） */
export const ATTR_KEYS = ["str", "agi", "vit", "spi"] as const;

export type AttrKey = (typeof ATTR_KEYS)[number];

/** 四维点数（每项都是非负整数） */
export type AttrAllocation = Record<AttrKey, number>;

/** 四维的中文名（服务端文案与错误提示共用；客户端自己有一份 `texts.ts`） */
export const ATTR_LABELS: Record<AttrKey, string> = {
  str: "力量",
  agi: "敏捷",
  vit: "体质",
  spi: "精神",
};

/**
 * 每升 1 级给几点属性点
 *
 * **不做成配置**（与 `SKILL_POINTS_PER_LEVEL` 同理）：总点数恒等于等级是
 * 「洗点全退」「存量库按等级补发」两条逻辑的地基。做成可调的键，运营改一次
 * 就让老号的累计点数与新号的算法对不上 —— 而这两条逻辑都没有历史流水可查。
 */
export const ATTR_POINTS_PER_LEVEL = 1;

/** 每点加成系数的出厂值（0.5%）；`growth_scalars.attrPointRatio` 可改 */
export const DEFAULT_ATTR_POINT_RATIO = 0.005;

/** 洗点花费的出厂值（绑定元宝）；`growth_scalars.attrResetCost` 可改 */
export const DEFAULT_ATTR_RESET_COST = 500;

/** 系数的上限：再大就会让「堆一项」直接顶满面板（500% 已经很离谱了） */
const ATTR_POINT_RATIO_MAX = 5;

/**
 * 存档里的点数 → 非负整数
 *
 * 与 `skillPointsOf` 同口径：NaN / 负数 / 字符串 / 缺失一律按 0。
 * 「读不懂就当没有」比「读不懂就报错」安全 —— 报错会让这个角色彻底加不了点。
 */
export function attrPointsOf(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * 存档里的 `data.attrs` → 四维点数（**返回新对象**，不改入参）
 *
 * 只认 `ATTR_KEYS` 里的四个键，别的键一律丢掉：存档是客户端推上来的不透明文档，
 * 多出来的键留着只会在「求和 / 回执」里变成幽灵点数。
 */
export function attrAllocationOf(value: unknown): AttrAllocation {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out = { str: 0, agi: 0, vit: 0, spi: 0 } as AttrAllocation;
  for (const key of ATTR_KEYS) out[key] = attrPointsOf(source[key]);
  return out;
}

/** 四维点数之和（洗点要退多少、面板「已分配」多少，都问这一个） */
export function totalAttrPoints(attrs: AttrAllocation): number {
  return ATTR_KEYS.reduce((sum, key) => sum + attrs[key], 0);
}

/** 一份「全 0」的四维（建号初始值 / 洗点结果） */
export function emptyAttrAllocation(): AttrAllocation {
  return { str: 0, agi: 0, vit: 0, spi: 0 };
}

/**
 * 每点加成系数（`growth_scalars.attrPointRatio`，缺行 / 非法回落出厂 0.5%）
 *
 * 运营把系数调**小**是合法需求（削弱养成线），所以 0 也认；只夹上限防手滑写 100。
 * 与 `critRate` 同样的读法：读内存缓存那一份，管理端写操作后由 `RuntimeConfigService` 重装。
 */
export function attrPointRatio(): number {
  const value = growthScalarOf("attrPointRatio");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_ATTR_POINT_RATIO;
  return Math.min(ATTR_POINT_RATIO_MAX, value);
}

/**
 * 洗点花费的绑定元宝（`growth_scalars.attrResetCost`，缺行 / 非法回落 500）
 *
 * 0 = 免费洗点，是合法配置（运营想让玩家随便试）。负数按 0：
 * 负的花费等于洗点送钱，那不是「配错一个数」，是「开了一个刷钱口子」。
 */
export function attrResetCost(): number {
  const value = growthScalarOf("attrResetCost");
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ATTR_RESET_COST;
  return Math.max(0, Math.floor(value));
}

/**
 * 升级卷轴（#787）—— 出厂清单与等级区间规则
 *
 * ===========================================================================
 * 这是什么
 * ===========================================================================
 * 背包里可以「使用」的道具，使用后**硬性提升 1 级**（不扣经验、不看经验够不够）：
 * 1000 级用一个直接到 1001 级。
 *
 * 唯一的限制是**等级区间**：一卷对应一段等级，用出这段就用不了了 ——
 *
 * | 卷轴 | 可用等级 | 用完之后 |
 * |------|----------|----------|
 * | Lv1  | 1 ~ 999      | 升到 1000 级就换 Lv2 |
 * | Lv2  | 1000 ~ 1999  | … |
 * | Lv7  | 6000 ~ 6999  | 出厂只到这一卷 |
 *
 * 「每 1000 级换一卷」是出厂切法，不是代码规则：区间是两个可改的列
 * （`min_level` / `max_level`），运营完全可以开一卷「500 ~ 800」的怪卷。
 *
 * ===========================================================================
 * 为什么清单在这里（而不是只躺在 config-sync.sql）
 * ===========================================================================
 * 与货币道具（#785）同一个套路：这张表是后加的，已经跑过很久的库不会再自举
 * （`config_meta` 里有 marker）。只改快照文件的话，存量库重启后表是空的 ——
 * 管理端页面空白、玩家拿到卷轴也用不了，而且没有任何报错。
 * 所以 `DatabaseService.migrate()` 里补一段 `INSERT OR IGNORE`，与这份清单同源。
 *
 * ⚠ 空库不受影响：自举的 SQL 是「DELETE + INSERT」，会把兜底插入的行整表替换掉。
 */

/** 每卷覆盖的等级跨度（出厂切法：1~999 / 1000~1999 / …） */
export const LEVEL_SCROLL_STEP = 1000;

/** 出厂卷轴个数（先上 7 卷：覆盖 1 ~ 6999 级） */
export const LEVEL_SCROLL_SEED_COUNT = 7;

/** 单卷一格子最多叠多少个（卷轴是「攒着一起用」的东西） */
export const LEVEL_SCROLL_STACK_MAX = 999;

/** 名称 / 描述长度上限（与药品 / 货币道具同一档） */
export const LEVEL_SCROLL_LABEL_MAX = 20;
export const LEVEL_SCROLL_DESCRIPTION_MAX = 200;

/** 单卷售价上限（与货币道具同一档；出厂 0 = 不可回收） */
export const LEVEL_SCROLL_SELL_PRICE_MAX = 100_000_000;

/**
 * 等级区间的取值域
 *
 * 上限放到 1000 万，与 `roleMaxLevel` 的取值域（`GROWTH_SCALAR_SPECS`）对齐 ——
 * 等级上限调到多少，卷轴就该能覆盖到多少。**两处必须成对检查**。
 */
export const LEVEL_SCROLL_LEVEL_MIN = 1;
export const LEVEL_SCROLL_LEVEL_MAX = 10_000_000;

/** id 形状：小写字母开头，字母数字下划线（与货币道具 / 装备同一风格） */
export const LEVEL_SCROLL_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** 一条升级卷轴（出厂清单的行形状；与 `level_scrolls` 表逐列对应） */
export interface LevelScrollSeed {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** 可用等级下限（含） */
  minLevel: number;
  /** 可用等级上限（含）—— 用完这一卷就到头，再要升得换下一卷 */
  maxLevel: number;
  maxStack: number;
  sellPrice: number;
}

/**
 * 某一卷的图标（**一卷一张**：`item/scroll/level-scroll-1` … `-7`）
 *
 * #787 出厂时 7 卷共用一张 `item/scroll/level-scroll`，而素材实际是按卷号分开的
 * `level-scroll-1…7.png` —— 于是 7 个道具的图标都是断链（`audit-resource-refs` 点名，
 * 客户端格子里也是空的）。缺省值改成按卷号派生，新建第 8 卷缺图时同样会被审计点出来，
 * 而不是静默空白。
 */
export function levelScrollIconOf(index: number): string {
  return `item/scroll/level-scroll-${index}`;
}

/**
 * 按卷号生成一条出厂行（卷号从 1 开始）
 *
 * 区间 = Lv1 是 `1 ~ 999`，之后每卷 `(n-1)×1000 ~ n×1000-1`（Lv2 → 1000~1999、Lv7 → 6000~6999）：
 * 也就是「用完之后那一级正好是下一卷的起点」。
 */
export function levelScrollSeedOf(index: number): LevelScrollSeed {
  const from = index === 1 ? 1 : (index - 1) * LEVEL_SCROLL_STEP;
  const to = index * LEVEL_SCROLL_STEP - 1;
  return {
    id: `level_scroll_${index}`,
    label: `升级卷轴 Lv${index}`,
    description: `等级 ${from} ~ ${to} 时可用：使用后等级直接 +1（不消耗经验）。超出这段等级就用不了，需要换更高阶的卷轴。`,
    icon: levelScrollIconOf(index),
    minLevel: from,
    maxLevel: to,
    maxStack: LEVEL_SCROLL_STACK_MAX,
    sellPrice: 0,
  };
}

/** 出厂清单：7 卷（1 ~ 6999 级） */
export const LEVEL_SCROLL_SEEDS: LevelScrollSeed[] = Array.from(
  { length: LEVEL_SCROLL_SEED_COUNT },
  (_, offset) => levelScrollSeedOf(offset + 1),
);

/**
 * 按等级区间推导「新建时的缺省字段」（id / 名称 / 描述）
 *
 * 运营新建一卷只要填两个等级，其余四个字段由这里补 —— 手填一律优先（见 CreateLevelScrollDto）。
 * 区间正好落在出厂切法（1~999 / 1000~1999 / …）时给成套的卷号命名（`level_scroll_8`），
 * 否则用「下限_上限」（`level_scroll_500_800`），保证 id 唯一且一眼看得出覆盖哪段。
 */
export function levelScrollDraftOf(minLevel: number, maxLevel: number): {
  id: string;
  label: string;
  description: string;
  icon: string;
} {
  // 卷号：1~999 → 1、1000~1999 → 2 …（与 `levelScrollSeedOf` 的区间切法互逆）
  const step = Math.floor(minLevel / LEVEL_SCROLL_STEP) + 1;
  const expectedMin = step === 1 ? 1 : (step - 1) * LEVEL_SCROLL_STEP;
  const aligned = minLevel === expectedMin && maxLevel === step * LEVEL_SCROLL_STEP - 1;
  return {
    id: aligned ? `level_scroll_${step}` : `level_scroll_${minLevel}_${maxLevel}`,
    label: aligned ? `升级卷轴 Lv${step}` : `升级卷轴 ${minLevel}~${maxLevel}`,
    description: `等级 ${minLevel} ~ ${maxLevel} 时可用：使用后等级直接 +1（不消耗经验）。超出这段等级就用不了，需要换更高阶的卷轴。`,
    // 非出厂切法的区间（如 500~800）没有专属素材，沿用起点所在那一卷的图
    icon: levelScrollIconOf(step),
  };
}

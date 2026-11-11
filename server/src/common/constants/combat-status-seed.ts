/**
 * 战斗状态的出厂补数据（#826 第三批）
 *
 * ===========================================================================
 * 这是什么
 * ===========================================================================
 * `statuses` 表里 2003 灼烧 / 2004 眩晕 / 2005 麻痹 是这一批新加的**行**，而
 * `config-sync.sql` 只在**空库首启**整份灌一次（`config_meta.bootstrap_at` 有值之后
 * 再也不灌）。所以存量库要靠 `DatabaseService.seedCombatStatusesOnce()` 补一次 ——
 * 这份常量就是那次补数据的取值，与快照里那三行逐字一致。
 *
 * ===========================================================================
 * 为什么允许「代码里有第二份数值」
 * ===========================================================================
 * #655 之后的总体口径是「库里是权威，快照是出厂」，代码不存数值副本。这里是**唯一的例外**，
 * 和 `MONEY_ITEM_SEEDS` / `LEVEL_SCROLL_SEEDS` / `ROLE_LEVEL_CURVE_SEEDS` 同一个理由：
 * 补数据发生在「快照已经不会被读」的存量库上，不写死在代码里就没有任何来源可用。
 *
 * 因此它**不是运行时数据源**：改玩法数值请改库（管理端状态页），别改这里 ——
 * 这段只在补数据那一刻生效一次（marker `config_meta.combat_statuses_seeded`），
 * 之后再怎么改都不会被读。
 */

/** 一条状态行（`statuses` 表；字段与 `rows.ts` 的 `StatusRow` 对齐） */
export interface CombatStatusSeed {
  id: string;
  owner: string;
  label: string;
  icon: string;
  /** 持续时长（秒）—— 0 表示「挂不上」，会被 `applyStatusToMonster` 直接拒掉 */
  duration: number;
  source: string;
  description: string;
  effect: string;
  effectHoldLast: number;
  /** 数值修正（JSON 字符串）：attackMultiplier / defenseMultiplier / blockChance … */
  combat: string;
  kind: string;
  maxStacks: number;
  /** 周期间隔（毫秒，0 = 无周期） */
  tickMs: number;
  tickEffect: string;
  controlFlags: string;
}

/**
 * 三条控制 / 周期状态
 *
 * 分工（与服务端判据逐条对应）：
 * - 灼烧 `kind=damage` + `tick_ms=1000` + `{hpPercent:-0.02}`：每秒掉 2% 最大生命，最多 3 层；
 * - 眩晕 / 麻痹 `kind=control` + `{stun:1}`：**同一条判据**（禁移动 + 禁出手），
 *   差别只在持续时长、图标与来源技能 —— 这也正是「眩晕与麻痹都禁一切，只是来源不同」的落地。
 */
export const COMBAT_STATUS_SEEDS: ReadonlyArray<CombatStatusSeed> = [
  {
    id: "2003",
    owner: "role",
    label: "灼烧",
    icon: "skill/icon/1006",
    duration: 5,
    source: "skill",
    description: "灼烧：每秒损失 2% 最大生命，最多叠 3 层；重复施加叠加层数并刷新持续时间",
    effect: "effect/status/2004@0",
    effectHoldLast: 1,
    combat: "{}",
    kind: "damage",
    maxStacks: 3,
    tickMs: 1000,
    tickEffect: '{"hpPercent":-0.02}',
    controlFlags: "{}",
  },
  {
    id: "2004",
    owner: "role",
    label: "眩晕",
    icon: "skill/icon/3007",
    duration: 1.5,
    source: "skill",
    description: "眩晕：持续时间内不能移动也不能出手（与麻痹是同一条判据，只是来源与图标不同）",
    effect: "effect/status/2004@0",
    effectHoldLast: 1,
    combat: "{}",
    kind: "control",
    maxStacks: 1,
    tickMs: 0,
    tickEffect: "{}",
    controlFlags: '{"stun":1}',
  },
  {
    id: "2005",
    owner: "role",
    label: "麻痹",
    icon: "skill/icon/3010",
    duration: 2.5,
    source: "skill",
    description: "麻痹：持续时间内不能移动也不能出手（与眩晕是同一条判据，只是来源与图标不同）",
    effect: "effect/status/2004@0",
    effectHoldLast: 1,
    combat: "{}",
    kind: "control",
    maxStacks: 1,
    tickMs: 0,
    tickEffect: "{}",
    controlFlags: '{"stun":1}',
  },
];

/**
 * 技能 → 挂哪个状态（存量库里 `status_id` 还是空串时才补）
 *
 * 与快照一致：烈火剑法 1001 灼烧 / 擒龙手 1004 眩晕 / 狮子吼 1007 麻痹 /
 * 跃鼠猛击 9001（怪）眩晕。
 */
export const COMBAT_SKILL_STATUS_SEEDS: ReadonlyArray<{ id: string; statusId: string }> = [
  { id: "1001", statusId: "2003" },
  { id: "1004", statusId: "2004" },
  { id: "1007", statusId: "2005" },
  { id: "9001", statusId: "2004" },
];

/**
 * 技能 → 数值列出厂值（存量库里该列还是 0 时才补）
 *
 * - `second_hit_ratio`：莲月剑法 1003 两段连击，第二段 = 第一段 × 0.5；
 * - `pull_distance`：擒龙手 1004 把目标拉到身边（上限 300px，实际会被 `PULL_STOP_GAP` 截断）。
 */
export const COMBAT_SKILL_NUMBER_SEEDS: ReadonlyArray<{ id: string; column: string; value: number }> = [
  { id: "1003", column: "second_hit_ratio", value: 0.5 },
  { id: "1004", column: "pull_distance", value: 300 },
];

/**
 * 技能升级的三条纯规则（#828）
 *
 * 只有三条，但都是**唯一的书写处**：服务端用它判，客户端不能自己算（否则「面板说 3 点、
 * 点了却被拒」这类扯皮永远查不完）。所以客户端只显示「等级 + 剩余点数」，
 * 花费由服务端回执 / 错误 `details` 带过来。
 */

/**
 * 存档里的技能点（`data.skillPoints`）折成非负整数
 *
 * 三种脏值都按 0 收：字段不存在（#828 之前建的老号 —— 存量补发在
 * `DatabaseService.seedSkillPointsOnce` 里做过一次）、NaN、负数。
 * 单个出口，别在业务里各写一遍 `Number(x) || 0`：`||` 会把 0 与 NaN 混成一件事，
 * 而这里两者的处理恰好相反（0 是合法值，NaN 是坏档）。
 */
export function skillPointsOf(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

/**
 * 每升 1 级角色给多少技能点（#828，docs/22 §2.5 已定：每级 +1）
 *
 * 写成常量而不是配置列：它是**累计口径**的一部分（建号 1 点 + 每级 1 点 = 等级），
 * 一旦运营改了它，库里存的点数与新算出来的就对不上 —— 而点数没有流水可回溯。
 */
export const SKILL_POINTS_PER_LEVEL = 1;

/**
 * 存档里的技能等级表（`data.skills`）折成 `{ 技能 id: 等级 }`
 *
 * **返回新对象**而不是就地改：`data.skills` 可能来自 `decodeStoredRoleData` 缓存的那一份，
 * 就地改等于让两个角色的存档共用一张表。只留「≥ 1 的整数」，坏值（0 / 负数 / 字符串 /
 * 嵌套对象）一律丢弃 —— 那些格子本来也升不动，留着只会让「有没有学过」的判定各写一套。
 *
 * 只服务 #828 的升级路径；结算侧读等级另有 `combat-settlement` 的 `readSkillLevel`
 * （它要处理「没学 = 不放技能」的语义），两边口径一致但**不要合并**：那个是每帧热路径。
 */
export function skillLevelsOf(skills: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return out;
  for (const [id, value] of Object.entries(skills as Record<string, unknown>)) {
    const level = Number(value);
    if (!Number.isFinite(level) || level < 1) continue;
    out[id] = Math.floor(level);
  }
  return out;
}

/**
 * 升到**下一级**消耗的技能点：`当前等级`（用户 2026-11-12 拍板，取代 docs/22 的 `1 + 当前等级`）
 *
 * 1→2 花 1 点、2→3 花 2 点 …… 一路练到 11 级共 **55 点**（1+2+…+10），
 * 正好等于「等级跟着系数档数」那条上限下的累计产出量级。
 *
 * 为什么不是 `1 + 当前等级`：那样 1→2 就要 2 点，而建号只给 1 点 ——
 * 新角色开局一级也升不了，技能面板里那个按钮第一次点就是「点数不足」。
 * 递增本身的理由不变：后面的档位收益更大，平摊会让「全技能铺到 5 级」永远优于「专精一个」。
 *
 * 脏值（0 / 负数 / NaN）一律按 1 级算：那意味着存档里这一格坏了，
 * 按 1 级收费总比按 0 点白送一级强。
 */
export function skillUpgradeCost(currentLevel: number): number {
  const level = Number(currentLevel);
  return Math.max(1, Number.isFinite(level) ? Math.floor(level) : 1);
}

/**
 * 某个技能的等级上限 = 它的伤害系数档数（#828 的落地口径：跟着系数档数走）
 *
 * `damageCoefficients` 有一档就能升到那一级，玩家技能现在都是 11 档 = 11 级。
 * 系数为空时返回 **0**（不是 1）—— 0 表示「**这个技能没有可升的档位**」，
 * 调用方据此返 20034「目标不合法」而不是 20036「已到顶」：1008 十步一杀这类系数为空
 * 的技能，升级不会让任何数字变大，允许升就是白吃玩家的技能点，而提示「已到顶」
 * 会让玩家以为「再加档就能升」，跑去问运营。
 *
 * 不另设一个「全局技能上限」标量：那会多一个「系数加到 12 档、上限还写着 11」的漂移面，
 * 而运营想封顶本来就该删档位（删档 = 上限降、伤害表也一致）。
 */
export function skillMaxLevelOf(coefficients: unknown): number {
  const list = Array.isArray(coefficients) ? coefficients : [];
  return list.length;
}

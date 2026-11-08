/**
 * 升级结算（#829 / #830 / #831 = docs/37 的 B11 / B12 / B13，A7 / A8）
 *
 * ## 为什么单独抽出来
 * 在此之前「算升级」这件事在 `roles.service.ts` 里出现了**两遍**（`applyKillExp` 与
 * `grantQuestRewards` 各抄一份循环），两遍之间已经漂了：击杀那份会补满血蓝、发奖那份不补，
 * 而运营看到的是同一个「升级」—— 玩家升一级有时满血有时不满，且他无从知道规律。
 *
 * 抽成纯函数的另一个理由：升级循环是**最容易写错边界**的地方（差一级、差一点经验、
 * 刚好落在上限上），纯函数才能拿一堆边界值直接跑，不必起服务 + 打怪 + 等掉落。
 *
 * ## 三条口径（都是已定结论，不是我的取舍）
 * - **B11**：等级的权威有两份（`roles.level` 索引列 + `data.level` 文档字段），
 *   写的时候必须一起写 —— 本函数只负责算出 `level`，落库时由调用方同步进 `data.level`；
 * - **A8 / B12**：满级后经验**封顶**。没有下一级，攒着只会让存档变大、让面板进度条
 *   显示一个永远填不满的比例。封顶值是 0：一是「没有进度」本来就该是 0，
 *   二是避免「满级 3 年的号存着 90 亿经验」这类脏数据；
 * - **A7 / B13**：升级统一回满血蓝 —— 由调用方在 `leveledUp` 时执行（本函数不碰血蓝）。
 *
 * ## 随机数 / 时间 / 存储一概不碰
 * 不引 Nest、不引数据库、不读缓存：上限与「下一级要多少经验」都由调用方传进来，
 * `expNeedOf` 是一个函数而不是一张表 —— 服务端那边它是曲线求值（带 memo），
 * 测试里可以直接传一张小映射。
 */

/** 升级结算的输入 */
export interface LevelUpInput {
  /** 当前等级（`roles.level` 列，权威） */
  level: number;
  /** 当前已攒经验（`data.exp`） */
  exp: number;
  /** 本次要加的经验（负数 / 小数 / NaN 一律按 0 处理） */
  gain: number;
  /** 等级上限（`growth_scalars.roleMaxLevel`，调用方负责取） */
  maxLevel: number;
  /** 升到下一级需要多少经验；取不到（曲线外 / 没配）返回 0 = 不可再升 */
  expNeedOf: (level: number) => number;
}

/** 升级结算的结果 */
export interface LevelUpOutcome {
  /** 结算后的等级 */
  level: number;
  /** 结算后已攒经验（满级恒为 0） */
  exp: number;
  /** 本次是否至少升了一级 */
  leveledUp: boolean;
}

/** 把任意脏值折成「非负整数」 */
function nonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

/**
 * 结算一次经验入账（可能连升多级）
 *
 * 循环退出条件有三个，缺一不可：
 * 1. `level >= maxLevel` —— 到顶了；
 * 2. `expNeed <= 0` —— 这一级没配「升级所需经验」（曲线外），再升就是凭空空转；
 * 3. `exp < expNeed` —— 还不够。
 *
 * 第 2 条容易被漏掉：漏了会在「曲线只配到 60 级、上限却写着 100 万」时把 60 级以后的
 * 经验需求当成 0，于是一次击杀直接升到 100 万级。
 */
export function resolveLevelUp(input: LevelUpInput): LevelUpOutcome {
  const maxLevel = Math.max(1, nonNegativeInt(input.maxLevel) || 1);
  let level = Math.max(1, Math.min(maxLevel, nonNegativeInt(input.level) || 1));

  // 已经满级：经验封顶（A8）。这里**直接返回 0** 而不是「原样保留」——
  // 保留的话每笔击杀都会把它加到数据库里，正是 B12 说的「无限累加」。
  if (level >= maxLevel) return { level, exp: 0, leveledUp: false };

  let exp = nonNegativeInt(input.exp) + nonNegativeInt(input.gain);
  let leveledUp = false;
  let expNeed = nonNegativeInt(input.expNeedOf(level));
  while (level < maxLevel && expNeed > 0 && exp >= expNeed) {
    exp -= expNeed;
    level += 1;
    leveledUp = true;
    expNeed = nonNegativeInt(input.expNeedOf(level));
  }
  // 正好升到满级：剩下的经验没有去处，一并按封顶处理（与「已经是满级」同一口径，
  // 否则同一个满级角色会因为「升上来的」和「本来就满级」两条路径显示不同的经验）
  if (level >= maxLevel) exp = 0;

  return { level, exp, leveledUp };
}

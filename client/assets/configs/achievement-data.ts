/**
 * 成就纯数据表（#401）
 *
 * **只有数据**（id / 分类 / 文案 / 条件 / 奖励），不含任何 UI 字段 —— 工具链
 * `tools/gen-shared-data.cjs` 要在 Node 垫片里编译加载本文件给三端生成公共数据快照
 * （同 `quest-data` 的分家纪律），一旦引到 UI 组件就会在加载期炸掉。
 *
 * ## 条件分两类，存储需求完全不同
 *
 * - **累计型**（`kill` / `quest`）：只能由事件 +1 累计，进度落 `role_achievements.progress`。
 *   成就本身不知道「你打过多少只鸡」，只有事件流知道。
 * - **状态型**（`level` / `combat` / `collect`）：**不存进度**，每次查询按角色当前状态现算
 *   （等级 / 战力 / 背包持有量）。存一份投影的唯一后果是「角色变强了成就进度没动」，
 *   还得为它写一套同步逻辑 —— 而真相本来就在角色存档里。
 *
 * ## 字段口径
 * - `condition.target`：`kill` = 怪物 key（`"*"` = 任意怪）；`collect` = 物品 id；
 *   `level` / `combat` / `quest` 不用 target（留空串，门槛看 `count`）；
 * - `condition.count`：门槛值（累计型 = 需要多少次，状态型 = 需要到多少）；
 * - `category`：面板页签的分类（battle 战斗 / growth 成长 / explore 探索）；
 * - `order`：同分类内的展示顺序（小的在前）；
 * - `hidden`：未达成的隐藏成就，面板默认折叠（不剧透条件）。
 *
 * 想新增成就就往这里加一条纯数据；服务端 achievements 表的 seed 来源、
 * 管理端「成就配置」页与客户端成就面板都以生成物为唯一来源。
 */
export type AchievementCategory = "battle" | "growth" | "explore";

/** 条件类型：前两个是累计型（事件驱动），后三个是状态型（查询现算） */
export type AchievementConditionType = "kill" | "quest" | "level" | "combat" | "collect";

export interface AchievementCondition {
  type: AchievementConditionType;
  /** kill = 怪物 key（"*" = 任意）/ collect = 物品 id / 其余留空串 */
  target: string;
  /** 门槛值 */
  count: number;
}

export interface AchievementRewards {
  gold: number;
  exp: number;
  items: Array<{ goodId: string; count: number }>;
}

export interface AchievementData {
  id: string;
  category: AchievementCategory;
  label: string;
  description: string;
  condition: AchievementCondition;
  rewards: AchievementRewards;
  order: number;
  hidden: boolean;
}

const achievementDataEntries: AchievementData[] = [
  {
    id: "ach_kill_10",
    category: "battle",
    label: "初露锋芒",
    description: "累计击杀 10 只怪物。",
    condition: { type: "kill", target: "*", count: 10 },
    rewards: { gold: 500, exp: 100, items: [] },
    order: 10,
    hidden: false,
  },
  {
    id: "ach_kill_100",
    category: "battle",
    label: "百战之身",
    description: "累计击杀 100 只怪物。",
    condition: { type: "kill", target: "*", count: 100 },
    rewards: { gold: 3000, exp: 800, items: [{ goodId: "material_iron", count: 2 }] },
    order: 20,
    hidden: false,
  },
  {
    id: "ach_kill_chicken",
    category: "battle",
    label: "斗鸡克星",
    description: "累计击杀 20 只赤焰斗鸡。",
    condition: { type: "kill", target: "1", count: 20 },
    rewards: { gold: 800, exp: 200, items: [] },
    order: 30,
    hidden: false,
  },
  {
    id: "ach_level_10",
    category: "growth",
    label: "十级入门",
    description: "角色等级达到 10 级。",
    condition: { type: "level", target: "", count: 10 },
    rewards: { gold: 1000, exp: 0, items: [{ goodId: "material_gem", count: 1 }] },
    order: 10,
    hidden: false,
  },
  {
    id: "ach_level_30",
    category: "growth",
    label: "三十而立",
    description: "角色等级达到 30 级。",
    condition: { type: "level", target: "", count: 30 },
    rewards: { gold: 5000, exp: 0, items: [{ goodId: "material_gem", count: 3 }] },
    order: 20,
    hidden: false,
  },
  {
    id: "ach_combat_10000",
    category: "growth",
    label: "战力破万",
    description: "角色战力达到 10000。",
    condition: { type: "combat", target: "", count: 10000 },
    rewards: { gold: 5000, exp: 1000, items: [] },
    order: 30,
    hidden: false,
  },
  {
    id: "ach_quest_5",
    category: "growth",
    label: "有求必应",
    description: "累计交付 5 个任务。",
    condition: { type: "quest", target: "", count: 5 },
    rewards: { gold: 2000, exp: 500, items: [] },
    order: 40,
    hidden: false,
  },
  {
    id: "ach_collect_hide",
    category: "explore",
    label: "皮料收藏家",
    description: "背包里同时持有 20 张兽皮。",
    condition: { type: "collect", target: "material_hide", count: 20 },
    rewards: { gold: 1500, exp: 300, items: [] },
    order: 10,
    hidden: false,
  },
];

export { achievementDataEntries as achievementData };

/**
 * 任务种子（#603 起服务端唯一书写处）
 *
 * #603 之前这张表写在客户端 `configs/quest-data`，生成器抄进 game-data.generated →
 * 服务端 quests 表 seed → 管理端可改 → 快照下发 → 客户端 `applyQuestRows` 装载。
 * 一条任务要改三次仓库才能生效，归属是反的 —— 现在**只在这里手写**。
 *
 * 客户端 `configs/quest-data.ts` 只剩类型与一张空数组，数据全部来自
 * `GET /game-config` 的 `quests` 段（`applyQuestRows` 会追加快照里新出现的任务）。
 *
 * ## 字段口径（与客户端 QuestData 同构）
 * - `kind`：main = 主线（一次性，`prevQuestId` 线性链门控）；daily = 日常（领奖后可重复接，
 *   进度清零；首版**不做每日重置定时器**，重接即新一轮）；
 * - `npcId`：发布 NPC（客户端头顶 `!` 标记与对话入口的依据，id 见 npc-data）；
 * - `objective`：**单目标**（v1 边界）—— kill = 击杀怪物 key、talk = 与 NPC id 对话、
 *   collect = 交付时背包持有物品 id ×count（会扣走）；
 * - `rewards.items`：奖励物品（goodId 必须存在于物品总表，生成器会校验）；
 * - `prevQuestId` 引用不存在的任务时**生成器直接报错**（配置漂移不该等运行时）。
 */

/** 任务目标（单目标，v1 边界） */
export interface QuestSeedObjective {
  /** kill = 击杀怪物（target = monster key）/ talk = 与 NPC 对话（target = npc id）/ collect = 收集物品（target = 物品 id） */
  type: "kill" | "talk" | "collect";
  /** 目标 id：怪物 key / NPC id / 物品 id，含义由 type 决定 */
  target: string;
  /** 需要的数量 */
  count: number;
}

/** 任务奖励 */
export interface QuestSeedRewards {
  /** 金币 */
  gold: number;
  /** 经验 */
  exp: number;
  /** 奖励物品（goodId 必须在物品总表里） */
  items: Array<{ goodId: string; count: number }>;
}

/** 一条任务 */
export interface QuestSeedRow {
  /** 任务 id（主线 8000 段、日常 8100 段） */
  id: string;
  /** main = 主线（一次性）/ daily = 日常（可重复接） */
  kind: "main" | "daily";
  /** 任务名 */
  label: string;
  /** 任务描述（任务面板正文） */
  description: string;
  /** 主线链门控：上一环的任务 id（空串 = 无前置） */
  prevQuestId: string;
  /** 接取最低等级 */
  minLevel: number;
  /** 发布 NPC 的 id（npc-data 的 id） */
  npcId: string;
  /** 单目标 */
  objective: QuestSeedObjective;
  /** 奖励 */
  rewards: QuestSeedRewards;
}

export const QUEST_SEED_ROWS: QuestSeedRow[] = [
  {
    id: "8001",
    kind: "main",
    label: "初入大陆",
    description: "拜访大陆传送官，了解这片大陆的现状。",
    prevQuestId: "",
    minLevel: 1,
    npcId: "0002",
    objective: { type: "talk", target: "0002", count: 1 },
    rewards: { gold: 500, exp: 100, items: [] },
  },
  {
    id: "8002",
    kind: "main",
    label: "除鸡令",
    description: "村外的赤焰斗鸡扰民已久，替传送官清理 5 只。",
    prevQuestId: "8001",
    minLevel: 1,
    npcId: "0002",
    objective: { type: "kill", target: "1", count: 5 },
    rewards: { gold: 800, exp: 200, items: [{ goodId: "material_hide", count: 2 }] },
  },
  {
    id: "8003",
    kind: "main",
    label: "皮料筹措",
    description: "传送官要修补货车，交付 3 张兽皮（material_hide）。",
    prevQuestId: "8002",
    minLevel: 1,
    npcId: "0002",
    objective: { type: "collect", target: "material_hide", count: 3 },
    rewards: { gold: 1000, exp: 300, items: [{ goodId: "material_iron", count: 1 }] },
  },
  {
    id: "8004",
    kind: "main",
    label: "战魂之门",
    description: "带着铁料去见战魂使者，开启战魂之路。",
    prevQuestId: "8003",
    minLevel: 1,
    npcId: "9002",
    objective: { type: "talk", target: "9002", count: 1 },
    rewards: { gold: 1500, exp: 500, items: [] },
  },
  {
    id: "8101",
    kind: "daily",
    label: "日常巡猎",
    description: "每日例行：猎杀 10 只金斑雄鹿，维持村郊安宁。",
    prevQuestId: "",
    minLevel: 1,
    npcId: "0002",
    objective: { type: "kill", target: "2", count: 10 },
    rewards: { gold: 500, exp: 150, items: [] },
  },
];

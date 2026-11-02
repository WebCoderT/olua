/**
 * 任务数据类型与运行时表（#396；#603 起客户端**不存任何任务数据**）
 *
 * 这里只剩类型定义与一张空数组：任务的唯一书写处是服务端
 * `server/src/shared/quest-seed.ts` —— 生成物 seed 进 quests 表 → 管理端可改 →
 * 随 `GET /game-config` 快照的 `quests` 段下发，由 `apply-snapshot.applyQuestRows`
 * 灌进这张表（快照里新出现的任务会追加，`quests` Map 由 `rebuildQuests()` 重建）。
 *
 * 保留类型是因为消费方（`configs/quest`、`apply-snapshot`、任务面板）都按它取值；
 * 数组本身在快照到达前是空的 —— 与怪物 / 状态同口径（登录 `loadGameConfig()` 是必经 await）。
 *
 * 字段口径（服务端种子与这里同构）：
 * - `kind`：main = 主线（一次性，`prevQuestId` 线性链门控）；daily = 日常（领奖后可重复接，进度清零；
 *   首版**不做每日重置定时器**，重接即新一轮）；
 * - `npcId`：发布 NPC（客户端头顶 `!` 标记与对话入口的依据）；
 * - `objective`：**单目标**（v1 边界）——kill = 击杀怪物 key、talk = 与 NPC key 对话、
 *   collect = 交付时背包持有物品 id ×count（会扣走）；
 * - `rewards.items`：奖励物品（goodId 必须存在于物品总表）。
 *
 * 新增 / 改任务去 `server/src/shared/quest-seed.ts`（新装库的 seed 来源），
 * 已上线的库走管理端「任务配置」页。
 */
export interface QuestObjective {
  /** kill = 击杀怪物（target = monster key）/ talk = 与 NPC 对话（target = npc id）/ collect = 收集物品（target = 物品 id） */
  type: "kill" | "talk" | "collect";
  target: string;
  count: number;
}

export interface QuestRewards {
  gold: number;
  exp: number;
  items: Array<{ goodId: string; count: number }>;
}

export interface QuestData {
  id: string;
  kind: "main" | "daily";
  label: string;
  description: string;
  /** 主线链门控：上一环的任务 id（空串 = 无前置） */
  prevQuestId: string;
  /** 接取最低等级 */
  minLevel: number;
  /** 发布 NPC（npc-data 的 id） */
  npcId: string;
  objective: QuestObjective;
  rewards: QuestRewards;
}

/**
 * 任务运行时表（空数组起步，内容全部来自服务端快照）
 *
 * 追加/覆写都由 `applyQuestRows` 负责：它按 id 对齐，本地没有的**追加**，
 * 本地有的原地覆写 —— 所以运营在管理端新建任务，客户端不需要改代码就能接。
 */
export const questData: QuestData[] = [];

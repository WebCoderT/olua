/**
 * 任务纯数据表（#396）
 *
 * **只有数据**（id / 类型 / 文案 / 目标 / 奖励），不含任何 UI 字段 ——
 * 工具链 `tools/gen-shared-data.cjs` 要在 Node 垫片里编译加载本文件给三端生成
 * 公共数据快照（同 `npc-data` 的分家纪律），一旦引到 UI 组件就会在加载期炸掉。
 *
 * 字段口径：
 * - `kind`：main = 主线（一次性，`prevQuestId` 线性链门控）；daily = 日常（领奖后可重复接，进度清零；
 *   首版**不做每日重置定时器**，重接即新一轮）；
 * - `npcId`：发布 NPC（客户端头顶 `!` 标记与对话入口的依据）；
 * - `objective`：**单目标**（v1 边界）——kill = 击杀怪物 key、talk = 与 NPC key 对话、
 *   collect = 交付时背包持有物品 id ×count（会扣走）；
 * - `rewards.items`：奖励物品（goodId 必须存在于物品总表）。
 *
 * 想新增任务就往这里加一条纯数据；服务端 quests 表的 seed 来源、
 * 管理端「任务配置」页与客户端任务列表都以生成物为唯一来源。
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

const questDataEntries: QuestData[] = [
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

export { questDataEntries as questData };

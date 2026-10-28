import { questData } from "./quest-data";
import type { QuestData } from "./quest-data";

export type { QuestData, QuestObjective, QuestRewards } from "./quest-data";

/**
 * 任务注册表（#396）
 *
 * 由 `quest-data` 的纯数据构建，消费方统一 `quests.get(id)`（同 `npc` / `skill` 的形态）。
 * 数据与行为分家：数据在 `quest-data`（要进三端生成物，不能引 UI），
 * 本文件只做注册表 + 覆写后的重建入口。
 *
 * 覆写来源是服务端配置快照的 `quests` 表（管理端「任务配置」页可增删改），
 * 覆写逻辑在 `configs/apply-snapshot` 的 `applyQuestRows`，改完必须调 `rebuildQuests()`
 * —— 消费方读的是这个 Map，不是 `questData` 数组。
 */
export const quests = new Map<string, QuestData>();

/** 用当前 questData 重建注册表（快照覆写后调用；行对象引用保持不变） */
export function rebuildQuests(): void {
  quests.clear();
  for (const quest of questData) quests.set(quest.id, quest);
}

rebuildQuests();

/** 全部任务（配置顺序：主线 8000 段在前、日常 8100 段在后） */
export function allQuests(): QuestData[] {
  // Array.from 而不是 `[...quests.values()]`：web 包走 babel loose，展开迭代器只剩迭代器本身，
  // 调用方拿到的每一条都不是任务（#471）。守卫：tools/audit-iterator-spread.cjs
  return Array.from(quests.values());
}

/** 目标的中文名（客户端只显示三种；配置里出现未知类型时原样显示） */
export const QUEST_OBJECTIVE_LABELS: Record<string, string> = {
  kill: "击杀怪物",
  talk: "与 NPC 对话",
  collect: "收集物品",
};

/** 任务类型的中文名 */
export const QUEST_KIND_LABELS: Record<string, string> = {
  main: "主线",
  daily: "日常",
};

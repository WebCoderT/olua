/**
 * 奖励物品 JSON 列的解析（**唯一实现**）
 *
 * 任务（`quests.reward_items`）与成就（`achievements.reward_items`）用同一个列格式，
 * 因此只该有一个解析器 —— 两份实现迟早会出现「一边容忍 null 一边炸」的差别。
 *
 * 坏数据**显式报错**，不静默吞：配置列坏掉是运营侧的问题，静默返回空数组会让
 * 「奖励没发」变成一个查不出原因的线上现象。
 */

/** 一条奖励物品 */
export interface RewardItem {
  goodId: string;
  count: number;
}

/** 奖励物品 JSON 列解析 */
export function parseRewardItems(json: string): RewardItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`reward_items 不是合法 JSON：${json}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`reward_items 必须是数组：${json}`);
  return parsed.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return { goodId: String(item.goodId ?? ""), count: Math.max(1, Math.floor(Number(item.count) || 1)) };
  });
}

/**
 * 成就面板的文案 / 分类（#401）
 *
 * 成就面板的文案 / 分类（#401）。布局在 `configs/layout/dialogs/achievement.ts`
 * （#1115 批次 2 起弹窗布局统一口径）：组件里不写死任何节点名、颜色、
 * 尺寸与文案（`audit-config-leak` 会拦），调版面改布局文件。
 */

/** 分类页签顺序（与 `achievement_data` 的 category 同值；页签名与它一一对应） */
export const achievementCategories = ["battle", "growth", "explore"] as const;
export type AchievementCategory = (typeof achievementCategories)[number];

/** 一条成就奖励的展示模板（物品名由客户端快照查，这里只放格式） */
export const achievementTexts = {
  /** 顶部小结：{achieved} 已达成 / {total} 总数 / {claimed} 已领 */
  summary: "已达成 {achieved} / {total}　已领 {claimed}",
  /** 进度：{progress}/{target} */
  progress: "{progress}/{target}",
  /** 按钮与状态字 */
  claim: "领取",
  claimed: "已领取",
  locked: "未达成",
  /** 列表三态 */
  loading: "正在取成就…",
  failed: "没取到，稍后再试",
  emptyList: "这一类还没有成就",
  /** 领取反馈 */
  claimSuccess: "成就奖励已领取",
  /** 背包满时服务端把整份奖励转成邮件（#429），这里只负责告诉玩家去哪儿拿 */
  claimMail: "背包已满，奖励已发至邮箱",
  claimBagFull: "背包放不下，先清出格子再来领",
  claimFailed: "领取失败，稍后再试",
  /** 分类页签名（顺序与 achievementCategories 一致） */
  tabs: ["战斗", "成长", "探索"],
  /** 未达成且 hidden 的成就，描述被这句替换（不剧透条件） */
  hiddenHint: "达成后揭晓",
};

import { Color, Size, Vec2 } from "cc";

/**
 * 成就面板的布局 / 样式 / 文案（#401）
 *
 * 与 `hudLayout.leaderboardDialogLayout` 同一取向：组件里**不写死任何节点名、颜色、
 * 尺寸与文案**（`audit-config-leak` 会拦），全部从这里取 —— 调版面只改这个文件。
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
  claimBagFull: "背包放不下，先清出格子再来领",
  claimFailed: "领取失败，稍后再试",
  /** 分类页签名（顺序与 achievementCategories 一致） */
  tabs: ["战斗", "成长", "探索"],
  /** 未达成且 hidden 的成就，描述被这句替换（不剧透条件） */
  hiddenHint: "达成后揭晓",
};

/** 成就弹窗布局（尺寸口径与排行榜弹窗同量级） */
export const achievementDialogLayout = {
  name: "achievement_dialog",
  title: "成就",
  size: new Size(560, 420),
  /** 顶部页签 */
  tabs: {
    y: 168,
    size: new Size(96, 34),
    radius: 8,
    /** 三个页签的横坐标（与 achievementCategories 一一对应） */
    columns: [-104, 0, 104],
    fontSize: 16,
    idleFill: new Color(38, 42, 54, 255),
    activeFill: new Color(88, 132, 196, 255),
    idleBorder: new Color(72, 78, 94, 255),
    idleText: new Color(178, 184, 196, 255),
    activeText: new Color(255, 255, 255, 255),
  },
  /** 顶部小结（页签下方一行） */
  summary: {
    position: new Vec2(0, 132),
    size: new Size(480, 22),
    fontSize: 15,
    color: new Color(196, 202, 214, 255),
  },
  /** 成就列表 */
  list: {
    name: "achievement_list",
    position: new Vec2(0, -22),
    size: new Size(500, 276),
  },
  /** 一行成就 */
  row: {
    size: new Size(480, 60),
    gap: 6,
    radius: 8,
    fill: new Color(30, 34, 44, 255),
    border: new Color(58, 64, 78, 255),
    /** 已达成（未领）的行：底色偏暖，与未达成一眼分得开 */
    achievedFill: new Color(58, 48, 30, 255),
    achievedBorder: new Color(176, 146, 74, 255),
    nameFontSize: 16,
    nameColor: new Color(238, 240, 246, 255),
    descFontSize: 12,
    descColor: new Color(150, 156, 170, 255),
    /** 名称 / 描述 / 进度 / 按钮各自的横向位置 */
    namePosition: new Vec2(-150, 12),
    nameSize: new Size(280, 20),
    descPosition: new Vec2(-150, -12),
    descSize: new Size(280, 18),
    progressPosition: new Vec2(120, 0),
    progressSize: new Size(80, 20),
    progressFontSize: 15,
    progressColor: new Color(196, 202, 214, 255),
    /** 状态按钮（领取 / 已领取 / 未达成） */
    actionPosition: new Vec2(196, 0),
    actionSize: new Size(72, 30),
    actionRadius: 6,
    claimFill: new Color(92, 148, 96, 255),
    claimedFill: new Color(52, 56, 66, 255),
    lockedFill: new Color(40, 44, 54, 255),
    actionTextColor: new Color(255, 255, 255, 255),
    lockedTextColor: new Color(130, 136, 148, 255),
    actionFontSize: 14,
  },
};

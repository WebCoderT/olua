import { Size, Vec2 } from "cc";
import { T } from "./layout/tokens";
import { dialogFootLayout } from "./layout/dialogs";

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
  /** 背包满时服务端把整份奖励转成邮件（#429），这里只负责告诉玩家去哪儿拿 */
  claimMail: "背包已满，奖励已发至邮箱",
  claimBagFull: "背包放不下，先清出格子再来领",
  claimFailed: "领取失败，稍后再试",
  /** 分类页签名（顺序与 achievementCategories 一致） */
  tabs: ["战斗", "成长", "探索"],
  /** 未达成且 hidden 的成就，描述被这句替换（不剧透条件） */
  hiddenHint: "达成后揭晓",
};

/** 成就弹窗布局（16-achievement 稿，面板 580×440） */
export const achievementDialogLayout = {
  name: "achievement_dialog",
  title: "成就",
  eyebrow: "荣誉",
  size: new Size(580, 440),
  /** 顶部页签（三枚 96 宽 + 6 间距，整行居中；头部下沿 175 − 半行高 16 = 159） */
  tabs: {
    y: 159,
    size: new Size(96, 32),
    radius: T.radius.r2,
    /** 三个页签的横坐标（与 achievementCategories 一一对应） */
    columns: [-102, 0, 102],
    fontSize: T.fontSize.f14,
    idleFill: T.surface[2],
    activeFill: T.gold[4],
    idleBorder: T.surface[3],
    idleText: T.text[1],
    activeText: T.surface[3],
  },
  /** 顶部小结（页签下方一行，居中；稿 `.asum`） */
  summary: {
    position: new Vec2(0, 133),
    size: new Size(500, 20),
    fontSize: T.fontSize.f11,
    color: T.text[4],
  },
  /** 成就列表（顶 123，底 -177） */
  list: {
    name: "achievement_list",
    position: new Vec2(0, -27),
    size: new Size(536, 300),
  },
  /** 一行成就 */
  row: {
    size: new Size(532, 60),
    gap: T.spacing.sp3,
    radius: T.radius.r2,
    fill: T.surface[1],
    border: T.surface[3],
    /** 已达成（未领）的行：底色偏暖，与未达成一眼分得开 */
    achievedFill: T.surface[3],
    achievedBorder: T.gold[2],
    nameFontSize: T.fontSize.f13,
    nameColor: T.text[1],
    descFontSize: T.fontSize.f11,
    descColor: T.text[3],
    /**
     * 名称 / 描述 / 进度 / 按钮各自的横向位置。
     *
     * 名称与描述都是**左对齐**的 label —— 文字从文本框左缘起排，而这里给的是文本框中心 x：
     * 行宽 532（半宽 266），`nameSize` 宽 280 → 中心 x 必须 ≥ −250 + 140 = −110 才不越出左缘。
     * 现在：名称/描述 bbox −250..30，进度 80..160，按钮 160..232（行内留白 34）。
     */
    namePosition: new Vec2(-110, 12),
    nameSize: new Size(280, 20),
    descPosition: new Vec2(-110, -12),
    descSize: new Size(280, 18),
    progressPosition: new Vec2(120, 0),
    progressSize: new Size(80, 20),
    progressFontSize: T.fontSize.f13,
    progressColor: T.text[2],
    /** 状态按钮（领取 / 已领取 / 未达成） */
    actionPosition: new Vec2(196, 0),
    actionSize: new Size(72, 24),
    actionRadius: T.radius.r1,
    claimFill: T.jadeDeep,
    claimedFill: T.surface[4],
    lockedFill: T.surface[2],
    actionTextColor: T.text.onEmber,
    lockedTextColor: T.text[4],
    actionFontSize: T.fontSize.f11,
  },
  /** 页脚（稿 16-achievement 的 .panel-foot） */
  foot: dialogFootLayout(new Size(580, 440), 240),
  footTexts: { left: "达成即自动记录，奖励要点一下才进包", right: "隐藏成就达成后才揭晓条件" },
};

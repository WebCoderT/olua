/**
 * 成就弹窗布局（16-achievement 稿，面板 580×440）
 *
 * 文案与分类仍在 configs/achievement.ts（texts / categories），这里只放几何 ——
 * 全部弹窗布局统一走 hudLayout barrel 口径（#1115 批次 2）。组件里不写死节点名 /
 * 颜色 / 字号（`audit-config-leak` 会拦），调版面只改这个文件。
 */
import { Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

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

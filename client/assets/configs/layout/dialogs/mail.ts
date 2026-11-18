/**
 * 邮件弹窗布局（09-mail 稿，面板 600×450）
 *
 * 文案与频道仍在 configs/mail.ts（texts / channels / kindLabels），这里只放几何 ——
 * 全部弹窗布局统一走 hudLayout barrel 口径（#1115 批次 2）。组件里不写死节点名 /
 * 颜色 / 字号（`audit-config-leak` 盯着这条）。
 */
import { Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

/**
 * 邮件弹窗布局（09-mail 稿，面板 600×450）
 *
 * 五段竖排：小结行（左「未读 N · 待领 N」+ 右两颗按钮）→ 频道页签 → 列表 → 页脚。
 * 几何按面板 450 高算：头部下沿 180 → 小结中心 169 → 页签中心 135 → 列表顶 112（268 高，底 -156）
 * → 页脚线 201。
 */
export const mailDialogLayout = {
  name: "mail_dialog",
  title: "消息",
  eyebrow: "信箱",
  size: new Size(600, 450),
  /** 顶部小结（左对齐，宽 240：内缘距面板边 20 → 中心 -160） */
  summary: {
    position: new Vec2(-160, 169),
    size: new Size(240, 22),
    fontSize: T.fontSize.f12,
    color: T.text[3],
  },
  /** 一键领取（中，金键）：只领**当前频道**的（「全部」页签下 = 领全部） */
  claimAll: {
    position: new Vec2(156, 169),
    size: new Size(88, 28),
    radius: T.radius.r2,
    fill: T.gold[2],
    disabledFill: T.surface[4],
    textColor: T.text.onGold,
    disabledTextColor: T.text[4],
    fontSize: T.fontSize.f12,
  },
  /** 公告入口（右，次要键）：公告板从邮件面板打开，一颗图标一个消息中心 */
  announcement: {
    position: new Vec2(244, 169),
    size: new Size(72, 28),
    radius: T.radius.r2,
    fill: T.surface[3],
    textColor: T.text[2],
    fontSize: T.fontSize.f12,
  },
  /**
   * 频道页签行（#436）
   *
   * 五个页签按 `mailChannels` 顺序横排：宽度 = tabs.width，间距 = gap，整行居中。
   * 角标画在页签右上角（红底白字，>9 显示「9+」）—— 用角标而不是把数字拼进标题，
   * 是因为标题长度会随未读数抖动，五个页签一起抖最难看的。
   */
  tabs: {
    /** 上边界让给小结点（169±11），下边界不能压到列表（列表顶 112） */
    y: 135,
    width: 84,
    height: 26,
    gap: T.spacing.sp2,
    radius: T.radius.r2,
    fill: T.surface[2],
    activeFill: T.gold[3],
    textColor: T.text[3],
    activeTextColor: T.text.onGold,
    fontSize: T.fontSize.f12,
    dotFill: T.ember[2],
    dotRadius: 8,
    dotFontSize: T.fontSize.f10,
    dotTextColor: T.text.onEmber,
    /** 角标上限：超过就换成「9+」那种写法（两位数会把小圆点撑变形） */
    dotCap: 9,
    /** 角标相对页签右上角的外扩量（不贴边才看得出是「附在页签上」） */
    dotOffset: new Vec2(14, 10),
  },
  /** 邮件列表（宽 556 = 内容宽 560 减滚动条 4） */
  list: {
    name: "mail_list",
    position: new Vec2(0, -22),
    size: new Size(556, 268),
  },
  /** 一封邮件（稿 `.mrow`：未读点 + 标题/附件 + 来源与时间 + 两枚按钮） */
  row: {
    size: new Size(552, 62),
    gap: T.spacing.sp3,
    radius: T.radius.r2,
    fill: T.surface[2],
    border: T.line[1],
    /** 未读的行底色偏亮 + 金边（与「已读」一眼分得开） */
    unreadFill: T.surface[3],
    unreadBorder: T.line[3],
    /** 未读标记点（左）：未读 = 金色实心，已读 = 一圈弱线空心 */
    flagPosition: new Vec2(-260, 0),
    flagSize: new Size(7, 7),
    flagColor: T.gold[4],
    flagOffColor: T.line[1],
    titlePosition: new Vec2(-82, 14),
    titleSize: new Size(330, 20),
    titleFontSize: T.fontSize.f13,
    titleColor: T.text[2],
    unreadTitleColor: T.gold[5],
    descPosition: new Vec2(-82, -8),
    descSize: new Size(330, 16),
    descFontSize: T.fontSize.f11,
    descColor: T.text[3],
    /** 来源与时间（右对齐两行，贴在按钮组左边） */
    metaPosition: new Vec2(140, 0),
    metaSize: new Size(100, 34),
    metaFontSize: T.fontSize.f10,
    metaColor: T.text[4],
    /** 领取按钮（上） */
    actionPosition: new Vec2(232, 12),
    actionSize: new Size(64, 22),
    actionRadius: T.radius.r1,
    actionFontSize: T.fontSize.f10,
    claimFill: T.jadeDeep,
    claimedFill: T.surface[4],
    actionTextColor: T.text.onEmber,
    lockedTextColor: T.text[4],
    /** 删除按钮（下）：附件没领时是灰的（点了也只飘一句提示） */
    removePosition: new Vec2(232, -14),
    removeSize: new Size(64, 20),
    removeRadius: T.radius.r1,
    removeFill: T.surface[3],
    removeDisabledFill: T.surface[2],
    removeTextColor: T.text[2],
    removeDisabledTextColor: T.text[4],
    removeFontSize: T.fontSize.f10,
  },
  /** 页脚（稿 `.panel-foot`）：左操作提示 / 右一键领取范围说明 */
  foot: dialogFootLayout(new Size(600, 450), 250),
};

import { Size, Vec2 } from "cc";
import { T } from "./layout/tokens";
import { dialogFootLayout } from "./layout/dialogs";

/**
 * 游戏内邮件（#429）
 *
 * 与 `mail_queue`（外发 SMTP 投递队列）没有关系：那是把信发到玩家注册邮箱，
 * 这是玩家在游戏里打开的收件箱。邮件**只能由服务端产生**（成就奖励背包满兜底、
 * 以后的运营补发），客户端能做的只有看、领、删。
 *
 * 文案与布局都放这里：组件里不写死节点名 / 颜色 / 字号（`audit-config-leak` 盯着这条）。
 */
export const mailTexts = {
  title: "邮件",
  /** 顶部小结：{unread} 未读 / {unclaimed} 未领（**永远是全量**，与入口红点同口径） */
  summary: "未读 {unread} · 待领 {unclaimed}",
  /** 频道页签（第一项是「全部」，其余与服务端 channel 一一对应） */
  channelAll: "全部",
  /** 行内按钮 */
  claim: "领取",
  claimed: "已领取",
  remove: "删除",
  /** 顶部按钮 */
  claimAll: "一键领取",
  announcement: "公告",
  /** 列表三态 */
  loading: "正在取邮件…",
  failed: "没取到，稍后再试",
  /** 整个收件箱是空的（一封都没有） */
  emptyList: "收件箱是空的",
  /** 这一栏是空的（收件箱里别的频道可能有） */
  emptyChannel: "这个频道还没有消息",
  /** 角标超过 tabs.dotCap 时的写法（两位数会把小圆点撑变形） */
  dotOverflow: "9+",
  /** 领取反馈 */
  claimSuccess: "附件已领取",
  claimBagFull: "背包放不下，先清出格子",
  claimAllDone: "已领取 {count} 封",
  /** 部分成功（#870）：一键领取是逐封的，领到几封、几封没领到要分开说 */
  claimAllPartial: "领了 {ok} 封，{fail} 封没领到",
  claimAllStopped: "背包满了，先清出格子再领",
  claimFailed: "领取失败，稍后再试",
  removeFailed: "删除失败，稍后再试",
  removeUnclaimed: "还有没领的奖励，先领取再删",
  /** 附件摘要：绑定元宝 / 经验 / 物品（{name} 换成共享快照里的物品名） */
  bindGold: "绑定元宝 {count}",
  exp: "经验 {count}",
  item: "{name}×{count}",
  /** 三段之间的分隔符 */
  separator: "　",
  noAttachment: "无附件",
};

/** 客户端的频道键：`all` 是「不筛」，其余与服务端 `channel` 字段同值 */
export type MailChannelKey = "all" | "system" | "reward" | "social" | "combat";

/**
 * 页签顺序与文案（**唯一来源**）
 *
 * 顺序不是随机的：玩家最常处理的是「全部」和「奖励」，社交与战斗是通知性质，放后面。
 * 服务端给的是这四个频道的角标（顺序由 `MAIL_CHANNELS` 定），这里只决定**怎么展示**。
 */
export const mailChannels: Array<{ key: MailChannelKey; label: string }> = [
  { key: "all", label: mailTexts.channelAll },
  { key: "system", label: "系统" },
  { key: "reward", label: "奖励" },
  { key: "social", label: "社交" },
  { key: "combat", label: "战斗" },
];

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
  eyebrow: "MAIL",
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

/** 邮件页脚与小结里的静态文案（布局之外的散句放这里，组件不写死中文字面量） */
export const mailFootTexts = {
  left: "点行即标已读 · 未领附件就删除会二次提醒",
  right: "一键领取只作用于当前频道",
};

/**
 * 邮件来源标签（服务端 `MailView.kind` → 行右侧第一行的中文）
 *
 * `kind` 比频道更细（同为 system 频道，成就奖励与运营公告的 kind 不同）。
 * 映射不到的 kind 原样显示 —— 服务端加了新来源，界面上露出英文也比显示空白强。
 */
export const mailKindLabels: Record<string, string> = {
  system: "系统",
  achievement: "成就",
  reward: "奖励",
  friend: "好友",
  guild: "行会",
  boss: "首领",
  combat: "战斗",
  gm: "运营",
};

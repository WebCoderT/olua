import { Color, Size, Vec2 } from "cc";

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
  claimAllStopped: "背包满了，先清出格子再领",
  claimFailed: "领取失败，稍后再试",
  removeFailed: "删除失败，稍后再试",
  removeUnclaimed: "附件还没领，先领取再删",
  /** 附件摘要：金币 / 经验 / 物品（{name} 换成共享快照里的物品名） */
  gold: "金币 {count}",
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

/** 邮件弹窗布局（尺寸口径与成就 / 排行榜弹窗同量级） */
export const mailDialogLayout = {
  name: "mail_dialog",
  title: "邮件",
  size: new Size(560, 420),
  /** 顶部小结（左） */
  summary: {
    position: new Vec2(-150, 178),
    size: new Size(240, 22),
    fontSize: 15,
    color: new Color(196, 202, 214, 255),
  },
  /** 一键领取（中）：只领**当前频道**的（「全部」页签下 = 领全部） */
  claimAll: {
    position: new Vec2(80, 178),
    size: new Size(88, 30),
    radius: 6,
    fill: new Color(92, 148, 96, 255),
    disabledFill: new Color(52, 56, 66, 255),
    textColor: new Color(255, 255, 255, 255),
    disabledTextColor: new Color(130, 136, 148, 255),
    fontSize: 14,
  },
  /** 公告入口（右）：公告板从邮件面板打开，一颗图标一个消息中心 */
  announcement: {
    position: new Vec2(196, 178),
    size: new Size(72, 30),
    radius: 6,
    fill: new Color(58, 84, 128, 255),
    textColor: new Color(255, 255, 255, 255),
    fontSize: 14,
  },
  /**
   * 频道页签行（#436）
   *
   * 五个页签按 `mailChannels` 顺序横排：宽度 = tabs.width，间距 = gap，整行居中。
   * 角标画在页签右上角（红底白字，>9 显示「9+」）—— 用角标而不是把数字拼进标题，
   * 是因为标题长度会随未读数抖动，五个页签一起抖最难看的。
   */
  tabs: {
    /** 上边界要让给小结行（178±11）与两颗按钮（178±15），下边界不能压到列表（列表顶 123） */
    y: 140,
    width: 88,
    height: 26,
    gap: 8,
    radius: 6,
    fill: new Color(30, 34, 44, 255),
    activeFill: new Color(58, 84, 128, 255),
    textColor: new Color(150, 156, 170, 255),
    activeTextColor: new Color(255, 255, 255, 255),
    fontSize: 13,
    dotFill: new Color(198, 64, 58, 255),
    dotRadius: 8,
    dotFontSize: 10,
    dotTextColor: new Color(255, 255, 255, 255),
    /** 角标上限：超过就换成「9+」那种写法（两位数会把小圆点撑变形） */
    dotCap: 9,
    /** 角标相对页签右上角的外扩量（不贴边才看得出是「附在页签上」） */
    dotOffset: new Vec2(14, 10),
  },
  /** 邮件列表 */
  list: {
    name: "mail_list",
    position: new Vec2(0, -32),
    size: new Size(500, 310),
  },
  /** 一封邮件 */
  row: {
    size: new Size(480, 72),
    gap: 6,
    radius: 8,
    fill: new Color(30, 34, 44, 255),
    border: new Color(58, 64, 78, 255),
    /** 未读的行底色偏亮（与「已读」一眼分得开） */
    unreadFill: new Color(40, 48, 62, 255),
    unreadBorder: new Color(92, 128, 176, 255),
    titlePosition: new Vec2(-90, 20),
    titleSize: new Size(290, 20),
    titleFontSize: 16,
    titleColor: new Color(150, 156, 170, 255),
    unreadTitleColor: new Color(238, 240, 246, 255),
    descPosition: new Vec2(-90, -6),
    descSize: new Size(290, 18),
    descFontSize: 12,
    descColor: new Color(150, 156, 170, 255),
    /** 领取按钮（上） */
    actionPosition: new Vec2(186, 14),
    actionSize: new Size(72, 26),
    actionRadius: 6,
    actionFontSize: 13,
    claimFill: new Color(92, 148, 96, 255),
    claimedFill: new Color(52, 56, 66, 255),
    actionTextColor: new Color(255, 255, 255, 255),
    lockedTextColor: new Color(130, 136, 148, 255),
    /** 删除按钮（下）：附件没领时是灰的（点了也只飘一句提示） */
    removePosition: new Vec2(186, -20),
    removeSize: new Size(72, 22),
    removeRadius: 6,
    removeFill: new Color(64, 52, 52, 255),
    removeDisabledFill: new Color(44, 44, 48, 255),
    removeTextColor: new Color(226, 196, 196, 255),
    removeDisabledTextColor: new Color(120, 120, 124, 255),
    removeFontSize: 12,
  },
};

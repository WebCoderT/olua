/**
 * 游戏内邮件（#429）
 *
 * 与 `mail_queue`（外发 SMTP 投递队列）没有关系：那是把信发到玩家注册邮箱，
 * 这是玩家在游戏里打开的收件箱。邮件**只能由服务端产生**（成就奖励背包满兜底、
 * 以后的运营补发），客户端能做的只有看、领、删。
 *
 * 文案在这里，布局在 `configs/layout/dialogs/mail.ts`（#1115 批次 2 起弹窗布局统一口径）：
 * 组件里不写死节点名 / 颜色 / 字号（`audit-config-leak` 盯着这条）。
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

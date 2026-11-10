/**
 * 玩家行为事件类型（**唯一来源**，#886 / J3）
 *
 * ## 与「总线事件」的区别
 * 这里登记的是**日志分类**（落 `event_logs.type`，管理端按它筛），不是
 * `GameEventsService` 的事件名。两者刻意不共用一张表：
 * - 总线事件要求**既有发布者又有订阅者**，否则就是死事件（见 game-events.service 的注释）；
 * - 日志分类是「我们希望事后能查到什么」，允许比现有埋点多 —— 但**没有埋点的那几类必须标明**，
 *   否则运营在管理端翻不到数据时会以为「漏埋了」。
 *
 * ## 十类里两类的现状
 * `trade` / `enhance` **暂时放置**：服务端没有交易与强化模块（27 篇定的是「只做面对面以物易物」，
 * 装备属性由等级派生、没有强化链路），所以这两类只在字典里占位、**没有发布者**。
 * 重开条件：交易 / 强化模块落地时，在各自的写入口补一条 `eventLog.record`，并把这里注释删掉。
 */

/** 事件类型（落库值，下划线风格与表字段一致） */
export const EVENT_TYPE = {
  /** 登录（成功与失败都记；失败的行 `success = 0`，`account_id` 为空） */
  LOGIN: "login",
  /** 进图落地（实时通道 `worldJoin` 通过门槛那一刻，不是「想进」） */
  ENTER_MAP: "enter_map",
  /** 击杀（总线 `monster:killed`） */
  KILL: "kill",
  /** 从地上捡起掉落物（带坐标） */
  PICK: "pick",
  /** 其它来源的物品 / 货币入账（商城购买、任务奖励…；地上捡的走 `pick`，不重复记） */
  GAIN: "gain",
  /** 物品出包（用药品、卖出、丢弃） */
  CONSUME: "consume",
  /** 邮件领取（附件入包） */
  MAIL: "mail",
  /** 任务交付（总线 `quest:claimed`） */
  QUEST: "quest",
  /** 交易 —— **暂时放置**，无发布者（见文件头） */
  TRADE: "trade",
  /** 强化 —— **暂时放置**，无发布者（见文件头） */
  ENHANCE: "enhance",
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

/**
 * 中文名（管理端筛选下拉与列表都用它）
 *
 * 只登记不含发布者的两类也能进字典：下拉的数据源是**库里出现过的类型**
 * （`distinctTypes()`），不是这张表 —— 于是「字典有、数据没有」不会让界面出现空筛选项。
 */
export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  login: "登录",
  enter_map: "进图",
  kill: "击杀",
  pick: "拾取",
  gain: "获得",
  consume: "消耗",
  mail: "邮件",
  quest: "任务",
  trade: "交易（暂时放置）",
  enhance: "强化（暂时放置）",
};

/** 是否是已知类型（未知类型落库也允许 —— 埋点先上、字典后补不该被拦） */
export function isKnownEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_LABELS, value);
}

/**
 * 邮件常量（**唯一来源**）
 *
 * 状态机只有一条链路：`pending → sending → (sent | retrying → sending → …) → failed`。
 * 没有「暂停 / 草稿」态：运营点下发送就是一次已确认的对外动作，留草稿态等于
 * 多出一份「还没发但不知道什么时候会发」的状态要解释。
 */
export const MailStatus = {
  /** 已入队，等待调度器第一次投递 */
  PENDING: "pending",
  /**
   * 正在投递（**瞬时状态**）
   *
   * 落这个状态是为了让「进程在发送中途被杀」这类中断可见：任务停在 sending
   * 说明没有人正在处理它、也没人计划重试它 —— 启动时的 `recoverStuck` 会把它捡回队列。
   */
  SENDING: "sending",
  /** 投递失败但还没到重试上限，等下一次重试 */
  RETRYING: "retrying",
  /** 投递成功 */
  SENT: "sent",
  /** 重试次数用尽，最终失败（原因留在 `lastError`） */
  FAILED: "failed",
} as const;

export type MailStatusValue = (typeof MailStatus)[keyof typeof MailStatus];

/** 全部状态（DTO 校验与文档 inline enum 共用） */
export const MAIL_STATUSES: MailStatusValue[] = Object.values(MailStatus);

/** 状态中文名（管理端界面与文档说明用） */
export const MAIL_STATUS_LABELS: Record<MailStatusValue, string> = {
  [MailStatus.PENDING]: "待发送",
  [MailStatus.SENDING]: "发送中",
  [MailStatus.RETRYING]: "重试中",
  [MailStatus.SENT]: "已发送",
  [MailStatus.FAILED]: "发送失败",
};

/**
 * 可被调度器捡起来投递的状态
 *
 * `sending` 不在里面 —— 它是「有人正在处理」的标记，被中断的 sending 由
 * `recoverStuck` 显式回收（按超时判断），不能让调度器顺手捡走造成重复发信。
 */
export const MAIL_DELIVERABLE_STATUSES: MailStatusValue[] = [MailStatus.PENDING, MailStatus.RETRYING];

/** 收件邮箱长度上限（邮箱格式校验只做最粗的一道：有且仅有一个 @，且不含空白） */
export const MAIL_TO_MAX = 120;

/** 自定义邮件的标题 / 正文长度上限 */
export const MAIL_SUBJECT_MAX = 120;
export const MAIL_BODY_MAX = 4000;

/** 单个模板变量的值长度上限（防止把整篇正文塞进变量里绕过正文长度限制） */
export const MAIL_VARIABLE_VALUE_MAX = 200;

/** 每次调度最多处理多少条（防止一次堆积几千封时把请求线程拖死） */
export const MAIL_BATCH_SIZE = 20;

/** 重试退避的倍数上限（`base * 2^(n-1)` 里的指数封顶，避免第 20 次失败要等好几年） */
export const MAIL_RETRY_MAX_FACTOR = 32;

/**
 * 尝试次数下限（配置项兜底）
 *
 * `MAIL_MAX_ATTEMPTS` 配成 0 或负数的语义会是「一次都不试就直接失败」，
 * 那还不如把通道关掉 —— 所以取配置值时一律不低于 1。
 */
export const MAIL_MIN_ATTEMPTS = 1;

/**
 * 判定「卡在发送中」的超时（毫秒）
 *
 * 认领与投递结束都会写 `updated_at`，超过这个时长还停在 sending，
 * 只可能是执行它的进程已经没了（发信中途被杀 / 容器被回收）。
 */
export const MAIL_STUCK_TIMEOUT_MS = 5 * 60 * 1000;

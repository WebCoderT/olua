/**
 * 社交常量（#388 帮会 / #389 关系）—— **服务端唯一来源**
 *
 * 客户端有一份镜像（`client/assets/configs/social.ts`）：关系的**配色与优先级**只在客户端定义
 * （那纯属表现），而这里管的是**能被刷接口绕过的口径**：职位、人数上限、名字长度。
 * 两边重复的那部分（职位名）由 `tools/audit-shared-data.cjs` 之外的人工约定兜着 ——
 * 改这里记得一起改客户端，否则界面上会显示一个不存在的职位。
 */

/** 帮会职位（`guild_members.rank`；leader 与 `guilds.leader_id` 必须指向同一个人） */
export const GUILD_RANK = {
  LEADER: "leader",
  VICE: "vice",
  MEMBER: "member",
} as const;
export type GuildRank = (typeof GUILD_RANK)[keyof typeof GUILD_RANK];

/** 职位的中文名（服务端也用它拼提示语，客户端不另写一套） */
export const GUILD_RANK_LABELS: Record<string, string> = {
  [GUILD_RANK.LEADER]: "帮主",
  [GUILD_RANK.VICE]: "副帮主",
  [GUILD_RANK.MEMBER]: "成员",
};

/** 帮会名长度（2~12 字：1 个字太容易撞名，太长在列表里放不下） */
export const GUILD_NAME_MIN = 2;
export const GUILD_NAME_MAX = 12;

/** 公告长度上限（0 = 清空公告） */
export const GUILD_NOTICE_MAX = 200;

/** 入帮留言长度上限 */
export const GUILD_APPLICATION_MESSAGE_MAX = 50;

/**
 * 帮会人数上限（默认值；可用 `GUILD_MEMBER_LIMIT` 覆盖）
 *
 * 与帮会等级脱钩：等级这一刀没有业务，别把上限写成 `level * 10` 这种「看起来能用」的公式 ——
 * 那会让一个不存在的系统悄悄决定真实容量。等真做起等级，再让它进这个函数的计算。
 */
export const GUILD_MEMBER_LIMIT_DEFAULT = 50;

/** 帮会 id 前缀（`g_` + 时间戳 + 随机段；与账号 / 角色的命名习惯一致，肉眼可辨类型） */
export const GUILD_ID_PREFIX = "g_";

//#region 好友（#389）

/**
 * 好友关系状态（`role_friends.status`）
 *
 * 只有两态：`pending`（一方发起、等对方处理）与 `accepted`（互为好友）。
 * **不放「拉黑」**：屏蔽是「我不想再收到你的任何东西」，与好友关系正交（拉黑一个陌生人
 * 不需要先加好友），所以它是独立一张表（`role_blocks`，#398）。往这里塞第三态的话，
 * 每一处查好友的代码都要多认一个合法值。
 */
export const FRIEND_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
} as const;
export type FriendStatus = (typeof FRIEND_STATUS)[keyof typeof FRIEND_STATUS];

/** 好友上限（拦住「加一千个好友」的刷子；满了好友列表也没法看） */
export const FRIEND_LIMIT_DEFAULT = 100;

//#endregion

//#region 屏蔽与举报（#398）

/**
 * 屏蔽上限（默认值；可用 `SOCIAL_BLOCK_LIMIT` 覆盖）
 *
 * 拉黑只影响自己（对方不知道、也不受影响），所以上限的作用不是「防骚扰」而是
 * 「防刷表」：没有上限时一个脚本可以给全服每个角色写一行。100 与好友上限同档 ——
 * 一个人真有必要屏蔽上百人时，问题不在这个上限上。
 */
export const BLOCK_LIMIT_DEFAULT = 100;

/**
 * 举报类别（`role_reports.category`）
 *
 * 固定四种：**不开放自由文本**作为类别 —— 自由文本没法在管理端做筛选，
 * 而「其他」已经兜住了所有没覆盖到的情况（详细说明走 `reason`）。
 */
export const REPORT_CATEGORY = {
  /** 骚扰 / 辱骂（聊天里的攻击性内容） */
  ABUSE: "abuse",
  /** 使用外挂 / 刷资源 */
  CHEAT: "cheat",
  /** 角色名 / 帮会名违规 */
  NAME: "name",
  /** 其他（在 reason 里说明） */
  OTHER: "other",
} as const;
export type ReportCategory = (typeof REPORT_CATEGORY)[keyof typeof REPORT_CATEGORY];

export const REPORT_CATEGORIES: ReportCategory[] = Object.values(REPORT_CATEGORY);

/** 举报类别的中文名（管理端列表直接用，不再自己映射一遍） */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  [REPORT_CATEGORY.ABUSE]: "骚扰辱骂",
  [REPORT_CATEGORY.CHEAT]: "外挂刷资源",
  [REPORT_CATEGORY.NAME]: "名字违规",
  [REPORT_CATEGORY.OTHER]: "其他",
};

/** 举报理由长度上限（可空） */
export const REPORT_REASON_MAX = 200;

/**
 * 举报状态（`role_reports.status`）
 *
 * `pending` 待处理 / `handled` 已处理 / `dismissed` 已驳回。
 * v1 **只写 pending**：管理端是只读列表，状态流转与处罚体系是后续刀（issue #398 边界）。
 * 常量先定下来，是为了让后续刀不用改表结构。
 */
export const REPORT_STATUS = {
  PENDING: "pending",
  HANDLED: "handled",
  DISMISSED: "dismissed",
} as const;
export type ReportStatusValue = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];

//#endregion

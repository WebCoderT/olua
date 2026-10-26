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
 * **不做「拉黑」**：拉黑是「我不想收到你的消息」，而本项目没有私聊，
 * 多一态只会让每处查询都要多记一个合法值。想断关系就用删除。
 */
export const FRIEND_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
} as const;
export type FriendStatus = (typeof FRIEND_STATUS)[keyof typeof FRIEND_STATUS];

/** 好友上限（拦住「加一千个好友」的刷子；满了好友列表也没法看） */
export const FRIEND_LIMIT_DEFAULT = 100;

//#endregion

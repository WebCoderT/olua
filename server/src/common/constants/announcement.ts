/**
 * 公告常量（**唯一来源**）
 *
 * 级别只用来决定「展示时的醒目程度」与「列表排序」，不参与权限判断 ——
 * 所以它是个普通的展示枚举，随时可以加档（加档只需在这里 + 管理端选项目）。
 */
export const AnnouncementLevel = {
  /** 普通公告 */
  NORMAL: "normal",
  /** 重要公告（列表排在前，界面标红） */
  IMPORTANT: "important",
} as const;

export type AnnouncementLevelValue = (typeof AnnouncementLevel)[keyof typeof AnnouncementLevel];

/** 全部级别（DTO 枚举校验与文档 inline enum 共用） */
export const ANNOUNCEMENT_LEVELS: AnnouncementLevelValue[] = Object.values(AnnouncementLevel);

/** 标题与正文长度上限（DTO 校验与建表注释共用同一组数字） */
export const ANNOUNCEMENT_TITLE_MAX = 60;
export const ANNOUNCEMENT_CONTENT_MAX = 2000;

/**
 * 投放范围（#963）
 *
 * - `zone`：只投给**当前区**（管理端请求头 `X-Zone-Id` 指定的那个），默认；
 * - `all`：全服（所有区都能看到），需要 `announcement:publish-all`。
 *
 * 客户端**不传 zoneId**：范围是「两个语义之一」，具体是哪个区由服务端按请求上下文算 ——
 * 让客户端传 id 等于给了它一个「往别区发公告」的口子。
 */
export const AnnouncementScope = {
  ZONE: "zone",
  ALL: "all",
} as const;

export type AnnouncementScopeValue = (typeof AnnouncementScope)[keyof typeof AnnouncementScope];

/** 全部投放范围（DTO 枚举校验与文档 inline enum 共用） */
export const ANNOUNCEMENT_SCOPES: AnnouncementScopeValue[] = Object.values(AnnouncementScope);

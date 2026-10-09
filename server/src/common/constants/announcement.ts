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

/** 级别中文名（管理端界面与文档说明用） */
export const ANNOUNCEMENT_LEVEL_LABELS: Record<AnnouncementLevelValue, string> = {
  [AnnouncementLevel.NORMAL]: "普通",
  [AnnouncementLevel.IMPORTANT]: "重要",
};

/** 标题与正文长度上限（DTO 校验与建表注释共用同一组数字） */
export const ANNOUNCEMENT_TITLE_MAX = 60;
export const ANNOUNCEMENT_CONTENT_MAX = 2000;

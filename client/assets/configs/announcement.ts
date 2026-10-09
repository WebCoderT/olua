import { getText } from "./texts";

/**
 * 公告（玩家侧展示）
 *
 * 职责边界：本文件只把「服务端拉回来的公告」变成**界面可以直接渲染的数据** ——
 * 排序、级别标签、时间窗文案、未读标记。拉取在 ui 层（ui/components/dialogs/Announcement*），
 * 已读记录在 ui/core/AnnouncementReadStore，这里既不碰网络也不碰存储。
 *
 * 为什么不直接把服务端字段丢给界面：「重要在前」「什么算未读」都是**展示口径**，
 * 服务端不关心；收敛到这里才能进沙箱单测（见 client/tools/test-announcement.cjs）。
 *
 * 输入的字段口径与公共接口 `GET /announcements/active` 一致（只有展示需要的那些，
 * 没有 enabled / 发布人 / 内部时间戳）。这里刻意用**结构类型**声明而不是 import
 * ui/utils/net 的生成模型：configs 不依赖 ui 层（见 configs 目录约定）。
 */
export interface AnnouncementInput {
  id: string;
  title: string;
  content: string;
  /** 级别：important 重要 / 其余按普通处理（服务端当前只有 normal / important 两档） */
  level: string;
  /** 生效开始时间（毫秒）；null = 立即生效 */
  startsAt: number | null;
  /** 生效结束时间（毫秒，不含）；null = 不设截止 */
  endsAt: number | null;
}

/** 重要级别（服务端 configs/announcement 同口径；客户端只用来分流展示） */
export const announcementImportantLevel = "important";

/** 界面渲染用的公告 */
export interface AnnouncementView {
  id: string;
  title: string;
  content: string;
  level: string;
  /** 级别标签的文案 key（取文案见 configs/texts，配色见 layout 的 levelColors） */
  levelTextKey: string;
  /** 时间窗的人读文案（模板已填好） */
  timeText: string;
  /** 相对**本地已读记录**是否未读 */
  unread: boolean;
}

/** 是否是重要公告（登录页提醒只摊开这一类） */
export function isImportant(level: string): boolean {
  return level === announcementImportantLevel;
}

/**
 * 级别标签的文案 key
 *
 * 只给「重要」单独一条文案，其余（含服务端以后新加的级别）一律按普通渲染：
 * 级别是运营侧的口径，客户端多一档就多一处要同步的样式，宁可回落也不自己发明。
 */
export function getAnnouncementLevelTextKey(level: string): string {
  return isImportant(level) ? "label_announcement_level_important" : "label_announcement_level_normal";
}

/**
 * 排序：重要在前，同级保持服务端给的相对次序
 *
 * 服务端的 `listActive` 已经是「重要在前 + 发布时间倒序」——但**发布时间不在公共接口的字段里**，
 * 客户端只有生效时间窗。拿时间窗当排序键会得到一套自造的、与运营预期不一致的顺序
 * （「立即生效」的那条按字面比谁都早），所以这里不自造口径，只做级别分层，
 * 同级用原始下标兜底 → 同一份输入永远同一个顺序（不依赖 Array.sort 的稳定性）。
 */
export function sortAnnouncements<T extends AnnouncementInput>(list: readonly T[]): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => levelRank(a.item.level) - levelRank(b.item.level) || a.index - b.index)
    .map((entry) => entry.item);
}

/** 分层用：重要 0 / 普通 1 */
function levelRank(level: string): number {
  return isImportant(level) ? 0 : 1;
}

/**
 * 组装渲染数据（排序 + 级别标签 + 时间窗文案 + 未读标记）
 *
 * @param list 服务端返回的生效中公告
 * @param readIds 本地已读的公告 id（见 ui/core/AnnouncementReadStore）
 */
export function buildAnnouncementViews(list: readonly AnnouncementInput[], readIds: readonly string[]): AnnouncementView[] {
  const read = new Set<string>(readIds);
  return sortAnnouncements(list).map((item) => ({
    id: item.id,
    title: item.title,
    content: item.content,
    level: item.level,
    levelTextKey: getAnnouncementLevelTextKey(item.level),
    timeText: formatAnnouncementWindow(item.startsAt, item.endsAt),
    unread: !read.has(item.id),
  }));
}

/** 登录页提醒要摊开的那几条：只取重要公告（顺序沿用 buildAnnouncementViews 的结果） */
export function pickNoticeAnnouncements(views: readonly AnnouncementView[]): AnnouncementView[] {
  return views.filter((view) => isImportant(view.level));
}

/** 未读条数（入口小红点与公告板标题用同一个口径） */
export function countUnread(views: readonly AnnouncementView[]): number {
  let count = 0;
  views.forEach((view) => {
    if (view.unread) count += 1;
  });
  return count;
}

/**
 * 时间窗的人读文案（`开始 → 结束`）
 *
 * 两个 null 分别代表「立即生效」与「不设截止」—— 服务端就是这么表达的（见公告表的两个可空列），
 * 客户端不把 null 折算成某个具体时间，否则「长期有效」会被显示成某天到期。
 */
export function formatAnnouncementWindow(startsAt: number | null, endsAt: number | null): string {
  const from = startsAt === null ? getText("label_announcement_immediate") : formatAnnouncementTime(startsAt);
  const to = endsAt === null ? getText("label_announcement_longterm") : formatAnnouncementTime(endsAt);
  return getText("label_announcement_window", { from, to });
}

/**
 * 时间点文本（本地时区的 MM-DD HH:mm）
 *
 * 不显示年份：公告都是「当下正在生效」的，跨年的公告在游戏里没有可读性收益，
 * 多两个数字反而挤掉标题的位置。
 */
export function formatAnnouncementTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

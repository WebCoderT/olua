import { sys } from "cc";

/**
 * 公告已读记录（本机）
 *
 * 只服务一件事：游戏内公告板上的「未读」标记。服务端不知道（也不需要知道）谁读过哪条，
 * 所以这份记录不上报、也不与服务端对齐 —— 它是纯粹的**展示状态**。
 *
 * 与 StorageManager 分开的原因：那个类管的是角色数据，而它的落盘出口 `updateOnlineRole`
 * 会连带把数据推给服务端（见 RoleSync）。把展示状态混进去，等于每次标已读都触发一次角色同步。
 *
 * 记录随**本机**走，不按账号分账本：换账号登录时上个账号的已读会继续生效 ——
 * 最坏后果是把一条已读公告再标一次已读，对展示层来说可接受（换来的是不必在这里再依赖会话）。
 */
export default class AnnouncementReadStore {
  /** 本机存储键（与角色数据分开，进登录页清缓存时不被一起带走，见 StorageManager.clear） */
  private static readonly KEY = "olua.announcementRead";

  /**
   * 已读的公告 id
   *
   * 读失败或格式不对一律当「没读过」：宁可多标几条未读，也不要因为一条坏记录
   * 让整个公告板空掉（同一口径见 ui/utils/net/Session 读账号时的容错）。
   */
  static getReadIds(): string[] {
    const raw = sys.localStorage.getItem(this.KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }

  /**
   * 记录已读
   *
   * @param readIds 本次视为已读的公告 id
   * @param activeIds 本次拉到的「生效中」公告 id 全集 —— 记录只在它里面保留，
   *   于是公告过期后对应的 id 自然被丢掉，本机不会随公告越来越多而无限增长
   */
  static markRead(readIds: readonly string[], activeIds: readonly string[]): void {
    const kept = this.getReadIds().filter((id) => activeIds.indexOf(id) !== -1);
    readIds.forEach((id) => {
      if (kept.indexOf(id) === -1) kept.push(id);
    });
    sys.localStorage.setItem(this.KEY, JSON.stringify(kept));
  }
}

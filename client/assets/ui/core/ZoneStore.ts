import { sys } from "cc";

/**
 * 本机记住的选区（#962）
 *
 * 只记「上一次选了哪个区」这一件事 —— 它是**偏好**，不是权威：真正生效的区在服务端
 * （`accounts.active_zone_id`），选角页每次进来都拿这份偏好去对齐一次（见 RoleSelector.ensureZone）。
 * 所以记录丢了 / 坏了最多是「默认回到最新区」，不会玩错号。
 *
 * 为什么存客户端而不是只信服务端：绝大多数玩家每次都在同一台机器上进同一个区，记在本机
 * 就能在**选服弹窗第一次打开时**把那个区排在高亮位（服务端也记着，但弹窗还要显示区名，
 * 存一份省一次「区 id → 区名」的额外查询）。
 *
 * 不按账号分账本（与 AnnouncementReadStore 同口径）：换账号登录时上个账号的选区会继续当默认值。
 * 最坏后果是别人的号默认落在你常玩的区，改一次就好；换来的是不必在这里再依赖会话。
 */
export default class ZoneStore {
  /** 本机存储键（与角色数据分开：进登录页清角色缓存时不带走它，见 StorageManager.clear） */
  private static readonly KEY = "olua.zone";

  /**
   * 读上次选的区
   *
   * 没有记录、JSON 坏了、id 不是数字一律返回 null —— 调用方回落到「最新的区」
   * （容错口径同 ui/utils/net/Session 读账号：宁可当没选过，也不要拿一条坏记录去请求）。
   */
  static get(): { id: number; name: string } | null {
    const raw = sys.localStorage.getItem(this.KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown };
      if (typeof parsed.id !== "number" || !Number.isFinite(parsed.id)) return null;
      return { id: parsed.id, name: typeof parsed.name === "string" ? parsed.name : "" };
    } catch {
      return null;
    }
  }

  /**
   * 记下这次选的区
   *
   * 区名一起存：游戏内的榜单 / 帮会标题要显示「X区 · …」，为几个字再发一次
   * `GET /zones/mine` 不值得（而且那个接口在游戏里也不该被反复调）。
   */
  static set(id: number, name: string): void {
    sys.localStorage.setItem(this.KEY, JSON.stringify({ id, name }));
  }

  /** 当前区名（没记录时给空串，调用方自己决定怎么退化 —— 别在这里编一个「一区」） */
  static currentName(): string {
    return this.get()?.name ?? "";
  }
}

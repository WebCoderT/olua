import { SocialApi } from "../utils/net/Api";
import type { MySocial } from "../utils/net/Api";
import type { RelationSelf } from "../../configs/social";
import PartyStore from "./PartyStore";

/**
 * 社交快照（#389：好友 / 敌人 / 我的帮会）
 *
 * ## 为什么要有这一层
 * 「我和他什么关系」这个判断在地图上是**逐帧**发生的（互见帧里每个远端玩家都要上一次色），
 * 而原料（我的好友 / 敌人 / 帮会）来自 HTTP 快照 —— 一次请求、多处消费。
 * 把它放成一个内存单例，`OtherPlayerManager` 与社交弹窗读同一份，改一处两边一起变。
 *
 * ## 谁负责刷新
 * - 登录进图后第一次收到互见帧时 `ensure()` 拉一次（地图上要上色，不能等玩家打开面板）；
 * - 社交弹窗每次切页 / 每次写操作后用响应里的 `MySocial` 覆盖（写接口都返回最新快照）；
 * - 帮会页的操作（建帮 / 入帮 / 退帮 / 解散）也会改 `guildId`，所以由弹窗统一在切页时重拉。
 *
 * ## 屏蔽名单（#398）
 * 快照里的 `blocks` 也在这里：地图上「这个人该不该出现」判断要用它。
 * 注意它只有**我拉黑的人** —— 「谁拉黑了我」服务端不下发（下发等于把屏蔽变成可观测信号）。
 *
 * ## 不落盘
 * 这是服务端状态的镜像，不是权威。掉线重连后重新拉一次即可；本地缓存只会制造
 * 「好友已经删了我这边还显示是好友」这类漂移。
 */
export default class SocialStore {
  /** 最近一次拿到的快照（null = 还没拉过） */
  private static snapshot: MySocial | null = null;
  /** 正在拉取中（并发调用合并成一次请求） */
  private static loading: Promise<void> | null = null;
  /** 快照变化时的回调（远端玩家名字颜色据此就地重刷） */
  private static listeners: Array<() => void> = [];

  /** 当前快照（未拉过返回 null；只读，改快照请走 set） */
  static get(): MySocial | null {
    return this.snapshot;
  }

  /**
   * 覆盖快照并通知订阅者
   *
   * 写接口（加好友 / 同意 / 标敌人…）的响应就是最新快照，直接喂进来，
   * 不必再请求一次 —— 也就不会出现「提示成功了，颜色还是旧的」。
   */
  static set(snapshot: MySocial): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  /**
   * 拉一次快照（已有请求在飞时复用它）
   *
   * 失败不抛：社交是**装饰性**数据（名字颜色 / 面板列表），拉不到就按「都是陌生人」显示，
   * 不该让玩家的主流程（进图、走路）因为一次 401/超时中断。
   */
  static refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = SocialApi.mine()
      .then((snapshot) => this.set(snapshot))
      .catch(() => undefined)
      .then(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** 还没拉过就拉一次（地图上第一次见到别人时调用；已拉过是空操作） */
  static ensure(): void {
    if (this.snapshot || this.loading) return;
    void this.refresh();
  }

  /** 订阅快照变化（同一函数重复订阅只算一次） */
  static onChange(listener: () => void): void {
    if (this.listeners.indexOf(listener) >= 0) return;
    this.listeners.push(listener);
  }

  /**
   * 关系判定的「我这一半」（#389 的唯一取源）
   *
   * 未拉过快照时给一个空壳：`roleId` 为空、没有任何好友 / 敌人 / 帮会 ——
   * `resolveRelation` 于是把所有人算成「同地图 / 普通」，与拉取前的显示一致。
   *
   * 队伍 id（#399）不在社交快照里：它来自实时通道的 `party` 帧，住在 `PartyStore`。
   * 两边都指向同一个判定入口 —— 「面板说我是队长」与「地图上队友名字是金色」用的是同一个 partyId。
   */
  static relationSelf(): RelationSelf {
    const partyId = PartyStore.partyId();
    const snapshot = this.snapshot;
    if (!snapshot) return { roleId: "", guildId: "", partyId, friendIds: [], enemyIds: [], blockIds: [] };
    return {
      roleId: snapshot.myRoleId,
      guildId: snapshot.guildId,
      partyId,
      friendIds: snapshot.friends.map((entry) => entry.roleId),
      enemyIds: snapshot.enemies.map((entry) => entry.roleId),
      blockIds: snapshot.blocks.map((entry) => entry.roleId),
    };
  }

  /** 是否已是好友（附近列表据此把按钮置灰，避免点一下拿 50111） */
  static isFriend(roleId: string): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !roleId) return false;
    return snapshot.friends.some((entry) => entry.roleId === roleId);
  }

  /** 是否已标敌人（同上，避免点一下拿 50113） */
  static isEnemy(roleId: string): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !roleId) return false;
    return snapshot.enemies.some((entry) => entry.roleId === roleId);
  }

  /** 是否已拉黑（#398：「附近」行据此把按钮换成「已拉黑」，避免点一下拿 50117） */
  static isBlocked(roleId: string): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !roleId) return false;
    return snapshot.blocks.some((entry) => entry.roleId === roleId);
  }

  /** 是否有「等我处理」的申请（入口按钮上的小红点之类；现在只有面板里用） */
  static incomingCount(): number {
    return this.snapshot ? this.snapshot.incoming.length : 0;
  }

  /** 清空（登出 / 换角色）：新角色的一切关系都不一样，留着就是错的 */
  static clear(): void {
    this.snapshot = null;
    this.loading = null;
    this.listeners.forEach((listener) => listener());
  }
}

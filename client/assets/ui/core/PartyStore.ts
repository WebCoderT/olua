import type { PartyInvite, PartySnapshot } from "../utils/net/CombatChannel";

/**
 * 队伍仓（#399：队伍面板 / 队友名字上色 / 队标的**唯一数据源**）
 *
 * ## 数据从哪来
 * 全部来自实时通道的三条帧（服务端是唯一权威，客户端一份本地状态都没算）：
 * - `party`：我的队伍现状（成员 / 队长 / 上限），**只在变化时发**，空 `partyId` = 我不在队伍；
 * - `partyInvite`：有人邀请我；
 * - `expGain`：队友击杀我分到的经验（这份经验**已经入账**，这里不管账，只管清掉过期的邀请）。
 *
 * ## 为什么关系判定要读这里
 * 「队友」是 `resolveRelation` 的一档（优先级在敌人之下、同帮之上），
 * 而判定需要「我的 partyId」—— 那个值就在这里。`SocialStore.relationSelf()` 从这里取，
 * 于是队友金色与面板显示走的是同一个数，不会出现「面板说在队里、地图上名字不是金色」。
 *
 * ## 邀请是**易失**的
 * 服务端把邀请放内存、30 秒过期（不落库）：帧丢了就只是「没收到邀请」，
 * 不会留下悬空状态。客户端这里同样只在内存里留一份，过期就自己扔掉 ——
 * 留一条点不动的僵尸邀请比看不见更糟。
 *
 * ## 时钟口径
 * 过期时刻 `expiresAt` 是**服务端时钟**。直接拿本机 `Date.now()` 跟它比，
 * 两端差几分钟就会「刚收到就过期」或「过期十分钟还能点」。所以收到时先算**还剩多久**
 * （`expiresAt - 收到时刻`），之后一律按本机时钟数这个时长。
 */
export default class PartyStore {
  /** 我的队伍现状（null = 没有队伍 / 还没收到过帧） */
  private static snapshot: PartySnapshot | null = null;
  /** 待处理的邀请（按到达顺序；同一个人重复邀请会合并成一条） */
  private static invites: Array<{ invite: PartyInvite; expiresAt: number }> = [];
  private static listeners: Array<() => void> = [];

  /** 我的队伍 id（空串 = 没队伍；关系判定用它区分「同队」） */
  static partyId(): string {
    return this.snapshot ? this.snapshot.partyId : "";
  }

  /** 当前队伍现状（null = 没队伍） */
  static current(): PartySnapshot | null {
    return this.snapshot;
  }

  /** 是否在队伍里 */
  static inParty(): boolean {
    return !!this.snapshot && this.snapshot.partyId !== "";
  }

  /** 我是不是队长（踢人 / 转让 / 解散按钮据此亮） */
  static isLeader(): boolean {
    return !!this.snapshot && this.snapshot.isLeader;
  }

  /** 队伍上限（没队伍时返回 0；面板据此显示「3 / 4」） */
  static limit(): number {
    return this.snapshot ? Math.max(0, this.snapshot.limit) : 0;
  }

  /** 某个人是不是我的队友（聊天名字上色 / 附近列表「已在队里」判断用） */
  static has(roleId: string): boolean {
    if (!this.snapshot || !roleId) return false;
    return this.snapshot.members.some((member) => member.roleId === roleId);
  }

  /** 覆盖率：队友里在线 / 同图的人（面板顶部的一行小结用） */
  static sameMapCount(): number {
    if (!this.snapshot) return 0;
    return this.snapshot.members.filter((member) => member.sameMap).length;
  }

  /**
   * 落一份队伍快照（realtime `party` 帧；进图补的快照也走这里）
   *
   * 空 `partyId` 一律归一成「没有队伍」：客户端各处只需要判断 `current()` 有没有值，
   * 不必到处再判断 `partyId !== ""`（漏一处的症状是「退队了面板还开着」）。
   */
  static applySnapshot(snapshot: PartySnapshot): void {
    if (!snapshot || typeof snapshot.partyId !== "string") return;
    if (!snapshot.partyId) {
      this.snapshot = null;
      // 已经不在队伍了，别人再拉我进新队才有意义 —— 旧邀请一并清掉
      this.invites = [];
    } else {
      this.snapshot = {
        partyId: snapshot.partyId,
        leaderRoleId: snapshot.leaderRoleId ?? "",
        limit: Math.max(0, snapshot.limit || 0),
        members: Array.isArray(snapshot.members) ? snapshot.members : [],
        isLeader: !!snapshot.isLeader,
      };
    }
    this.notify();
  }

  /** 落一条邀请（同一个人重复邀请只留最新那条，避免面板上叠一排同名） */
  static applyInvite(invite: PartyInvite): void {
    if (!invite || !invite.fromRoleId) return;
    this.prune();
    const remain = Math.max(0, invite.expiresAt - Date.now());
    const entry = { invite, expiresAt: Date.now() + remain };
    const index = this.invites.findIndex((item) => item.invite.fromRoleId === invite.fromRoleId);
    if (index >= 0) this.invites.splice(index, 1);
    this.invites.push(entry);
    this.notify();
  }

  /** 还活着的邀请（读的时候顺手清过期的；面板直接渲染这个列表） */
  static pendingInvites(): PartyInvite[] {
    this.prune();
    return this.invites.map((item) => item.invite);
  }

  /** 摘掉某个人的邀请（同意 / 拒绝之后都得摘，否则同一条能点两次） */
  static dropInvite(fromRoleId: string): void {
    const before = this.invites.length;
    this.invites = this.invites.filter((item) => item.invite.fromRoleId !== fromRoleId);
    if (this.invites.length !== before) this.notify();
  }

  /** 某个人是不是队长（面板每行显示「队长」用小徽标） */
  static isLeaderRole(roleId: string): boolean {
    return !!this.snapshot && !!roleId && this.snapshot.leaderRoleId === roleId;
  }

  /** 订阅变化（队伍面板 / 名字上色都挂在上面） */
  static onChange(listener: () => void): () => void {
    if (this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /**
   * 清空（切场景 / 回登录：队伍是「这个角色此刻」的状态，不跨会话留）
   *
   * **订阅者不清**：`OtherPlayerManager` 的「队伍一变就重刷名字颜色」是长期订阅，
   * 在这里把 listeners 清掉，重新登录后就再也没人通知它了（症状：队友名字一直是白的）。
   * 与 `SocialStore.clear` 同一口径 —— 数据清空 ≠ 拆掉线。
   */
  static clear(): void {
    this.snapshot = null;
    this.invites = [];
    this.notify();
  }

  //#region 内部

  private static notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  /** 清掉过期的邀请（懒清理：只在读写时跑，不起定时器） */
  private static prune(): void {
    const now = Date.now();
    this.invites = this.invites.filter((item) => item.expiresAt > now);
  }

  //#endregion
}

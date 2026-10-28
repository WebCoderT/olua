import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import {
  PARTY_ACTION,
  PARTY_EXP_MATE_SHARE_DEFAULT,
  PARTY_ID_PREFIX,
  PARTY_INVITE_TTL_MS_DEFAULT,
  PARTY_MEMBER_LIMIT_DEFAULT,
  PARTY_MIN_LEVEL_DEFAULT,
} from "../../common/constants/social";
import { PartyRepository } from "../../database/repositories/party.repository";
import { PartyMemberWithRoleRow, PartyRow } from "../../database/rows";
import { RolesService } from "../roles/roles.service";
import type {
  RealtimePartyInviteMessage,
  RealtimePartyMember,
  RealtimePartySnapshot,
  RealtimePartySnapshotMessage,
  RealtimeServerMessage,
} from "../realtime/realtime.protocol";

/** 一次队伍操作的发起人（身份由实时通道给，服务端不信客户端自称） */
export interface PartyActor {
  accountId: string;
  roleId: string;
  /** 显示名（角色名；飘字与邀请帧里用） */
  name: string;
  /** 当前所在地图（空串 = 还没进图；同图判定用） */
  mapId: string;
}

/** 一条待处理的邀请（内存态，30 秒过期） */
interface PartyInvite {
  partyId: string;
  fromRoleId: string;
  fromName: string;
  fromLevel: number;
  memberCount: number;
  expiresAt: number;
}

/**
 * 队伍（#399）
 *
 * ===========================================================================
 * 为什么落库、为什么走帧
 * ===========================================================================
 * - **落库**（`parties` + `party_members`）：纯内存的队伍在实时进程重启时就全没了，
 *   而「重连回来还在同一个队」才是玩家的预期；顺带把「一人一队」交给数据库的唯一约束。
 * - **走 WS 帧**：邀请必须即时送达。HTTP 在存档进程、WS 在实时进程，存档进程推不到
 *   别人的通道；而队伍快照本来就要跟互见帧一起变（队友金色名字、头顶队标）。
 *
 * ===========================================================================
 * 缓存只有一张表
 * ===========================================================================
 * `roleId → partyId` 进内存：这是**热路径**（互见帧 200ms 一拍、每次击杀分经验一次都要问）。
 * 其余一律读库 —— 队伍快照只在变化时发，一次 JOIN 读库不心疼，而缓存成员名单就得在
 * 改名 / 升级 / 入队 / 退队四条路径上同步，多出来的只是漂移的机会。
 * 写也全部走本服务（实时进程是队伍表的唯一写者），所以这张表不需要 TTL 刷新。
 *
 * ===========================================================================
 * 谁有权限做什么
 * ===========================================================================
 * - 邀请：**任何队员都能邀**（组队是协作，门槛只会挡住正常玩家）；
 * - 踢人 / 转让 / 解散：只有队长（这三件事会伤到别人）；
 * - 退出：谁都能退。队长退出**自动移交**给最早加入的成员（没人就删队）——
 *   「队长不能退」在队长掉线不回来时会把整队锁死。
 *
 * ===========================================================================
 * 与屏蔽的关系（#398）
 * ===========================================================================
 * 双向都不能互邀。两种说法分开：**我拉黑他** → 明说「先解除」（那是自己的设置）；
 * **他拉黑我** → 只说「对方不在线」（说破等于把屏蔽变成可观测信号，
 * 与私聊同一纪律）。
 */
@Injectable()
export class PartyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartyService.name);

  /** 热路径索引：角色 → 队伍（唯一写者是本服务，所以不需要 TTL 刷新） */
  private readonly partyOfRole = new Map<string, string>();

  /** 待处理的邀请：被邀请人角色 id → 他收到的邀请（最多几条，正常状态是一条） */
  private readonly invites = new Map<string, PartyInvite[]>();

  /**
   * 发送出口（RealtimeService 启动时接线）
   *
   * 不注入 RealtimeService 的原因与 presence 的 `onBroadcast` 一样：通道依赖队伍，
   * 队伍再依赖通道就成了循环。
   */
  sendTo: ((accountId: string, frame: RealtimeServerMessage) => void) | null = null;

  /**
   * 在线位置（RealtimeService 接线）：角色 id → 连接所在账号与地图
   *
   * 返回 null = 这个角色此刻没有在线连接。队伍快照的「在线 / 同图」与经验分享的
   * 「同图才分」都靠它，而连接表在通道那边。
   */
  locationOf: ((roleId: string) => { accountId: string; mapId: string } | null) | null = null;

  /** 屏蔽判定（RealtimeService 接线到 BlockService.hiddenFor：a 是否拉黑了 b） */
  blockedFrom: ((aRoleId: string, bRoleId: string) => boolean) | null = null;

  constructor(
    private readonly parties: PartyRepository,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 启动时把「谁在哪个队」灌进内存
   *
   * 队伍表规模很小（在线玩家数 / 队伍人数），一次整表读足够；这也是「落库」的收益兑现处：
   * 进程重启后内存索引照样是对的，玩家重连回来还在队里。
   */
  onApplicationBootstrap(): void {
    try {
      for (const row of this.parties.allMemberships()) this.partyOfRole.set(row.role_id, row.party_id);
      if (this.partyOfRole.size > 0) {
        this.logger.log(`队伍索引已恢复（${this.partyOfRole.size} 名成员在队里）`);
      }
    } catch (error) {
      // 起服失败不该挡启动：索引是缓存，读失败只意味着「重启后第一次查询会读库」
      this.logger.warn(`恢复队伍索引失败（重启后按需读库）：${(error as Error).message}`);
    }
  }

  //#region 只读出口（互见 / 结算用）

  /** 这个角色在哪个队（空串 = 没队伍；热路径，全内存） */
  partyIdOfRole(roleId: string): string {
    if (!roleId) return "";
    return this.partyOfRole.get(roleId) ?? "";
  }

  /**
   * 与击杀者同图、在线的其他队友（经验分成用）
   *
   * 只返回**在线且同图**的：离线队友不能入账（`applyKillExp` 要求账号的在线角色是它），
   * 不同图的队友拿不到（组队不等于「全图共享经验」，那是跨图支援的事，本刀不做）。
   */
  sameMapMates(roleId: string, mapId: string): Array<{ roleId: string; accountId: string }> {
    const partyId = this.partyIdOfRole(roleId);
    if (!partyId || !mapId) return [];
    const mates: Array<{ roleId: string; accountId: string }> = [];
    for (const member of this.parties.membersOf(partyId)) {
      if (member.role_id === roleId) continue;
      const location = this.locationOf?.(member.role_id) ?? null;
      if (!location || location.mapId !== mapId) continue;
      mates.push({ roleId: member.role_id, accountId: location.accountId });
    }
    return mates;
  }

  /**
   * 进图 / 重连时补一份快照
   *
   * 快照只在变化时发：换图与断线重连的人都错过了那些变化，进图这一步是**重建**的时机
   * （与互见的 `full` 快照同一口径）。顺带解决了「上线时队伍已存在」——
   * 客户端不需要再走一条 HTTP 拉取。
   */
  pushSnapshotToAccount(accountId: string, roleId: string, mapId: string): void {
    if (!accountId || !roleId) return;
    this.sendSnapshot(roleId, { accountId, mapId });
  }

  /** 队友分到经验的通知（#399；由结算侧调用，走同一根发送出口） */
  notifyExpGain(accountId: string, data: RealtimeExpGainPayload): void {
    this.sendTo?.(accountId, { type: "expGain", data });
  }

  //#endregion

  //#region 动作入口（实时通道分发）

  /**
   * 处理一条 `party` 帧
   *
   * 统一规则：**成功 = 给发起人一份他自己的最新快照**（客户端只认快照，不自己推状态），
   * 失败 = 一条 `error` 帧（带业务码，客户端据此选提示语）。这样客户端不需要为每个动作
   * 单独写「成功之后怎么改本地状态」—— 少一套会和真状态漂移的镜像。
   */
  handle(actor: PartyActor, action: unknown, targetRoleId: unknown): void {
    if (typeof action !== "string" || !action) {
      this.fail(actor, BizCode.PARAM_INVALID, "party 消息缺 action");
      return;
    }
    const target = typeof targetRoleId === "string" ? targetRoleId.trim() : "";
    switch (action) {
      case PARTY_ACTION.INVITE:
        this.invite(actor, target);
        return;
      case PARTY_ACTION.ACCEPT:
        this.accept(actor);
        return;
      case PARTY_ACTION.DECLINE:
        this.decline(actor);
        return;
      case PARTY_ACTION.LEAVE:
        this.leave(actor, true);
        return;
      case PARTY_ACTION.KICK:
        this.kick(actor, target);
        return;
      case PARTY_ACTION.TRANSFER:
        this.transfer(actor, target);
        return;
      case PARTY_ACTION.DISBAND:
        this.disband(actor);
        return;
      default:
        this.fail(actor, BizCode.PARAM_INVALID, `不认识的队伍动作：${action}`);
    }
  }

  //#endregion

  //#region 动作实现

  /**
   * 邀请某人入队（邀请人还没队伍时**顺手建一支**）
   *
   * 不单设「创建队伍」：单人的空队伍没有任何存在感，多一次点击只是把「组队」拆成两步。
   */
  private invite(actor: PartyActor, targetRoleId: string): void {
    if (!targetRoleId) {
      this.fail(actor, BizCode.PARAM_INVALID, "invite 缺 roleId");
      return;
    }
    if (targetRoleId === actor.roleId) {
      this.fail(actor, BizCode.PARTY_INVITE_SELF, "不能邀请自己");
      return;
    }
    // 等级门槛（#497）：客户端「组队」入口按 openLevel 锁着（现在是 10），服务端必须同口径 ——
    // 否则改包就能让一个 1 级号去邀请别人，而对方收到邀请后连面板都打不开，邀请只能烂在那儿。
    // 先卡发起人（自己不够级，后面查目标都没意义）
    const minLevel = this.minLevel();
    if (this.roles.levelOf(actor.roleId) < minLevel) {
      this.fail(actor, BizCode.PARTY_LEVEL_TOO_LOW, `需要 ${minLevel} 级才能组队`);
      return;
    }
    if (!this.roles.existsById(targetRoleId)) {
      this.fail(actor, BizCode.SOCIAL_ROLE_NOT_FOUND, "找不到这个角色");
      return;
    }
    // 屏蔽优先（#398）：两个方向分开说 —— 我拉黑他是自己的设置（可以解除），
    // 他拉黑我不能说破（说破等于把屏蔽变成信号）
    if (this.blockedFrom?.(actor.roleId, targetRoleId)) {
      this.fail(actor, BizCode.PARTY_INVITE_BLOCKED, "你已把对方拉黑，先解除才能邀请");
      return;
    }
    if (this.blockedFrom?.(targetRoleId, actor.roleId)) {
      this.fail(actor, BizCode.PARTY_TARGET_OFFLINE, "对方不在线");
      return;
    }
    // 目标已经在线才可能收到帧：离线邀请只能靠落库 + 上线补推，本刀不做（见 #399 边界）
    const targetLocation = this.locationOf?.(targetRoleId) ?? null;
    if (!targetLocation) {
      this.fail(actor, BizCode.PARTY_TARGET_OFFLINE, "对方不在线");
      return;
    }
    // 目标等级（#497）：等级不够的号收到邀请也打不开面板（入口锁着），不如现在就说清
    const targetLevel = this.roles.levelOf(targetRoleId);
    if (targetLevel < minLevel) {
      this.fail(actor, BizCode.PARTY_LEVEL_TOO_LOW, `对方还没到 ${minLevel} 级（当前 ${targetLevel} 级），暂时不能组队`);
      return;
    }
    if (this.partyIdOfRole(targetRoleId)) {
      this.fail(actor, BizCode.PARTY_ALREADY_IN, "对方已经在队伍里了");
      return;
    }
    this.pruneInvites();
    const existing = this.invites.get(targetRoleId) ?? [];
    if (existing.some((entry) => entry.fromRoleId === actor.roleId)) {
      this.fail(actor, BizCode.PARTY_INVITE_EXISTS, "已经邀请过他了，等对方回应");
      return;
    }

    // 发起人没队伍 → 建一支（自己当队长）。建队与邀请分两步写库：建队成功但邀请失败时，
    // 留下一支只有自己的队伍 —— 它是可恢复状态（解散即可），不需要回滚
    let partyId = this.partyIdOfRole(actor.roleId);
    if (!partyId) {
      partyId = this.createParty(actor.roleId);
      if (!partyId) {
        this.fail(actor, BizCode.INTERNAL, "创建队伍失败，请稍后重试");
        return;
      }
    }
    const roster = this.parties.membersOf(partyId);
    if (roster.length >= this.memberLimit()) {
      this.fail(actor, BizCode.PARTY_FULL, `队伍已满（${this.memberLimit()} 人）`);
      return;
    }

    const invite: PartyInvite = {
      partyId,
      fromRoleId: actor.roleId,
      fromName: actor.name,
      fromLevel: this.levelOfActor(actor),
      memberCount: roster.length,
      expiresAt: Date.now() + this.inviteTtlMs(),
    };
    this.invites.set(targetRoleId, [...existing, invite]);
    const frame: RealtimePartyInviteMessage = {
      type: "partyInvite",
      data: {
        partyId,
        fromRoleId: invite.fromRoleId,
        fromName: invite.fromName,
        fromLevel: invite.fromLevel,
        memberCount: invite.memberCount,
        limit: this.memberLimit(),
        expiresAt: invite.expiresAt,
      },
    };
    this.sendTo?.(targetLocation.accountId, frame);
    // 发起人拿到自己的快照（刚建队时这是「只有我」的那一份；已在队里则是原样回一份，幂等）
    this.sendSnapshotTo([actor.roleId]);
    this.logger.debug(`邀请入队：${actor.name}(${actor.roleId}) → ${targetRoleId}（队 ${partyId}）`);
  }

  /** 同意最近一条邀请（多条时取最晚收到的那条） */
  private accept(actor: PartyActor): void {
    this.pruneInvites();
    const list = this.invites.get(actor.roleId) ?? [];
    const invite = list.length > 0 ? list[list.length - 1] : null;
    if (!invite) {
      this.fail(actor, BizCode.PARTY_INVITE_NOT_FOUND, "没有待处理的队伍邀请（可能已过期，让队长再拉一次）");
      return;
    }
    if (this.partyIdOfRole(actor.roleId)) {
      this.fail(actor, BizCode.PARTY_ALREADY_IN, "你已经在队伍里了，先退出才能加入新的队伍");
      return;
    }
    const party = this.parties.findPartyOf(invite.fromRoleId);
    // 邀请期里队伍可能已经散了 / 邀请人退了：这条邀请作废（判据用「队伍还在不在」，
    // 而不是「邀请人还在不在队里」—— 邀请人是队伍的一员，队伍在就说明这支队还活着）
    if (!party || party.id !== invite.partyId) {
      this.dropInvite(actor.roleId, invite);
      this.fail(actor, BizCode.PARTY_INVITE_NOT_FOUND, "这个队伍已经解散了");
      return;
    }
    // 邀请发出之后可能才发生的屏蔽：同样作废（不说破方向，直接当邀请没了）
    if (this.blockedFrom?.(actor.roleId, invite.fromRoleId) || this.blockedFrom?.(invite.fromRoleId, actor.roleId)) {
      this.dropInvite(actor.roleId, invite);
      this.fail(actor, BizCode.PARTY_INVITE_NOT_FOUND, "这个队伍已经解散了");
      return;
    }
    if (this.parties.countMembers(party.id) >= this.memberLimit()) {
      this.fail(actor, BizCode.PARTY_FULL, `队伍已满（${this.memberLimit()} 人）`);
      return;
    }

    try {
      this.parties.insertMember({ party_id: party.id, role_id: actor.roleId, joined_at: Date.now() });
    } catch (error) {
      // 唯一约束撞了 = 并发下别处刚把他加进某个队（正常不会发生，但不能让连接崩）
      this.logger.warn(`入队写库失败（角色 ${actor.roleId}）：${(error as Error).message}`);
      this.fail(actor, BizCode.PARTY_ALREADY_IN, "你已经在队伍里了");
      return;
    }
    this.partyOfRole.set(actor.roleId, party.id);
    // 进队之后其他队伍的邀请一律作废：留着会在面板上显示「你还有邀请」，点进去却是加入失败
    this.invites.delete(actor.roleId);
    this.broadcast(party.id);
    this.logger.log(`入队：${actor.name}(${actor.roleId}) → 队伍 ${party.id}`);
  }

  /** 拒绝最近一条邀请（不通知邀请人：拒绝是静默的，通知只会加社交压力） */
  private decline(actor: PartyActor): void {
    this.pruneInvites();
    const list = this.invites.get(actor.roleId) ?? [];
    if (list.length === 0) {
      this.fail(actor, BizCode.PARTY_INVITE_NOT_FOUND, "没有待处理的队伍邀请");
      return;
    }
    const invite = list[list.length - 1];
    this.dropInvite(actor.roleId, invite);
    // 回一份自己的快照（大概率是空队伍）：客户端据此清掉邀请弹窗的残留状态
    this.sendSnapshotTo([actor.roleId]);
  }

  /**
   * 退出队伍
   *
   * `notifySelf = true` 时给发起人回一份空快照（他自己退的，得把面板收掉）；
   * 被踢的那条路径由 kick 自己发（对方的快照也得清）。
   */
  private leave(actor: PartyActor, notifySelf: boolean): void {
    const partyId = this.partyIdOfRole(actor.roleId);
    if (!partyId) {
      this.fail(actor, BizCode.PARTY_NOT_FOUND, "你还没有加入任何队伍");
      return;
    }
    this.removeMember(partyId, actor.roleId, actor);
    if (notifySelf) this.sendSnapshotTo([actor.roleId]);
    this.logger.log(`退队：${actor.name}(${actor.roleId}) ← 队伍 ${partyId}`);
  }

  /** 踢人（仅队长；不能踢自己 —— 那是「退出」） */
  private kick(actor: PartyActor, targetRoleId: string): void {
    const partyId = this.partyIdOfRole(actor.roleId);
    if (!partyId) {
      this.fail(actor, BizCode.PARTY_NOT_FOUND, "你还没有加入任何队伍");
      return;
    }
    if (!targetRoleId) {
      this.fail(actor, BizCode.PARAM_INVALID, "kick 缺 roleId");
      return;
    }
    if (targetRoleId === actor.roleId) {
      this.fail(actor, BizCode.PARTY_NOT_MEMBER, "不能踢自己，请用「退出队伍」");
      return;
    }
    const party = this.parties.findPartyOf(actor.roleId);
    if (!party || party.leader_role_id !== actor.roleId) {
      this.fail(actor, BizCode.PARTY_NOT_LEADER, "只有队长能踢人");
      return;
    }
    if (!this.parties.findMember(partyId, targetRoleId)) {
      this.fail(actor, BizCode.PARTY_NOT_MEMBER, "对方不在你的队伍里");
      return;
    }
    const targetName = this.nameOfRole(partyId, targetRoleId);
    this.removeMember(partyId, targetRoleId, { ...actor, roleId: targetRoleId, name: targetName });
    // 被踢的人也要收到空快照：他的客户端得把面板关掉、队友标记清掉
    this.sendSnapshotTo([targetRoleId]);
    this.logger.log(`踢人：${actor.name} 踢出 ${targetName}(${targetRoleId})，队伍 ${partyId}`);
  }

  /** 转让队长（仅队长；目标必须是本队成员） */
  private transfer(actor: PartyActor, targetRoleId: string): void {
    const partyId = this.partyIdOfRole(actor.roleId);
    if (!partyId) {
      this.fail(actor, BizCode.PARTY_NOT_FOUND, "你还没有加入任何队伍");
      return;
    }
    const party = this.parties.findPartyOf(actor.roleId);
    if (!party || party.leader_role_id !== actor.roleId) {
      this.fail(actor, BizCode.PARTY_NOT_LEADER, "只有队长能转让队长");
      return;
    }
    if (!targetRoleId || !this.parties.findMember(partyId, targetRoleId)) {
      this.fail(actor, BizCode.PARTY_NOT_MEMBER, "对方不在你的队伍里");
      return;
    }
    if (targetRoleId === actor.roleId) return; // 转给自己 = 已经达成，幂等返回（下面照样发快照）
    this.parties.setLeader(partyId, targetRoleId);
    this.broadcast(partyId);
    this.logger.log(`转让队长：${actor.roleId} → ${targetRoleId}（队伍 ${partyId}）`);
  }

  /** 解散（仅队长）：所有人都收到空快照 */
  private disband(actor: PartyActor): void {
    const partyId = this.partyIdOfRole(actor.roleId);
    if (!partyId) {
      this.fail(actor, BizCode.PARTY_NOT_FOUND, "你还没有加入任何队伍");
      return;
    }
    const party = this.parties.findPartyOf(actor.roleId);
    if (!party || party.leader_role_id !== actor.roleId) {
      this.fail(actor, BizCode.PARTY_NOT_LEADER, "只有队长能解散队伍");
      return;
    }
    const roleIds = this.parties.membersOf(partyId).map((member) => member.role_id);
    this.parties.deleteParty(partyId);
    for (const roleId of roleIds) this.partyOfRole.delete(roleId);
    for (const roleId of roleIds) this.invites.delete(roleId);
    this.sendSnapshotTo(roleIds);
    this.logger.log(`解散队伍 ${partyId}（${roleIds.length} 人）`);
  }

  //#endregion

  //#region 内部：成员增删 / 广播 / 快照

  /** 建一支只有 `leaderRoleId` 的队伍（写库失败返回空串，调用方转成错误帧） */
  private createParty(leaderRoleId: string): string {
    const id = `${PARTY_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.parties.insertParty({ id, leader_role_id: leaderRoleId, created_at: Date.now() });
      this.parties.insertMember({ party_id: id, role_id: leaderRoleId, joined_at: Date.now() });
    } catch (error) {
      this.logger.warn(`建队写库失败（队长 ${leaderRoleId}）：${(error as Error).message}`);
      return "";
    }
    this.partyOfRole.set(leaderRoleId, id);
    return id;
  }

  /**
   * 把一个人从队伍里摘掉（退队与被踢共用）
   *
   * 队长被摘掉时**自动移交**给最早加入的成员；摘空了就把队伍删掉。
   * 剩下的人收到新快照（队长变了 / 人数变了都得让他们看到）。
   */
  private removeMember(partyId: string, roleId: string, actor: PartyActor): void {
    const party = this.parties.findPartyOf(roleId);
    const wasLeader = !!party && party.leader_role_id === roleId;
    this.parties.removeMember(roleId);
    this.partyOfRole.delete(roleId);
    this.invites.delete(roleId);

    const remaining = this.parties.membersOf(partyId);
    if (remaining.length === 0) {
      this.parties.deleteParty(partyId);
      return;
    }
    if (wasLeader) {
      const next = remaining[0].role_id;
      this.parties.setLeader(partyId, next);
      this.logger.log(`队长移交：队伍 ${partyId} 的新队长是 ${next}（原队长 ${actor.name} 离开）`);
    }
    this.broadcast(partyId);
  }

  /** 给队伍里所有在线成员推一份各自的快照 */
  private broadcast(partyId: string): void {
    const roster = this.parties.membersOf(partyId);
    if (roster.length === 0) return;
    this.sendSnapshotTo(roster.map((member) => member.role_id), { partyId, roster });
  }

  /**
   * 给指定角色各推一份「他自己的」队伍快照
   *
   * 一次读库、逐人组装：`isLeader` / `sameMap` 都是**观看者视角**的字段，
   * 所以同一支队里不同的人收到的帧不一样。角色不在队里时收到的是空快照（离队 / 被踢 / 解散）。
   */
  private sendSnapshotTo(roleIds: string[], context?: { partyId: string; roster: PartyMemberWithRoleRow[] }): void {
    for (const roleId of roleIds) {
      const location = this.locationOf?.(roleId) ?? null;
      if (!location) continue; // 离线：重连进图时会补一份（见 realtime.service 的 worldJoin 分支）
      this.sendSnapshot(roleId, location, context);
    }
  }

  /**
   * 给一个人发一份「他自己的」队伍快照
   *
   * 位置由调用方给（而不是现查在场表）：进图那一刻 `pos` 帧可能还没到，而在场表里没有条目
   * 就查不到「这个角色在谁的连接上」—— 那会让「刚进游戏时队伍是空的」变成一个假象，
   * 直到下一次队伍变化才恢复。
   */
  private sendSnapshot(
    roleId: string,
    location: { accountId: string; mapId: string },
    context?: { partyId: string; roster: PartyMemberWithRoleRow[] },
  ): void {
    const partyId = this.partyIdOfRole(roleId);
    const party = partyId ? this.parties.findPartyOf(roleId) : undefined;
    const roster = partyId ? (context && context.partyId === partyId ? context.roster : this.parties.membersOf(partyId)) : [];
    const frame: RealtimePartySnapshotMessage = {
      type: "party",
      data: this.buildSnapshot(roleId, partyId, party ?? null, roster, location.mapId),
    };
    this.sendTo?.(location.accountId, frame);
  }

  /** 组装一份快照（`partyId` 空串 = 不在队伍里，成员数组为空） */
  private buildSnapshot(
    viewerRoleId: string,
    partyId: string,
    party: PartyRow | null,
    roster: PartyMemberWithRoleRow[],
    viewerMapId: string,
  ): RealtimePartySnapshot {
    const leaderRoleId = party ? party.leader_role_id : "";
    const members: RealtimePartyMember[] = roster.map((member) => {
      const location = this.locationOf?.(member.role_id) ?? null;
      return {
        roleId: member.role_id,
        // 角色被删时 JOIN 出 null：退回 id，面板上至少还能看出「这里少了一个人」
        name: member.role_name ?? member.role_id,
        level: Number(member.level ?? 0) || 0,
        online: !!location,
        sameMap: !!location && !!viewerMapId && location.mapId === viewerMapId,
        leader: member.role_id === leaderRoleId,
      };
    });
    return {
      partyId,
      leaderRoleId,
      limit: this.memberLimit(),
      members,
      isLeader: !!partyId && leaderRoleId === viewerRoleId,
    };
  }

  //#endregion

  //#region 内部：邀请表维护

  /** 清掉过期邀请（懒清理：只在有动作时跑，不需要定时器） */
  private pruneInvites(): void {
    const now = Date.now();
    for (const [roleId, list] of this.invites) {
      const alive = list.filter((entry) => entry.expiresAt > now);
      if (alive.length === 0) this.invites.delete(roleId);
      else if (alive.length !== list.length) this.invites.set(roleId, alive);
    }
  }

  /** 摘掉被邀请人身上某一条邀请（同意 / 拒绝后都得摘，否则同一条能被同意两次） */
  private dropInvite(inviteeRoleId: string, invite: PartyInvite): void {
    const list = this.invites.get(inviteeRoleId) ?? [];
    const next = list.filter((entry) => entry.fromRoleId !== invite.fromRoleId);
    if (next.length === 0) this.invites.delete(inviteeRoleId);
    else this.invites.set(inviteeRoleId, next);
  }

  //#endregion

  //#region 内部：小工具与配置

  private fail(actor: PartyActor, code: number, message: string): void {
    this.sendTo?.(actor.accountId, { type: "error", data: { code, message } });
  }

  private levelOfActor(actor: PartyActor): number {
    const role = this.roles.online(actor.accountId);
    return Number(role?.level ?? 0) || 0;
  }

  private nameOfRole(partyId: string, roleId: string): string {
    const member = this.parties.membersOf(partyId).find((entry) => entry.role_id === roleId);
    return member?.role_name ?? roleId;
  }

  /** 队伍上限（脏值回落默认；与帮会 / 好友上限同口径） */
  memberLimit(): number {
    const raw = Number(this.config.get<number>("partyMemberLimit"));
    return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : PARTY_MEMBER_LIMIT_DEFAULT;
  }

  private inviteTtlMs(): number {
    const raw = Number(this.config.get<number>("partyInviteTtlMs"));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PARTY_INVITE_TTL_MS_DEFAULT;
  }

  /**
   * 组队的最低等级（脏值回落默认）
   *
   * 与客户端 `bottomNav` 里 group 入口的 `openLevel` 是同一个门槛（审计
   * `tools/audit-party-level.cjs` 比默认值与客户端配置）。
   */
  minLevel(): number {
    const raw = Number(this.config.get<number>("partyMinLevel"));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : PARTY_MIN_LEVEL_DEFAULT;
  }

  /** 队友经验分成比例（0~1；脏值回落 0.5） */
  expMateShare(): number {
    const raw = Number(this.config.get<number>("partyExpMateShare"));
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : PARTY_EXP_MATE_SHARE_DEFAULT;
  }

  //#endregion
}

/** `expGain` 帧的载荷（与协议里的 RealtimeExpGainMessage.data 同形；导出免得结算侧再写一遍） */
export interface RealtimeExpGainPayload {
  exp: number;
  level: number;
  expNow: number;
  expNeed: number;
  leveledUp: boolean;
  revision: number;
  from: { roleId: string; username: string };
}

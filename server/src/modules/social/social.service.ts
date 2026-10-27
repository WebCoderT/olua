import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import {
  BLOCK_LIMIT_DEFAULT,
  FRIEND_LIMIT_DEFAULT,
  FRIEND_STATUS,
  REPORT_STATUS,
} from "../../common/constants/social";
import { BizException } from "../../common/errors/biz.exception";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { ReportRepository } from "../../database/repositories/report.repository";
import { SocialRepository } from "../../database/repositories/social.repository";
import { RolesService } from "../roles/roles.service";
import { CreateReportDto, MySocialDto, SocialTargetDto } from "./dto/social.dto";

/**
 * 好友与敌人业务（#389）
 *
 * ## 关系判定**不在这里**
 * 服务端只管「谁和谁是什么关系」的**原料**：我的好友/敌人/帮会快照（`GET /social/me`）
 * 随这份 DTO 下发，对方的 `roleId` / `guildId` 随互见帧下发。至于「敌人 > 同帮 > 好友 >
 * 同地图 > 普通」这套优先级与配色，判定放在客户端 `configs/social.ts` 一处 ——
 * 放服务端意味着要为**每个观看者**各算一遍（O(n²)），而原料本来就在两边。
 *
 * ## 镜像两行 + 单向一行
 * 好友是两行（A→B 与 B→A），所以「同意 / 拒绝 / 删除」都要**成对**改，一律走
 * `SocialRepository.transaction()`；敌人是单向一行，我标我的，对方不知道也不受影响。
 *
 * ## 一个边界：名字不唯一
 * 角色名只在**同一账号内**唯一。按名加人因此可能撞上多个同名角色 —— 返回 50116 让玩家
 * 改从「附近」或帮会成员里加（那里有 roleId），而不是替他挑一个（挑错了就是「加错人」）。
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly social: SocialRepository,
    private readonly reports: ReportRepository,
    private readonly guilds: GuildRepository,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  //#region 查询

  /** 我的社交快照（好友 / 别人加我 / 我加别人 / 敌人 + 我的帮会） */
  mine(accountId: string): MySocialDto {
    const role = this.onlineRole(accountId);
    const guild = this.guilds.guildOfRole(role.id);
    const dto = new MySocialDto();
    dto.myRoleId = role.id;
    dto.guildId = guild ? guild.id : "";
    dto.guildName = guild ? guild.name : "";
    dto.friends = this.social.friends(role.id).map((row) => MySocialDto.fromFriend(row, FRIEND_STATUS.ACCEPTED));
    dto.incoming = this.social
      .incomingRequests(role.id)
      .map((row) => MySocialDto.fromFriend(row, "pendingIncoming"));
    dto.outgoing = this.social
      .outgoingRequests(role.id)
      .map((row) => MySocialDto.fromFriend(row, "pendingOutgoing"));
    dto.enemies = this.social.enemies(role.id).map((row) => MySocialDto.fromEnemy(row));
    dto.blocks = this.social.blocks(role.id).map((row) => MySocialDto.fromBlock(row));
    return dto;
  }

  //#endregion

  //#region 好友

  /**
   * 加好友
   *
   * 三种情形按顺序判：已是好友 → 50111；**对方也在等我 → 直接当同意**（玩家不用再点一次
   * 「同意」）；其余（含我重复点）→ 50111 提示已有待处理申请。
   */
  addFriend(accountId: string, dto: SocialTargetDto): MySocialDto {
    const me = this.onlineRole(accountId);
    const targetId = this.resolveTarget(me.id, dto);
    // 他把我拉黑了 → 用「找不到这个人」挡回去（#398）
    //
    // 刻意复用 50109 而不是新开一个「你已被拉黑」：一旦告诉对方「你被拉黑了」，
    // 拉黑就从「看不见」变成了「明确信号」，换个号再来的人反而被引导了。
    // 挡住的理由是「好友申请会出现在他的待处理列表里」—— 那是唯一能绕过屏蔽送达的通道。
    if (this.social.findBlock(targetId, me.id)) {
      throw BizException.notFound(BizCode.SOCIAL_ROLE_NOT_FOUND, "没有找到这个角色名");
    }
    const existing = this.social.findFriend(me.id, targetId);

    if (existing && existing.status === FRIEND_STATUS.ACCEPTED) {
      throw BizException.conflict(BizCode.SOCIAL_ALREADY_FRIEND, "你们已经是好友了");
    }
    if (existing) {
      // 他在等我：这次点击就是同意（省掉「再加一次 → 再去同意」的来回）
      if (existing.requested_by !== me.id) {
        const now = Date.now();
        this.social.transaction(() => this.social.acceptPair(me.id, targetId, now));
        return this.mine(accountId);
      }
      throw BizException.conflict(BizCode.SOCIAL_ALREADY_FRIEND, "已经发过申请了，等对方处理");
    }
    if (this.social.countFriends(me.id) >= this.friendLimit()) {
      throw BizException.conflict(BizCode.SOCIAL_FRIEND_FULL, `好友数量上限 ${this.friendLimit()}，先删几个再加`);
    }
    const now = Date.now();
    this.social.transaction(() => this.social.upsertRequest(me.id, targetId, me.id, now));
    return this.mine(accountId);
  }

  /** 同意别人加我（只有「他发起、等我这边的」才能同意） */
  acceptFriend(accountId: string, targetRoleId: string): MySocialDto {
    const me = this.onlineRole(accountId);
    const pending = this.mustIncoming(me.id, targetRoleId);
    const now = Date.now();
    this.social.transaction(() => this.social.acceptPair(pending.role_id, pending.friend_id, now));
    return this.mine(accountId);
  }

  /** 拒绝别人加我（直接删掉这一对，不留记录 —— 被拒的人不会看到「你被拒绝」） */
  rejectFriend(accountId: string, targetRoleId: string): MySocialDto {
    const me = this.onlineRole(accountId);
    const pending = this.mustIncoming(me.id, targetRoleId);
    this.social.transaction(() => this.social.removePair(pending.role_id, pending.friend_id));
    return this.mine(accountId);
  }

  /**
   * 移除一段好友关系（删好友 / 撤回我发出的申请 / 拒绝别人加我，都是「删掉这一对」）
   *
   * 三种状态在这里统一收口：**accepted** = 删好友（双向消失，不需要对方同意）；
   * **pending** = 撤回我发出的申请（或我这边的拒绝，另一端随之消失）。
   * 客户端于是不必区分两个接口 ——「好友」页删好友与「我发出的」页撤回是同一个动作，
   * 只有真正没有这段关系时才 50112。
   */
  removeFriend(accountId: string, targetRoleId: string): MySocialDto {
    const me = this.onlineRole(accountId);
    const existing = this.social.findFriend(me.id, targetRoleId);
    if (!existing) {
      throw BizException.notFound(BizCode.SOCIAL_FRIEND_NOT_FOUND, "你们还不是好友（也没有待处理的申请）");
    }
    this.social.transaction(() => this.social.removePair(me.id, targetRoleId));
    return this.mine(accountId);
  }

  //#endregion

  //#region 敌人

  /** 标敌人（单向：只有我自己看得见，对方既不知道也不受影响） */
  addEnemy(accountId: string, dto: SocialTargetDto): MySocialDto {
    const me = this.onlineRole(accountId);
    const targetId = this.resolveTarget(me.id, dto);
    if (this.social.findEnemy(me.id, targetId)) {
      throw BizException.conflict(BizCode.SOCIAL_ENEMY_EXISTS, "你已经把他标成敌人了");
    }
    this.social.insertEnemy(me.id, targetId, Date.now());
    return this.mine(accountId);
  }

  /** 解除敌人 */
  removeEnemy(accountId: string, targetRoleId: string): MySocialDto {
    const me = this.onlineRole(accountId);
    if (!this.social.findEnemy(me.id, targetRoleId)) {
      throw BizException.notFound(BizCode.SOCIAL_ENEMY_NOT_FOUND, "你没有把他标成敌人");
    }
    this.social.removeEnemy(me.id, targetRoleId);
    return this.mine(accountId);
  }

  //#endregion

  //#region 屏蔽（#398）

  /**
   * 拉黑一个人（单向：只有我自己看得见，对方既不知道也不受影响）
   *
   * **过滤不在这里做**（这条只写库）：实时进程的 `BlockService` 按这张表缓存过滤，
   * 聊天投递与互见帧各判一次。写在这里只会变成「HTTP 进程的一套口径 + 实时进程的另一套」。
   */
  addBlock(accountId: string, dto: SocialTargetDto): MySocialDto {
    const me = this.onlineRole(accountId);
    const targetId = this.resolveTarget(me.id, dto);
    if (this.social.findBlock(me.id, targetId)) {
      throw BizException.conflict(BizCode.SOCIAL_BLOCK_EXISTS, "你已经拉黑他了");
    }
    if (this.social.countBlocks(me.id) >= this.blockLimit()) {
      throw BizException.conflict(BizCode.SOCIAL_BLOCK_FULL, `黑名单上限 ${this.blockLimit()} 人，先解除几个`);
    }
    this.social.insertBlock(me.id, targetId, Date.now());
    // 顺带把「好友」与「敌人」清掉：拉黑之后还留着他的一句「好友」标签毫无意义，
    // 而名字颜色若按敌人红名走，反而更难从人群里忽略他
    if (this.social.findFriend(me.id, targetId)) this.social.transaction(() => this.social.removePair(me.id, targetId));
    if (this.social.findEnemy(me.id, targetId)) this.social.removeEnemy(me.id, targetId);
    return this.mine(accountId);
  }

  /** 解除拉黑 */
  removeBlock(accountId: string, targetRoleId: string): MySocialDto {
    const me = this.onlineRole(accountId);
    if (!this.social.findBlock(me.id, targetRoleId)) {
      throw BizException.notFound(BizCode.SOCIAL_BLOCK_NOT_FOUND, "你没有拉黑他");
    }
    this.social.removeBlock(me.id, targetRoleId);
    return this.mine(accountId);
  }

  //#endregion

  //#region 举报（#398）

  /**
   * 举报一个人（只落库，供管理端人工处理）
   *
   * 三件事刻意不做：**不自动处罚**（判定交给人）、**不通知被举报人**（通知等于把举报人卖了）、
   * **不回传被举报人是否已被处理**。同一对「我 → 他」只留一条待处理的举报，
   * 连点不会让人更快被处理，只会让列表里全是同一个人。
   */
  report(accountId: string, dto: CreateReportDto): void {
    const me = this.onlineRole(accountId);
    const targetId = (dto.roleId ?? "").trim();
    if (!targetId) throw BizException.notFound(BizCode.SOCIAL_ROLE_NOT_FOUND, "没有找到这个角色");
    if (targetId === me.id) {
      throw BizException.conflict(BizCode.SOCIAL_TARGET_SELF, "不能举报自己");
    }
    if (!this.roles.existsById(targetId)) {
      throw BizException.notFound(BizCode.SOCIAL_ROLE_NOT_FOUND, "这个角色不存在（可能已被删除）");
    }
    if (this.reports.findOpen(me.id, targetId, REPORT_STATUS.PENDING)) {
      throw BizException.conflict(BizCode.SOCIAL_REPORT_EXISTS, "已经举报过了，等管理端处理后再试");
    }
    this.reports.insert({
      id: randomUUID(),
      role_id: me.id,
      target_role_id: targetId,
      category: dto.category,
      reason: (dto.reason ?? "").trim(),
      status: REPORT_STATUS.PENDING,
      created_at: Date.now(),
    });
  }

  //#endregion

  //#region 内部

  /**
   * 好友数量上限（读配置 `SOCIAL_FRIEND_LIMIT`，缺省 100）
   *
   * 与帮会人数上限同一口径：脏值（NaN / 0 / 负数）一律回落默认，
   * 免得配错一个 `SOCIAL_FRIEND_LIMIT=0` 把所有人的好友功能关死。
   */
  private friendLimit(): number {
    const value = Number(this.config.get<number>("socialFriendLimit") ?? FRIEND_LIMIT_DEFAULT);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : FRIEND_LIMIT_DEFAULT;
  }

  /** 黑名单上限（与 friendLimit 同一口径：脏值回落默认，免得一个 0 把功能关死） */
  private blockLimit(): number {
    const value = Number(this.config.get<number>("socialBlockLimit") ?? BLOCK_LIMIT_DEFAULT);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : BLOCK_LIMIT_DEFAULT;
  }

  /** 账号当前在线角色（社交动作都落在它身上） */
  private onlineRole(accountId: string) {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }

  /**
   * 入参 → 目标角色 id
   *
   * `roleId` 优先（「附近」与帮会成员列表里本来就有 id，精确且不受重名影响）；
   * 否则按名字找，找不到 50109、同名多个 50116。最后统一挡掉「对自己」。
   */
  private resolveTarget(myRoleId: string, dto: SocialTargetDto): string {
    const byId = (dto.roleId ?? "").trim();
    let targetId = "";
    if (byId) {
      if (!this.roles.existsById(byId)) {
        throw BizException.notFound(BizCode.SOCIAL_ROLE_NOT_FOUND, "这个角色不存在（可能已被删除）");
      }
      targetId = byId;
    } else {
      const ids = this.roles.idsByName(dto.name ?? "");
      if (ids.length === 0) throw BizException.notFound(BizCode.SOCIAL_ROLE_NOT_FOUND, "没有找到这个角色名");
      if (ids.length > 1) {
        throw BizException.conflict(
          BizCode.SOCIAL_NAME_AMBIGUOUS,
          "有多个同名角色，请从「附近」或帮会成员列表里加",
        );
      }
      targetId = ids[0];
    }
    if (targetId === myRoleId) {
      throw BizException.conflict(BizCode.SOCIAL_TARGET_SELF, "不能对自己做这个操作");
    }
    return targetId;
  }

  /** 必须存在一条「他发起、等我这边的」待处理申请 */
  private mustIncoming(myRoleId: string, targetRoleId: string) {
    const existing = this.social.findFriend(myRoleId, targetRoleId);
    if (!existing || existing.status !== FRIEND_STATUS.PENDING || existing.requested_by === myRoleId) {
      throw BizException.notFound(BizCode.SOCIAL_FRIEND_NOT_FOUND, "没有这条待处理的好友申请（可能已被处理）");
    }
    return existing;
  }

  //#endregion
}

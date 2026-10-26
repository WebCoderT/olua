import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import {
  GUILD_ID_PREFIX,
  GUILD_MEMBER_LIMIT_DEFAULT,
  GUILD_RANK,
  GUILD_RANK_LABELS,
} from "../../common/constants/social";
import { BizException } from "../../common/errors/biz.exception";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { GuildRow } from "../../database/rows";
import { RolesService } from "../roles/roles.service";
import {
  AdminGuildDetailDto,
  AdminGuildDto,
  AdminUpdateGuildDto,
  CreateGuildDto,
  GuildSummaryDto,
  MyGuildDto,
  MyGuildParts,
} from "./dto/guild.dto";

/** 能审批 / 管理帮会的职位（帮主与副帮主；解散只有帮主） */
function isOfficer(rank: string): boolean {
  return rank === GUILD_RANK.LEADER || rank === GUILD_RANK.VICE;
}

/**
 * 帮会业务（#388）
 *
 * ## 一件事只在一处判
 * - **一个人只能在一个帮会**：库上是 `guild_members.role_id` 唯一索引，业务里只是把它翻成
 *   可读的错误（50103）—— 靠业务自觉的话，并发两次入帮就会留下两条。
 * - **职位规则**：`isOfficer` 一处；控制器只做鉴权与文档，客户端只按服务端给的
 *   `canReview / canManage / canDisband` 显隐按钮（不自己再判一遍 rank）。
 * - **帮主的身份有两份**：`guilds.leader_id` 与 `guild_members.rank='leader'` 的那一行。
 *   转让时**同一个事务**里改两处，否则会出现「帮主显示是 A、A 却没有帮主权限」。
 *
 * ## 会话口径
 * 所有玩家侧方法的入参都是**账号 id**，帮会动作落到该账号的**在线角色**上 ——
 * 玩家侧不接受请求体里的角色 id（那就能替别人退帮了）。唯一例外是转让/踢人/审批的
 * **目标**角色 id：它是「对谁做」，服务端会校验那个角色确实在本帮里。
 */
@Injectable()
export class GuildService {
  private readonly logger = new Logger(GuildService.name);

  constructor(
    private readonly guilds: GuildRepository,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  /** 帮会人数上限（配置驱动；与帮会等级无关，见 common/constants/social） */
  private get memberLimit(): number {
    const value = Number(this.config.get<number>("guildMemberLimit") ?? GUILD_MEMBER_LIMIT_DEFAULT);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : GUILD_MEMBER_LIMIT_DEFAULT;
  }

  //#region 玩家侧

  /** 帮会列表（浏览：人多的在前） */
  list(): GuildSummaryDto[] {
    return this.guilds.list().map((row) => GuildSummaryDto.from(row));
  }

  /** 我的帮会；不在任何帮会时返回 null（客户端据此显示「创建 / 申请」两种入口） */
  mine(accountId: string): MyGuildDto | null {
    const role = this.onlineRole(accountId);
    const membership = this.guilds.membershipOf(role.id);
    if (!membership) return null;
    const guild = this.guilds.findById(membership.guild_id);
    if (!guild) return null; // 外键保证不可达；真出现了也别 500，当作没有帮会
    const members = this.guilds.members(guild.id);
    const officer = isOfficer(membership.rank);
    const parts: MyGuildParts = {
      guild,
      memberCount: members.length,
      memberLimit: this.memberLimit,
      myRoleId: role.id,
      myRank: membership.rank,
      members,
      // 非干部看不到申请名单：谁在申请是给管理人员看的待办，不是公共信息
      applicants: officer ? this.guilds.applications(guild.id) : [],
    };
    return this.toMyGuild(parts);
  }

  /** 建帮（建帮人自动成为帮主；顺手清掉他挂在别的帮会的申请） */
  create(accountId: string, dto: CreateGuildDto): MyGuildDto {
    const role = this.onlineRole(accountId);
    if (this.guilds.membershipOf(role.id)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "你已经在一个帮会里了，先退出才能另建");
    }
    const name = dto.name.trim();
    if (this.guilds.findByName(name)) {
      throw BizException.conflict(BizCode.GUILD_NAME_EXISTS, "这个帮会名已经被占用了");
    }
    const now = Date.now();
    const row: GuildRow = {
      id: `${GUILD_ID_PREFIX}${now.toString(36)}_${randomUUID().slice(0, 8)}`,
      name,
      notice: (dto.notice ?? "").trim(),
      leader_id: role.id,
      level: 1,
      funds: 0,
      created_at: now,
      updated_at: now,
    };
    this.guilds.transaction(() => {
      this.guilds.insert(row);
      this.guilds.insertMember(row.id, role.id, GUILD_RANK.LEADER, now);
      this.guilds.removeApplicationsOfRole(role.id);
    });
    this.logger.log(`帮会创建：${row.name}（${row.id}，帮主 ${role.id}）`);
    return this.mustMine(accountId);
  }

  /** 申请加入（重复申请覆盖留言，不堆两条；已在帮会里直接拒） */
  apply(accountId: string, guildId: string, message: string): void {
    const role = this.onlineRole(accountId);
    if (this.guilds.membershipOf(role.id)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "你已经在一个帮会里了，先退出才能申请别的");
    }
    const guild = this.guilds.findById(guildId);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "这个帮会不存在（可能刚被解散）");
    if (this.guilds.countMembers(guildId) >= this.memberLimit) {
      throw BizException.conflict(BizCode.GUILD_FULL, "这个帮会人满了");
    }
    this.guilds.upsertApplication(guildId, role.id, message.trim(), Date.now());
  }

  /** 审批入帮申请（帮主 / 副帮主）：通过则入帮，拒绝直接删掉申请 */
  review(accountId: string, targetRoleId: string, approve: boolean): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (!isOfficer(membership.rank)) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主和副帮主能审批入帮申请");
    }
    const application = this.guilds.findApplication(guild.id, targetRoleId);
    if (!application) {
      throw BizException.notFound(BizCode.GUILD_TARGET_INVALID, "这个申请已经不存在了（可能已被处理）");
    }
    if (!approve) {
      this.guilds.removeApplication(guild.id, targetRoleId);
      return this.mustMine(accountId);
    }
    // 申请期间对方可能已经进了别的帮会 —— 入帮前再查一次，不能靠「申请时查过」
    if (this.guilds.membershipOf(targetRoleId)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "对方已经加入其它帮会了");
    }
    if (this.guilds.countMembers(guild.id) >= this.memberLimit) {
      throw BizException.conflict(BizCode.GUILD_FULL, "帮会人满了，先踢人或等上限提高");
    }
    const now = Date.now();
    this.guilds.transaction(() => {
      this.guilds.insertMember(guild.id, targetRoleId, GUILD_RANK.MEMBER, now);
      this.guilds.removeApplication(guild.id, targetRoleId);
      // 入帮后他挂在别处的申请全部作废，免得别的帮主看到一个「已入帮的人来申请」
      this.guilds.removeApplicationsOfRole(targetRoleId);
    });
    return this.mustMine(accountId);
  }

  /** 踢人（副帮主不能踢副帮主与帮主；谁都不能踢自己 —— 自己走请用退出） */
  kick(accountId: string, targetRoleId: string): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (!isOfficer(membership.rank)) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主和副帮主能踢人");
    }
    if (targetRoleId === membership.role_id) {
      throw new BizException(BizCode.GUILD_TARGET_INVALID, "不能踢自己，退出请用「退出帮会」");
    }
    const target = this.requireMember(guild.id, targetRoleId);
    if (target.rank === GUILD_RANK.LEADER) {
      throw BizException.forbidden(BizCode.GUILD_LEADER_LOCKED, "帮主不能被踢，只能由帮主转让后自行处理");
    }
    if (target.rank === GUILD_RANK.VICE && membership.rank !== GUILD_RANK.LEADER) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "副帮主不能踢另一位副帮主");
    }
    this.guilds.removeMember(guild.id, targetRoleId);
    this.guilds.removeApplicationsOfRole(targetRoleId);
    return this.mustMine(accountId);
  }

  /** 转让帮主（仅帮主；双方职位互换，`guilds.leader_id` 与成员表同一事务改） */
  transfer(accountId: string, targetRoleId: string): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (membership.rank !== GUILD_RANK.LEADER) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主能转让帮会");
    }
    if (targetRoleId === membership.role_id) {
      throw new BizException(BizCode.GUILD_TARGET_INVALID, "不用转让给自己");
    }
    this.requireMember(guild.id, targetRoleId);
    const now = Date.now();
    this.guilds.transaction(() => {
      this.guilds.updateRank(guild.id, membership.role_id, GUILD_RANK.MEMBER);
      this.guilds.updateRank(guild.id, targetRoleId, GUILD_RANK.LEADER);
      this.guilds.updateLeader(guild.id, targetRoleId, now);
    });
    return this.mustMine(accountId);
  }

  /** 改公告（帮主 / 副帮主；空串 = 清空） */
  updateNotice(accountId: string, notice: string): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (!isOfficer(membership.rank)) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主和副帮主能改公告");
    }
    this.guilds.updateNotice(guild.id, notice.trim(), Date.now());
    return this.mustMine(accountId);
  }

  /** 退出帮会（帮主不能退：先转让或解散，否则帮会会变成一个没有帮主的空壳） */
  leave(accountId: string): void {
    const { guild, membership } = this.mustMembership(accountId);
    if (membership.rank === GUILD_RANK.LEADER) {
      throw BizException.conflict(
        BizCode.GUILD_LEADER_LOCKED,
        "帮主不能直接退出：先把帮主转让给别人，或者解散帮会",
      );
    }
    this.guilds.removeMember(guild.id, membership.role_id);
    this.guilds.removeApplicationsOfRole(membership.role_id);
  }

  /** 解散帮会（仅帮主；成员与申请靠外键级联删除） */
  disband(accountId: string): void {
    const { guild, membership } = this.mustMembership(accountId);
    if (membership.rank !== GUILD_RANK.LEADER) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主能解散帮会");
    }
    this.guilds.remove(guild.id);
    this.logger.log(`帮会解散：${guild.name}（${guild.id}）`);
  }

  //#endregion

  //#region 管理端

  adminList(): AdminGuildDto[] {
    return this.guilds.list().map((row) => AdminGuildDto.fromAdmin(row));
  }

  adminDetail(id: string): AdminGuildDetailDto {
    const row = this.guilds.findListRow(id);
    if (!row) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "帮会不存在");
    return AdminGuildDetailDto.fromDetail(row, this.guilds.members(id));
  }

  /** 改帮会（名字 / 公告）：名字仍要全局唯一（排除自己） */
  adminUpdate(id: string, dto: AdminUpdateGuildDto): AdminGuildDetailDto {
    const guild = this.guilds.findById(id);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "帮会不存在");
    const now = Date.now();
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const other = this.guilds.findByName(name);
      if (other && other.id !== id) throw BizException.conflict(BizCode.GUILD_NAME_EXISTS, "这个帮会名已经被占用了");
      if (name !== guild.name) {
        this.guilds.updateName(id, name, now);
      }
    }
    if (dto.notice !== undefined) {
      this.guilds.updateNotice(id, dto.notice.trim(), now);
    }
    return this.adminDetail(id);
  }

  /** 强制解散（运营手段：违规帮会名 / 组织性刷资源等） */
  adminRemove(id: string): void {
    const guild = this.guilds.findById(id);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "帮会不存在");
    this.guilds.remove(id);
    this.logger.log(`帮会被管理员强制解散：${guild.name}（${guild.id}）`);
  }

  //#endregion

  //#region 内部：取上下文与组装

  /** 账号当前在线角色（社交动作都落在它身上；没选角色就没有「我」） */
  private onlineRole(accountId: string) {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }

  /** 我所在的帮会 + 我的成员行；不在帮会就 50104 */
  private mustMembership(accountId: string): { guild: GuildRow; membership: { role_id: string; rank: string } } {
    const role = this.onlineRole(accountId);
    const membership = this.guilds.membershipOf(role.id);
    if (!membership) throw BizException.conflict(BizCode.GUILD_NOT_IN, "你还没有加入任何帮会");
    const guild = this.guilds.findById(membership.guild_id);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "这个帮会不存在（可能刚被解散）");
    return { guild, membership };
  }

  /** 目标必须是本帮成员（转让 / 踢人的共同前提） */
  private requireMember(guildId: string, roleId: string) {
    const member = this.guilds.members(guildId).find((item) => item.role_id === roleId);
    if (!member) throw BizException.notFound(BizCode.GUILD_TARGET_INVALID, "对方不是本帮成员");
    return member;
  }

  /** 动作后回一份最新的「我的帮会」（写接口统一返回它，客户端一次刷新到位） */
  private mustMine(accountId: string): MyGuildDto {
    const mine = this.mine(accountId);
    if (!mine) throw BizException.conflict(BizCode.GUILD_NOT_IN, "你还没有加入任何帮会");
    return mine;
  }

  private toMyGuild(parts: MyGuildParts): MyGuildDto {
    const { guild, members, applicants, myRank } = parts;
    const leader = members.find((item) => item.role_id === guild.leader_id);
    const dto = new MyGuildDto();
    dto.id = guild.id;
    dto.name = guild.name;
    dto.notice = guild.notice;
    dto.level = guild.level;
    dto.leaderId = guild.leader_id;
    dto.leaderName = leader ? leader.role_name : "";
    dto.memberCount = parts.memberCount;
    dto.memberLimit = parts.memberLimit;
    dto.myRoleId = parts.myRoleId;
    dto.myRank = myRank;
    dto.myRankLabel = GUILD_RANK_LABELS[myRank] ?? myRank;
    dto.canReview = isOfficer(myRank);
    dto.canManage = isOfficer(myRank);
    dto.canDisband = myRank === GUILD_RANK.LEADER;
    dto.members = members.map((item) => ({
      roleId: item.role_id,
      name: item.role_name,
      level: item.role_level,
      occupation: item.role_occupation,
      rank: item.rank,
      rankLabel: GUILD_RANK_LABELS[item.rank] ?? item.rank,
      joinedAt: item.joined_at,
    }));
    dto.applicants = applicants.map((item) => ({
      roleId: item.role_id,
      name: item.role_name,
      level: item.role_level,
      message: item.message,
      createdAt: item.created_at,
    }));
    return dto;
  }

  //#endregion
}

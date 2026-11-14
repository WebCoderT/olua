import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import {
  GUILD_APPLICATION_LIMIT_PER_GUILD_DEFAULT,
  GUILD_APPLICATION_LIMIT_PER_ROLE_DEFAULT,
  GUILD_APPLICATION_TTL_MS_DEFAULT,
  GUILD_ID_PREFIX,
  GUILD_MEMBER_LIMIT_DEFAULT,
  GUILD_RANK,
  GUILD_RANK_LABELS,
  GUILD_VICE_LIMIT_DEFAULT,
} from "../../common/constants/social";
import { BizException } from "../../common/errors/biz.exception";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { GuildRow } from "../../database/rows";
import { RolesService } from "../roles/roles.service";
import { RuntimeParamsService } from "../game-config/runtime-params.service";
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
 * - **职位规则**：`isOfficer` 一处（审批 / 踢人 / 改公告的共同前提）；「只有帮主」的三件事
 *   （解散 / 转让 / 任命副帮主）各自显式判 rank。控制器只做鉴权与文档，客户端只按服务端给的
 *   `canReview / canManage / canDisband / canAppoint` 显隐按钮（不自己再判一遍 rank）。
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
    private readonly runtimeParams: RuntimeParamsService,
  ) {}

  /** 帮会人数上限（配置驱动；与帮会等级无关，见 common/constants/social） */
  private get memberLimit(): number {
    const value = Number(this.config.get<number>("guildMemberLimit") ?? GUILD_MEMBER_LIMIT_DEFAULT);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : GUILD_MEMBER_LIMIT_DEFAULT;
  }

  /** 每帮待处理申请上限（#873；脏值回落默认） */
  private get applicationLimitPerGuild(): number {
    const value = Number(this.config.get<number>("guildApplicationLimitPerGuild"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : GUILD_APPLICATION_LIMIT_PER_GUILD_DEFAULT;
  }

  /** 每角色同时挂着的申请数上限（#873；脏值回落默认） */
  private get applicationLimitPerRole(): number {
    const value = Number(this.config.get<number>("guildApplicationLimitPerRole"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : GUILD_APPLICATION_LIMIT_PER_ROLE_DEFAULT;
  }

  /** 入帮申请有效期（#873；脏值回落默认 24h） */
  private get applicationTtlMs(): number {
    const value = Number(this.config.get<number>("guildApplicationTtlMs"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : GUILD_APPLICATION_TTL_MS_DEFAULT;
  }

  /**
   * 申请过期懒清理（#873）：申请 / 看名单 / 审批的入口顺手清一次
   *
   * 全表 DELETE 很轻（申请表规模 = 待处理申请总数），不挂定时器 —— 与队伍邀请表的
   * 懒清理同一口径：过期数据留着唯一的害处是「帮主看到一条 24 小时前的旧申请」。
   */
  private pruneExpiredApplications(): void {
    this.guilds.removeApplicationsOlderThan(Date.now() - this.applicationTtlMs);
  }

  /**
   * 帮会规则门槛（#605：从编译期常量升级为运行时参数）
   *
   * 唯一书写处是 `config-sync.sql` 的 `guild` 组，运营在管理端「运行时参数」页改，
   * **保存即生效**（每次建帮 / 改公告现读，不缓存）。出厂值 2~12 字 / 公告 200 / 留言 50。
   *
   * 为什么校验在 service 而不在 DTO：`@Length` 在类定义时求值，配置改了它不会变 ——
   * DTO 只留**结构上限**（防止超长串进来），业务窗口在这里按当前配置判。
   */
  private rules() {
    return this.runtimeParams.params().guild;
  }

  /** 帮会名长度（按当前配置的上下限） */
  private assertName(name: string): void {
    const { nameMin, nameMax } = this.rules();
    if (name.length < nameMin || name.length > nameMax) {
      throw new BizException(BizCode.PARAM_INVALID, `帮会名需为 ${nameMin}~${nameMax} 字`);
    }
  }

  /** 公告长度（0 = 不限；空串 = 清空，永远合法） */
  private assertNotice(notice: string): void {
    const { noticeMax } = this.rules();
    if (noticeMax > 0 && notice.length > noticeMax) {
      throw new BizException(BizCode.PARAM_INVALID, `公告最多 ${noticeMax} 字`);
    }
  }

  /** 入帮申请留言长度（0 = 不限） */
  private assertApplicationMessage(message: string): void {
    const { applicationMessageMax } = this.rules();
    if (applicationMessageMax > 0 && message.length > applicationMessageMax) {
      throw new BizException(BizCode.PARAM_INVALID, `留言最多 ${applicationMessageMax} 字`);
    }
  }

  //#region 玩家侧

  /**
   * 帮会列表（浏览：人多的在前）
   *
   * 只出**当前区**（#958）：区是独立服，1 区的玩家看不到 2 区的帮会。
   * 区取账号的当前上下文（`roles.zoneOf`：在线角色优先，回落浏览区）——
   * 还没进游戏也能先浏览本区帮会。
   */
  list(accountId: string): GuildSummaryDto[] {
    const zoneId = this.roles.zoneOf(accountId);
    return this.guilds.listByZone(zoneId).map((row) => GuildSummaryDto.from(row));
  }

  /** 我的帮会；不在任何帮会时返回 null（客户端据此显示「创建 / 申请」两种入口） */
  mine(accountId: string): MyGuildDto | null {
    const role = this.onlineRole(accountId);
    const membership = this.guilds.membershipOf(role.id);
    if (!membership) return null;
    // 按角色的区取（#958）：成员行只可能指向本区帮会，跨区说明库被手改过 —— 当作没有帮会
    const guild = this.guilds.findById(role.zoneId, membership.guild_id);
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
      applicants: officer ? (this.pruneExpiredApplications(), this.guilds.applications(guild.id)) : [],
    };
    return this.toMyGuild(parts);
  }

  /**
   * 建帮（建帮人自动成为帮主；顺手清掉他挂在别的帮会的申请）
   *
   * 门槛两条（#872，运营在管理端「运行时参数」页改，保存即生效）：
   * - **等级**（`guild.createLevelMin`）：不够就拒 50147，文案带当前等级与门槛；
   * - **绑定元宝**（`guild.createCostBindGold`）：扣款与建帮**同一个事务**（`DatabaseService.
   *   transaction()` 可重入），钱扣不动就整笔不做，不会留下「钱没了帮没建成」。
   *
   * 顺序：等级 → 名字 → 重名 → 钱。前面几条都是纯读，钱是唯一有副作用的一步，放最后 ——
   * 名字被占了却先扣钱，玩家要等退款逻辑（而这里根本没有退款通道）。
   *
   * 扣完钱**不回传余额**：客户端 1 秒内会收到 `roleUpdate` 帧把整份存档（含 revision 与
   * `bindGold`）覆盖掉，那是「谁改了钱」的唯一通路（与商城 / 回收 / 邮件同一套）。
   */
  create(accountId: string, dto: CreateGuildDto): MyGuildDto {
    const role = this.onlineRole(accountId);
    if (this.guilds.membershipOf(role.id)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "你已经在一个帮会里了，先退出才能另建");
    }
    const { createLevelMin, createCostBindGold } = this.rules();
    if (createLevelMin > 0 && role.level < createLevelMin) {
      throw BizException.forbidden(
        BizCode.GUILD_CREATE_LEVEL_LOW,
        `创建帮会需要 ${createLevelMin} 级，你当前 ${role.level} 级`,
      );
    }
    const name = dto.name.trim();
    // 规则先判：长度不合规时说清「现在允许几个字」，比「已占用」更可能是真原因
    this.assertName(name);
    const notice = (dto.notice ?? "").trim();
    this.assertNotice(notice);
    if (this.guilds.findByName(name)) {
      throw BizException.conflict(BizCode.GUILD_NAME_EXISTS, "这个帮会名已经被占用了");
    }
    const now = Date.now();
    const row: GuildRow = {
      id: `${GUILD_ID_PREFIX}${now.toString(36)}_${randomUUID().slice(0, 8)}`,
      // 区取帮主的角色（#958）：不接受前端传区，建帮就是把「我这一区的角色」聚起来
      zone_id: role.zoneId,
      name,
      notice,
      leader_id: role.id,
      level: 1,
      funds: 0,
      created_at: now,
      updated_at: now,
    };
    this.guilds.transaction(() => {
      // 扣钱放第一步：余额不足抛 20011，整个事务回滚（帮会一行都不会留）
      this.roles.spendBindGold(accountId, createCostBindGold, "创建帮会");
      this.guilds.insert(row);
      this.guilds.insertMember(row.id, role.id, GUILD_RANK.LEADER, now);
      this.guilds.removeApplicationsOfRole(role.id);
    });
    this.logger.log(
      `帮会创建：${row.name}（${row.id}，帮主 ${role.id}，花费 ${createCostBindGold} 绑定元宝）`,
    );
    return this.mustMine(accountId);
  }

  /**
   * 申请加入（重复申请覆盖留言，不堆两条；已在帮会里直接拒）
   *
   * 顺序有讲究（#873）：**同帮已有申请的覆盖留言走在配额之前** —— 我已经挂着这个帮的
   * 申请，改个留言不新增任何行，不该被「我挂的申请数」卡死。配额只拦**新增**：
   * 先每帮待处理上限、再每角色申请数上限；同一码 50146、文案区分是哪一种 ——
   * 客户端只需要一个「申请被拒」提示，但玩家得知道自己为什么被拒。
   */
  apply(accountId: string, guildId: string, message: string): void {
    const role = this.onlineRole(accountId);
    this.pruneExpiredApplications();
    if (this.guilds.membershipOf(role.id)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "你已经在一个帮会里了，先退出才能申请别的");
    }
    // 只在**本区**找（#958）：别区的帮会 id 与「不存在」同一种回复，不给跨区申请留入口
    const guild = this.guilds.findById(role.zoneId, guildId);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "这个帮会不存在（可能刚被解散）");
    if (this.guilds.countMembers(guildId) >= this.memberLimit) {
      throw BizException.conflict(BizCode.GUILD_FULL, "这个帮会人满了");
    }
    const trimmed = message.trim();
    this.assertApplicationMessage(trimmed);
    const existing = this.guilds.findApplication(guildId, role.id);
    if (!existing) {
      if (this.guilds.countApplicationsOfGuild(guildId) >= this.applicationLimitPerGuild) {
        throw BizException.conflict(
          BizCode.GUILD_APPLICATION_LIMIT,
          "这个帮会的申请名额已满，等帮主处理后再试",
        );
      }
      if (this.guilds.countApplicationsOfRole(role.id) >= this.applicationLimitPerRole) {
        throw BizException.conflict(
          BizCode.GUILD_APPLICATION_LIMIT,
          `你同时最多申请 ${this.applicationLimitPerRole} 个帮会，先等之前的申请有结果（24 小时未处理会自动过期）`,
        );
      }
    }
    this.guilds.upsertApplication(guildId, role.id, trimmed, Date.now());
  }

  /** 审批入帮申请（帮主 / 副帮主）：通过则入帮，拒绝直接删掉申请 */
  review(accountId: string, targetRoleId: string, approve: boolean): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (!isOfficer(membership.rank)) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主和副帮主能审批入帮申请");
    }
    this.pruneExpiredApplications();
    const application = this.guilds.findApplication(guild.id, targetRoleId);
    if (!application) {
      throw BizException.notFound(BizCode.GUILD_TARGET_INVALID, "这个申请已经不存在了（可能已被处理或已过期）");
    }
    if (!approve) {
      this.guilds.removeApplication(guild.id, targetRoleId);
      return this.mustMine(accountId);
    }
    // 申请期间对方可能已经进了别的帮会 —— 入帮前再查一次，不能靠「申请时查过」
    if (this.guilds.membershipOf(targetRoleId)) {
      throw BizException.conflict(BizCode.GUILD_ALREADY_IN, "对方已经加入其它帮会了");
    }
    // 申请期间对方可能换了区（合区搬角色）：跨区入帮会把「别区的人」写进本帮的成员表，
    // 之后列表 / 帮会频道 / 经验分成全都要为此写例外。直接作废这条申请（#958）
    if (this.roles.zoneOfRole(targetRoleId) !== guild.zone_id) {
      this.guilds.removeApplication(guild.id, targetRoleId);
      throw BizException.notFound(BizCode.GUILD_TARGET_INVALID, "这个申请的玩家已经不在本区服了，申请已作废");
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

  /**
   * 任命 / 卸任副帮主（#871，仅帮主）
   *
   * 一个接口两个方向（`rank = vice | member`）：两者前置条件、权限、失败码完全一样，
   * 拆两个端点只会多一份要同步的鉴权代码。**换帮主不走这里** —— 那要同时改
   * `guilds.leader_id` 与成员表两处，只在 `transfer` 里做。
   *
   * 名额：`GUILD_VICE_LIMIT_DEFAULT`（1 名，用户 2026-11-11 拍板）。判据是「除目标外
   * 现有副帮主数」—— 对一个已经是副帮主的人再任命一次不该占两个名额（幂等）。
   *
   * 失败路径：50105 不是帮主 / 50108 目标不是本帮成员或就是帮主自己 / 50148 名额已满。
   */
  appoint(accountId: string, targetRoleId: string, rank: string): MyGuildDto {
    const { guild, membership } = this.mustMembership(accountId);
    if (membership.rank !== GUILD_RANK.LEADER) {
      throw BizException.forbidden(BizCode.GUILD_PERMISSION_DENIED, "只有帮主能任命或卸任副帮主");
    }
    const target = this.requireMember(guild.id, targetRoleId);
    if (target.rank === GUILD_RANK.LEADER) {
      throw new BizException(BizCode.GUILD_TARGET_INVALID, "帮主的职位不能在这里改，换帮主请用「转让」");
    }
    const next = rank === GUILD_RANK.VICE ? GUILD_RANK.VICE : GUILD_RANK.MEMBER;
    if (next === target.rank) return this.mustMine(accountId); // 已经是这个职位：幂等，不写库
    if (next === GUILD_RANK.VICE) {
      const others = this.guilds.members(guild.id).filter((item) => item.rank === GUILD_RANK.VICE).length;
      if (others >= GUILD_VICE_LIMIT_DEFAULT) {
        throw BizException.conflict(
          BizCode.GUILD_VICE_LIMIT,
          `副帮主最多 ${GUILD_VICE_LIMIT_DEFAULT} 名，先卸任现任副帮主`,
        );
      }
    }
    this.guilds.updateRank(guild.id, targetRoleId, next);
    this.logger.log(`帮会职位变更：${guild.name}（${guild.id}）${targetRoleId} → ${GUILD_RANK_LABELS[next] ?? next}`);
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
    const trimmed = notice.trim();
    this.assertNotice(trimmed);
    this.guilds.updateNotice(guild.id, trimmed, Date.now());
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

  /**
   * 管理端列表：**只看当前区**（#960）
   *
   * 帮会本来就带区（`guilds.zone_id`，见 #958），所以管理端的「第 3 页」必须指本区第 3 页。
   * 名字仍然全局唯一 —— 别区有个同名帮会时，改名会撞 50102，那是刻意的（见建表注释）。
   */
  adminList(zoneId: number): AdminGuildDto[] {
    return this.guilds.listByZone(zoneId).map((row) => AdminGuildDto.fromAdmin(row));
  }

  /** 详情：别区的帮会 id 一律 404（不是 403 —— 403 会泄露「这个 id 存在」） */
  adminDetail(zoneId: number, id: string): AdminGuildDetailDto {
    const row = this.guilds.findListRow(zoneId, id);
    if (!row) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "帮会不存在");
    return AdminGuildDetailDto.fromDetail(row, this.guilds.members(id));
  }

  /** 改帮会（名字 / 公告）：名字仍要全局唯一（排除自己） */
  adminUpdate(zoneId: number, id: string, dto: AdminUpdateGuildDto): AdminGuildDetailDto {
    const guild = this.guilds.findById(zoneId, id);
    if (!guild) throw BizException.notFound(BizCode.GUILD_NOT_FOUND, "帮会不存在");
    const now = Date.now();
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      this.assertName(name);
      const other = this.guilds.findByName(name);
      if (other && other.id !== id) throw BizException.conflict(BizCode.GUILD_NAME_EXISTS, "这个帮会名已经被占用了");
      if (name !== guild.name) {
        this.guilds.updateName(id, name, now);
      }
    }
    if (dto.notice !== undefined) {
      const notice = dto.notice.trim();
      this.assertNotice(notice);
      this.guilds.updateNotice(id, notice, now);
    }
    return this.adminDetail(zoneId, id);
  }

  /** 强制解散（运营手段：违规帮会名 / 组织性刷资源等） */
  adminRemove(zoneId: number, id: string): void {
    const guild = this.guilds.findById(zoneId, id);
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
    const guild = this.guilds.findById(role.zoneId, membership.guild_id);
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
    dto.zoneId = guild.zone_id;
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
    dto.canAppoint = myRank === GUILD_RANK.LEADER;
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

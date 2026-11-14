import { Injectable, Logger } from "@nestjs/common";
import { isEmail } from "class-validator";
import { EQUIPMENT_SLOT_KEYS } from "../../common/constants/game-enums";
import { BizCode } from "../../common/constants/biz-code";
import { AdminRole, isAdminRole, Permission, roleHasPermission } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword } from "../../common/utils/password.util";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { AccountListOptions, AccountRepository } from "../../database/repositories/account.repository";
import { AdminListOptions, AdminRepository } from "../../database/repositories/admin.repository";
import { AuditRepository } from "../../database/repositories/audit.repository";
import { AuditService } from "../audit/audit.service";
import { RoleRepository } from "../../database/repositories/role.repository";
import { AccountRow, AdminRow, RoleRow, RoleWithAccountRow } from "../../database/rows";
import { AccountDto } from "../auth/dto/account.dto";
import { AdminRoleDetailDto, AdminRoleDto, RoleSummaryDto } from "../roles/dto/role.dto";
import {
  applyBagCells,
  mergeWornEquipments,
  normalizeBagCells,
  normalizeEquipments,
  normalizeName,
  normalizeSkills,
  parseRoleData,
  parseStoredRoleData,
  ROLE_PATCH_NUMBER_FIELDS,
} from "../roles/role-data.util";
import { findOverstackedCell, readBagGrid, reconcileBagCells } from "../roles/role-inventory";
import { clampVitals } from "../roles/role-authority";
import { applyAttributeSummary, roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { equipmentSlotOf, resolveMaxStack } from "../../common/runtime-config-cache";
import { BatchDeleteResultDto, BatchDeleteRolesDto } from "./dto/batch-role.dto";
import { BatchStatusResultDto, BatchUpdateAccountStatusDto } from "./dto/batch-account.dto";
import { AdminDto, AdminUpdateDto } from "./dto/admin.dto";
import { AdminPatchRoleDto } from "./dto/patch-role.dto";
import { ResetAccountPasswordDto, ResetAdminPasswordDto, ResetPasswordResultDto } from "./dto/password.dto";
import { UpdateAccountEmailDto } from "./dto/account-email.dto";
import { AccountQueryDto, AdminQueryDto, RoleQueryDto, roleFilterOf, UpdateAccountStatusDto } from "./dto/query.dto";
import { normalizePage } from "../../common/utils/page.util";
import {
  AdminAccountDetailDto,
  AdminStatsDto,
  StatsBreakdownDto,
  StatsBreakdownItemDto,
  StatsRecentItemDto,
  StatsTrendDto,
  StatsTrendPointDto,
} from "./dto/stats.dto";

/**
 * 管理端业务（账号与角色）
 *
 * 这里可以跨账号操作 —— 与玩家侧 RolesService 的关键差别：
 * 玩家侧靠「令牌里的 accountId + 归属校验」，管理侧靠「@ApiAudience("admin") 守卫」，
 * 所以管理端接口一旦少了守卫就是越权漏洞（见 admin.module 的控制器注解）。
 */
/** 操作人（写审计明细用；`username` 同时会落进 `banned_by` 这类冗余列） */
export type AdminActor = { id: string; username: string; role?: string };

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly roles: RoleRepository,
    private readonly admins: AdminRepository,
    private readonly audit: AuditRepository,
    /**
     * 操作日志**写入**（#885）：批量操作要按目标逐条记明细
     *
     * 与上面的 `audit`（仓储，只读查询）不是一回事 —— 那个给管理端日志页用，
     * 这个是给拦截器之外的手写留痕用（批量操作一条请求改了 N 个目标，
     * 拦截器只能记到「一次操作」，记不到「哪几个」）。
     */
    private readonly auditLog: AuditService,
  ) {}

  //#region 账号

  /**
   * 账号分页检索（keyword 匹配账号名；排序字段白名单见 AccountRepository.ACCOUNT_SORT）
   *
   * **只出「在当前区有角色」的账号**（#960）：管理端一次只在一个区里干活，
   * 全服账号混在一页里，第 3 页到底是谁的第 3 页说不清。
   */
  listAccounts(query: AccountQueryDto, zoneId: number, user?: AuthenticatedUser): PageResult<AccountDto> {
    const { page, size } = normalizePage(query);
    const keyword = query.keyword?.trim() || undefined;
    const options: AccountListOptions = { page, size, keyword, status: query.status, sort: query.sort, order: query.order };
    // 邮箱是个人信息：只有持 account:email 权限的角色才在列表里看到（只读观察员看不到）
    const includeEmail = roleHasPermission(user?.role, Permission.ACCOUNT_EMAIL);
    return {
      list: this.accounts.list(zoneId, options).map((row) => AccountDto.from(row, includeEmail)),
      total: this.accounts.count(zoneId, { keyword, status: query.status }),
      page,
      size,
    };
  }

  /**
   * 账号详情（账号 + 名下**本区**角色概要 + 另在几个区有角色）
   *
   * 「另在 N 个区有角色」是给客服看的提示（#960）：账号级操作（封禁 / 改密 / 删号）
   * 会影响所有区，提交前要知道影响面 —— 但详情里只列当前区的角色，不然一个人在 A 区
   * 的页面上删掉 B 区的角色，只是因为他刚好翻到了那一行。
   */
  accountDetail(id: string, zoneId: number, user?: AuthenticatedUser): AdminAccountDetailDto {
    const account = this.mustAccount(id);
    // 邮箱是个人信息：只有持 account:email 权限的角色才在详情里看到
    const includeEmail = roleHasPermission(user?.role, Permission.ACCOUNT_EMAIL);
    return {
      account: AccountDto.from(account, includeEmail),
      roles: this.roles.findByAccountAndZone(zoneId, id).map((row) => RoleSummaryDto.from(row, account.online_role_id)),
      otherZoneCount: this.roles.countOtherZonesOfAccount(zoneId, id),
    };
  }

  /**
   * 补录 / 修改玩家邮箱
   *
   * 单独一个权限点（account:email，ADMIN / SUPER 持有，VIEWER 不持有）：邮箱是个人信息，
   * 不该跟着 account:read 一起被只读观察员看到，所以补录与查看共用同一道闸。
   *
   * 去重：同一邮箱只绑一个账号（大小写不敏感），写时还有 `idx_accounts_email` 部分唯一索引兜底；
   * 这里先查一遍，冲突时给明确的业务码（而不是等数据库抛唯一约束错误）。
   * 传空串 = 清空（账号回到「未填写邮箱」）。
   */
  updateAccountEmail(id: string, dto: UpdateAccountEmailDto): AccountDto {
    this.mustAccount(id);
    const normalized = dto.email.trim();
    const email = normalized === "" ? null : normalized;
    if (email !== null && !isEmail(email)) {
      throw new BizException(BizCode.PARAM_INVALID, "收件邮箱格式不正确");
    }
    if (email !== null) {
      const conflict = this.accounts.findByEmail(email, id);
      if (conflict) {
        throw BizException.conflict(BizCode.ACCOUNT_EMAIL_EXISTS, "该邮箱已被别的账号绑定");
      }
    }
    this.accounts.updateById(id, { email });
    return AccountDto.from(this.mustAccount(id), true);
  }

  /**
   * 封禁 / 解封账号
   *
   * 封禁时顺手做两件事：① 清在线标记 —— 否则概览的「在线账号数」虚高，玩家重登
   * 还会发现自己「还在游戏里」；② 记下原因 / 到期时间 / 执行人（冗余存账号名，
   * 管理员被删也追得到人）。
   *
   * 「临时封禁到期自动解封」**不靠这里**：判定走 common/utils/ban.util（登录与守卫
   * 每次请求都算），定时器另负责把库里的状态扫回去（见 BanSchedulerService）——
   * 两者互不依赖，服务端停过一段时间再起来也不会漏掉解封。
   */
  updateAccountStatus(id: string, dto: UpdateAccountStatusDto, actor?: AdminActor): AccountDto {
    this.mustAccount(id);
    this.accounts.updateById(id, this.statusPatch(dto, actor?.username, Date.now()));
    return AccountDto.from(this.mustAccount(id));
  }

  /**
   * 批量封禁 / 解封
   *
   * 与单条走**同一套字段**（statusPatch）—— 两处各写一份的话，很容易出现
   * 「批量封禁忘了清在线标记」这种只在批量路径上才有的差异，而批量正是运营最常用的入口。
   *
   * 幂等：已不存在的 id 静默跳过，返回实际改到的条数（与批量删角色同一口径）。
   */
  batchUpdateAccountStatus(dto: BatchUpdateAccountStatusDto, actor?: AdminActor): BatchStatusResultDto {
    const ids = [...new Set(dto.ids.map((item) => item.trim()).filter(Boolean))];
    const patch = this.statusPatch(dto, actor?.username, Date.now());
    const rows = this.accounts.findManyByIds(ids);
    const clearedOnlineAccountIds: string[] = [];
    for (const row of rows) {
      // 封禁会把在线角色标记清掉，记下来供界面提示「有 N 个正在玩的被踢下线」
      if (patch.status === ENTITY_STATUS.DISABLED && row.online_role_id) clearedOnlineAccountIds.push(row.id);
      this.accounts.updateById(row.id, patch);
      // 按目标补一条明细（#885）：拦截器那条只记到「一次批量操作、目标 id 为空」，
      // 于是「批量封了谁」永远查不出来。明细行的 action 与主行相同，靠 target_id 区分
      this.auditLog.record({
        actor: actor ?? null,
        action: "adminAccount.batchStatus",
        targetType: "account",
        targetId: row.id,
        detail: {
          item: true,
          status: patch.status,
          reason: patch.ban_reason ?? null,
          until: patch.ban_until ?? null,
          batchSize: rows.length,
        },
        success: true,
      });
    }
    return {
      requested: dto.ids.length,
      updated: rows.length,
      ids: rows.map((row) => row.id),
      clearedOnlineAccountIds,
    };
  }

  /**
   * 扫描并解封已到期的临时封禁（由 BanSchedulerService 每分钟调用一次）
   *
   * 有意**不写操作日志**：`audit_logs` 记的是「谁改了什么」，而这条是系统行为
   * （actor 为空），写进去只会让「按操作人筛」多出一堆查不到人的记录。
   */
  unbanExpired(now: number = Date.now()): string[] {
    const ids = this.accounts.findExpiredBans(now);
    for (const id of ids) this.accounts.liftBan(id, now);
    return ids;
  }

  /** 删除账号（其名下角色由外键级联删除） */
  removeAccount(id: string): null {
    this.mustAccount(id);
    this.accounts.deleteById(id);
    return null;
  }

  /**
   * 重置玩家账号的密码
   *
   * 玩家忘了密码只能靠这一步（客户端没有找回流程）—— 运营最常用的一条。
   * 会**连带作废该账号已签发的全部令牌**（token_version +1）：否则「账号被盗 → 改密码」
   * 之后，盗号者手里那个 7 天有效期的令牌照样能用，改密码就白改了。
   */
  resetAccountPassword(id: string, dto: ResetAccountPasswordDto): ResetPasswordResultDto {
    const account = this.mustAccount(id);
    this.accounts.updatePasswordAndBumpVersion(id, hashPassword(dto.password));
    return { id, name: account.username, revokedTokens: true };
  }

  /**
   * 踢下线（清掉账号当前选中的在线角色）
   *
   * 幂等：本来就不在线时直接返回当前状态，不报错（界面可能拿着过期的列表点）。
   * 玩家侧那台客户端会在下一次推存档时收到 `ROLE_KICKED`（见 RolesService.save），
   * 才真正被赶回选角界面 —— 只清标记是拦不住本地还在跑的客户端的。
   */
  kickAccountOffline(id: string): AccountDto {
    const account = this.mustAccount(id);
    if (!account.online_role_id) return AccountDto.from(account);
    // #547：标记与心跳一起清 —— 留着心跳，下一拍清算判据虽然不会动它（标记已空），
    // 但「标记没了心跳还在」的半截行会污染排查
    this.accounts.setOnlineRole(id, null);
    return AccountDto.from({ ...account, online_role_id: null });
  }

  /**
   * 状态变更要写的字段（单条与批量共用）
   *
   * 封禁写四件套 + 清在线标记：不清标记则概览的「在线账号数」虚高，
   * 玩家重登还会发现自己「还在游戏里」。解封把四件套一起清空，
   * 避免后台一直显示「已解封，原因：xxx」这种残影。
   */
  private statusPatch(
    dto: UpdateAccountStatusDto,
    operator: string | undefined,
    now: number,
  ): Partial<Omit<AccountRow, "id" | "created_at">> {
    if (dto.status !== ENTITY_STATUS.DISABLED) {
      return { status: ENTITY_STATUS.ACTIVE, ban_reason: null, ban_until: null, banned_by: null, banned_at: null };
    }
    const hours = dto.durationHours ?? null;
    return {
      status: ENTITY_STATUS.DISABLED,
      online_role_id: null,
      online_heartbeat_at: null,
      ban_reason: dto.reason?.trim() || null,
      ban_until: hours === null ? null : now + hours * 3_600_000,
      banned_by: operator ?? null,
      banned_at: now,
    };
  }

  //#endregion

  //#region 角色

  /** 角色分页检索（keyword 匹配角色名或角色 id；条件见 RoleQueryDto，区恒为当前区） */
  listRoles(query: RoleQueryDto, zoneId: number): PageResult<AdminRoleDto> {
    const { page, size } = normalizePage(query);
    const filter = roleFilterOf(query, zoneId);
    return {
      list: this.roles.list({ ...filter, page, size, sort: query.sort, order: query.order }).map((row) => this.toAdminRoleDto(row)),
      total: this.roles.count(filter),
      page,
      size,
    };
  }

  /**
   * 角色详情（带**服务端重算**的战斗属性）
   *
   * `derived` 不在库里，每次读现算，所以管理端改了 level / 战魂 / 称号 / 军衔 / 装备之后
   * 这里立刻是新值，**不用等客户端同步**。
   *
   * 顺带在这里做「客户端上报值 vs 服务端重算值」的观测：不一致记一条 warn。
   * 详情接口是**抽查**（要有人点开才发生），真正的全量观测在玩家上报存档那条线上（issue #94）。
   */
  roleDetail(id: string, zoneId: number): AdminRoleDetailDto {
    return this.toAdminRoleDetailDto(this.withAccount(this.mustRole(zoneId, id)));
  }

  /**
   * 修改角色（只改提交的字段，其余原样保留）
   *
   * 三类字段：基础信息 / 常用数值 / 运行时数据（装备、技能、背包，结构化）。
   * 数值与结构化字段直接写进 data，因此游戏里读到的就是改后的值；
   * 保存后角色修订号 +1 —— 在线玩家那边的下一次进度推送会撞上乐观锁（20006），
   * 从而先同步到这里，不会被玩家手上的旧存档覆盖回去。
   */
  patchRole(id: string, zoneId: number, dto: AdminPatchRoleDto): AdminRoleDetailDto {
    const row = this.mustRole(zoneId, id);
    // roles.data 是 JSON 字符串，编辑前先解出来（坏了直接报错，绝不拿空对象覆盖）
    const { data } = parseRoleData(parseStoredRoleData(row.data));
    const next: Record<string, unknown> = { ...data };
    const patch: { name?: string; occupation?: string; sex?: string; level?: number; data: string; updated_at: number } = {
      data: "",
      updated_at: Date.now(),
    };

    if (dto.name !== undefined) {
      const name = normalizeName(dto.name);
      // 同一区不许重名（#957）：区是独立服，同名跨区合法，同区重名才会让选角页分不清。
      // 区就是当前作业区（row 本身就是按它取出来的，见 mustRole）
      if (this.roles.findByAccountZoneAndName(zoneId, row.account_id, name, id)) {
        throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该区下已存在同名角色");
      }
      patch.name = name;
      next.name = name;
    }
    if (dto.occupation !== undefined) {
      patch.occupation = dto.occupation;
      next.occupation = dto.occupation;
    }
    if (dto.sex !== undefined) {
      patch.sex = dto.sex;
      next.sex = dto.sex;
    }
    if (dto.level !== undefined) {
      patch.level = dto.level;
      next.level = dto.level;
    }
    for (const field of ROLE_PATCH_NUMBER_FIELDS) {
      const value = dto[field];
      if (value !== undefined) next[field] = value;
    }
    // 基础信息里的外观与位置
    if (dto.fashionCloth !== undefined) next.fashionCloth = dto.fashionCloth;
    // 时装拥有清单（#596）：运营发放 / 回收；穿着态归客户端 fashion-wear 接口（有「拥有才给穿」校验），
    // 这里只改清单本身 —— 发放后客户端要穿还得走接口，正好让校验跑一遍
    if (dto.fashionsOwned !== undefined) next.fashionsOwned = Array.from(new Set(dto.fashionsOwned.filter((id) => id.length > 0)));
    if (dto.avatar !== undefined) next.avatar = dto.avatar;
    // 位置：`onMap` 是客户端自报的那份（走图 / 统计），`mapAt` 是服务端承认的那份（#606 进图门槛读它）。
    // 运营把人摆到某张图 = 同时承认这个位置，所以两个一起写；只改 onMap 会让「门槛认为他还在旧图」，
    // 玩家下次登录就被自己的门槛挡在门外。
    if (dto.onMap !== undefined) {
      next.onMap = dto.onMap;
      next.mapAt = dto.onMap;
    }
    // 血蓝（#596 起服务端独占，这里是运营旁路）：改值同时重置回复结算游标，
    // 否则下一次玩家存档会把「游标到现在」的离线时长一次性补成回复
    if (dto.hp !== undefined || dto.mp !== undefined) {
      if (dto.hp !== undefined) next.hp = dto.hp;
      if (dto.mp !== undefined) next.mp = dto.mp;
      next.vitalsSettledAt = Date.now();
    }
    // 运行时数据（结构化；逐项校验在 role-data.util，服务端不认识客户端的配置清单）
    // 槽位在存档里是 `{ id, bound, from }` 对象（#816），管理端入参仍是「槽位 → id」简表：
    // 同一个 id 的条目连元数据一起沿用，换了 id 才新建（规则见 mergeWornEquipments）
    if (dto.equipments !== undefined) {
      // 槽位键先归一（历史习惯是大写「WEAPON」，属性汇总那边一直大小写不敏感；
      // #836 收口之后入参也要认得这套写法 —— 归一成真实部位名再往下走）
      const canonicalInput: Record<string, string | null> = {};
      for (const [key, id] of Object.entries(normalizeEquipments(dto.equipments))) {
        const known = EQUIPMENT_SLOT_KEYS.find((name) => name.toLowerCase() === key.toLowerCase());
        if (!known) {
          throw new BizException(BizCode.ROLE_DATA_INVALID, `没有这个装备槽位：${key}`);
        }
        canonicalInput[known] = id;
      }
      const merged = mergeWornEquipments(canonicalInput, data.equipments);
      // #836：部位与存在性在这里拦（之前不校验直接落库，脏装备要等下次存档清洗，
      // 而清洗会把它丢掉 = 物品凭空消失）。与玩家穿戴同一份裁决（equipmentSlotOf）
      for (const [slot, item] of Object.entries(merged)) {
        if (!item) continue;
        const actual = equipmentSlotOf(item.id);
        if (!actual) {
          throw new BizException(BizCode.ROLE_DATA_INVALID, `槽位「${slot}」的装备不存在或不是装备：${item.id}`);
        }
        if (actual !== slot) {
          throw new BizException(BizCode.ROLE_DATA_INVALID, `装备 ${item.id} 属于「${actual}」槽位，不能放在「${slot}」`);
        }
      }
      next.equipments = merged;
    }
    if (dto.skills !== undefined) next.skills = normalizeSkills(dto.skills);
    // #836：管理端改背包不再整体按未绑定重写 —— 与玩家 move/tidy 同一套元数据认领
    // （reconcileBagCells：同 id 同总量时把 bound/from 认领回新格子，运营新增的堆照旧未绑定；
    // 运营真想洗白一件东西，把件数改掉一个即可，件数对不上就不会认领）。
    // 单格叠加上限在这里一并拦下（装备格 count>1 也算超限，#837 口径）
    if (dto.bag !== undefined) {
      const previous = readBagGrid(data.bag);
      const reconciled = reconcileBagCells(previous, applyBagCells(data.bag, normalizeBagCells(dto.bag)));
      const over = findOverstackedCell(reconciled, resolveMaxStack);
      if (over) {
        throw new BizException(
          BizCode.ROLE_DATA_INVALID,
          `「${over.id}」单格最多 ${over.max} 件，这一格放了 ${over.count} 件`,
        );
      }
      next.bag = reconciled;
    }

    // #836：装备 / 等级 / 背包等重算输入被改后，属性与战斗力必须当场重算 ——
    // 之前沿用上次算的值落库，面板现算与存档值分裂，下次玩家存档走权威重算时
    // 「凭空跳变」。与玩家侧 applyAuthoritativeAttributes 同一对算子（纯函数共用）。
    // 等级不在成长曲线里时跳过并留 warn（与玩家侧同一口径：保留原值好过抹成 0）。
    const level = patch.level ?? row.level;
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(level, next));
    if (summary) {
      applyAttributeSummary(next, summary);
      // 血蓝跟着上限夹取（运营把 maxHp 改小后，hp 不能还停在旧上限之上）
      clampVitals(next);
    } else {
      this.logger.warn(`[admin] 角色 ${id} 的等级 ${level} 不在成长曲线内，战斗属性未重算`);
    }
    patch.data = JSON.stringify(next);
    this.roles.updateById(id, patch);
    return this.roleDetail(id, zoneId);
  }

  /** 删除角色（若正好是账号的在线角色，一并清掉在线标记） */
  removeRole(id: string, zoneId: number): null {
    const row = this.mustRole(zoneId, id);
    this.roles.deleteById(id);
    this.accounts.clearOnlineRole(row.account_id, id);
    return null;
  }

  /**
   * 批量删除角色（按 id）
   *
   * 幂等：已不存在的 id 静默跳过（管理端列表可能已过期，为一条陈旧 id 整体失败更难用）。
   * 删到某个账号的在线角色时顺带清掉在线标记 —— 与单条删除同一套收尾（见 removeRole）。
   *
   * **只删当前区的**（#960）：跨区 id 与「不存在」同一种处理（跳过）。顺着「列表里那批 id」
   * 删是对的，但 id 是客户端传的 —— 它可以是任何区的任何角色。
   */
  batchRemoveRoles(dto: BatchDeleteRolesDto, zoneId: number, actor?: AdminActor): BatchDeleteResultDto {
    const ids = [...new Set(dto.ids.map((item) => item.trim()).filter(Boolean))];
    const found = this.roles.findManyByIds(ids).filter((row) => row.zone_id === zoneId);
    const clearedOnlineAccountIds = this.clearOnlineMarkers(found);
    const deleted = this.roles.deleteByIds(found.map((row) => row.id));
    // 按目标补明细（#885）：同一个理由，主行只记到「批量删了一次」
    for (const row of found) {
      this.auditLog.record({
        actor: actor ?? null,
        action: "adminRole.batchRemove",
        targetType: "role",
        targetId: row.id,
        detail: { item: true, name: row.name, level: row.level, batchSize: found.length },
        success: true,
      });
    }
    return {
      requested: dto.ids.length,
      deleted,
      ids: found.map((row) => row.id),
      clearedOnlineAccountIds,
    };
  }

  /**
   * 清空某账号在**当前区**的全部角色（重置玩家存档时用；账号本身保留）
   *
   * 只清本区：跨区清角等于「在 A 区的页面上把 B 区的号也删了」，而页面根本没列出那些角色。
   * 真要清全服的角色，得逐个区切过去做（这是刻意的：一次误点不该毁掉所有区）。
   */
  purgeAccountRoles(accountId: string, zoneId: number): BatchDeleteResultDto {
    this.mustAccount(accountId);
    const rows = this.roles.findByAccountAndZone(zoneId, accountId);
    const clearedOnlineAccountIds = this.clearOnlineMarkers(rows);
    const deleted = this.roles.deleteByIds(rows.map((row) => row.id));
    return {
      requested: rows.length,
      deleted,
      ids: rows.map((row) => row.id),
      clearedOnlineAccountIds,
    };
  }

  /**
   * 把这些角色恰好是「所属账号的在线角色」的账号标记清掉
   *
   * 必须**先清标记再删角色**：清标记的 SQL 带 `AND online_role_id = ?` 条件，
   * 角色行没了就无法再判断当初指向的是谁。
   */
  private clearOnlineMarkers(rows: RoleRow[]): string[] {
    const cleared: string[] = [];
    for (const row of rows) {
      const account = this.accounts.findById(row.account_id);
      if (!account || account.online_role_id !== row.id) continue;
      this.accounts.clearOnlineRole(row.account_id, row.id);
      cleared.push(row.account_id);
    }
    return cleared;
  }

  /** 把角色设为所属账号的在线角色（等价于玩家在选角界面选它进游戏） */
  selectRole(id: string, zoneId: number): AdminRoleDetailDto {
    const row = this.mustRole(zoneId, id);
    this.accounts.updateById(row.account_id, { online_role_id: row.id });
    return this.roleDetail(id, zoneId);
  }

  //#endregion

  //#region 管理员（权限管理：只有超管能动，且不能把后台锁死）

  /** 管理员分页列表 */
  listAdmins(query: AdminQueryDto): PageResult<AdminDto> {
    const { page, size } = normalizePage(query);
    const keyword = query.keyword?.trim() || undefined;
    const options: AdminListOptions = { page, size, keyword, role: query.role, sort: query.sort, order: query.order };
    return {
      list: this.admins.list(options).map((row) => AdminDto.from(row)),
      total: this.admins.count({ keyword, role: query.role }),
      page,
      size,
    };
  }

  /**
   * 改管理员角色 / 启停
   *
   * 允许改自己（比如超管之间轮值），但**最后一个启用中的超级管理员**不能被降级或停用 ——
   * 这条规则同时兜住了「误降自己导致没人能管后台」的情况，不需要额外的自锁判据。
   * 改完立即生效：守卫每次请求都回查角色，不用等令牌过期。
   */
  updateAdmin(id: string, dto: AdminUpdateDto): AdminDto {
    const target = this.mustAdmin(id);
    const nextRole = dto.role ?? (isAdminRole(target.role) ? target.role : AdminRole.VIEWER);
    const nextStatus = dto.status ?? target.status;
    this.mustKeepSuperAdmin(target, { role: nextRole, status: nextStatus });

    this.admins.updateById(id, { role: nextRole, status: nextStatus });
    return AdminDto.from({ ...target, role: nextRole, status: nextStatus });
  }

  /** 删除管理员（同样保护最后一个启用中的超管；允许删自己 = 离职） */
  removeAdmin(id: string): null {
    const target = this.mustAdmin(id);
    this.mustKeepSuperAdmin(target, { role: null, status: ENTITY_STATUS.DISABLED });
    this.admins.deleteById(id);
    return null;
  }

  /**
   * 重置某个管理员的密码（超管专用；管理员之间不能互相改密码，只有超管能）
   *
   * 不触发「最后一个超管」保护：改密码不会让人失去登录能力，改的也不是身份与状态。
   * 同样会作废对方已签发的令牌（他会被踢回登录页，用新密码重登）。
   */
  resetAdminPassword(id: string, dto: ResetAdminPasswordDto): ResetPasswordResultDto {
    const target = this.mustAdmin(id);
    this.admins.updatePasswordAndBumpVersion(id, hashPassword(dto.password));
    return { id, name: target.username, revokedTokens: true };
  }

  /**
   * 保护：被改的人若是启用中的超级管理员，得确保外面还有别的启用超管
   *
   * 「降级 / 停用 / 删除」三种情况的判定收敛成一句：改完之后他不再「启用中的超管」，
   * 而外面又没有人接得上 → 拒绝。
   */
  private mustKeepSuperAdmin(target: AdminRow, next: { role: string | null; status: string }): void {
    const wasActiveSuper = target.role === AdminRole.SUPER && target.status === ENTITY_STATUS.ACTIVE;
    const staysActiveSuper = next.role === AdminRole.SUPER && next.status === ENTITY_STATUS.ACTIVE;
    if (!wasActiveSuper || staysActiveSuper) return;
    if (this.admins.countActiveSuperAdminsExcept(target.id) === 0) {
      throw BizException.forbidden(BizCode.ADMIN_PROTECTED, "这是最后一个启用中的超级管理员，不能降级、停用或删除");
    }
  }

  //#endregion

  /** 概览统计（当前区；`adminCount` 是全局的 —— 管理员不属于任何区） */
  stats(zoneId: number): AdminStatsDto {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const dto = new AdminStatsDto();
    dto.accountCount = this.accounts.countAll(zoneId);
    dto.roleCount = this.roles.countAll(zoneId);
    dto.onlineAccountCount = this.accounts.countOnline(zoneId);
    dto.todayNewAccountCount = this.accounts.countCreatedAfter(zoneId, startOfToday.getTime());
    dto.todayNewRoleCount = this.roles.countCreatedAfter(zoneId, startOfToday.getTime());
    dto.bannedAccountCount = this.accounts.countBanned(zoneId, Date.now());
    dto.adminCount = this.admins.countAll();
    return dto;
  }

  /**
   * 增长趋势（按天）
   *
   * 「补齐没有数据的日期」放在服务端做：SQL 的 GROUP BY 只会返回**有数据的那几天**，
   * 前端拿到稀疏数组还得自己补，补错了折线就会骗人（缺的那天被前后两点连成直线，
   * 看着就像那天有人在注册）。
   */
  statsTrend(days: number, zoneId: number): StatsTrendDto {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const since = start.getTime();

    const accountsByDay = new Map(this.accounts.countByDaySince(zoneId, since).map((row) => [row.day, row.total]));
    const rolesByDay = new Map(this.roles.countByDaySince(zoneId, since).map((row) => [row.day, row.total]));

    const dto = new StatsTrendDto();
    dto.days = days;
    dto.points = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      const day = localDayKey(date);
      const point = new StatsTrendPointDto();
      point.day = day;
      point.newAccounts = accountsByDay.get(day) ?? 0;
      point.newRoles = rolesByDay.get(day) ?? 0;
      dto.points.push(point);
    }
    dto.totalNewAccounts = dto.points.reduce((sum, item) => sum + item.newAccounts, 0);
    dto.totalNewRoles = dto.points.reduce((sum, item) => sum + item.newRoles, 0);
    return dto;
  }

  /**
   * 分布（等级 / 职业 / 性别 / 地图）
   *
   * 只给分组键与数量：职业、性别、地图的名字都由管理端按客户端字典翻译
   * （服务端不复制游戏配置）。等级档的区间起点是通用格式，不涉及游戏配置。
   */
  statsBreakdown(zoneId: number): StatsBreakdownDto {
    const dto = new StatsBreakdownDto();
    // 等级档：key 存区间起点（bucket 0 -> "1"，代表 1~10 级）
    dto.levels = this.roles.countByLevelBucket(zoneId).map((row) => breakdownItem(String(row.bucket * 10 + 1), row.total));
    dto.occupations = this.roles.countByOccupation(zoneId).map((row) => breakdownItem(row.key, row.total));
    dto.sexes = this.roles.countBySex(zoneId).map((row) => breakdownItem(row.key, row.total));
    // 快照里没有 onMap 的老数据归到空键
    dto.maps = this.roles.countByMap(zoneId).map((row) => breakdownItem(row.key ?? "", row.total));
    return dto;
  }

  /** 最近动态（直接复用操作日志表；只挑界面要显示的字段，不外泄请求体） */
  statsRecent(limit: number): StatsRecentItemDto[] {
    return this.audit.list({ page: 1, size: limit }).map((row) => {
      const item = new StatsRecentItemDto();
      item.createdAt = row.created_at;
      item.actorName = row.actor_name;
      item.action = row.action;
      item.targetType = row.target_type;
      item.targetId = row.target_id;
      item.success = row.success === 1;
      return item;
    });
  }

  //#region 内部

  private mustAdmin(id: string): AdminRow {
    const row = this.admins.findById(id);
    if (!row) throw BizException.notFound(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
    return row;
  }

  private mustAccount(id: string): AccountRow {
    const account = this.accounts.findById(id);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return account;
  }

  /**
   * 取**当前区**的角色（#960）
   *
   * 跨区取 = 404，不是 403：这里不是权限问题（客服本来就能切到那个区），
   * 是「A 区页面 + B 区 id」这种拼接请求必须失败，而不是悄悄改到另一个区去。
   */
  private mustRole(zoneId: number, id: string): RoleRow {
    const row = this.roles.findById(zoneId, id);
    if (!row) throw BizException.notFound(BizCode.ROLE_NOT_FOUND, "角色不存在");
    return row;
  }

  /** 给单条角色行补上账号信息（与列表查询的 join 结果同形） */
  private withAccount(row: RoleRow): RoleWithAccountRow {
    const account = this.accounts.findById(row.account_id);
    return { ...row, account_name: account?.username ?? null, account_online_role_id: account?.online_role_id ?? null };
  }

  private toAdminRoleDto(row: RoleWithAccountRow): AdminRoleDto {
    return AdminRoleDto.fromRow(row, row.account_online_role_id);
  }

  /**
   * 详情用的 DTO（比列表多一组派生字段）
   *
   * 不一致时记一条 warn —— 只记不拦：既存的存档不该因为「口径对不上」被改写，
   * 而 `mismatch` 也不等于作弊（升级与重算之间存档就会命中，详见比对模块的文件头）。
   * 所以日志里把两侧数值都带上，让看到的人自己判断。
   */
  private toAdminRoleDetailDto(row: RoleWithAccountRow): AdminRoleDetailDto {
    const dto = AdminRoleDetailDto.fromRow(row, row.account_online_role_id);
    const { derived } = dto;
    if (derived.mismatch) {
      this.logger.warn(
        `角色 ${row.id}（等级 ${row.level}）战斗属性两端口径不一致：` +
          `服务端重算 combat=${derived.attributes?.combat} maxHp=${derived.attributes?.maxHp}；` +
          `客户端上报 combat=${derived.reported.combat} maxHp=${derived.reported.maxHp}`,
      );
    }
    if (derived.unknownEquipmentIds.length > 0) {
      this.logger.warn(`角色 ${row.id} 有 ${derived.unknownEquipmentIds.length} 个装备 id 查不到属性：${derived.unknownEquipmentIds.join(", ")}`);
    }
    return dto;
  }

  //#endregion
}

/** 造一个分布项（DTO 的构造样板收在一处） */
function breakdownItem(key: string, count: number): StatsBreakdownItemDto {
  const item = new StatsBreakdownItemDto();
  item.key = key;
  item.count = count;
  return item;
}

/**
 * 本地日期键（YYYY-MM-DD）
 *
 * 格式必须与 SQLite 的 `date(..., 'localtime')` 完全一致 —— 趋势是用它把
 * 「查询结果」和「补齐的日期序列」对上的，差一个字符就全拼不上（曲线全 0）。
 */
function localDayKey(date: Date): string {
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

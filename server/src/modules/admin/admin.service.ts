import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { AdminRole, isAdminRole } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword } from "../../common/utils/password.util";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import { AdminListOptions, AdminRepository } from "../../database/repositories/admin.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { AccountRow, AdminRow, RoleRow, RoleWithAccountRow } from "../../database/rows";
import { AccountDto } from "../auth/dto/account.dto";
import { AdminRoleDto, RoleSummaryDto } from "../roles/dto/role.dto";
import {
  applyBagCells,
  normalizeBagCells,
  normalizeEquipments,
  normalizeName,
  normalizeSkills,
  parseRoleData,
  parseStoredRoleData,
  ROLE_PATCH_NUMBER_FIELDS,
} from "../roles/role-data.util";
import { BatchDeleteResultDto, BatchDeleteRolesDto } from "./dto/batch-role.dto";
import { AdminDto, AdminUpdateDto } from "./dto/admin.dto";
import { AdminPatchRoleDto } from "./dto/patch-role.dto";
import { ResetAccountPasswordDto, ResetAdminPasswordDto, ResetPasswordResultDto } from "./dto/password.dto";
import { AccountQueryDto, AdminQueryDto, normalizePage, RoleQueryDto, roleFilterOf, UpdateAccountStatusDto } from "./dto/query.dto";
import { AdminAccountDetailDto, AdminStatsDto } from "./dto/stats.dto";

/**
 * 管理端业务（账号与角色）
 *
 * 这里可以跨账号操作 —— 与玩家侧 RolesService 的关键差别：
 * 玩家侧靠「令牌里的 accountId + 归属校验」，管理侧靠「@ApiAudience("admin") 守卫」，
 * 所以管理端接口一旦少了守卫就是越权漏洞（见 admin.module 的控制器注解）。
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly roles: RoleRepository,
    private readonly admins: AdminRepository,
  ) {}

  //#region 账号

  /** 账号分页检索（keyword 匹配账号名） */
  listAccounts(query: AccountQueryDto): PageResult<AccountDto> {
    const { page, size } = normalizePage(query);
    const keyword = query.keyword?.trim() || undefined;
    const options = { page, size, keyword, status: query.status };
    return {
      list: this.accounts.list(options).map((row) => AccountDto.from(row)),
      total: this.accounts.count({ keyword, status: query.status }),
      page,
      size,
    };
  }

  /** 账号详情（账号 + 名下角色概要） */
  accountDetail(id: string): AdminAccountDetailDto {
    const account = this.mustAccount(id);
    return {
      account: AccountDto.from(account),
      roles: this.roles.findByAccount(id).map((row) => RoleSummaryDto.from(row, account.online_role_id)),
    };
  }

  /** 封禁 / 解封账号（下次请求即生效 —— 守卫每次都回查状态） */
  updateAccountStatus(id: string, dto: UpdateAccountStatusDto): AccountDto {
    const account = this.mustAccount(id);
    this.accounts.updateById(id, { status: dto.status });
    return AccountDto.from({ ...account, status: dto.status });
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
    this.accounts.updateById(id, { online_role_id: null });
    return AccountDto.from({ ...account, online_role_id: null });
  }

  //#endregion

  //#region 角色

  /** 角色分页检索（keyword 匹配角色名或角色 id；其余条件见 RoleQueryDto） */
  listRoles(query: RoleQueryDto): PageResult<AdminRoleDto> {
    const { page, size } = normalizePage(query);
    const filter = roleFilterOf(query);
    return {
      list: this.roles.list({ ...filter, page, size }).map((row) => this.toAdminRoleDto(row)),
      total: this.roles.count(filter),
      page,
      size,
    };
  }

  /** 角色详情 */
  roleDetail(id: string): AdminRoleDto {
    return this.toAdminRoleDto(this.withAccount(this.mustRole(id)));
  }

  /**
   * 修改角色（只改提交的字段，其余原样保留）
   *
   * 三类字段：基础信息 / 常用数值 / 运行时数据（装备、技能、背包，结构化）。
   * 数值与结构化字段直接写进 data，因此游戏里读到的就是改后的值；
   * 保存后角色修订号 +1 —— 在线玩家那边的下一次进度推送会撞上乐观锁（20006），
   * 从而先同步到这里，不会被玩家手上的旧存档覆盖回去。
   */
  patchRole(id: string, dto: AdminPatchRoleDto): AdminRoleDto {
    const row = this.mustRole(id);
    // roles.data 是 JSON 字符串，编辑前先解出来（坏了直接报错，绝不拿空对象覆盖）
    const { data } = parseRoleData(parseStoredRoleData(row.data));
    const next: Record<string, unknown> = { ...data };
    const patch: { name?: string; occupation?: string; sex?: string; level?: number; data: string; updated_at: number } = {
      data: "",
      updated_at: Date.now(),
    };

    if (dto.name !== undefined) {
      const name = normalizeName(dto.name);
      // 同账号不许重名：玩家侧的创建与保存都拦了，管理端不能开这个口子
      // （否则客户端选角列表里会出现两个同名角色，玩家自己也没法区分）
      if (this.roles.findByAccountAndName(row.account_id, name, id)) {
        throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");
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
    if (dto.avatar !== undefined) next.avatar = dto.avatar;
    if (dto.onMap !== undefined) next.onMap = dto.onMap;
    // 运行时数据（结构化；逐项校验在 role-data.util，服务端不认识客户端的配置清单）
    if (dto.equipments !== undefined) next.equipments = normalizeEquipments(dto.equipments);
    if (dto.skills !== undefined) next.skills = normalizeSkills(dto.skills);
    if (dto.bag !== undefined) next.bag = applyBagCells(data.bag, normalizeBagCells(dto.bag));

    patch.data = JSON.stringify(next);
    this.roles.updateById(id, patch);
    return this.roleDetail(id);
  }

  /** 删除角色（若正好是账号的在线角色，一并清掉在线标记） */
  removeRole(id: string): null {
    const row = this.mustRole(id);
    this.roles.deleteById(id);
    this.accounts.clearOnlineRole(row.account_id, id);
    return null;
  }

  /**
   * 批量删除角色（按 id）
   *
   * 幂等：已不存在的 id 静默跳过（管理端列表可能已过期，为一条陈旧 id 整体失败更难用）。
   * 删到某个账号的在线角色时顺带清掉在线标记 —— 与单条删除同一套收尾（见 removeRole）。
   */
  batchRemoveRoles(dto: BatchDeleteRolesDto): BatchDeleteResultDto {
    const ids = [...new Set(dto.ids.map((item) => item.trim()).filter(Boolean))];
    const found = this.roles.findManyByIds(ids);
    const clearedOnlineAccountIds = this.clearOnlineMarkers(found);
    const deleted = this.roles.deleteByIds(found.map((row) => row.id));
    return {
      requested: dto.ids.length,
      deleted,
      ids: found.map((row) => row.id),
      clearedOnlineAccountIds,
    };
  }

  /** 清空某账号的全部角色（重置玩家存档时用；账号本身保留） */
  purgeAccountRoles(accountId: string): BatchDeleteResultDto {
    this.mustAccount(accountId);
    const rows = this.roles.findByAccount(accountId);
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
  selectRole(id: string): AdminRoleDto {
    const row = this.mustRole(id);
    this.accounts.updateById(row.account_id, { online_role_id: row.id });
    return this.roleDetail(id);
  }

  //#endregion

  //#region 管理员（权限管理：只有超管能动，且不能把后台锁死）

  /** 管理员分页列表 */
  listAdmins(query: AdminQueryDto): PageResult<AdminDto> {
    const { page, size } = normalizePage(query);
    const keyword = query.keyword?.trim() || undefined;
    const options: AdminListOptions = { page, size, keyword, role: query.role };
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

  /** 概览统计 */
  stats(): AdminStatsDto {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const dto = new AdminStatsDto();
    dto.accountCount = this.accounts.countAll();
    dto.roleCount = this.roles.countAll();
    dto.onlineAccountCount = this.accounts.countOnline();
    dto.todayNewAccountCount = this.accounts.countCreatedAfter(startOfToday.getTime());
    dto.adminCount = this.admins.countAll();
    return dto;
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

  private mustRole(id: string): RoleRow {
    const row = this.roles.findById(id);
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

  //#endregion
}

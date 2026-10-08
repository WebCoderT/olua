import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { AdminRole, isAdminRole } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import { AdminListOptions, AdminRepository } from "../../database/repositories/admin.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { AccountRow, AdminRow, RoleRow, RoleWithAccountRow } from "../../database/rows";
import { AccountDto } from "../auth/dto/account.dto";
import { AdminRoleDto, RoleSummaryDto } from "../roles/dto/role.dto";
import { normalizeName, parseRoleData, parseStoredRoleData, ROLE_PATCH_NUMBER_FIELDS } from "../roles/role-data.util";
import { AdminDto, AdminUpdateDto } from "./dto/admin.dto";
import { AdminPatchRoleDto } from "./dto/patch-role.dto";
import { AccountQueryDto, AdminQueryDto, normalizePage, RoleQueryDto, UpdateAccountStatusDto } from "./dto/query.dto";
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

  //#endregion

  //#region 角色

  /** 角色分页检索（keyword 匹配角色名或角色 id；accountId 限定账号） */
  listRoles(query: RoleQueryDto): PageResult<AdminRoleDto> {
    const { page, size } = normalizePage(query);
    const keyword = query.keyword?.trim() || undefined;
    const accountId = query.accountId?.trim() || undefined;
    return {
      list: this.roles.list({ page, size, keyword, accountId }).map((row) => this.toAdminRoleDto(row)),
      total: this.roles.count({ keyword, accountId }),
      page,
      size,
    };
  }

  /** 角色详情 */
  roleDetail(id: string): AdminRoleDto {
    return this.toAdminRoleDto(this.withAccount(this.mustRole(id)));
  }

  /**
   * 修改角色（只开放索引字段 + 常用数值字段，其余字段原样保留）
   * 数值字段直接写进 data，因此游戏里读到的就是改后的值
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

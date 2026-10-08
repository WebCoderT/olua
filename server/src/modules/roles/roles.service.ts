import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AccountRepository } from "../../database/repositories/account.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { AccountRow, RoleRow } from "../../database/rows";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { parseRoleData } from "./role-data.util";

/**
 * 角色业务（玩家侧）
 *
 * 所有方法都带 accountId：**归属校验在这里**（越权访问别人的角色一律 403），
 * 控制器只从令牌取 accountId，绝不接受请求体里的账号 id。
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly accounts: AccountRepository,
    private readonly config: ConfigService,
  ) {}

  /** 角色数量上限（与客户端 configs/role.maxRoleCount 对齐，改在服务端 .env） */
  private get maxRoles(): number {
    return this.config.get<number>("roleMaxPerAccount") ?? 3;
  }

  /** 当前账号的角色列表（按创建时间升序，与客户端站位顺序一致） */
  list(accountId: string): RoleSummaryDto[] {
    const account = this.mustAccount(accountId);
    return this.roles.findByAccount(accountId).map((row) => RoleSummaryDto.from(row, account.online_role_id));
  }

  /** 当前选中（在线）角色；未选或角色已被删返回 null */
  online(accountId: string): RoleDto | null {
    const account = this.mustAccount(accountId);
    const roleId = account.online_role_id;
    if (!roleId) return null;
    const row = this.roles.findById(roleId);
    return row ? RoleDto.from(row, roleId) : null;
  }

  /** 角色详情 */
  detail(accountId: string, roleId: string): RoleDto {
    const account = this.mustAccount(accountId);
    return RoleDto.from(this.mustOwnRole(accountId, roleId), account.online_role_id);
  }

  /**
   * 创建角色
   *
   * 校验顺序：数量上限 → id 是否已存在 → 同账号是否重名。
   * 第一个角色自动设为在线（与客户端「建完就能进游戏」的体验一致）。
   */
  create(accountId: string, dto: CreateRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const { fields, data } = parseRoleData(dto.data);

    if (this.roles.countByAccount(accountId) >= this.maxRoles) {
      throw BizException.conflict(BizCode.ROLE_LIMIT, `角色数量已达上限（最多 ${this.maxRoles} 个）`);
    }
    if (this.roles.findById(fields.id)) throw BizException.conflict(BizCode.ROLE_ID_EXISTS, "角色 id 已存在，请重试");
    if (this.roles.findByAccountAndName(accountId, fields.name)) throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");

    const now = Date.now();
    const row: RoleRow = {
      id: fields.id,
      account_id: accountId,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level: fields.level,
      data: JSON.stringify(data),
      created_at: now,
      updated_at: now,
    };
    this.roles.insert(row);
    if (!account.online_role_id) this.accounts.updateById(accountId, { online_role_id: row.id });
    return RoleDto.from(row, account.online_role_id ?? row.id);
  }

  /** 保存角色进度（全量覆盖；id 以路径参数为准，避免换 id 写别人角色） */
  save(accountId: string, roleId: string, dto: SaveRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    const { fields, data } = parseRoleData({ ...dto.data, id: roleId });

    if (fields.name !== existing.name && this.roles.findByAccountAndName(accountId, fields.name, roleId)) {
      throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");
    }

    const row: RoleRow = {
      ...existing,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level: fields.level,
      data: JSON.stringify(data),
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return RoleDto.from(row, account.online_role_id);
  }

  /** 选中（在线）角色 */
  select(accountId: string, roleId: string): RoleDto {
    this.mustAccount(accountId);
    const row = this.mustOwnRole(accountId, roleId);
    this.accounts.updateById(accountId, { online_role_id: row.id });
    return RoleDto.from(row, row.id);
  }

  /** 删除角色（删掉的正好是在线角色时，顺带清掉账号上的在线标记） */
  remove(accountId: string, roleId: string): null {
    this.mustAccount(accountId);
    this.mustOwnRole(accountId, roleId);
    this.roles.deleteById(roleId);
    this.accounts.clearOnlineRole(accountId, roleId);
    return null;
  }

  /** 账号必须存在（守卫已校验，这里兜底防御 + 供服务层内部取在线角色） */
  private mustAccount(accountId: string): AccountRow {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return account;
  }

  /**
   * 角色必须存在且属于该账号
   * @throws BizException 不存在 → 404；存在但不属于该账号 → 403（越权）
   */
  private mustOwnRole(accountId: string, roleId: string): RoleRow {
    const row = this.roles.findById(roleId);
    if (!row) throw BizException.notFound(BizCode.ROLE_NOT_FOUND, "角色不存在");
    if (row.account_id !== accountId) {
      throw new BizException(BizCode.FORBIDDEN, "无权操作该角色", HttpStatus.FORBIDDEN);
    }
    return row;
  }
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";
import { ADMIN_ROLE_LABELS, ADMIN_ROLES, AdminRoleValue, permissionsOfRole } from "../../../common/constants/permission";
import { ENTITY_STATUS } from "../../../common/constants/status";
import { AdminRow } from "../../../database/rows";

/** 管理员信息（不含口令摘要） */
export class AdminDto {
  @ApiProperty({ description: "管理员 id" })
  id: string;

  @ApiProperty({ description: "管理员账号名" })
  username: string;

  @ApiProperty({ description: "状态：active 正常 / disabled 停用" })
  status: string;

  @ApiProperty({
    description: "管理员角色：super_admin 超级管理员 / admin 管理员 / viewer 只读观察员",
    enum: ADMIN_ROLES,
  })
  role: AdminRoleValue;

  @ApiProperty({ description: "角色中文名（界面直接展示）" })
  roleLabel: string;

  @ApiProperty({
    description: "该角色拥有的权限点（管理端据此显示 / 隐藏按钮；服务端仍会独立校验）",
    type: "array",
    items: { type: "string" },
    example: ["stats:read", "account:read"],
  })
  permissions: string[];

  @ApiProperty({ description: "创建时间（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "最近登录时间（毫秒，从未登录为 null）", type: "number", nullable: true })
  lastLoginAt: number | null;

  static from(row: AdminRow): AdminDto {
    const dto = new AdminDto();
    const permissions = permissionsOfRole(row.role);
    dto.id = row.id;
    dto.username = row.username;
    dto.status = row.status;
    // 脏角色兜底成只读观察员以外的「最小权限」：permissionsOfRole 对未知角色返回空数组
    dto.role = permissions.length ? (row.role as AdminRoleValue) : "viewer";
    dto.roleLabel = ADMIN_ROLE_LABELS[dto.role];
    dto.permissions = permissions;
    dto.createdAt = row.created_at;
    dto.lastLoginAt = row.last_login_at;
    return dto;
  }
}

/** 管理端登录 / 注册成功后的返回 */
export class AdminTokenDto {
  @ApiProperty({ description: "访问令牌（放 Authorization: Bearer <token>）" })
  token: string;

  @ApiProperty({ description: "令牌有效期", example: "7d" })
  expiresIn: string;

  @ApiProperty({ description: "管理员信息", type: AdminDto })
  admin: AdminDto;
}

/** 修改管理员（改角色 / 启停；仅 admin:manage 权限可调） */
export class AdminUpdateDto {
  @ApiPropertyOptional({ description: "目标角色", enum: ADMIN_ROLES })
  @IsOptional()
  @IsIn(ADMIN_ROLES, { message: "管理员角色取值不合法" })
  role?: AdminRoleValue;

  @ApiPropertyOptional({ description: "目标状态", enum: [ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED] })
  @IsOptional()
  @IsIn([ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED], { message: "状态取值不合法" })
  status?: string;
}

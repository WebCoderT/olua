import { ApiProperty } from "@nestjs/swagger";
import { AccountRow, AccountWithCountRow } from "../../../database/rows";

/** 账号信息（对外的账号视图：**不含**口令摘要） */
export class AccountDto {
  @ApiProperty({ description: "账号 id", example: "6f1c2b1e-3a5d-4c9e-9a1f-2b3c4d5e6f70" })
  id: string;

  @ApiProperty({ description: "账号名", example: "player001" })
  username: string;

  @ApiProperty({ description: "状态：active 正常 / disabled 封禁（临时封禁到期后由服务端扫回 active）", example: "active" })
  status: string;

  @ApiProperty({ description: "封禁原因（未封禁为 null）", type: "string", nullable: true, example: null })
  banReason: string | null;

  /**
   * 与 status 配合读：`disabled` + `null` = 永久封禁；
   * `disabled` + 已过期时间 = 封禁已到期（服务端下次扫描或该账号下次登录时改回 active）。
   */
  @ApiProperty({ description: "封禁到期时间（毫秒）；null 表示未封禁或永久封禁", type: "number", nullable: true, example: null })
  banUntil: number | null;

  @ApiProperty({ description: "执行封禁的管理员账号名（未封禁为 null）", type: "string", nullable: true, example: null })
  bannedBy: string | null;

  @ApiProperty({ description: "封禁时间（毫秒；未封禁为 null）", type: "number", nullable: true, example: null })
  bannedAt: number | null;

  @ApiProperty({ description: "当前选中的角色 id（未选角色时为 null）", type: "string", nullable: true, example: null })
  onlineRoleId: string | null;

  @ApiProperty({ description: "角色数量（列表接口返回）", required: false, example: 2 })
  roleCount?: number;

  @ApiProperty({ description: "注册时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）", example: 1760000000000 })
  updatedAt: number;

  @ApiProperty({ description: "最近登录时间（毫秒，从未登录为 null）", type: "number", nullable: true, example: 1760000000000 })
  lastLoginAt: number | null;

  static from(row: AccountRow | AccountWithCountRow): AccountDto {
    const dto = new AccountDto();
    dto.id = row.id;
    dto.username = row.username;
    dto.status = row.status;
    dto.banReason = row.ban_reason;
    dto.banUntil = row.ban_until;
    dto.bannedBy = row.banned_by;
    dto.bannedAt = row.banned_at;
    dto.onlineRoleId = row.online_role_id;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    dto.lastLoginAt = row.last_login_at;
    if ("role_count" in row) dto.roleCount = Number((row as AccountWithCountRow).role_count);
    return dto;
  }
}

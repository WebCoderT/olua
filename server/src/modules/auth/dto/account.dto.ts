import { ApiProperty } from "@nestjs/swagger";
import { AccountRow, AccountWithCountRow } from "../../../database/rows";

/** 账号信息（对外的账号视图：**不含**口令摘要） */
export class AccountDto {
  @ApiProperty({ description: "账号 id", example: "6f1c2b1e-3a5d-4c9e-9a1f-2b3c4d5e6f70" })
  id: string;

  @ApiProperty({ description: "账号名", example: "player001" })
  username: string;

  @ApiProperty({ description: "状态：active 正常 / disabled 封禁", example: "active" })
  status: string;

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
    dto.onlineRoleId = row.online_role_id;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    dto.lastLoginAt = row.last_login_at;
    if ("role_count" in row) dto.roleCount = Number((row as AccountWithCountRow).role_count);
    return dto;
  }
}

import { ApiProperty } from "@nestjs/swagger";
import { RoleRow, RoleWithAccountRow } from "../../../database/rows";
import { decodeStoredRoleData } from "../role-data.util";

/** 角色概要（列表接口用：不含 data，体量小；画选角列表只需要这几项） */
export class RoleSummaryDto {
  @ApiProperty({ description: "角色 id" })
  id: string;

  @ApiProperty({ description: "所属账号 id" })
  accountId: string;

  @ApiProperty({ description: "角色名" })
  name: string;

  @ApiProperty({ description: "职业：1 战士 / 2 魔法师 / 3 道士 / 4 全职业" })
  occupation: string;

  @ApiProperty({ description: "性别：1 男 / 2 女 / 3 全性别" })
  sex: string;

  @ApiProperty({ description: "等级" })
  level: number;

  @ApiProperty({ description: "是否当前选中（在线）角色" })
  online: boolean;

  /**
   * 修订号（乐观锁）
   *
   * 客户端保存进度时把它读到的值带回来（`SaveRoleDto.revision`），
   * 对不上说明角色在别处（管理端）被改过 → 服务端拒收并让客户端先拉最新数据。
   */
  @ApiProperty({ description: "修订号（每次落库 +1；客户端保存进度时带上它做乐观锁）" })
  revision: number;

  @ApiProperty({ description: "创建时间（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: RoleRow, onlineRoleId: string | null): RoleSummaryDto {
    const dto = new RoleSummaryDto();
    dto.id = row.id;
    dto.accountId = row.account_id;
    dto.name = row.name;
    dto.occupation = row.occupation;
    dto.sex = row.sex;
    dto.level = row.level;
    dto.online = onlineRoleId === row.id;
    dto.revision = row.revision;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 角色完整信息（详情 / 创建 / 保存 / 选中 的返回；data 是客户端 entities/Role 的完整快照） */
export class RoleDto extends RoleSummaryDto {
  @ApiProperty({
    description: "角色完整数据（客户端 entities/Role 的 JSON 快照，服务端按不透明文档存取；管理端只编辑其中的常用字段）",
    type: "object",
    additionalProperties: true,
  })
  data: Record<string, unknown>;

  static from(row: RoleRow, onlineRoleId: string | null): RoleDto {
    const dto = new RoleDto();
    Object.assign(dto, RoleSummaryDto.from(row, onlineRoleId));
    dto.data = decodeStoredRoleData(row.data);
    return dto;
  }
}

/** 管理端列表里的角色（额外带所属账号名） */export class AdminRoleDto extends RoleDto {
  @ApiProperty({ description: "所属账号名", nullable: true })
  accountName: string | null;

  static fromRow(row: RoleWithAccountRow, onlineRoleId: string | null): AdminRoleDto {
    const dto = new AdminRoleDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.accountName = row.account_name;
    return dto;
  }
}

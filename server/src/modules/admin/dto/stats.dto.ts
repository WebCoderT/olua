import { ApiProperty } from "@nestjs/swagger";
import { AccountDto } from "../../auth/dto/account.dto";
import { RoleSummaryDto } from "../../roles/dto/role.dto";

/** 账号详情（账号 + 其名下角色概要） */
export class AdminAccountDetailDto {
  @ApiProperty({ description: "账号信息", type: AccountDto })
  account: AccountDto;

  @ApiProperty({ description: "该账号的角色列表", type: RoleSummaryDto, isArray: true })
  roles: RoleSummaryDto[];
}

/** 概览统计 */
export class AdminStatsDto {
  @ApiProperty({ description: "账号总数" })
  accountCount: number;

  @ApiProperty({ description: "角色总数" })
  roleCount: number;

  @ApiProperty({ description: "已选中在线角色的账号数" })
  onlineAccountCount: number;

  @ApiProperty({ description: "今日新增账号数" })
  todayNewAccountCount: number;

  @ApiProperty({ description: "管理员数量" })
  adminCount: number;
}

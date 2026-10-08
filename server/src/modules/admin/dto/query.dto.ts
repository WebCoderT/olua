import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";
import { PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { ADMIN_ROLES } from "../../../common/constants/permission";
import { ENTITY_STATUS } from "../../../common/constants/status";

/** 账号列表查询 */
export class AccountQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "状态筛选", enum: [ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED] })
  @IsOptional()
  @IsString({ message: "状态必须是字符串" })
  @IsIn([ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED], { message: "状态取值不合法" })
  status?: string;
}

/** 角色列表查询（keyword 同时匹配角色名与角色 id） */
export class RoleQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "限定账号 id（查某账号下的全部角色）" })
  @IsOptional()
  @IsString({ message: "账号 id 必须是字符串" })
  accountId?: string;
}

/** 管理员列表查询 */
export class AdminQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "角色筛选", enum: ADMIN_ROLES })
  @IsOptional()
  @IsString({ message: "角色必须是字符串" })
  @IsIn(ADMIN_ROLES, { message: "管理员角色取值不合法" })
  role?: string;
}

/** 账号状态变更 */
export class UpdateAccountStatusDto {
  @ApiPropertyOptional({ description: "目标状态", enum: [ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED], example: ENTITY_STATUS.DISABLED })
  @IsString({ message: "状态必须是字符串" })
  @IsIn([ENTITY_STATUS.ACTIVE, ENTITY_STATUS.DISABLED], { message: "状态取值不合法" })
  status: string;
}

/** 分页入参规整（page 从 1 开始，size 限 1~100） */
export function normalizePage(query: PageQueryDto, defaultSize = 20): { page: number; size: number } {
  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1);
  const raw = Math.floor(Number(query.size ?? defaultSize)) || defaultSize;
  const size = Math.min(100, Math.max(1, raw));
  return { page, size };
}

/** 数值上限（管理端改数值字段时防止写入荒谬值） */
export const ADMIN_NUMBER_FIELD_MAX = 999_999_999;

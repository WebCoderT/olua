import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { BizCode } from "../../../common/constants/biz-code";
import { ADMIN_ROLES } from "../../../common/constants/permission";
import { ENTITY_STATUS } from "../../../common/constants/status";
import { BizException } from "../../../common/errors/biz.exception";
import { RoleFilter } from "../../../database/repositories/role.repository";
import { ROLE_LEVEL_MAX, ROLE_OCCUPATIONS, ROLE_SEXES } from "../../roles/role-data.util";

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

  /**
   * 在线状态筛选
   *
   * 用字符串而不是 boolean：query 参数本来就是字符串，而 class-transformer 的隐式转换会把
   * `"false"` 变成 `true`（非空字符串 → Boolean），踩过一次就会静默筛错。
   */
  @ApiPropertyOptional({ description: "在线状态筛选：true 只看在线（账号当前选中的）角色", enum: ["true", "false"] })
  @IsOptional()
  @IsString({ message: "在线状态必须是字符串" })
  @IsIn(["true", "false"], { message: "在线状态只能传 true 或 false" })
  online?: string;

  @ApiPropertyOptional({ description: "职业筛选", enum: [...ROLE_OCCUPATIONS] })
  @IsOptional()
  @IsString({ message: "职业必须是字符串" })
  @IsIn([...ROLE_OCCUPATIONS], { message: "职业取值不合法" })
  occupation?: string;

  @ApiPropertyOptional({ description: "性别筛选", enum: [...ROLE_SEXES] })
  @IsOptional()
  @IsString({ message: "性别必须是字符串" })
  @IsIn([...ROLE_SEXES], { message: "性别取值不合法" })
  sex?: string;

  @ApiPropertyOptional({ description: "最低等级（含）", minimum: 1, maximum: ROLE_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "最低等级必须是整数" })
  @Min(1, { message: "最低等级最小为 1" })
  @Max(ROLE_LEVEL_MAX, { message: `最低等级最大为 ${ROLE_LEVEL_MAX}` })
  minLevel?: number;

  @ApiPropertyOptional({ description: "最高等级（含）", minimum: 1, maximum: ROLE_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "最高等级必须是整数" })
  @Min(1, { message: "最高等级最小为 1" })
  @Max(ROLE_LEVEL_MAX, { message: `最高等级最大为 ${ROLE_LEVEL_MAX}` })
  maxLevel?: number;
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

/**
 * 角色筛选条件规整（把 query 里的字符串形态收敛成仓储层的口径）
 *
 * `online` 传字符串是为了绕开隐式转换的坑（见 RoleQueryDto.online 注释）；
 * 等级区间写反了（min > max）直接报参数错误，否则会得到一个「莫名其妙空」的列表。
 */
export function roleFilterOf(query: RoleQueryDto): RoleFilter {
  if (query.minLevel !== undefined && query.maxLevel !== undefined && query.minLevel > query.maxLevel) {
    throw new BizException(BizCode.PARAM_INVALID, "最低等级不能大于最高等级");
  }
  return {
    keyword: query.keyword?.trim() || undefined,
    accountId: query.accountId?.trim() || undefined,
    online: query.online === undefined ? undefined : query.online === "true",
    occupation: query.occupation,
    sex: query.sex,
    minLevel: query.minLevel,
    maxLevel: query.maxLevel,
  };
}

/** 数值上限（管理端改数值字段时防止写入荒谬值） */
export const ADMIN_NUMBER_FIELD_MAX = 999_999_999;

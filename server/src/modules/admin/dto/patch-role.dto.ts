import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { ROLE_LEVEL_MAX, ROLE_NAME_MAX_LENGTH, ROLE_OCCUPATIONS, ROLE_SEXES } from "../../roles/role-data.util";
import { ADMIN_NUMBER_FIELD_MAX } from "./query.dto";

/**
 * 管理端修改角色
 *
 * 只开放「索引字段 + 常用数值字段」：背包 / 装备 / 技能这些属于游戏运行时细节，
 * 用表单编辑它们不现实（也没意义），要改请在游戏里操作或走专用工具。
 */
export class AdminPatchRoleDto {
  @ApiPropertyOptional({ description: "角色名", example: "小明" })
  @IsOptional()
  @IsString({ message: "角色名必须是字符串" })
  @Length(1, ROLE_NAME_MAX_LENGTH, { message: `角色名需为 1~${ROLE_NAME_MAX_LENGTH} 个字` })
  name?: string;

  @ApiPropertyOptional({ description: "职业（1 战士 / 2 魔法师 / 3 道士 / 4 全职业）", enum: [...ROLE_OCCUPATIONS] })
  @IsOptional()
  @IsString({ message: "职业必须是字符串" })
  @IsIn([...ROLE_OCCUPATIONS], { message: "职业取值不合法" })
  occupation?: string;

  @ApiPropertyOptional({ description: "性别（1 男 / 2 女 / 3 全性别）", enum: [...ROLE_SEXES] })
  @IsOptional()
  @IsString({ message: "性别必须是字符串" })
  @IsIn([...ROLE_SEXES], { message: "性别取值不合法" })
  sex?: string;

  @ApiPropertyOptional({ description: "等级", minimum: 1, maximum: ROLE_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(1, { message: "等级最小为 1" })
  @Max(ROLE_LEVEL_MAX, { message: `等级最大为 ${ROLE_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({ description: "金币" })
  @IsOptional()
  @IsInt({ message: "金币必须是整数" })
  @Min(0, { message: "金币不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "金币数值过大" })
  gold?: number;

  @ApiPropertyOptional({ description: "绑定元宝" })
  @IsOptional()
  @IsInt({ message: "绑定元宝必须是整数" })
  @Min(0, { message: "绑定元宝不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "绑定元宝数值过大" })
  bindGold?: number;

  @ApiPropertyOptional({ description: "银两" })
  @IsOptional()
  @IsInt({ message: "银两必须是整数" })
  @Min(0, { message: "银两不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "银两数值过大" })
  silver?: number;

  @ApiPropertyOptional({ description: "经验" })
  @IsOptional()
  @IsInt({ message: "经验必须是整数" })
  @Min(0, { message: "经验不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "经验数值过大" })
  exp?: number;

  @ApiPropertyOptional({ description: "战魂等级" })
  @IsOptional()
  @IsInt({ message: "战魂等级必须是整数" })
  @Min(0, { message: "战魂等级不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "战魂等级数值过大" })
  soulOfWar?: number;

  @ApiPropertyOptional({ description: "称号等级" })
  @IsOptional()
  @IsInt({ message: "称号等级必须是整数" })
  @Min(0, { message: "称号等级不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "称号等级数值过大" })
  title?: number;

  @ApiPropertyOptional({ description: "军衔阶数" })
  @IsOptional()
  @IsInt({ message: "军衔阶数必须是整数" })
  @Min(0, { message: "军衔阶数不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "军衔阶数数值过大" })
  rank?: number;
}

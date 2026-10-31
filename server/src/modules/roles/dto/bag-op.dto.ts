import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { ROLE_BAG_AXIS_MAX, ROLE_FIELD_VALUE_MAX_LENGTH } from "../role-data.util";
import { RoleDto } from "./role.dto";

/**
 * 背包操作的动作集合（#556）
 *
 * 五个动作共用一个接口：它们的返回形状完全一样（操作后的角色），拆成五个路径
 * 只是把同一份模型抄五遍。合法组合在服务端逐条校验，不做「字段有就用的」宽松处理。
 */
export const BAG_OP_ACTIONS = ["equip", "unequip", "discard", "move", "tidy"] as const;
export type BagOpAction = (typeof BAG_OP_ACTIONS)[number];

/** 整理 / 搬运提交的一格（**稀疏**：只报有东西的格子，空格不报） */
export class BagOpCellDto {
  @ApiProperty({ description: "行", minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  row!: number;

  @ApiProperty({ description: "列", minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1, example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  col!: number;

  @ApiProperty({ description: "物品 id", example: "drug_1" })
  @IsString()
  @MaxLength(ROLE_FIELD_VALUE_MAX_LENGTH)
  id!: string;

  @ApiProperty({ description: "件数", minimum: 1, example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  count!: number;
}

/**
 * 背包操作请求
 *
 * 字段与动作的对应关系（服务端会逐条校验，缺字段 / 多字段都拒绝）：
 * | action | 必填 | 说明 |
 * |---|---|---|
 * | `equip` | `row` `col` | 穿上这一格里的装备 |
 * | `unequip` | `slot` | 脱下这个槽位 |
 * | `discard` | `row` `col` | 丢掉这一格（整格） |
 * | `move` / `tidy` | `cells` | 操作后的完整内容（稀疏），服务端只验守恒 |
 */
export class BagOpDto {
  @ApiProperty({ description: "动作", enum: BAG_OP_ACTIONS, example: "equip" })
  @IsIn(BAG_OP_ACTIONS as unknown as string[])
  action!: BagOpAction;

  @ApiProperty({ description: "背包行（equip / discard）", required: false, minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  row?: number;

  @ApiProperty({ description: "背包列（equip / discard）", required: false, minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  col?: number;

  @ApiProperty({ description: "装备槽位（unequip），如 cloth / weapon", required: false, example: "cloth" })
  @IsOptional()
  @IsString()
  @MaxLength(ROLE_FIELD_VALUE_MAX_LENGTH)
  slot?: string;

  @ApiProperty({
    description: "操作后的背包内容（move / tidy；稀疏格子，只报有东西的格子）",
    required: false,
    type: [BagOpCellDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ROLE_BAG_AXIS_MAX * ROLE_BAG_AXIS_MAX)
  @ValidateNested({ each: true })
  @Type(() => BagOpCellDto)
  cells?: BagOpCellDto[];

  @ApiProperty({
    description: "修订号（乐观锁）：带上了就校验，与服务端当前值不一致时 20006；与 role.save 同一语义",
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision?: number;
}

/** 背包操作结果（操作后的角色 + 本次涉及的装备槽位，客户端刷新对应弹窗直接用） */
export class BagOpResultDto extends RoleDto {
  @ApiProperty({ description: "本次执行的动作", enum: BAG_OP_ACTIONS })
  action: string;

  @ApiProperty({ description: "本次涉及的装备槽位（非装备操作为 null）", type: "string", nullable: true })
  slot: string | null;

  static fromRow(row: RoleRow, onlineRoleId: string | null, action: string, slot: string | null): BagOpResultDto {
    const dto = new BagOpResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.action = action;
    dto.slot = slot;
    return dto;
  }
}

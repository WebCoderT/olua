import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/** 背包网格坐标上限（客户端配置 bagRow × bagCol = 4 × 6；越界坐标本来就不存在，防御性兜住） */
export const DRUG_USE_ROW_MAX = 99;
export const DRUG_USE_COL_MAX = 99;

/** 药品使用请求（玩家侧 #308：回复结算与扣减都在服务端，客户端只报「用哪一格」） */
export class DrugUseDto {
  @ApiProperty({ description: "背包行", minimum: 0, maximum: DRUG_USE_ROW_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(DRUG_USE_ROW_MAX)
  row!: number;

  @ApiProperty({ description: "背包列", minimum: 0, maximum: DRUG_USE_COL_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(DRUG_USE_COL_MAX)
  col!: number;

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

/** 药品使用结果（使用后的角色 + 本次回复量，客户端刷新血蓝/背包与飘字直接用） */
export class DrugUseResultDto extends RoleDto {
  @ApiProperty({ description: "使用的药品 id" })
  drugId: string;

  @ApiProperty({ description: "实际生效的生命回复量（封顶后；0 = 血量本已满）" })
  recoveredHp: number;

  @ApiProperty({ description: "实际生效的魔法回复量（封顶后；0 = 魔法本已满）" })
  recoveredMp: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    drugId: string,
    recoveredHp: number,
    recoveredMp: number,
  ): DrugUseResultDto {
    const dto = new DrugUseResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.drugId = drugId;
    dto.recoveredHp = recoveredHp;
    dto.recoveredMp = recoveredMp;
    return dto;
  }
}

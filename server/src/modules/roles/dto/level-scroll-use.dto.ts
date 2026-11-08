import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/** 背包网格坐标上限（与药品 / 货币道具同一档：客户端 4 × 6，这里只是防御性上界） */
export const LEVEL_SCROLL_USE_ROW_MAX = 99;
export const LEVEL_SCROLL_USE_COL_MAX = 99;

/** 使用升级卷轴的请求（客户端只报「用哪一格」，等级与区间一律读服务端表） */
export class LevelScrollUseDto {
  @ApiProperty({ description: "背包行", minimum: 0, maximum: LEVEL_SCROLL_USE_ROW_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LEVEL_SCROLL_USE_ROW_MAX)
  row!: number;

  @ApiProperty({ description: "背包列", minimum: 0, maximum: LEVEL_SCROLL_USE_COL_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LEVEL_SCROLL_USE_COL_MAX)
  col!: number;

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/**
 * 使用升级卷轴的结果（使用后的角色 + 本次跳级明细）
 *
 * 客户端拿 `level` 刷等级显示、拿 `maxHp` / `maxMp` 刷血条上限、拿 `bag` 换掉本地背包 ——
 * 都是服务端算好的值，客户端不再自己推一遍（推一遍就会与落库值漂开）。
 */
export class LevelScrollUseResultDto extends RoleDto {
  @ApiProperty({ description: "使用的升级卷轴 id（如 level_scroll_1）" })
  itemId: string;

  @ApiProperty({ description: "使用前的等级" })
  fromLevel: number;

  @ApiProperty({ description: "使用后的等级（恒为 fromLevel + 1）" })
  toLevel: number;

  @ApiProperty({ description: "当前经验（卷轴不消耗经验，原样保留）" })
  exp: number;

  @ApiProperty({ description: "升到下一级所需经验（客户端进度条用；满级为 0）" })
  expNeed: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    itemId: string,
    fromLevel: number,
    exp: number,
    expNeed: number,
  ): LevelScrollUseResultDto {
    const dto = new LevelScrollUseResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.itemId = itemId;
    dto.fromLevel = fromLevel;
    dto.toLevel = row.level;
    dto.exp = exp;
    dto.expNeed = expNeed;
    return dto;
  }
}

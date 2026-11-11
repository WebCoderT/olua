import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/** 背包网格坐标上限（与药品同一档：客户端 4 × 6，这里只是防御性上界） */
export const MONEY_USE_ROW_MAX = 99;
export const MONEY_USE_COL_MAX = 99;

/** 使用货币物品的请求（玩家侧 #785：客户端只报「用哪一格」，金额与币种一律读服务端表） */
export class MoneyUseDto {
  @ApiProperty({ description: "背包行", minimum: 0, maximum: MONEY_USE_ROW_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MONEY_USE_ROW_MAX)
  row!: number;

  @ApiProperty({ description: "背包列", minimum: 0, maximum: MONEY_USE_COL_MAX, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MONEY_USE_COL_MAX)
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

/** 使用货币物品的结果（使用后的角色 + 本次入账明细，客户端刷 HUD 与背包直接用） */
export class MoneyUseResultDto extends RoleDto {
  @ApiProperty({ description: "使用的货币物品 id（如 money_bind_gold_100）" })
  itemId: string;

  @ApiProperty({ description: "入账的账本字段：bindGold（唯一货币）" })
  currency: string;

  @ApiProperty({ description: "本次入账金额（读服务端表，客户端报的不算数）" })
  amount: number;

  @ApiProperty({ description: "入账后的余额（客户端飘字「+100 绑定元宝（共 300）」用）" })
  balance: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    itemId: string,
    currency: string,
    amount: number,
    balance: number,
  ): MoneyUseResultDto {
    const dto = new MoneyUseResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.itemId = itemId;
    dto.currency = currency;
    dto.amount = amount;
    dto.balance = balance;
    return dto;
  }
}

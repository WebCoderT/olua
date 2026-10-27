import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { ROLE_FIELD_VALUE_MAX_LENGTH } from "../role-data.util";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/**
 * 一次出售里的单条（物品 id + 件数）
 *
 * 刻意**不按格子坐标**卖：存档背包是客户端配置决定的网格，格子会因整理 / 拾取挪位置，
 * 拿坐标当入参等于把「格子布局」写进协议；而同一件物品散在多格是常态。
 * 服务端按 id 点数扣（见 roles.takeGoodsFromBag），与任务 collect 的扣法同一处实现。
 */
export class SellEntryDto {
  @ApiProperty({ description: "物品 id（必须在共享快照的出售价表里，否则 20018）", example: "material_hide" })
  @IsString()
  @MaxLength(ROLE_FIELD_VALUE_MAX_LENGTH)
  goodId!: string;

  @ApiProperty({ description: "要卖的件数（≥1；超过背包持有量整单拒绝 20019）", example: 3, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9999)
  count!: number;
}

/** 出售请求（#397：客户端只报「卖什么、卖几件」，价格与扣物全在服务端） */
export class SellGoodsDto {
  @ApiProperty({
    description:
      "要卖的东西（一次最多 200 条，够一键回收把整包装备报上来）。" +
      "同 id 的多条会先合并再扣，重复报同一格不构成两次出售。",
    type: [SellEntryDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SellEntryDto)
  entries!: SellEntryDto[];

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

/** 出售结果里的一行结算（客户端提示「卖了什么、一件多少钱」直接用，不自己算） */
export class SellLineDto {
  @ApiProperty({ description: "物品 id" })
  goodId: string;

  @ApiProperty({ description: "卖出的件数（同 id 已合并）" })
  count: number;

  @ApiProperty({ description: "单价（绑定元宝/件，来自共享快照）" })
  unitPrice: number;

  @ApiProperty({ description: "这一行的合计（unitPrice × count）" })
  total: number;
}

/** 出售结果（出售后的角色 + 本次结算明细；bag / bindGold / revision 以这里为准） */
export class SellGoodsResultDto extends RoleDto {
  @ApiProperty({ description: "逐行结算明细", type: [SellLineDto] })
  sold: SellLineDto[];

  @ApiProperty({ description: "卖出的总件数" })
  count: number;

  @ApiProperty({ description: "本次获得的绑定元宝合计" })
  total: number;

  static fromRow(row: RoleRow, onlineRoleId: string | null, sold: SellLineDto[], total: number): SellGoodsResultDto {
    const dto = new SellGoodsResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.sold = sold;
    dto.count = sold.reduce((sum, line) => sum + line.count, 0);
    dto.total = total;
    return dto;
  }
}

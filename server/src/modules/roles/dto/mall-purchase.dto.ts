import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { ROLE_FIELD_VALUE_MAX_LENGTH } from "../role-data.util";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/** 商城购买请求（玩家侧 #304：扣费与入包都在服务端，客户端只报「买什么」） */
export class MallPurchaseDto {
  @ApiProperty({ description: "商品 id（必须是商城目录里的装备变体）", example: "cloth_1_p0s1" })
  @IsString()
  @MaxLength(ROLE_FIELD_VALUE_MAX_LENGTH)
  goodId!: string;

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

/** 商城购买结果（购买后的角色 + 本次消耗，客户端刷新余额/背包与提示直接用） */
export class MallPurchaseResultDto extends RoleDto {
  @ApiProperty({ description: "本次购买消耗的绑定元宝" })
  consumed: number;

  @ApiProperty({ description: "买到的商品 id" })
  goodId: string;

  static fromRow(row: RoleRow, onlineRoleId: string | null, consumed: number, goodId: string): MallPurchaseResultDto {
    const dto = new MallPurchaseResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.consumed = consumed;
    dto.goodId = goodId;
    return dto;
  }
}

import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Length, Min } from "class-validator";
import { ROLE_FIELD_VALUE_MAX_LENGTH } from "../role-data.util";

/** 时装 id 长度上限（fashions 表主键，如 cloth_2） */
const FASHION_ID_MAX = 32;

/** 时装购买请求（#596：扣费与拥有清单都在服务端） */
export class FashionBuyDto {
  @ApiProperty({ description: "要买的时装 id（fashions 表主键，如 cloth_2）", example: "cloth_2" })
  @IsString({ message: "时装 id 必须是字符串" })
  @Length(1, FASHION_ID_MAX, { message: `时装 id 需为 1~${FASHION_ID_MAX} 个字符` })
  fashionId!: string;

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/** 时装购买结果（扣费后的绑定元宝 + 完整拥有清单） */
export class FashionBuyResultDto {
  @ApiProperty({ description: "本次购买的时装 id" })
  fashionId: string;

  @ApiProperty({ description: "本次扣除的绑定元宝（= fashions.sell_price）" })
  price: number;

  @ApiProperty({ description: "购买后的绑定元宝余额" })
  bindGold: number;

  @ApiProperty({ description: "购买后的拥有清单（含新买的这件；已拥有的 id 不会重复）", type: [String] })
  owned: string[];

  @ApiProperty({ description: "最新修订号" })
  revision: number;
}

/** 时装穿 / 脱请求（#596：穿着态归服务端，「拥有才给穿」在这里校验） */
export class FashionWearDto {
  @ApiProperty({ description: "要穿的时装 id；null = 脱下当前时装", type: "string", nullable: true })
  @IsOptional()
  @IsString({ message: "时装 id 必须是字符串" })
  @Length(1, ROLE_FIELD_VALUE_MAX_LENGTH, { message: "时装 id 过长" })
  fashionId?: string | null;

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/** 时装穿 / 脱结果 */
export class FashionWearResultDto {
  @ApiProperty({ description: "穿着态（当前穿的时装 id，null = 未穿）", type: "string", nullable: true })
  fashionCloth: string | null;

  @ApiProperty({ description: "当前拥有清单", type: [String] })
  owned: string[];

  @ApiProperty({ description: "最新修订号" })
  revision: number;
}

import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/** 成长线种类（三条线同构：称号 / 战魂 / 军衔） */
export const GROWTH_KINDS = ["title", "soul", "rank"] as const;
export type GrowthKind = (typeof GROWTH_KINDS)[number];

/** 升到下一阶消耗的绑定元宝上限（防脏数据上界；与 MALL_PRICE_MAX 同量级） */
const GROWTH_LEVEL_MAX = 10_000;

/** 成长线升级请求（玩家侧；扣费与阶位推进都在服务端，客户端只报「想升哪条线、升到哪阶」） */
export class GrowthUpgradeDto {
  @ApiProperty({ description: "成长线：title 称号 / soul 战魂 / rank 军衔", enum: GROWTH_KINDS })
  @IsIn(GROWTH_KINDS)
  kind!: GrowthKind;

  @ApiProperty({ description: "目标阶位（必须是升级链上当前阶位的下一阶，防跳级）", minimum: 1, maximum: GROWTH_LEVEL_MAX })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GROWTH_LEVEL_MAX)
  targetLevel!: number;

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

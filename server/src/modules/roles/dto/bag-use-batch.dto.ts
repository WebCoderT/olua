import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, Max, Min, ValidateNested } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { ROLE_BAG_AXIS_MAX, ROLE_BAG_COUNT_MAX } from "../role-data.util";
import { RoleDto } from "./role.dto";

/**
 * 一次批量使用里「最多真正用掉多少件」
 *
 * 64 = 背包一列的量级：更多的目标交给下一轮（自动使用的扫描由背包变化触发，
 * 用掉之后自然会再排一轮）。设上限是为了让「一个请求」的时间与落库体积有确定边界，
 * 而不是让客户端一次把 999 个堆叠全烧掉。
 */
export const BAG_USE_BATCH_MAX_APPLY = 64;

/** 批量使用的一个目标（报「哪一格」，最多用几件） */
export class BagUseTargetDto {
  @ApiProperty({ description: "背包行", minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  row!: number;

  @ApiProperty({ description: "背包列", minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1, example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROLE_BAG_AXIS_MAX - 1)
  col!: number;

  @ApiProperty({
    description:
      "这一格用几件（缺省 1；叠放的一堆可以一次用完）。逐次扣减：用不动（血蓝满 / 冷却中 / 等级出区间）就停在这一条上，剩下的留给下一轮",
    required: false,
    minimum: 1,
    maximum: ROLE_BAG_COUNT_MAX,
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ROLE_BAG_COUNT_MAX)
  count?: number;
}

/**
 * 批量使用请求（玩家侧；自动使用的热路径）
 *
 * 与 `drug-use` / `money-use` / `level-scroll-use` 的关系：**规则完全同一份**
 * （三条单条路径的判定在服务端抽成私有助手，这里逐条复用），区别只在
 * 「一次请求、一次解码、一次落库、revision 只 +1」，以及逐条失败**不整单回滚**。
 *
 * 客户端只报「用哪几格、每格几件」：回血量、入账金额、等级区间一概由服务端读库计算。
 */
export class BagUseBatchDto {
  @ApiProperty({
    description: "要用的目标（稀疏：只报有东西的格子；同一格不要重复报）",
    type: [BagUseTargetDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BAG_USE_BATCH_MAX_APPLY)
  @ValidateNested({ each: true })
  @Type(() => BagUseTargetDto)
  uses!: BagUseTargetDto[];

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/** 批量使用里的一条结果（逐条成败，客户端据此知道哪一格用不动、为什么） */
export class BagUseBatchItemDto {
  @ApiProperty({ description: "背包行" })
  row: number;

  @ApiProperty({ description: "背包列" })
  col: number;

  @ApiProperty({ description: "这一格用的是什么物品 id（空格 / 认不出的 id 时为空串）" })
  id: string;

  @ApiProperty({
    description: "这一格走的是哪条规则：drug / money / levelScroll / unknown（不是可直接使用的物品）",
    enum: ["drug", "money", "levelScroll", "unknown"],
  })
  kind: "drug" | "money" | "levelScroll" | "unknown";

  @ApiProperty({ description: "这一格实际用掉了多少件（0 = 一件都没用成）" })
  count: number;

  @ApiProperty({ description: "是否至少用成了一件" })
  ok: boolean;

  @ApiProperty({
    description:
      "失败原因的业务码（ok=true 时为 null）：20013 药品 / 20014 血蓝已满 / 20030 药品冷却 / " +
      "20023 货币道具 / 20031 道具冷却 / 20024~20026 升级卷轴",
    type: "number",
    nullable: true,
  })
  code: number | null;

  @ApiProperty({ description: "失败原因（中文，ok=true 时为 null）", type: "string", nullable: true })
  message: string | null;
}

/** 批量使用结果（使用后的角色 + 逐条结果与合计，客户端刷新血蓝/背包/等级直接用） */
export class BagUseBatchResultDto extends RoleDto {
  @ApiProperty({ description: "逐条结果（与请求的 uses 一一对应）", type: [BagUseBatchItemDto] })
  uses: BagUseBatchItemDto[];

  @ApiProperty({ description: "本次实际用掉的件数合计（所有目标相加）" })
  usedCount: number;

  @ApiProperty({ description: "实际生效的生命回复量合计（封顶后）" })
  recoveredHp: number;

  @ApiProperty({ description: "实际生效的魔法回复量合计（封顶后）" })
  recoveredMp: number;

  @ApiProperty({ description: "货币道具本次入账的绑定元宝合计" })
  bindGoldGained: number;

  @ApiProperty({ description: "升级卷轴本次升的等级数合计" })
  levelsGained: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    uses: BagUseBatchItemDto[],
    totals: { usedCount: number; recoveredHp: number; recoveredMp: number; bindGoldGained: number; levelsGained: number },
  ): BagUseBatchResultDto {
    const dto = new BagUseBatchResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.uses = uses;
    dto.usedCount = totals.usedCount;
    dto.recoveredHp = totals.recoveredHp;
    dto.recoveredMp = totals.recoveredMp;
    dto.bindGoldGained = totals.bindGoldGained;
    dto.levelsGained = totals.levelsGained;
    return dto;
  }
}

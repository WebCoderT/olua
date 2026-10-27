import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { PageMetaDto } from "../../../common/dto/api-envelope.dto";
import { LEADERBOARD_BOARD, LeaderboardBoard } from "../../../common/constants/leaderboard";

/**
 * 榜上的一条
 *
 * 只给「别人也能看到」的东西：名字、职业、等级、战力、击杀、区服。
 * **刻意不带** accountId（对外数据里的关联键）、`data`（整份存档）、在线状态
 * （在线状态会让人蹲点）。
 */
export class LeaderboardEntryDto {
  @ApiProperty({ description: "名次（并列同分同名次：1、2、2、4）", example: 1 })
  rank: number;

  @ApiProperty({ description: "角色 id（点进去看详情 / 加好友用）" })
  roleId: string;

  @ApiProperty({ description: "角色名" })
  name: string;

  @ApiProperty({ description: "职业码" })
  occupation: string;

  @ApiProperty({ description: "等级" })
  level: number;

  @ApiProperty({ description: "战斗力（与客户端 combatCalc 同源）" })
  combat: number;

  @ApiProperty({ description: "击杀数（服务端结算路径累加）" })
  kills: number;

  @ApiProperty({ description: "归属区服 id（榜是全服单榜，这一项只用于展示「来自 X 区」）" })
  zoneId: number;
}

/** 分页结果（比通用分页多一个「这份快照算出来的时刻」） */
export class LeaderboardPageDto extends PageMetaDto {
  @ApiProperty({ type: [LeaderboardEntryDto], description: "本页条目（按名次升序）" })
  list: LeaderboardEntryDto[];

  @ApiProperty({
    description:
      "这份快照算出来的时刻（毫秒）。榜单是**物化**的（默认每分钟重算一次），" +
      "客户端据此告诉玩家「每分钟更新」，而不是让人以为刚升级就该立刻跳名次。",
    example: 1760000000000,
  })
  computedAt: number;
}

/** 我自己在这个榜上的位置 */
export class LeaderboardSelfDto {
  @ApiProperty({
    description: "我的名次；**0 = 没有名次**（没有在线角色，或角色不在这份快照里）",
    example: 37,
  })
  rank: number;

  @ApiProperty({
    description: "我在榜上的那一条（`rank = 0` 时为 null）",
    type: LeaderboardEntryDto,
    nullable: true,
  })
  entry: LeaderboardEntryDto | null;

  @ApiProperty({ description: "这份快照算出来的时刻（毫秒）", example: 1760000000000 })
  computedAt: number;
}

/**
 * 榜单分页入参
 *
 * 不复用 `PageQueryDto`：那个还带 `keyword` / `sort` / `order`，而榜单的排序是**固定**的
 * （不然名次就没意义了）——把用不上的参数写进文档只会让人以为可以按关键字筛榜。
 */
export class LeaderboardQueryDto {
  @ApiPropertyOptional({ description: "页码，从 1 开始", example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @IsInt({ message: "页码必须是整数" })
  @Min(1, { message: "页码最小为 1" })
  page?: number;

  @ApiPropertyOptional({
    description:
      "每页条数（默认 20）。上限由服务端配置 `LEADERBOARD_TOP_N` 决定（默认 100）——" +
      "传得比它大不会报错，会被夹到上限。",
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt({ message: "每页条数必须是整数" })
  @Min(1, { message: "每页条数最小为 1" })
  @Max(100, { message: "每页条数最大为 100" })
  size?: number;
}

/** 榜类型是否合法（路由参数是裸字符串，校验放在服务里 —— 错误信息要说清「有哪几个榜」） */
export function isLeaderboardBoard(value: string): value is LeaderboardBoard {
  return value === LEADERBOARD_BOARD.LEVEL || value === LEADERBOARD_BOARD.COMBAT || value === LEADERBOARD_BOARD.KILLS;
}

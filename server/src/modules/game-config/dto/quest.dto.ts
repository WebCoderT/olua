import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { QuestRow } from "../../../database/rows";

/** 管理端看到的一条任务目标 */
export class QuestObjectiveDto {
  @ApiProperty({ description: "目标类型：kill 击杀怪物 / talk 与 NPC 对话 / collect 收集物品", enum: ["kill", "talk", "collect"] })
  type: "kill" | "talk" | "collect";

  @ApiProperty({ description: "目标键：kill = 怪物 key / talk = NPC id / collect = 物品 id" })
  target: string;

  @ApiProperty({ description: "目标数量" })
  count: number;

  static from(row: { objective_type: string; objective_target: string; objective_count: number }): QuestObjectiveDto {
    const dto = new QuestObjectiveDto();
    dto.type = row.objective_type as QuestObjectiveDto["type"];
    dto.target = row.objective_target;
    dto.count = row.objective_count;
    return dto;
  }
}

/** 一条奖励物品 */
export class QuestRewardItemDto {
  @ApiProperty({ description: "物品 id" })
  goodId: string;

  @ApiProperty({ description: "数量" })
  count: number;
}

/** 任务奖励 */
export class QuestRewardsDto {
  @ApiProperty({ description: "金币" })
  gold: number;

  @ApiProperty({ description: "经验" })
  exp: number;

  @ApiProperty({ description: "物品清单", type: [QuestRewardItemDto] })
  items: QuestRewardItemDto[];

  static from(row: { reward_gold: number; reward_exp: number; reward_items: string }): QuestRewardsDto {
    const dto = new QuestRewardsDto();
    dto.gold = row.reward_gold;
    dto.exp = row.reward_exp;
    dto.items = parseRewardItems(row.reward_items);
    return dto;
  }
}

/**
 * 奖励物品 JSON 列解析 —— 实现住在 `common/utils/reward-items.util.ts`，
 * 任务与成就共用（同一个列格式只该有一个解析器），这里只做转出。
 */
import { parseRewardItems } from "../../../common/utils/reward-items.util";

export { parseRewardItems };

/** 管理端看到的一条任务配置 */
export class QuestDto {
  @ApiProperty({ description: "任务 id（主线 8000 段 / 日常 8100 段）" })
  id: string;

  @ApiProperty({ description: "类型：main 主线（一次性）/ daily 日常（领奖后可重接）", enum: ["main", "daily"] })
  kind: "main" | "daily";

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "主线链前置任务 id（空串 = 无前置）" })
  prevQuestId: string;

  @ApiProperty({ description: "接取最低等级" })
  minLevel: number;

  @ApiProperty({ description: "发布 NPC id" })
  npcId: string;

  @ApiProperty({ description: "目标（单目标，v1 边界）", type: QuestObjectiveDto })
  objective: QuestObjectiveDto;

  @ApiProperty({ description: "奖励", type: QuestRewardsDto })
  rewards: QuestRewardsDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: QuestRow): QuestDto {
    const dto = new QuestDto();
    dto.id = row.id;
    dto.kind = row.kind as QuestDto["kind"];
    dto.label = row.label;
    dto.description = row.description;
    dto.prevQuestId = row.prev_quest_id;
    dto.minLevel = row.min_level;
    dto.npcId = row.npc_id;
    dto.objective = QuestObjectiveDto.from(row);
    dto.rewards = QuestRewardsDto.from(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 任务列表查询入参 */
export class QuestQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "类型筛选：main | daily" })
  @IsOptional()
  @IsIn(["main", "daily"], { message: "类型只能是 main 或 daily" })
  declare kind?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 任务分页结果 */
export class QuestPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的任务配置", type: [QuestDto] })
  list: QuestDto[];
}

/** 任务目标编辑入参 */
export class UpdateQuestObjectiveDto {
  @ApiPropertyOptional({ description: "目标类型", enum: ["kill", "talk", "collect"] })
  @IsOptional()
  @IsIn(["kill", "talk", "collect"], { message: "目标类型只能是 kill / talk / collect" })
  type?: "kill" | "talk" | "collect";

  @ApiPropertyOptional({ description: "目标键（非空）" })
  @IsOptional()
  @IsString({ message: "目标键必须是字符串" })
  @MinLength(1, { message: "目标键不能为空" })
  @MaxLength(64, { message: "目标键不能超过 64 字" })
  target?: string;

  @ApiPropertyOptional({ description: "目标数量（1~9999）" })
  @IsOptional()
  @IsInt({ message: "目标数量必须是整数" })
  @Min(1, { message: "目标数量至少 1" })
  @Max(9999, { message: "目标数量不能超过 9999" })
  count?: number;
}

/** 任务奖励编辑入参 */
export class UpdateQuestRewardsDto {
  @ApiPropertyOptional({ description: "金币（≥0）" })
  @IsOptional()
  @IsInt({ message: "金币必须是整数" })
  @Min(0, { message: "金币不能为负" })
  gold?: number;

  @ApiPropertyOptional({ description: "经验（≥0）" })
  @IsOptional()
  @IsInt({ message: "经验必须是整数" })
  @Min(0, { message: "经验不能为负" })
  exp?: number;

  @ApiPropertyOptional({ description: "物品清单（≤20 条；goodId 非空、count 1~9999）", type: [QuestRewardItemDto] })
  @IsOptional()
  @IsArray({ message: "物品清单必须是数组" })
  @ArrayMaxSize(20, { message: "物品清单不能超过 20 条" })
  @ValidateNested({ each: true })
  @Type(() => QuestRewardItemDto)
  items?: QuestRewardItemDto[];
}

/**
 * 编辑任务配置入参（**部分更新**）
 *
 * `prevQuestId` / `objective` / `rewards` 传了就整份替换；跨字段一致性
 * （链不能成环、collect 的 target 必须是真实物品 id 等）在 service 校验。
 */
export class UpdateQuestDto {
  @ApiPropertyOptional({ description: "类型", enum: ["main", "daily"] })
  @IsOptional()
  @IsIn(["main", "daily"], { message: "类型只能是 main 或 daily" })
  kind?: "main" | "daily";

  @ApiPropertyOptional({ description: "名称（1~50 字）" })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "描述（≤500 字）" })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(500, { message: "描述不能超过 500 字" })
  description?: string;

  @ApiPropertyOptional({ description: "主线链前置任务 id（空串 = 无前置）" })
  @IsOptional()
  @IsString({ message: "前置任务 id 必须是字符串" })
  @MaxLength(32, { message: "前置任务 id 不能超过 32 字" })
  prevQuestId?: string;

  @ApiPropertyOptional({ description: "接取最低等级（1~999）" })
  @IsOptional()
  @IsInt({ message: "接取等级必须是整数" })
  @Min(1, { message: "接取等级至少 1" })
  @Max(999, { message: "接取等级不能超过 999" })
  minLevel?: number;

  @ApiPropertyOptional({ description: "发布 NPC id" })
  @IsOptional()
  @IsString({ message: "发布 NPC 必须是字符串" })
  @MaxLength(32, { message: "发布 NPC 不能超过 32 字" })
  npcId?: string;

  @ApiPropertyOptional({ description: "目标（传了就整份替换）", type: UpdateQuestObjectiveDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateQuestObjectiveDto)
  objective?: UpdateQuestObjectiveDto;

  @ApiPropertyOptional({ description: "奖励（传了就整份替换）", type: UpdateQuestRewardsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateQuestRewardsDto)
  rewards?: UpdateQuestRewardsDto;
}

/** 新建任务入参（id 必填；与 UpdateQuestDto 同形状） */
export class CreateQuestDto extends UpdateQuestDto {
  @ApiProperty({ description: "任务 id（唯一；建议主线 8000 段 / 日常 8100 段）" })
  @IsString({ message: "任务 id 必须是字符串" })
  @MinLength(1, { message: "任务 id 不能为空" })
  @MaxLength(32, { message: "任务 id 不能超过 32 字" })
  declare id: string;
}

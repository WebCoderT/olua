import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { AchievementRow } from "../../../database/rows";
import { parseRewardItems } from "../../../common/utils/reward-items.util";

/** 条件类型枚举（**唯一来源**：DTO 校验、seed 校验、客户端面板都照它） */
export const ACHIEVEMENT_CONDITION_TYPES = ["kill", "quest", "level", "combat", "collect"] as const;

/** 分类枚举 */
export const ACHIEVEMENT_CATEGORIES = ["battle", "growth", "explore"] as const;

/** 管理端看到的一条成就条件 */
export class AchievementConditionDto {
  @ApiProperty({
    description:
      "类型：kill 累计击杀 / quest 累计交付任务（累计型，进度落库）；" +
      "level 等级 / combat 战力 / collect 持有物品（状态型，查询现算）",
    enum: ACHIEVEMENT_CONDITION_TYPES,
  })
  type: string;

  @ApiProperty({ description: "目标：kill = 怪物 key（\"*\" 任意）/ collect = 物品 id / 其余空串" })
  target: string;

  @ApiProperty({ description: "门槛值（累计型 = 需要多少次，状态型 = 需要到多少）" })
  count: number;

  static from(row: AchievementRow): AchievementConditionDto {
    const dto = new AchievementConditionDto();
    dto.type = row.condition_type;
    dto.target = row.condition_target;
    dto.count = row.condition_count;
    return dto;
  }
}

/** 一条成就奖励物品 */
export class AchievementRewardItemDto {
  @ApiProperty({ description: "物品 id" })
  goodId: string;

  @ApiProperty({ description: "数量" })
  count: number;
}

/** 成就奖励 */
export class AchievementRewardsDto {
  @ApiProperty({ description: "金币" })
  gold: number;

  @ApiProperty({ description: "经验" })
  exp: number;

  @ApiProperty({ description: "物品清单", type: [AchievementRewardItemDto] })
  items: AchievementRewardItemDto[];

  static from(row: AchievementRow): AchievementRewardsDto {
    const dto = new AchievementRewardsDto();
    dto.gold = row.reward_gold;
    dto.exp = row.reward_exp;
    // 奖励 JSON 列的解析复用任务的实现：同一个列格式只该有一个解析器
    dto.items = parseRewardItems(row.reward_items);
    return dto;
  }
}

/** 管理端看到的一条成就配置 */
export class AchievementDto {
  @ApiProperty({ description: "成就 id（语义串，如 ach_kill_10）" })
  id: string;

  @ApiProperty({ description: "分类：battle 战斗 / growth 成长 / explore 探索", enum: ACHIEVEMENT_CATEGORIES })
  category: string;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "条件", type: AchievementConditionDto })
  condition: AchievementConditionDto;

  @ApiProperty({ description: "奖励", type: AchievementRewardsDto })
  rewards: AchievementRewardsDto;

  @ApiProperty({ description: "分类内展示顺序（小的在前）" })
  sortOrder: number;

  @ApiProperty({ description: "未达成时是否默认折叠（不剧透条件）" })
  hidden: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  /** 该成就已有多少角色记录（删除守卫要显示；列表接口不填，详情/编辑时按需带） */
  @ApiPropertyOptional({ description: "已有多少角色拥有这条成就的记录（仅行内统计用，列表不填）" })
  recordCount?: number;

  static from(row: AchievementRow, recordCount?: number): AchievementDto {
    const dto = new AchievementDto();
    dto.id = row.id;
    dto.category = row.category;
    dto.label = row.label;
    dto.description = row.description;
    dto.condition = AchievementConditionDto.from(row);
    dto.rewards = AchievementRewardsDto.from(row);
    dto.sortOrder = row.sort_order;
    dto.hidden = row.hidden === 1;
    dto.updatedAt = row.updated_at;
    if (recordCount !== undefined) dto.recordCount = recordCount;
    return dto;
  }
}

/** 成就列表查询入参 */
export class AchievementQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "分类筛选：battle | growth | explore" })
  @IsOptional()
  @IsIn(ACHIEVEMENT_CATEGORIES as unknown as string[], { message: "分类只能是 battle / growth / explore" })
  declare category?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 成就分页结果 */
export class AchievementPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的成就配置", type: [AchievementDto] })
  list: AchievementDto[];
}

/** 条件编辑入参 */
export class UpdateAchievementConditionDto {
  @ApiPropertyOptional({ description: "条件类型", enum: ACHIEVEMENT_CONDITION_TYPES })
  @IsOptional()
  @IsIn(ACHIEVEMENT_CONDITION_TYPES as unknown as string[], {
    message: "条件类型只能是 kill / quest / level / combat / collect",
  })
  type?: string;

  @ApiPropertyOptional({ description: "目标（kill = 怪物 key 或 \"*\"；collect = 物品 id；其余留空）" })
  @IsOptional()
  @IsString({ message: "目标必须是字符串" })
  @MaxLength(64, { message: "目标不能超过 64 字" })
  target?: string;

  @ApiPropertyOptional({ description: "门槛值（1~999999）" })
  @IsOptional()
  @IsInt({ message: "门槛值必须是整数" })
  @Min(1, { message: "门槛值至少 1" })
  @Max(999999, { message: "门槛值不能超过 999999" })
  count?: number;
}

/** 奖励编辑入参 */
export class UpdateAchievementRewardsDto {
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

  @ApiPropertyOptional({ description: "物品清单（≤20 条）", type: [AchievementRewardItemDto] })
  @IsOptional()
  @IsArray({ message: "物品清单必须是数组" })
  @ArrayMaxSize(20, { message: "物品清单不能超过 20 条" })
  @ValidateNested({ each: true })
  @Type(() => AchievementRewardItemDto)
  items?: AchievementRewardItemDto[];
}

/**
 * 编辑成就配置入参（**部分更新**）
 *
 * `condition` / `rewards` 逐字段合并（`items` 传了就整份替换）—— 与任务配置同一取向：
 * 只改金币时不至于把物品清单静默清空。
 */
export class UpdateAchievementDto {
  @ApiPropertyOptional({ description: "分类", enum: ACHIEVEMENT_CATEGORIES })
  @IsOptional()
  @IsIn(ACHIEVEMENT_CATEGORIES as unknown as string[], { message: "分类只能是 battle / growth / explore" })
  category?: string;

  @ApiPropertyOptional({ description: "名称（1~50 字）" })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "描述（≤200 字）" })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(200, { message: "描述不能超过 200 字" })
  description?: string;

  @ApiPropertyOptional({ description: "条件（逐字段合并）", type: UpdateAchievementConditionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAchievementConditionDto)
  condition?: UpdateAchievementConditionDto;

  @ApiPropertyOptional({ description: "奖励（逐字段合并）", type: UpdateAchievementRewardsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAchievementRewardsDto)
  rewards?: UpdateAchievementRewardsDto;

  @ApiPropertyOptional({ description: "分类内展示顺序（0~9999）" })
  @IsOptional()
  @IsInt({ message: "顺序必须是整数" })
  @Min(0, { message: "顺序不能为负" })
  @Max(9999, { message: "顺序不能超过 9999" })
  sortOrder?: number;

  @ApiPropertyOptional({ description: "未达成时是否默认折叠" })
  @IsOptional()
  @IsBoolean({ message: "hidden 必须是布尔值" })
  hidden?: boolean;
}

/** 新建成就入参（id 必填；与 UpdateAchievementDto 同形状） */
export class CreateAchievementDto extends UpdateAchievementDto {
  @ApiProperty({ description: "成就 id（唯一；语义串，如 ach_kill_10）" })
  @IsString({ message: "成就 id 必须是字符串" })
  @MinLength(1, { message: "成就 id 不能为空" })
  @MaxLength(64, { message: "成就 id 不能超过 64 字" })
  declare id: string;
}

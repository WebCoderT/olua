import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { AchievementRow } from "../../../database/rows";

/** 客户端看到的一条成就（配置 + 我的状态，一次给全） */
export class AchievementViewDto {
  @ApiProperty({ description: "成就 id" })
  id: string;

  @ApiProperty({ description: "分类：battle 战斗 / growth 成长 / explore 探索（面板页签）", enum: ["battle", "growth", "explore"] })
  category: string;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述（达成条件的人话说明）" })
  description: string;

  @ApiProperty({
    description: "条件类型：kill 累计击杀 / quest 累计交付任务（这两类是累计型，进度落库）；level 等级 / combat 战力 / collect 持有物品（这三类是状态型，每次查询现算）",
    enum: ["kill", "quest", "level", "combat", "collect"],
  })
  conditionType: string;

  @ApiProperty({ description: "条件目标：kill = 怪物 key（\"*\" 任意）/ collect = 物品 id / 其余空串" })
  conditionTarget: string;

  @ApiProperty({ description: "当前进度（已按门槛钳制，不会超过 target）" })
  progress: number;

  @ApiProperty({ description: "门槛值（来自成就配置，客户端免查快照比对）" })
  target: number;

  @ApiProperty({ description: "是否已达成" })
  achieved: boolean;

  @ApiProperty({ description: "是否已领奖（已领 = 不可再领）" })
  claimed: boolean;

  @ApiProperty({ description: "未达成时是否默认折叠（不剧透条件）" })
  hidden: boolean;

  @ApiProperty({ description: "分类内展示顺序（小的在前）" })
  sortOrder: number;

  static of(row: AchievementRow, progress: number, target: number, achieved: boolean, claimed: boolean): AchievementViewDto {
    const dto = new AchievementViewDto();
    dto.id = row.id;
    dto.category = row.category;
    dto.label = row.label;
    dto.description = row.description;
    dto.conditionType = row.condition_type;
    dto.conditionTarget = row.condition_target;
    dto.progress = progress;
    dto.target = target;
    dto.achieved = achieved;
    dto.claimed = claimed;
    dto.hidden = row.hidden === 1;
    dto.sortOrder = row.sort_order;
    return dto;
  }
}

/** 我的成就统计（面板顶部的「已达成 12 / 30」） */
export class AchievementSummaryDto {
  @ApiProperty({ description: "成就总数（配置行数）" })
  total: number;

  @ApiProperty({ description: "已达成数" })
  achieved: number;

  @ApiProperty({ description: "已领奖数" })
  claimed: number;
}

/** 我的成就快照（GET /achievements/me 与领取的统一返回） */
export class MyAchievementsDto {
  @ApiProperty({ description: "全部成就（含未达成；客户端按分类自己分组）", type: [AchievementViewDto] })
  achievements: AchievementViewDto[];

  @ApiProperty({ description: "统计", type: AchievementSummaryDto })
  summary: AchievementSummaryDto;
}

/** 领奖结果 */
export class AchievementClaimResultDto {
  @ApiProperty({ description: "领取后的成就快照", type: [AchievementViewDto] })
  achievements: AchievementViewDto[];

  @ApiProperty({ description: "统计", type: AchievementSummaryDto })
  summary: AchievementSummaryDto;

  @ApiProperty({ description: "本次发放的金币" })
  gold: number;

  @ApiProperty({ description: "本次发放的经验" })
  exp: number;

  @ApiProperty({ description: "本次发放的物品", type: [Object] })
  items: Array<{ goodId: string; count: number }>;

  @ApiProperty({ description: "发奖后等级" })
  level: number;

  @ApiProperty({ description: "是否升级" })
  leveledUp: boolean;
}

/** 领奖入参 */
export class AchievementIdDto {
  @ApiProperty({ description: "成就 id（如 \"ach_kill_10\"）" })
  @IsString({ message: "成就 id 必须是字符串" })
  @MinLength(1, { message: "成就 id 不能为空" })
  @MaxLength(64, { message: "成就 id 不能超过 64 字" })
  achievementId!: string;
}

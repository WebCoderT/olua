import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/** 客户端看到的一条任务进度（服务端权威） */
export class QuestStateDto {
  @ApiProperty({ description: "任务 id" })
  questId: string;

  @ApiProperty({
    description: "状态：available 可接（无进度行）/ accepted 进行中 / ready 可交付 / claimed 已领奖",
    enum: ["available", "accepted", "ready", "claimed"],
  })
  status: "available" | "accepted" | "ready" | "claimed";

  @ApiProperty({ description: "当前进度（kill/talk 为累计次数；collect 为背包持有量与目标取小）" })
  progress: number;

  @ApiProperty({ description: "目标数量（来自任务配置，客户端免查快照比对）" })
  target: number;

  static from(questId: string, status: string, progress: number, target: number): QuestStateDto {
    const dto = new QuestStateDto();
    dto.questId = questId;
    dto.status = status as QuestStateDto["status"];
    dto.progress = progress;
    dto.target = target;
    return dto;
  }
}

/** 我的任务快照（GET /quests/me 与写操作的统一返回） */
export class MyQuestsDto {
  @ApiProperty({ description: "全部进度行（可接的任务不在内 —— 可接态由客户端按快照配置与 claimed 行计算）", type: [QuestStateDto] })
  quests: QuestStateDto[];
}

/** 交付结果（进度快照 + 奖励结算） */
export class QuestRewardResultDto {
  @ApiProperty({ description: "金币" })
  gold: number;

  @ApiProperty({ description: "经验" })
  exp: number;

  @ApiProperty({ description: "物品清单", type: [Object] })
  items: Array<{ goodId: string; count: number }>;

  @ApiProperty({ description: "发奖后等级" })
  level: number;

  @ApiProperty({ description: "是否升级" })
  leveledUp: boolean;
}

export class QuestSubmitResultDto {
  @ApiProperty({ description: "交付后的任务快照", type: [QuestStateDto] })
  quests: QuestStateDto[];

  @ApiProperty({ description: "本次奖励结算", type: QuestRewardResultDto })
  reward: QuestRewardResultDto;
}

/** NPC 对话结果 */
export class NpcTalkResultDto {
  @ApiProperty({ description: "对话文案（管理端 npcs 表的 dialog 列，空串 = 未配置）" })
  dialog: string;

  @ApiProperty({ description: "该 NPC 名下全部任务在当前角色上的状态（含可接但未接的）", type: [QuestStateDto] })
  quests: QuestStateDto[];
}

/** 接取 / 交付入参 */
export class QuestIdDto {
  @ApiProperty({ description: "任务 id" })
  @IsString({ message: "任务 id 必须是字符串" })
  @MinLength(1, { message: "任务 id 不能为空" })
  @MaxLength(32, { message: "任务 id 不能超过 32 字" })
  questId!: string;
}

/** NPC 对话入参 */
export class NpcTalkDto {
  @ApiProperty({ description: "NPC id" })
  @IsString({ message: "NPC id 必须是字符串" })
  @MinLength(1, { message: "NPC id 不能为空" })
  @MaxLength(32, { message: "NPC id 不能超过 32 字" })
  npcId!: string;

  /** 预留：对话选项（v1 无分支对话，不校验） */
  @ApiPropertyOptional({ description: "预留字段（v1 无对话分支）" })
  @IsOptional()
  @IsString({ message: "option 必须是字符串" })
  option?: string;
}

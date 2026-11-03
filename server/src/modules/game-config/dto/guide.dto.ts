import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { GUIDE_EVENTS, GUIDE_SPOTS, GUIDE_STEP_MAX } from "../../../shared/guide-seed";

/**
 * 新手引导步骤（#605）
 *
 * 一张**有序的小表**（出厂 6 步、上限 64 步），整份提交 / 整份读回：
 * 运营编辑的是「顺序 + 文案 + 高亮位 + 推进事件」，逐行增删接口反而让前端要做更多合并逻辑。
 *
 * `spot` / `trigger` 用 `@IsIn` 收在**客户端能力白名单**里（枚举本身在客户端代码里，
 * 新增一个高亮位 / 事件本来就要改客户端）—— 配了白名单外的值，客户端会跳过那一步，
 * 与其等到玩家进游戏才静默跳过，不如在保存时就 400 拒掉。
 */

/** 一步 */
export class GuideStepDto {
  @ApiProperty({ description: "步骤标识（日志与单测用；同一份配置里唯一，不落存档）", example: "move" })
  @IsString()
  @Matches(/^[a-z][a-zA-Z0-9]{0,31}$/, { message: "步骤标识需以小写字母开头、只含字母数字、最长 32 字符" })
  id: string;

  @ApiProperty({ description: "气泡标题", example: "先动起来" })
  @IsString()
  @Length(1, 20)
  title: string;

  @ApiProperty({ description: "气泡正文（一句话说清「做什么」）", example: "拖住左下角的摇杆走两步；电脑上也可以按住方向键或点地面。" })
  @IsString()
  @Length(1, 200)
  desc: string;

  @ApiProperty({
    description: `高亮语义位：${GUIDE_SPOTS.join(" / ")}（客户端按它现取节点，取不到就只显示气泡）`,
    enum: GUIDE_SPOTS,
    example: "joystick",
  })
  @IsIn(GUIDE_SPOTS as unknown as string[])
  spot: string;

  @ApiProperty({
    description: `推进事件：${GUIDE_EVENTS.join(" / ")}（当前步收到它才前进，别的事件不越级）`,
    enum: GUIDE_EVENTS,
    example: "move",
  })
  @IsIn(GUIDE_EVENTS as unknown as string[])
  trigger: string;
}

/** 整份步骤表（GET / PATCH 的响应） */
export class GuideStepsDto {
  @ApiProperty({ description: "步骤表（数组顺序 = 体验顺序）", type: [GuideStepDto] })
  @ValidateNested({ each: true })
  @Type(() => GuideStepDto)
  steps: GuideStepDto[];

  @ApiProperty({ description: "最后修改时间（毫秒，0 = 从未改过、仍是出厂值）", example: 1762000000000 })
  updatedAt: number;
}

/** 整份提交（先校验后写：任何一步不合法都不落库） */
export class UpdateGuideStepsDto {
  @ApiProperty({ description: "步骤表（整份替换，顺序即体验顺序）", type: [GuideStepDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GUIDE_STEP_MAX)
  @ValidateNested({ each: true })
  @Type(() => GuideStepDto)
  steps: GuideStepDto[];

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}

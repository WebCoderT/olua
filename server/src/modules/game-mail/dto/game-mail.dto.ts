import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { RoleMailRow } from "../../../database/rows";
import { parseRewardItems } from "../../../common/utils/reward-items.util";

/** 邮件里的一件附件（口径与任务 / 成就的奖励物品完全一致） */
export class MailAttachmentDto {
  @ApiProperty({ description: "物品 id（客户端拿共享快照换名字与图标）" })
  @IsString()
  goodId: string;

  @ApiProperty({ description: "数量" })
  @IsInt()
  @Min(1)
  @Max(9999)
  count: number;
}

/**
 * 管理端补发入参（#437）
 *
 * `channel` 收窄成两个值（system / reward）：social / combat 是系统自动产生的事实记录，
 * 人工往里发一条「运营补偿」，玩家翻战报时就得先分辨这是不是真的战斗记录。
 * 收窄在 DTO 的 `@IsIn`（400）与服务端 sendFromAdmin（兜底）各拦一道 ——
 * DTO 管形状，业务管语义，两层缺一不可。
 */
export class AdminSendMailDto {
  @ApiProperty({ description: "频道：只允许 system（系统）/ reward（奖励）", enum: ["system", "reward"] })
  @IsIn(["system", "reward"], { message: "人工补发只允许 system / reward 频道（social / combat 是系统事实记录）" })
  channel: string;

  @ApiProperty({ description: "标题", minLength: 1, maxLength: 60 })
  @IsString()
  @MaxLength(60)
  title: string;

  @ApiProperty({ description: "正文（纯文本，换行用 \\n；可空）", required: false, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;

  @ApiProperty({ description: "附件金币（不传 = 没有）", required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99_999_999)
  gold?: number;

  @ApiProperty({ description: "附件经验（不传 = 没有）", required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99_999_999)
  exp?: number;

  @ApiProperty({ description: "附件物品（不传 = 没有）", required: false, type: [MailAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MailAttachmentDto)
  items?: MailAttachmentDto[];
}

/**
 * 收件箱里的一封邮件
 *
 * `gold` / `exp` / `attachments` 是**还没到手**的那份奖励：`claimed` 为 false 时它们
 * 只是「预告」，点领取之后才真的进角色存档。`read` 与 `claimed` 是两件事 ——
 * 看过不等于领过（`#401` 成就那刀同一条口径：看和拿分开）。
 */
export class MailViewDto {
  @ApiProperty({ description: "邮件 id" })
  id: string;

  @ApiProperty({ description: "频道：system 系统 / reward 奖励 / social 社交 / combat 战斗" })
  channel: string;

  @ApiProperty({ description: "来源标签（比频道更细）：system / achievement / friend / boss …" })
  kind: string;

  @ApiProperty({ description: "标题" })
  title: string;

  @ApiProperty({ description: "正文（纯文本，换行用 \\n）" })
  body: string;

  @ApiProperty({ description: "附件金币（0 = 没有）" })
  gold: number;

  @ApiProperty({ description: "附件经验（0 = 没有）" })
  exp: number;

  @ApiProperty({ description: "附件物品", type: [MailAttachmentDto] })
  attachments: MailAttachmentDto[];

  @ApiProperty({ description: "是否已读" })
  read: boolean;

  @ApiProperty({ description: "附件是否已领（已领 = 不可再领，且可以删）" })
  claimed: boolean;

  @ApiProperty({ description: "收到时间（毫秒时间戳）" })
  createdAt: number;

  static of(row: RoleMailRow): MailViewDto {
    const dto = new MailViewDto();
    dto.id = row.id;
    dto.channel = row.channel;
    dto.kind = row.kind;
    dto.title = row.title;
    dto.body = row.body;
    dto.gold = row.gold;
    dto.exp = row.exp;
    dto.attachments = parseRewardItems(row.attachments);
    dto.read = row.read_at !== null;
    dto.claimed = row.claimed_at !== null;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/**
 * 一个频道的角标
 *
 * 三个数字分开给：`unread` 是「有没有新的」（点开就减），`unclaimed` 是「有没有要处理的」
 * （领了才减），`total` 是这一栏一共几封。客户端拿它画面板上的页签角标 ——
 * 服务端**永远按全量算**这几个数（哪怕客户端当前只看某一栏），否则切到别的页签就看不到
 * 「那一栏有几条没看」了。
 */
export class MailChannelSummaryDto {
  @ApiProperty({ description: "频道：system / reward / social / combat" })
  channel: string;

  @ApiProperty({ description: "未读数" })
  unread: number;

  @ApiProperty({ description: "未领附件数" })
  unclaimed: number;

  @ApiProperty({ description: "总封数" })
  total: number;
}

/** 收件箱快照（查 / 已读 / 删除都返回这一份） */
export class MailBoxDto {
  @ApiProperty({ description: "全部邮件（新的在前，含所有频道；频道筛选在客户端做）", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数（入口红点用）" })
  unread: number;

  @ApiProperty({ description: "未领封数（「一键领取」按钮用）" })
  unclaimed: number;

  @ApiProperty({ description: "每个频道的角标（固定四条，没有邮件的频道也会出现）", type: [MailChannelSummaryDto] })
  channels: MailChannelSummaryDto[];
}

/** 单封领取结果 */
export class MailClaimResultDto {
  @ApiProperty({ description: "领取后的收件箱", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数" })
  unread: number;

  @ApiProperty({ description: "未领封数" })
  unclaimed: number;

  @ApiProperty({ description: "每个频道的角标", type: [MailChannelSummaryDto] })
  channels: MailChannelSummaryDto[];

  @ApiProperty({ description: "本次到手的金币" })
  gold: number;

  @ApiProperty({ description: "本次到手的经验" })
  exp: number;

  @ApiProperty({ description: "本次到手的物品", type: [MailAttachmentDto] })
  items: MailAttachmentDto[];

  @ApiProperty({ description: "领取后的等级（经验可能触发升级）" })
  level: number;

  @ApiProperty({ description: "本次是否升级了" })
  leveledUp: boolean;
}

/**
 * 一键领取里「没领到」的一封（#870）
 *
 * 失败**不影响其他封**：`claimAll` 逐封独立事务，一封失败只记一条，继续领下一封。
 * `code` 是业务码（`MALL_BAG_FULL` 20012 / `MAIL_ALREADY_CLAIMED` 50142 /
 * `ROLE_REVISION_CONFLICT` 20006 …），0 = 非业务异常（原因只在服务端日志里）。
 * `reason` 可以直接展示 —— 它来自 `BizException.message`，那个类约定写人话。
 */
export class MailClaimFailureDto {
  @ApiProperty({ description: "没领到的那封邮件 id" })
  mailId: string;

  @ApiProperty({ description: "失败原因的业务码（0 = 未知异常，详见服务端日志）" })
  code: number;

  @ApiProperty({ description: "失败原因（可直接展示给玩家）" })
  reason: string;
}

/**
 * 一键领取结果
 *
 * `stoppedByBag` 与 `failures[]` 是两个粒度：前者回答「有没有被背包挡住」，
 * 后者回答「具体哪几封、为什么」。**背包满不是整单失败** —— 需要放物品的那几封
 * 留在箱里，纯金币 / 纯经验的照样到手（#870）。
 */
export class MailClaimAllResultDto {
  @ApiProperty({ description: "领取后的收件箱", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数" })
  unread: number;

  @ApiProperty({ description: "未领封数" })
  unclaimed: number;

  @ApiProperty({ description: "每个频道的角标", type: [MailChannelSummaryDto] })
  channels: MailChannelSummaryDto[];

  @ApiProperty({ description: "本次成功领取的封数" })
  claimedCount: number;

  @ApiProperty({ description: "本次到手的金币合计" })
  gold: number;

  @ApiProperty({ description: "本次到手的经验合计" })
  exp: number;

  @ApiProperty({ description: "本次到手的物品合计（同 id 已合并）", type: [MailAttachmentDto] })
  items: MailAttachmentDto[];

  @ApiProperty({ description: "领取后的等级" })
  level: number;

  @ApiProperty({ description: "本次是否升级了" })
  leveledUp: boolean;

  @ApiProperty({ description: "是否至少有一封因背包满没领到（true = 清出格子后还能再领）" })
  stoppedByBag: boolean;

  @ApiProperty({ description: "没领到的封数（= failures.length）" })
  failedCount: number;

  @ApiProperty({ description: "没领到的明细（一封失败不影响其他封）", type: [MailClaimFailureDto] })
  failures: MailClaimFailureDto[];
}

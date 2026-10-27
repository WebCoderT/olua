import { ApiProperty } from "@nestjs/swagger";
import { RoleMailRow } from "../../../database/rows";
import { parseRewardItems } from "../../../common/utils/reward-items.util";

/** 邮件里的一件附件（口径与任务 / 成就的奖励物品完全一致） */
export class MailAttachmentDto {
  @ApiProperty({ description: "物品 id（客户端拿共享快照换名字与图标）" })
  goodId: string;

  @ApiProperty({ description: "数量" })
  count: number;
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

  @ApiProperty({ description: "来源：system 系统 / achievement 成就奖励兜底 / reward 其他奖励" })
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

/** 收件箱快照（查 / 已读 / 删除都返回这一份） */
export class MailBoxDto {
  @ApiProperty({ description: "全部邮件（新的在前）", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数（入口红点用）" })
  unread: number;

  @ApiProperty({ description: "未领封数（「一键领取」按钮用）" })
  unclaimed: number;
}

/** 单封领取结果 */
export class MailClaimResultDto {
  @ApiProperty({ description: "领取后的收件箱", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数" })
  unread: number;

  @ApiProperty({ description: "未领封数" })
  unclaimed: number;

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
 * 一键领取结果
 *
 * `stoppedByBag` 是关键字段：背包满时**不是整单失败**，而是「领到满为止」——
 * 已经领到的照常落库，客户端据此提示「背包满了，剩下的领不了」。
 */
export class MailClaimAllResultDto {
  @ApiProperty({ description: "领取后的收件箱", type: [MailViewDto] })
  mails: MailViewDto[];

  @ApiProperty({ description: "未读封数" })
  unread: number;

  @ApiProperty({ description: "未领封数" })
  unclaimed: number;

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

  @ApiProperty({ description: "是否因为背包满而提前停下（true = 还有没领的）" })
  stoppedByBag: boolean;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { MailBroadcastRow } from "../../../database/rows";
import { parseRewardItems } from "../../../common/utils/reward-items.util";
import { AdminSendMailDto, MailAttachmentDto } from "./game-mail.dto";

/**
 * 群发范围（#438）
 *
 * - `zone`：**当前区**（管理端 `X-Zone-Id` 指的那个）—— 管理员默认能做的事；
 * - `all` ：所有未合并的区 —— 需要 `gameMail:broadcast-all`（只给超管）。
 *
 * 等级段不是第三个范围，而是**叠加在两个范围上的筛子**：`zone` + 等级段、
 * `all` + 等级段都成立。做成「三选一」的话「全区只发 30 级以上」这种最常见的运营需求
 * （老玩家补偿）就表达不出来了。
 */
export const BROADCAST_SCOPES = ["zone", "all"] as const;
export type BroadcastScope = (typeof BROADCAST_SCOPES)[number];

/**
 * 批次里记下的投放条件快照（存 JSON，不存外键：区会被合并、等级口径会变，历史要能自解释）
 *
 * 写成**类**而不是 interface：它是响应体的一部分（`BroadcastViewDto.filter`），
 * 只有带 `@ApiProperty` 的类才会被 Swagger 展开成具体形状 —— 用 interface 生成出来是 `unknown`，
 * 管理端拿不到字段类型（第一版就是，tsc 当场报 `'row.filter' is of type 'unknown'`）。
 */
export class BroadcastFilterDto {
  @ApiProperty({ description: "投放范围：zone = 当时那个区 / all = 当时所有未合并的区", enum: BROADCAST_SCOPES })
  scope: BroadcastScope;

  @ApiProperty({ description: "scope = zone 时的区 id；all 时为 null", type: "number", nullable: true })
  zoneId: number | null;

  @ApiProperty({ description: "最低等级（含；不填 = 不限）", required: false })
  minLevel?: number;

  @ApiProperty({ description: "最高等级（含；不填 = 不限）", required: false })
  maxLevel?: number;
}

/** 群发的正文与附件：与单发**同一个 DTO**（校验、频道收窄、长度上限都不许分叉） */
export class AdminBroadcastMailDto extends AdminSendMailDto {
  @ApiProperty({
    description: "批次号：由管理端生成（浏览器 `crypto.randomUUID()`），**重试时原样复用** —— 同一个批次号只发一次",
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: "批次号只能是 8~64 位字母 / 数字 / - / _" })
  batchId: string;

  @ApiProperty({
    description: "投递范围：zone = 当前区 / all = 全服（所有未合并的区，需要超级管理员权限）",
    enum: BROADCAST_SCOPES,
  })
  @IsIn(BROADCAST_SCOPES as unknown as string[], { message: "投递范围只能是 zone（当前区）或 all（全服）" })
  scope: string;

  @ApiProperty({ description: "最低等级（含；不传 = 不限）", required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  minLevel?: number;

  @ApiProperty({ description: "最高等级（含；不传 = 不限）", required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  maxLevel?: number;
}

/**
 * 影响面预估（发送前那一下「预计影响 N 人」）
 *
 * 独立成一个入参类而不是复用 `AdminBroadcastMailDto` 的必填项：预估**不需要**正文与附件，
 * 让运营在写完 300 字公告前就能先看人数。
 */
export class BroadcastPreviewDto {
  @ApiProperty({
    description: "投递范围：zone = 当前区 / all = 全服（预览全服同样需要超级管理员权限）",
    enum: BROADCAST_SCOPES,
  })
  @IsIn(BROADCAST_SCOPES as unknown as string[], { message: "投递范围只能是 zone（当前区）或 all（全服）" })
  scope: string;

  @ApiProperty({ description: "最低等级（含；不传 = 不限）", required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  minLevel?: number;

  @ApiProperty({ description: "最高等级（含；不传 = 不限）", required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  maxLevel?: number;
}

/** 影响面预估结果 */
export class BroadcastPreviewResultDto {
  @ApiProperty({ description: "命中的角色数（= 每个人各收到一封）" })
  targetCount: number;

  @ApiProperty({ description: "本次覆盖的区 id（scope = zone 时只有一个；all 时是全部未合并的区）", type: [Number] })
  zoneIds: number[];
}

/**
 * 一个群发批次（管理端列表与「发送结果」共用）
 *
 * `targetCount` 与 `sentCount` 不等是**正常的**：发送过程中有人建号 / 删号。
 * 真正要警惕的是 `finishedAt` 为空 —— 那是批次写到一半进程挂了，行已经发出去了，
 * 但服务端不知道停在哪；此时按批次号重提会返回 `duplicated: true`（不会补发，也不会重复发）。
 */
export class BroadcastViewDto {
  @ApiProperty({ description: "批次号" })
  batchId: string;

  @ApiProperty({ description: "频道：system / reward" })
  channel: string;

  @ApiProperty({ description: "标题" })
  title: string;

  @ApiProperty({ description: "正文" })
  body: string;

  @ApiProperty({ description: "附件绑定元宝（0 = 没有）" })
  bindGold: number;

  @ApiProperty({ description: "附件经验（0 = 没有）" })
  exp: number;

  @ApiProperty({ description: "附件物品", type: [MailAttachmentDto] })
  attachments: MailAttachmentDto[];

  @ApiProperty({ description: "投放条件快照（scope / zoneId / minLevel / maxLevel）", type: () => BroadcastFilterDto })
  filter: BroadcastFilterDto;

  @ApiProperty({ description: "发送前算出的目标人数" })
  targetCount: number;

  @ApiProperty({ description: "实际写入的封数" })
  sentCount: number;

  @ApiProperty({ description: "操作人 id" })
  operatorId: string;

  @ApiProperty({ description: "操作人用户名" })
  operatorName: string;

  @ApiProperty({ description: "发起时刻（毫秒时间戳）" })
  createdAt: number;

  @ApiProperty({ description: "完成时刻（null = 还在写 / 中途中断）", type: "number", nullable: true })
  finishedAt: number | null;

  @ApiProperty({ description: "true = 这个批次号之前已经发过，本次没有再写任何一行" })
  @IsBoolean()
  duplicated: boolean;

  static of(row: MailBroadcastRow, duplicated = false): BroadcastViewDto {
    const dto = new BroadcastViewDto();
    dto.batchId = row.id;
    dto.channel = row.channel;
    dto.title = row.title;
    dto.body = row.body;
    dto.bindGold = row.bind_gold;
    dto.exp = row.exp;
    dto.attachments = parseRewardItems(row.attachments);
    dto.filter = parseFilterSnapshot(row.filter);
    dto.targetCount = row.target_count;
    dto.sentCount = row.sent_count;
    dto.operatorId = row.operator_id;
    dto.operatorName = row.operator_name;
    dto.createdAt = row.created_at;
    dto.finishedAt = row.finished_at;
    dto.duplicated = duplicated;
    return dto;
  }
}

/**
 * 从库里那列 JSON 还原条件快照
 *
 * 解析失败**不抛**：一条脏的历史批次不该让整个列表页 500。返回 `scope: "zone"` +
 * 全空条件，界面上显示成「条件未知」也比报错强（这批到底发给了谁还能从 `role_mails.batch_id` 数）。
 */
export function parseFilterSnapshot(raw: string): BroadcastFilterDto {
  try {
    const parsed = JSON.parse(raw) as Partial<BroadcastFilterDto>;
    return {
      scope: parsed.scope === "all" ? "all" : "zone",
      zoneId: typeof parsed.zoneId === "number" ? parsed.zoneId : null,
      minLevel: typeof parsed.minLevel === "number" ? parsed.minLevel : undefined,
      maxLevel: typeof parsed.maxLevel === "number" ? parsed.maxLevel : undefined,
    };
  } catch {
    return { scope: "zone", zoneId: null };
  }
}

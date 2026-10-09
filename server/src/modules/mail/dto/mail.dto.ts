import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import {
  MAIL_BODY_MAX,
  MAIL_STATUS_LABELS,
  MAIL_STATUSES,
  MAIL_SUBJECT_MAX,
  MAIL_TO_MAX,
  MailStatusValue,
} from "../../../common/constants/mail";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { MailQueueWithAccountRow } from "../../../database/rows";
import { findMailTemplate, MAIL_TEMPLATE_KEYS } from "../mail-templates";

/**
 * 投递任务（管理端列表与详情）
 *
 * `statusLabel` 由服务端给：状态的中文名只有一份（见 MAIL_STATUS_LABELS），
 * 让界面自己维护一份映射，迟早出现「库里新增一个状态、界面显示英文原始值」。
 */
export class MailJobDto {
  @ApiProperty({ description: "任务 id" })
  id: string;

  @ApiProperty({ description: "收件邮箱" })
  to: string;

  @ApiProperty({ description: "关联的玩家账号 id；null = 未关联账号", type: "string", nullable: true })
  accountId: string | null;

  @ApiProperty({ description: "关联的玩家账号名；账号已被删则为 null", type: "string", nullable: true })
  accountName: string | null;

  @ApiProperty({ description: "模板 key" })
  templateKey: string;

  @ApiProperty({ description: "模板中文名（模板已被删则退回 key）" })
  templateName: string;

  @ApiProperty({ description: "渲染后的标题" })
  subject: string;

  @ApiProperty({ description: "渲染后的正文（重投时发的仍是这份内容，模板改动不影响已入队的任务）" })
  body: string;

  @ApiProperty({ description: "状态", enum: MAIL_STATUSES })
  status: string;

  @ApiProperty({ description: "状态中文名" })
  statusLabel: string;

  @ApiProperty({ description: "已尝试次数（成功的那次也计入）" })
  attempts: number;

  @ApiProperty({
    description: "下一次重试的时刻（毫秒）；待发送与终态为 null",
    type: "number",
    nullable: true,
  })
  nextRetryAt: number | null;

  @ApiProperty({ description: "最近一次失败的原因；成功为 null（界面可直接展示）", type: "string", nullable: true })
  lastError: string | null;

  @ApiProperty({ description: "发起人管理员账号名（管理员被删后仍可追溯）", type: "string", nullable: true })
  createdBy: string | null;

  @ApiProperty({ description: "入队时间（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  @ApiProperty({ description: "投递成功的时刻（毫秒）；未成功为 null", type: "number", nullable: true })
  sentAt: number | null;

  static from(row: MailQueueWithAccountRow): MailJobDto {
    const dto = new MailJobDto();
    dto.id = row.id;
    dto.to = row.to_email;
    dto.accountId = row.account_id;
    dto.accountName = row.account_name;
    dto.templateKey = row.template_key;
    dto.templateName = findMailTemplate(row.template_key)?.name ?? row.template_key;
    dto.subject = row.subject;
    dto.body = row.body;
    dto.status = row.status;
    dto.statusLabel = MAIL_STATUS_LABELS[row.status as MailStatusValue] ?? row.status;
    dto.attempts = row.attempts;
    dto.nextRetryAt = row.next_retry_at;
    dto.lastError = row.last_error;
    dto.createdBy = row.created_by;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    dto.sentAt = row.sent_at;
    return dto;
  }
}

/** 投递任务分页结果 */
export class MailJobPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的投递任务", type: [MailJobDto] })
  list: MailJobDto[];
}

/** 投递记录查询入参 */
export class MailQueryDto extends PageQueryDto {
  /** 关键字：覆写基类那条「含义见各接口说明」的描述（这里是真的会用到的条件） */
  @ApiPropertyOptional({ description: "关键字：模糊匹配收件邮箱 / 标题 / 收件账号名" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "状态筛选", enum: MAIL_STATUSES })
  @IsOptional()
  @IsString({ message: "状态必须是字符串" })
  @IsIn([...MAIL_STATUSES], { message: "状态取值不合法" })
  status?: string;
}

/**
 * 发信入参
 *
 * **入队即返回**，不等投递结果 —— 投递由后台调度器完成，结果在投递记录里查。
 * 这样 SMTP 服务器不可达时，运营点下「发送」不会卡到网关超时。
 */
export class SendMailDto {
  @ApiProperty({ description: "收件邮箱", maxLength: MAIL_TO_MAX, example: "player@example.com" })
  @IsString({ message: "收件邮箱必须是字符串" })
  @IsEmail({}, { message: "收件邮箱格式不正确" })
  @MaxLength(MAIL_TO_MAX, { message: `收件邮箱最长 ${MAIL_TO_MAX} 个字符` })
  to: string;

  @ApiProperty({ description: "模板 key（custom = 自定义，此时必须传 subject 与 body）", enum: MAIL_TEMPLATE_KEYS })
  @IsString({ message: "模板必须是字符串" })
  @IsIn([...MAIL_TEMPLATE_KEYS], { message: "模板取值不合法" })
  templateKey: string;

  /**
   * 关联的玩家账号（可选）
   *
   * 只为「这封信是发给谁的」留一条可追溯的线（投递记录里显示账号名、审计里记目标），
   * **不是投递凭据** —— 不传也照样发，传了不存在的账号 id 会报 50004。
   */
  @ApiPropertyOptional({ description: "关联的玩家账号 id（可选，仅用于追溯）" })
  @IsOptional()
  @IsString({ message: "账号 id 必须是字符串" })
  accountId?: string;

  /**
   * 模板变量（模板 key 为 custom 时不需要）
   *
   * 是**动态键值**而不是固定字段的 DTO：变量名由模板声明（`MAIL_TEMPLATES`），
   * 加一个模板不该要求改一次接口。代价是校验只能到「是个对象、值是字符串」这一层，
   * 必填变量是否给全是**业务层**的事（`missingVariables`）。
   */
  @ApiPropertyOptional({
    description: "模板变量（键是模板声明的变量名，如 username / reason）；缺必填变量会直接拒发",
    example: { username: "张三" },
    // 不写 `additionalProperties` 的话，文档里只剩一个裸 `object`，两端生成物会退化成 `unknown`
    type: "object",
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject({ message: "模板变量必须是对象" })
  variables?: Record<string, string>;

  @ApiPropertyOptional({ description: "自定义标题（**仅 custom 模板必填**）", maxLength: MAIL_SUBJECT_MAX })
  @IsOptional()
  @IsString({ message: "标题必须是字符串" })
  @MaxLength(MAIL_SUBJECT_MAX, { message: `标题最长 ${MAIL_SUBJECT_MAX} 个字` })
  subject?: string;

  @ApiPropertyOptional({ description: "自定义正文（**仅 custom 模板必填**，纯文本）", maxLength: MAIL_BODY_MAX })
  @IsOptional()
  @IsString({ message: "正文必须是字符串" })
  @MaxLength(MAIL_BODY_MAX, { message: `正文最长 ${MAIL_BODY_MAX} 个字` })
  body?: string;
}

/** 邮件模板（管理端下拉框与说明用） */
export class MailTemplateDto {
  @ApiProperty({ description: "模板 key" })
  key: string;

  @ApiProperty({ description: "模板中文名" })
  name: string;

  @ApiProperty({ description: "用途说明（界面提示运营这封信该填什么）" })
  hint: string;

  @ApiProperty({ description: "必填变量名；缺一个就拒发", type: [String] })
  variables: string[];

  @ApiProperty({ description: "标题模板（含 {{变量}} 占位符；custom 为空串）" })
  subject: string;

  @ApiProperty({ description: "正文模板（含 {{变量}} 占位符；custom 为空串）" })
  body: string;
}

/** 发信响应（入队成功，不代表已投递） */
export class SendMailResultDto {
  @ApiProperty({ description: "投递任务 id" })
  id: string;

  @ApiProperty({ description: "入队后的状态（恒为 pending：是否真发出去要在投递记录里看）" })
  status: string;

  @ApiProperty({ description: "渲染后的标题（可以先看一眼，发错了还来得及在记录里查到）" })
  subject: string;
}

/** 分页默认每页条数（与其它列表接口一致） */
export const MAIL_DEFAULT_PAGE_SIZE = 20;

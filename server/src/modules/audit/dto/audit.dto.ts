import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { ADMIN_ROLES } from "../../../common/constants/permission";
import { AuditLogWithNameRow } from "../../../database/rows";

/** 审计目标类型（查询筛选用） */
export const AUDIT_TARGET_TYPES = ["account", "role", "admin", "announcement", "mail"] as const;

/** 一条操作日志 */
export class AuditLogDto {
  @ApiProperty({ description: "日志 id" })
  id: string;

  @ApiProperty({ description: "操作人管理员 id（匿名事件如登录失败为 null）", type: "string", nullable: true })
  actorId: string | null;

  @ApiProperty({ description: "操作人账号名（冗余存下来，操作人被删后仍可追溯）", type: "string", nullable: true })
  actorName: string | null;

  @ApiProperty({ description: "操作人角色（super_admin / admin / viewer）", type: "string", nullable: true })
  actorRole: string | null;

  @ApiProperty({ description: "动作（即接口标识 operationId，如 adminRole.patch）", example: "adminRole.patch" })
  action: string;

  @ApiProperty({ description: "目标类型：account / role / admin / announcement / mail", type: "string", nullable: true })
  targetType: string | null;

  @ApiProperty({ description: "目标 id", type: "string", nullable: true })
  targetId: string | null;

  @ApiProperty({
    description: "目标**当前**的名字（按 targetType 关联出来；目标已删则为 null，界面退回显示 id）",
    type: "string",
    nullable: true,
  })
  targetName: string | null;

  @ApiProperty({
    description: "附加上下文（请求体，已对 password / secret / token / code 一类字段打码；无则 null）",
    type: "object",
    additionalProperties: true,
    nullable: true,
  })
  detail: unknown;

  @ApiProperty({ description: "来源 IP（反向代理下需 TRUST_PROXY=true 才准）", type: "string", nullable: true })
  ip: string | null;

  @ApiProperty({ description: "HTTP 方法", type: "string", nullable: true })
  method: string | null;

  @ApiProperty({ description: "请求路径", type: "string", nullable: true })
  path: string | null;

  @ApiProperty({ description: "HTTP 状态码", type: "number", nullable: true })
  statusCode: number | null;

  @ApiProperty({ description: "是否成功" })
  success: boolean;

  @ApiProperty({ description: "失败时的业务码", type: "number", nullable: true })
  errorCode: number | null;

  @ApiProperty({ description: "失败原因（可展示的中文）", type: "string", nullable: true })
  errorMessage: string | null;

  @ApiProperty({ description: "发生时间（毫秒）" })
  createdAt: number;

  static from(row: AuditLogWithNameRow): AuditLogDto {
    const dto = new AuditLogDto();
    dto.id = row.id;
    dto.actorId = row.actor_id;
    dto.actorName = row.actor_name;
    dto.actorRole = row.actor_role;
    dto.action = row.action;
    dto.targetType = row.target_type;
    dto.targetId = row.target_id;
    dto.targetName = row.target_name;
    dto.detail = safeParse(row.detail);
    dto.ip = row.ip;
    dto.method = row.method;
    dto.path = row.path;
    dto.statusCode = row.status_code;
    dto.success = row.success === 1;
    dto.errorCode = row.error_code;
    dto.errorMessage = row.error_message;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/** 操作日志查询入参 */
export class AuditQueryDto extends PageQueryDto {
  /**
   * 关键字
   *
   * 覆写基类那条「含义见各接口说明」的描述：这里是真的会用的条件，
   * 模糊匹配**操作人账号名 / 动作 / 目标 id / 请求路径**四项（任一命中即返回）。
   */
  @ApiPropertyOptional({ description: "关键字：模糊匹配操作人账号名 / 动作（如 password）/ 目标 id / 请求路径" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "只看某个操作人的日志（管理员 id）" })
  @IsOptional()
  @IsString({ message: "操作人 id 必须是字符串" })
  actorId?: string;

  @ApiPropertyOptional({ description: "只看某个动作（operationId，取值见 /admin/audit-logs/actions）" })
  @IsOptional()
  @IsString({ message: "动作必须是字符串" })
  action?: string;

  @ApiPropertyOptional({ description: "目标类型筛选", enum: AUDIT_TARGET_TYPES })
  @IsOptional()
  @IsString({ message: "目标类型必须是字符串" })
  @IsIn([...AUDIT_TARGET_TYPES], { message: "目标类型取值不合法" })
  targetType?: string;

  @ApiPropertyOptional({ description: "只看针对某个目标的日志（目标 id）" })
  @IsOptional()
  @IsString({ message: "目标 id 必须是字符串" })
  targetId?: string;

  @ApiPropertyOptional({
    description: "只看某个来源 IP（**精确匹配**；反向代理下需要 TRUST_PROXY=true 才准）",
    maxLength: 45,
    example: "203.0.113.9",
  })
  @IsOptional()
  @IsString({ message: "来源 IP 必须是字符串" })
  @MaxLength(45, { message: "来源 IP 过长" })
  ip?: string;

  @ApiPropertyOptional({ description: "只看某个操作人角色", enum: ADMIN_ROLES })
  @IsOptional()
  @IsString({ message: "操作人角色必须是字符串" })
  @IsIn(ADMIN_ROLES, { message: "操作人角色取值不合法" })
  actorRole?: string;

  /**
   * 只看成功 / 只看失败
   *
   * 与角色的在线筛选同一约定：**用字符串而不是 boolean** —— query 参数本来就是字符串，
   * class-transformer 的隐式转换会把 `"false"` 当成非空字符串转成 `true`，静默筛错。
   */
  @ApiPropertyOptional({ description: "结果筛选：true 只看成功 / false 只看失败", enum: ["true", "false"] })
  @IsOptional()
  @IsString({ message: "结果筛选必须是字符串" })
  @IsIn(["true", "false"], { message: "结果筛选只能传 true 或 false" })
  success?: string;

  @ApiPropertyOptional({ description: "起始时间（毫秒时间戳，含）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "起始时间必须是整数" })
  @Min(0, { message: "起始时间不能为负" })
  from?: number;

  @ApiPropertyOptional({ description: "结束时间（毫秒时间戳，含）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "结束时间必须是整数" })
  @Min(0, { message: "结束时间不能为负" })
  to?: number;
}

/** 操作日志分页结果 */
export class AuditLogPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的操作日志", type: [AuditLogDto] })
  list: AuditLogDto[];
}

/** 出现过的动作清单（筛选下拉用，不写死在界面里） */
export class AuditActionListDto {
  @ApiProperty({ description: "动作（operationId）列表", type: [String] })
  actions: string[];
}

/**
 * 导出结果（CSV 文本 + 统计）
 *
 * 为什么是「把文本装进统一包裹」而不是直接吐 `text/csv` 响应：三端约定响应体恒为
 * `{code,message,data,timestamp}`，两端请求层都按 JSON 解析 —— 直吐 CSV 会把请求层打穿，
 * 出错时的错误提示也一并失效。由管理端拿 `content` 自己造 Blob 下载，两边都干净。
 */
export class AuditExportDto {
  @ApiProperty({ description: "建议的文件名（含本地时间戳）", example: "olua-audit-20261009-153000.csv" })
  filename: string;

  @ApiProperty({ description: "CSV 文本（已带 UTF-8 BOM 与表头，行尾 CRLF）" })
  content: string;

  @ApiProperty({ description: "实际导出的数据行数（不含表头）" })
  rows: number;

  @ApiProperty({ description: "当前筛选条件下的总条数（可能大于 rows）" })
  total: number;

  @ApiProperty({ description: "是否因达到导出上限被截断（true 时界面要提示先缩小筛选范围）" })
  truncated: boolean;
}

/** 宽松解析 detail（存进去的本来就是 JSON，坏数据不该让整页查不出来） */
function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

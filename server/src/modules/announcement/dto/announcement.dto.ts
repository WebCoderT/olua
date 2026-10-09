import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";
import {
  ANNOUNCEMENT_CONTENT_MAX,
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_TITLE_MAX,
} from "../../../common/constants/announcement";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { AnnouncementRow } from "../../../database/rows";

/**
 * 对外（玩家侧）的公告
 *
 * 刻意**不含** `enabled` / `createdBy` / 时间戳：那些是运营内部字段 ——
 * 对外接口只给「展示一条公告需要的全部信息」，多给的字段迟早会被人当成契约用。
 * 所以这里与 `AnnouncementDto` 是两个独立的类，而不是继承关系。
 */
export class ActiveAnnouncementDto {
  @ApiProperty({ description: "公告 id" })
  id: string;

  @ApiProperty({ description: "标题", example: "例行维护公告" })
  title: string;

  @ApiProperty({ description: "正文（纯文本，换行用 \\n）" })
  content: string;

  @ApiProperty({ description: "级别：normal 普通 / important 重要（重要排在前）", enum: ANNOUNCEMENT_LEVELS })
  level: string;

  @ApiProperty({ description: "生效开始时间（毫秒）；null = 立即生效", type: "number", nullable: true })
  startsAt: number | null;

  @ApiProperty({ description: "生效结束时间（毫秒，不含）；null = 不设截止", type: "number", nullable: true })
  endsAt: number | null;

  static from(row: AnnouncementRow): ActiveAnnouncementDto {
    const dto = new ActiveAnnouncementDto();
    dto.id = row.id;
    dto.title = row.title;
    dto.content = row.content;
    dto.level = row.level;
    dto.startsAt = row.starts_at;
    dto.endsAt = row.ends_at;
    return dto;
  }
}

/** 管理端看到的公告（含内部字段：启停开关、发布人、时间戳） */
export class AnnouncementDto {
  @ApiProperty({ description: "公告 id" })
  id: string;

  @ApiProperty({ description: "标题" })
  title: string;

  @ApiProperty({ description: "正文（纯文本，换行用 \\n）" })
  content: string;

  @ApiProperty({ description: "级别", enum: ANNOUNCEMENT_LEVELS })
  level: string;

  @ApiProperty({ description: "是否启用（手动下线开关；与时间窗是两道独立的闸）" })
  enabled: boolean;

  @ApiProperty({ description: "生效开始时间（毫秒）；null = 立即生效", type: "number", nullable: true })
  startsAt: number | null;

  @ApiProperty({ description: "生效结束时间（毫秒，不含）；null = 不设截止", type: "number", nullable: true })
  endsAt: number | null;

  @ApiProperty({ description: "发布人管理员账号名（管理员被删后仍可追溯）", type: "string", nullable: true })
  createdBy: string | null;

  @ApiProperty({ description: "创建时间（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  /**
   * 当前是否**生效中**（启用 + 在时间窗内）
   *
   * 由服务端算好给界面：让界面自己去比时间，等于把「什么算生效」这套判据复制到前端，
   * 迟早与服务端 SQL 里的那份漂移（例如一端用 `>`、一端用 `>=`）。
   */
  @ApiProperty({ description: "当前是否生效中（由服务端判定，界面不要自己算）" })
  active: boolean;

  static from(row: AnnouncementRow, now: number): AnnouncementDto {
    const dto = new AnnouncementDto();
    dto.id = row.id;
    dto.title = row.title;
    dto.content = row.content;
    dto.level = row.level;
    dto.enabled = row.enabled === 1;
    dto.startsAt = row.starts_at;
    dto.endsAt = row.ends_at;
    dto.createdBy = row.created_by;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    dto.active = isActive(row, now);
    return dto;
  }
}

/**
 * 判据的 TypeScript 侧实现
 *
 * 与 `announcement.repository` 里那段 `ACTIVE_SQL` 是**同一套规则的两侧实现**：
 * SQL 那份负责筛选（数据库里筛），这份负责给单条记录打标（已有行上算），
 * 改规则时两处必须一起改 —— e2e 里有一条「列表 active 筛选结果」与「逐条 active 标记」
 * 必须一致的断言盯着这件事。
 */
export function isActive(row: AnnouncementRow, now: number): boolean {
  if (row.enabled !== 1) return false;
  if (row.starts_at !== null && row.starts_at > now) return false;
  if (row.ends_at !== null && row.ends_at <= now) return false;
  return true;
}

/** 公告列表查询入参 */
export class AnnouncementQueryDto extends PageQueryDto {
  /** 关键字：覆写基类那条「含义见各接口说明」的描述（这里是真的会用到的条件） */
  @ApiPropertyOptional({ description: "关键字：模糊匹配标题与正文" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "级别筛选", enum: ANNOUNCEMENT_LEVELS })
  @IsOptional()
  @IsString({ message: "级别必须是字符串" })
  @IsIn([...ANNOUNCEMENT_LEVELS], { message: "级别取值不合法" })
  level?: string;

  /**
   * 启用状态筛选
   *
   * 用字符串而不是 boolean：query 参数本来就是字符串，class-transformer 的隐式转换
   * 会把 `"false"` 变成 `true`（非空字符串 → Boolean），静默筛成「全部启用」。
   */
  @ApiPropertyOptional({ description: "启用状态筛选：true 只看启用 / false 只看停用", enum: ["true", "false"] })
  @IsOptional()
  @IsString({ message: "启用状态必须是字符串" })
  @IsIn(["true", "false"], { message: "启用状态只能传 true 或 false" })
  enabled?: string;

  @ApiPropertyOptional({
    description: "生效状态筛选：true 只看生效中 / false 只看不在生效窗口内（含未开始与已过期）",
    enum: ["true", "false"],
  })
  @IsOptional()
  @IsString({ message: "生效状态必须是字符串" })
  @IsIn(["true", "false"], { message: "生效状态只能传 true 或 false" })
  active?: string;
}

/** 公告分页结果 */
export class AnnouncementPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的公告", type: [AnnouncementDto] })
  list: AnnouncementDto[];
}

/** 新建公告入参 */
export class CreateAnnouncementDto {
  @ApiProperty({ description: "标题", maxLength: ANNOUNCEMENT_TITLE_MAX, example: "例行维护公告" })
  @IsString({ message: "标题必须是字符串" })
  @MinLength(1, { message: "标题不能为空" })
  @MaxLength(ANNOUNCEMENT_TITLE_MAX, { message: `标题最长 ${ANNOUNCEMENT_TITLE_MAX} 个字` })
  title: string;

  @ApiProperty({ description: "正文（纯文本）", maxLength: ANNOUNCEMENT_CONTENT_MAX })
  @IsString({ message: "正文必须是字符串" })
  @MinLength(1, { message: "正文不能为空" })
  @MaxLength(ANNOUNCEMENT_CONTENT_MAX, { message: `正文最长 ${ANNOUNCEMENT_CONTENT_MAX} 个字` })
  content: string;

  @ApiPropertyOptional({ description: "级别，默认 normal", enum: ANNOUNCEMENT_LEVELS, default: "normal" })
  @IsOptional()
  @IsString({ message: "级别必须是字符串" })
  @IsIn([...ANNOUNCEMENT_LEVELS], { message: "级别取值不合法" })
  level?: string;

  @ApiPropertyOptional({ description: "是否启用，默认 true", default: true })
  @IsOptional()
  @IsBoolean({ message: "启用状态必须是布尔值" })
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "生效开始时间（毫秒时间戳）；不传 = 立即生效",
    minimum: 0,
    example: 1760000000000,
  })
  @IsOptional()
  @IsInt({ message: "开始时间必须是整数" })
  @Min(0, { message: "开始时间不能为负" })
  startsAt?: number;

  @ApiPropertyOptional({ description: "生效结束时间（毫秒时间戳，不含）；不传 = 不设截止", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "结束时间必须是整数" })
  @Min(0, { message: "结束时间不能为负" })
  endsAt?: number;
}

/**
 * 编辑公告入参（**部分更新**）
 *
 * 所有字段可选，只改传上来的那些 —— 列表上的「启用 / 停用」按钮因此不必回传整篇正文，
 * 也就不会出现「为了停用一条公告，把运营正在编辑的正文覆盖回去」。
 */
export class UpdateAnnouncementDto {
  @ApiPropertyOptional({ description: "标题（不传则不改）", maxLength: ANNOUNCEMENT_TITLE_MAX })
  @IsOptional()
  @IsString({ message: "标题必须是字符串" })
  @MinLength(1, { message: "标题不能为空" })
  @MaxLength(ANNOUNCEMENT_TITLE_MAX, { message: `标题最长 ${ANNOUNCEMENT_TITLE_MAX} 个字` })
  title?: string;

  @ApiPropertyOptional({ description: "正文（不传则不改）", maxLength: ANNOUNCEMENT_CONTENT_MAX })
  @IsOptional()
  @IsString({ message: "正文必须是字符串" })
  @MinLength(1, { message: "正文不能为空" })
  @MaxLength(ANNOUNCEMENT_CONTENT_MAX, { message: `正文最长 ${ANNOUNCEMENT_CONTENT_MAX} 个字` })
  content?: string;

  @ApiPropertyOptional({ description: "级别（不传则不改）", enum: ANNOUNCEMENT_LEVELS })
  @IsOptional()
  @IsString({ message: "级别必须是字符串" })
  @IsIn([...ANNOUNCEMENT_LEVELS], { message: "级别取值不合法" })
  level?: string;

  @ApiPropertyOptional({ description: "启用 / 停用（不传则不改）" })
  @IsOptional()
  @IsBoolean({ message: "启用状态必须是布尔值" })
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "生效开始时间（毫秒）；传 `null` = 改为立即生效，不传则不改",
    type: "number",
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: "开始时间必须是整数" })
  @Min(0, { message: "开始时间不能为负" })
  startsAt?: number | null;

  @ApiPropertyOptional({
    description: "生效结束时间（毫秒，不含）；传 `null` = 改为不设截止，不传则不改",
    type: "number",
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: "结束时间必须是整数" })
  @Min(0, { message: "结束时间不能为负" })
  endsAt?: number | null;
}

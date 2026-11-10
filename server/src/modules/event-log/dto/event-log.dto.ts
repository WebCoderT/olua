import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { EVENT_TYPE_LABELS, EventType, isKnownEventType } from "../../../common/constants/event-type";
import { EventLogRow } from "../../../database/rows";

/** 一条玩家行为流水 */
export class EventLogDto {
  @ApiProperty({ description: "流水 id" })
  id: string;

  @ApiProperty({ description: "事件类型（login / enter_map / kill / pick / gain / consume / mail / quest…）", example: "kill" })
  type: string;

  @ApiProperty({ description: "事件类型的中文名（未知类型回显原值）", example: "击杀" })
  typeLabel: string;

  @ApiProperty({ description: "账号 id（登录失败时为 null）", type: "string", nullable: true })
  accountId: string | null;

  @ApiProperty({ description: "角色 id（没有在线角色的行为为 null）", type: "string", nullable: true })
  roleId: string | null;

  @ApiProperty({ description: "角色名（冗余存下来，角色被删后仍可追溯）", type: "string", nullable: true })
  roleName: string | null;

  @ApiProperty({ description: "区服 id", type: "number", nullable: true })
  zoneId: number | null;

  @ApiProperty({ description: "地图 id（进图 / 拾取 / 击杀带）", type: "string", nullable: true })
  mapId: string | null;

  @ApiProperty({
    description: "关键对象：击杀=怪物 key / 拾取与获得与消耗=物品 id / 任务=任务 id / 邮件=邮件 id",
    type: "string",
    nullable: true,
  })
  target: string | null;

  @ApiProperty({ description: "数量 / 经验 / 金额（该事件没有「多少」这个维度时为 null）", type: "number", nullable: true })
  amount: number | null;

  @ApiProperty({
    description: "其余上下文（坐标、技能、绑定状态等；JSON 对象，无则 null）",
    type: "object",
    additionalProperties: true,
    nullable: true,
  })
  detail: unknown;

  @ApiProperty({ description: "来源 IP（登录带；反向代理下需 TRUST_PROXY=true 才准）", type: "string", nullable: true })
  ip: string | null;

  @ApiProperty({ description: "是否成功（目前只有登录失败会为 false）" })
  success: boolean;

  @ApiProperty({ description: "发生时间（毫秒）" })
  createdAt: number;

  static from(row: EventLogRow): EventLogDto {
    const dto = new EventLogDto();
    dto.id = row.id;
    dto.type = row.type;
    dto.typeLabel = typeLabelOf(row.type);
    dto.accountId = row.account_id;
    dto.roleId = row.role_id;
    dto.roleName = row.role_name;
    dto.zoneId = row.zone_id;
    dto.mapId = row.map_id;
    dto.target = row.target;
    dto.amount = row.amount;
    dto.detail = safeParse(row.detail);
    dto.ip = row.ip;
    dto.success = row.success === 1;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/** 玩家行为流水查询入参 */
export class EventLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配角色名 / 目标 / 载荷" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "事件类型（取值见 /admin/event-logs/types）" })
  @IsOptional()
  @IsString({ message: "事件类型必须是字符串" })
  @IsIn(Object.keys(EVENT_TYPE_LABELS), { message: "事件类型取值不合法" })
  type?: string;

  @ApiPropertyOptional({ description: "只看某个角色（角色 id）" })
  @IsOptional()
  @IsString({ message: "角色 id 必须是字符串" })
  roleId?: string;

  @ApiPropertyOptional({ description: "只看某个账号（账号 id）" })
  @IsOptional()
  @IsString({ message: "账号 id 必须是字符串" })
  accountId?: string;

  @ApiPropertyOptional({ description: "只看某张地图（地图 id）" })
  @IsOptional()
  @IsString({ message: "地图 id 必须是字符串" })
  @MaxLength(64, { message: "地图 id 过长" })
  mapId?: string;

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

/** 玩家行为流水分页结果 */
export class EventLogPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的流水", type: [EventLogDto] })
  list: EventLogDto[];
}

/** 一种事件类型（筛选下拉用） */
export class EventTypeDto {
  @ApiProperty({ description: "类型值（落库值）", example: "pick" })
  value: string;

  @ApiProperty({ description: "中文名", example: "拾取" })
  label: string;

  @ApiProperty({ description: "该类型当前的记录条数（0 表示这条链路还没有埋上）" })
  total: number;
}

/**
 * 事件类型清单
 *
 * 数据源是**库里出现过的类型**再并上字典里的全部类型：
 * - 只列库里的 → 没数据的那几类筛不出来，也看不出「少了哪类」；
 * - 只列字典里的 → 界面出现一堆永远是 0 的筛选项，运营会以为漏埋。
 *
 * 两者并集 + 每条带 `total`，于是「有字典、没数据」这件事在界面上一眼可见。
 */
export class EventTypeListDto {
  @ApiProperty({ description: "全部事件类型（含当前 0 条的）", type: [EventTypeDto] })
  types: EventTypeDto[];
}

/** 类型 → 中文名（未知类型回显原值：埋点先上、字典后补时不该让整页显示空） */
function typeLabelOf(type: string): string {
  return isKnownEventType(type) ? EVENT_TYPE_LABELS[type as EventType] : type;
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

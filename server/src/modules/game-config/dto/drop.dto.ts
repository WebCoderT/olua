import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { DropTableRow, MonsterDropRow } from "../../../database/rows";

/**
 * 掉落配置（#254）
 *
 * picks / entries 的**结构校验在 service**（assertDropPicks / assertDropEntries）——
 * 「goodId 必须在物品总表里」要查生成物、「picks 是数字或区间」是联合类型，
 * class-validator 的声明式装饰器写这些很拧巴；DTO 只做 whitelist 认键 + 基本形态，
 * 越界细节由 service 抛 40000（与 assertAttributeRanges 同一分工模式）。
 */

/** 表 id 的取值形态（小写字母数字下划线；具名表可动态增删，id 是运营自起的） */
export const DROP_TABLE_ID_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
/** 单表条目数上限（防御性；现有表最多几十条） */
export const DROP_ENTRIES_MAX = 200;

/** 每怪来源的取值清单（语义标注：引用具名表 / 内联条目 / 未配置走兜底） */
export const MONSTER_DROP_SOURCES = ["table", "entries", "none"] as const;

/** 掉落条目入参（服务端 DTO；生成物快照里已是全显式形状） */
export class DropEntryDto {
  @ApiProperty({ description: "物品 id（物品总表 configs/items 的键，含装备前后缀变体）" })
  @IsString({ message: "goodId 必须是字符串" })
  @IsNotEmpty({ message: "goodId 不能为空" })
  goodId: string;

  @ApiPropertyOptional({ description: "抽取权重（同一表内相对值，缺省 1）", minimum: 0 })
  @IsOptional()
  @IsNumber({}, { message: "weight 必须是数字" })
  @Min(0, { message: "weight 不能为负" })
  weight?: number;

  @ApiPropertyOptional({ description: "掉落概率 0~1（抽中后再判定，缺省 1 必掉）", minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber({}, { message: "chance 必须是数字" })
  @Min(0, { message: "chance 不能小于 0" })
  @Max(1, { message: "chance 不能大于 1" })
  chance?: number;

  @ApiPropertyOptional({ description: "数量区间 [最小, 最大]（缺省 [1,1]）", type: [Number] })
  @IsOptional()
  @IsArray({ message: "count 必须是数组" })
  @ArrayMinSize(2, { message: "count 必须是 [最小, 最大] 两位" })
  @ArrayMaxSize(2, { message: "count 必须是 [最小, 最大] 两位" })
  @IsInt({ each: true, message: "count 里必须是整数" })
  @Min(0, { each: true, message: "count 不能为负" })
  count?: number[];
}

/** 掉落表内容（创建 / 更新共用的 body 形状；picks 结构校验在 service） */
export class DropTableBodyDto {
  @ApiPropertyOptional({ description: "抽取次数：数字（固定件数）或 [最小, 最大]（件数区间）", oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] })
  @IsOptional()
  picks?: unknown;

  @ApiProperty({ description: "条目池（goodId 必须在物品总表里；weight/chance/count 缺省 1/1/[1,1]）", type: [DropEntryDto] })
  @IsArray({ message: "entries 必须是数组" })
  @ArrayMaxSize(DROP_ENTRIES_MAX, { message: `条目数不能超过 ${DROP_ENTRIES_MAX}` })
  @ValidateNested({ each: true })
  @Type(() => DropEntryDto)
  entries: DropEntryDto[];
}

/** 创建具名掉落表入参（**只有创建**才带 id —— id 是主键，更新接口不带） */
export class CreateDropTableDto extends DropTableBodyDto {
  @ApiProperty({ description: "表 id（小写字母开头的字母/数字/下划线，≤50 字符）", pattern: DROP_TABLE_ID_PATTERN.source })
  @IsString({ message: "表 id 必须是字符串" })
  @Matches(DROP_TABLE_ID_PATTERN, { message: "表 id 只能是小写字母开头的字母/数字/下划线（≤50 字符）" })
  id: string;
}

/** 更新具名掉落表入参（picks / entries 部分更新：只改传了的字段） */
export class UpdateDropTableDto {
  @ApiPropertyOptional({ description: "抽取次数：数字（固定件数）或 [最小, 最大]（件数区间）；不传则不改", oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] })
  @IsOptional()
  picks?: unknown;

  @ApiPropertyOptional({ description: "条目池（**整份替换**；不传则不改）", type: [DropEntryDto] })
  @IsOptional()
  @IsArray({ message: "entries 必须是数组" })
  @ArrayMaxSize(DROP_ENTRIES_MAX, { message: `条目数不能超过 ${DROP_ENTRIES_MAX}` })
  @ValidateNested({ each: true })
  @Type(() => DropEntryDto)
  entries?: DropEntryDto[];
}

/** 管理端看到的一条具名掉落表 */
export class DropTableDto {
  @ApiProperty({ description: "表 id（如 \"common\"）" })
  id: string;

  @ApiProperty({ description: "抽取次数：数字（固定件数）或 [最小, 最大]（件数区间）", oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] })
  picks: number | [number, number];

  @ApiProperty({ description: "条目池（全显式形状）", type: [DropEntryDto] })
  entries: DropEntryDto[];

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: DropTableRow): DropTableDto {
    const dto = new DropTableDto();
    dto.id = row.id;
    dto.picks = JSON.parse(row.picks);
    dto.entries = JSON.parse(row.entries);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 具名掉落表列表结果（一张表一行，量小不分页） */
export class DropTableListDto {
  @ApiProperty({ description: "具名掉落表", type: [DropTableDto] })
  list: DropTableDto[];

  @ApiProperty({ description: "总张数" })
  total: number;
}

/** 每怪掉落列表查询入参 */
export class MonsterDropQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配怪物 key" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "按来源筛（不落 schema 以免枚举键进两端生成物）", enum: [...MONSTER_DROP_SOURCES] })
  @IsOptional()
  @IsString({ message: "来源必须是字符串" })
  @IsIn([...MONSTER_DROP_SOURCES], { message: "来源取值不合法" })
  source?: string;
}

/** 管理端看到的一条每怪掉落配置 */
export class MonsterDropDto {
  @ApiProperty({ description: "怪物 key（= monsters.id，与怪物配置页同一键）" })
  monsterKey: string;

  @ApiProperty({ description: "来源：table（引用具名表）/ entries（内联条目池）/ none（未配置走兜底）", enum: [...MONSTER_DROP_SOURCES] })
  source: string;

  @ApiProperty({ description: "引用的具名表 id（source = table 时非空）", nullable: true, type: String })
  tableId: string | null;

  @ApiProperty({ description: "抽取次数 JSON（内联时必填；表引用时可覆盖件数，null = 用表自己的）", nullable: true, oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] })
  picks: number | [number, number] | null;

  @ApiProperty({ description: "内联条目池（source = entries 时非空）", nullable: true, type: [DropEntryDto] })
  entries: DropEntryDto[] | null;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: MonsterDropRow): MonsterDropDto {
    const dto = new MonsterDropDto();
    dto.monsterKey = row.monster_key;
    dto.source = row.source;
    dto.tableId = row.table_id;
    dto.picks = row.picks === null ? null : JSON.parse(row.picks);
    dto.entries = row.entries === null ? null : JSON.parse(row.entries);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 每怪掉落分页结果 */
export class MonsterDropPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的每怪掉落配置", type: [MonsterDropDto] })
  list: MonsterDropDto[];
}

/**
 * 编辑每怪掉落入参（**整份替换**：表引用 / 内联条目 / 清空 三选一）
 *
 * - `tableId` 非空 → 该怪引用具名表（`picks` 可覆盖件数，`entries` 必须不传）；
 * - `tableId` 为 null 且 `entries` 非空 → 内联条目池（`picks` 必填）；
 * - `tableId` 为 null 且 `entries` 为 null → 清空该怪配置（走兜底表）。
 * `monsterKey` 不存在 → 404（50024）；`tableId` 指向的表不存在 → 404（50023）。
 */
export class UpdateMonsterDropDto {
  @ApiPropertyOptional({ description: "引用的具名表 id（null = 不引用具名表）", nullable: true, type: String })
  @IsOptional()
  @IsString({ message: "tableId 必须是字符串" })
  tableId?: string | null;

  @ApiPropertyOptional({ description: "抽取次数：数字（固定件数）或 [最小, 最大]（件数区间）", oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] })
  @IsOptional()
  picks?: unknown;

  @ApiPropertyOptional({ description: "内联条目池（**整份替换**）", type: [DropEntryDto] })
  @IsOptional()
  @IsArray({ message: "entries 必须是数组" })
  @ArrayMaxSize(DROP_ENTRIES_MAX, { message: `条目数不能超过 ${DROP_ENTRIES_MAX}` })
  @ValidateNested({ each: true })
  @Type(() => DropEntryDto)
  entries?: DropEntryDto[];
}

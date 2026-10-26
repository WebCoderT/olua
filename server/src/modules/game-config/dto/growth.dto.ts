import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { GROWTH_CURVE_KEYS, GROWTH_SCALAR_SPECS } from "../../../common/constants/game-config";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { GrowthScalarRow, GrowthSegmentRow, LevelExpRow } from "../../../database/rows";

// —— 等级经验 ——

/** 管理端看到的一行升级经验 */
export class LevelExpDto {
  @ApiProperty({ description: "等级（1 起；序列固定，不可增删行）" })
  level: number;

  @ApiProperty({ description: "升到下一级所需经验" })
  exp: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: LevelExpRow): LevelExpDto {
    const dto = new LevelExpDto();
    dto.level = row.level;
    dto.exp = row.exp;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 等级经验列表查询入参 */
export class LevelExpQueryDto extends PageQueryDto {
  // 等级序列就是主键升序，没有筛选维度；继承分页与排序即可
}

/** 等级经验分页结果 */
export class LevelExpPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的升级经验", type: [LevelExpDto] })
  list: LevelExpDto[];
}

/** 编辑升级经验入参（部分更新；等级本身不可改） */
export class UpdateLevelExpDto {
  @ApiPropertyOptional({ description: "升到下一级所需经验（≥ 1，0 级经验永远升不上去）", minimum: 1 })
  @IsInt({ message: "经验必须是整数" })
  @Min(1, { message: "经验至少为 1" })
  exp?: number;
}

// —— 曲线分段 ——

/** 管理端看到的一段曲线 */
export class GrowthSegmentDto {
  @ApiProperty({ description: "曲线键（maxHp / attack / defense / killsPerLevel）", enum: [...GROWTH_CURVE_KEYS] })
  curve: string;

  @ApiProperty({ description: "段序号（1 起；同曲线内不可增删段）" })
  seq: number;

  @ApiProperty({ description: "起始等级（含）" })
  fromLevel: number;

  @ApiProperty({ description: "结束等级（含）" })
  toLevel: number;

  @ApiProperty({ description: "该段起始等级的值" })
  startValue: number;

  @ApiProperty({ description: "段内每升一级的增量" })
  perLevel: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: GrowthSegmentRow): GrowthSegmentDto {
    const dto = new GrowthSegmentDto();
    dto.curve = row.curve;
    dto.seq = row.seq;
    dto.fromLevel = row.from_level;
    dto.toLevel = row.to_level;
    dto.startValue = row.start_value;
    dto.perLevel = row.per_level;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 曲线分段列表查询入参 */
export class GrowthSegmentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "按曲线键筛", enum: [...GROWTH_CURVE_KEYS] })
  @IsOptional()
  @IsString({ message: "曲线键必须是字符串" })
  @IsIn([...GROWTH_CURVE_KEYS], { message: "曲线键取值不合法" })
  curve?: string;
}

/** 曲线分段分页结果 */
export class GrowthSegmentPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的曲线分段", type: [GrowthSegmentDto] })
  list: GrowthSegmentDto[];
}

/** 编辑曲线分段入参（四个数值字段都要带 —— 段的边界与斜率是一体的，部分提交会出现「改了 to 忘了下一段 from」的半截状态） */
export class UpdateGrowthSegmentDto {
  @ApiProperty({ description: "起始等级（含，≥ 1）", minimum: 1 })
  @IsInt({ message: "起始等级必须是整数" })
  @Min(1, { message: "起始等级至少为 1" })
  fromLevel!: number;

  @ApiProperty({ description: "结束等级（含，≥ 起始等级）", minimum: 1 })
  @IsInt({ message: "结束等级必须是整数" })
  @Min(1, { message: "结束等级至少为 1" })
  toLevel!: number;

  @ApiProperty({ description: "该段起始等级的值（≥ 0）", minimum: 0 })
  @IsInt({ message: "起始值必须是整数" })
  @Min(0, { message: "起始值不能为负" })
  startValue!: number;

  @ApiProperty({ description: "段内每升一级的增量（≥ 0）", minimum: 0 })
  @IsInt({ message: "每级增量必须是整数" })
  @Min(0, { message: "每级增量不能为负" })
  perLevel!: number;
}

// —— 标量参数 ——

/** 管理端看到的一个标量参数 */
export class GrowthScalarDto {
  @ApiProperty({ description: "参数键（如 roleMaxLevel / attributeRange.minRate）" })
  key: string;

  @ApiProperty({ description: "参数值" })
  value: number;

  @ApiProperty({ description: "参数说明（改之前先读一遍 —— 每个键的语义都在这里）" })
  description: string;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: GrowthScalarRow): GrowthScalarDto {
    const dto = new GrowthScalarDto();
    dto.key = row.key;
    dto.value = row.value;
    dto.description = row.description;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 标量参数列表查询入参 */
export class GrowthScalarQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配参数键与说明" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 标量参数分页结果 */
export class GrowthScalarPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的标量参数", type: [GrowthScalarDto] })
  list: GrowthScalarDto[];
}

/** 编辑标量参数入参（各键的取值域见服务端 GROWTH_SCALAR_SPECS；roleMaxLevel 还有跨表校验） */
export class UpdateGrowthScalarDto {
  @ApiProperty({
    description: "参数值；整数键（roleMaxLevel / expGain.*）必须是整数，比率键在 [0, 1] 等取值域内",
    minimum: 0,
  })
  @IsNumber({}, { message: "参数值必须是数字" })
  @Min(0, { message: "参数值不能为负" })
  value!: number;
}

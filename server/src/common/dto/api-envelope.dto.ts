import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/**
 * 统一响应包裹的 Swagger 描述
 *
 * 具体接口用它 + 业务模型组合（见 common/decorators/api-data-response.decorator），
 * 于是 Swagger 上看到的响应体与真实返回完全一致：{ code, message, data, timestamp }。
 */
export class ApiEnvelopeDto {
  @ApiProperty({ description: "业务码，0 = 成功", example: 0 })
  code: number;

  @ApiProperty({ description: "提示信息", example: "ok" })
  message: string;

  @ApiProperty({ description: "业务数据（无数据时为 null）", type: "object", additionalProperties: true, nullable: true })
  data: unknown;

  @ApiProperty({ description: "服务端时间戳（毫秒）", example: 1760000000000 })
  timestamp: number;

  @ApiPropertyOptional({ description: "出错时的请求路径", example: "/api/auth/login" })
  path?: string;
}

/** 分页查询的公共入参（列表接口统一继承它） */
export class PageQueryDto {
  @ApiPropertyOptional({ description: "页码，从 1 开始", example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @IsInt({ message: "页码必须是整数" })
  @Min(1, { message: "页码最小为 1" })
  page?: number;

  @ApiPropertyOptional({ description: "每页条数（1~100）", example: 20, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt({ message: "每页条数必须是整数" })
  @Min(1, { message: "每页条数最小为 1" })
  @Max(100, { message: "每页条数最大为 100" })
  size?: number;

  @ApiPropertyOptional({ description: "关键字（不同接口含义见其说明）" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  keyword?: string;

  /**
   * 排序字段
   *
   * 取值**由各接口自己声明**（写在各仓储顶部的白名单里）—— 排序列是拼进 SQL 的，
   * 服务端只认登记过的键，传了别的值会静默退回该列表的默认排序（不报错）。
   */
  @ApiPropertyOptional({ description: "排序字段（取值见各接口说明，未登记的值会退回默认排序）", example: "createdAt" })
  @IsOptional()
  @IsString({ message: "排序字段必须是字符串" })
  @MaxLength(32, { message: "排序字段过长" })
  sort?: string;

  @ApiPropertyOptional({ description: "排序方向：asc 升序 / desc 降序", enum: ["asc", "desc"], default: "desc" })
  @IsOptional()
  @IsString({ message: "排序方向必须是字符串" })
  @IsIn(["asc", "desc"], { message: "排序方向只能是 asc 或 desc" })
  order?: string;
}

/**
 * 分页结果里的公共字段（列表接口的响应模型统一继承它）
 *
 * 和 `PageQueryDto` 对称：列表接口**入参**分页、**出参**也分页，
 * 出参这一侧必须写成 DTO 类（而不是 interface）才能进 OpenAPI ——
 * 客户端与管理端的接口类型是从文档生成的，文档里没有的东西生成不出来
 * （此前列表接口在文档里被写成「一个数组」，管理端只能手写分页类型补上）。
 */
export class PageMetaDto {
  @ApiProperty({ description: "总条数", example: 42 })
  total: number;

  @ApiProperty({ description: "当前页码（从 1 开始）", example: 1 })
  page: number;

  @ApiProperty({ description: "每页条数", example: 20 })
  size: number;
}

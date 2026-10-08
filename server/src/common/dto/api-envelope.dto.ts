import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

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
}

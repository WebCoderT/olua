import { ApiProperty } from "@nestjs/swagger";

/** 健康检查返回 */
export class HealthDto {
  @ApiProperty({ description: "服务状态", example: "ok" })
  status: string;

  @ApiProperty({ description: "运行环境", example: "development" })
  env: string;

  @ApiProperty({ description: "服务端时间戳（毫秒）" })
  time: number;
}

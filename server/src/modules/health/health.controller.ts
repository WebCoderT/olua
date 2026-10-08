import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { HealthDto } from "./dto/health.dto";

/**
 * 系统接口（客户端与管理端启动时都可以先探一下这个）
 *
 * 分组只由方法级装饰器决定：Swagger「没有类级 tag 就自动用控制器类名分组」的行为
 * 已在 main.ts 关掉（autoTagControllers: false），否则每个接口都会多挂一个类名分组。
 */
@Controller("health")
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiPublicDoc({ summary: "健康检查", description: "无需登录；用于客户端 / 管理端确认服务端可达。" })
  @ApiDataResponse(HealthDto, { description: "服务状态" })
  check(): HealthDto {
    const dto = new HealthDto();
    dto.status = "ok";
    dto.env = this.config.get<string>("env") ?? "development";
    dto.time = Date.now();
    return dto;
  }
}

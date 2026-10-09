import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { SystemService } from "./system.service";
import { SystemInfoDto } from "./dto/system.dto";

/**
 * 管理端 · 系统信息（运维自查）
 *
 * 只读接口，因此**没有** `@AuditTarget` —— 看自己的运行状态不该造审计。
 */
@ApiAudience("admin")
@Controller("admin/system")
export class AdminSystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminSystem.info",
    summary: "系统信息",
    description:
      "版本 / Node 版本 / 运行时长 / 内存 / 数据文件路径与体积 / 各表行数 / 脱敏配置快照。\n\n" +
      "**配置快照走白名单**：只有服务端 `CONFIG_SNAPSHOT` 表里登记过的项才会出现，`JWT_SECRET` 与 " +
      "`ADMIN_REGISTER_CODE` 只报「已配置 / 仍是默认值」这类形态，绝不回显原文 —— " +
      "白名单的意义是「将来新增密钥时默认不暴露」，而黑名单要靠人记得去加。\n\n" +
      "`warning: true` 的项是运维该注意的（内置 JWT 密钥未改、CORS 全开）。只读观察员没有 `system:read`。",
    permissions: [Permission.SYSTEM_READ],
  })
  @ApiDataResponse(SystemInfoDto, { description: "系统信息" })
  info(): SystemInfoDto {
    return this.systemService.info();
  }
}

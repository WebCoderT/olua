import { Controller, Get, Query } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AuditService } from "./audit.service";
import { AuditActionListDto, AuditLogDto, AuditLogPageDto, AuditQueryDto } from "./dto/audit.dto";

/**
 * 管理端 · 操作日志
 *
 * 只读接口（写由 common/interceptors/audit.interceptor 自动完成），
 * 因此这里没有 `@AuditTarget` —— 审计自己的查询不该再造审计。
 */
@ApiAudience("admin")
@Controller("admin/audit-logs")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminAudit.list",
    summary: "操作日志列表",
    description:
      "按时间倒序返回管理端的写操作记录（含登录成功 / 失败、改密码）。" +
      "`keyword`（模糊匹配操作人账号名 / 动作 / 目标 id / 请求路径）、`actorId` / `action` / `targetType` / `targetId` / " +
      "`success` / `from` / `to` 均可选，条件之间是「与」的关系。\n\n" +
      "`detail` 是当时的请求体，已对 `password` / `secret` / `token` / `registerCode` 一类字段打码（值替换为 `***`）。",
    permissions: [Permission.AUDIT_READ],
  })
  @ApiQueryModel(AuditQueryDto)
  @ApiDataResponse(AuditLogPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: AuditQueryDto): PageResult<AuditLogDto> {
    return this.auditService.list(query);
  }

  @Get("actions")
  @ApiAdminDoc({
    operationId: "adminAudit.actions",
    summary: "出现过的动作清单",
    description: "返回日志里出现过的全部动作（接口标识），供界面的「动作」筛选下拉使用 —— 界面不写死动作清单。",
    permissions: [Permission.AUDIT_READ],
  })
  @ApiDataResponse(AuditActionListDto, { description: "动作清单" })
  actions(): AuditActionListDto {
    return { actions: this.auditService.actions() };
  }
}

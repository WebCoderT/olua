import { Controller, Get, Query } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AUDIT_SORT, sortFieldNames } from "../../database/sort-specs";
import { AuditService } from "./audit.service";
import { AuditActionListDto, AuditExportDto, AuditLogDto, AuditLogPageDto, AuditQueryDto } from "./dto/audit.dto";

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
      `**排序**：\`sort\` 取 ${sortFieldNames(AUDIT_SORT)}，\`order\` 取 asc / desc（默认 createdAt 倒序）。` +
      "同一毫秒的多条日志另有 id 兜底次序，保证翻页稳定。\n\n" +
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

  @Get("export")
  @ApiAdminDoc({
    operationId: "adminAudit.export",
    summary: "导出操作日志（CSV）",
    description:
      "筛选条件与列表接口**完全一致**（含 `sort` / `order`，导出即「当前筛选下的全部」）；" +
      "`page` / `size` 不生效 —— 条数上限取服务端配置 `AUDIT_EXPORT_MAX_ROWS`，超出时返回前 N 条并置 `truncated`。\n\n" +
      "返回的是**文本**而不是 `text/csv` 响应：三端约定响应体恒为 `{code,message,data,timestamp}`，" +
      "直吐文件会把两端请求层的 JSON 解析打穿；管理端拿 `content` 自己造 Blob 下载。\n\n" +
      "内容已带 UTF-8 BOM（Excel 打开中文不乱码）与表头；以 `=` `+` `-` `@` 开头的值会加前导单引号，" +
      "避免一个叫 `=HYPERLINK(...)` 的账号名在表格软件里被当公式执行。",
    permissions: [Permission.AUDIT_READ],
  })
  @ApiQueryModel(AuditQueryDto)
  @ApiDataResponse(AuditExportDto, { description: "CSV 文本与统计（filename / content / rows / total / truncated）" })
  exportCsv(@Query() query: AuditQueryDto): AuditExportDto {
    return this.auditService.exportCsv(query);
  }
}

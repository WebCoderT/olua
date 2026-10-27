import { Controller, Get, Query } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { Permission } from "../../common/constants/permission";
import { REPORT_CATEGORIES } from "../../common/constants/social";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { ReportDto, ReportPageDto, ReportQueryDto } from "./dto/report.dto";
import { ReportService } from "./report.service";

/**
 * 管理端 · 玩家举报（#398）
 *
 * **只有读**：这一刀不做状态流转、不做处罚（边界见 issue #398）。举报是玩家对玩家的指控，
 * 处理它需要一整套「谁改的、凭什么改、能不能申诉」的东西 —— 那是不小的一刀，
 * 先让举报**能被看见**，比先做一个半成品的处置流程更有价值。
 *
 * 因此这里也没有 `@AuditTarget`：只读接口不产生审计记录（审计记的是写操作）。
 */
@ApiAudience("admin")
@Controller("admin/reports")
export class AdminReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminReport.list",
    summary: "举报列表",
    description:
      "按举报时间倒序（新举报在前，同毫秒以 id 兜底，翻页稳定）。\n\n" +
      "`category` 取 " +
      REPORT_CATEGORIES.join(" / ") +
      "，`status` 取 pending / handled / dismissed（v1 只会是 pending），" +
      "`keyword` 模糊匹配双方角色名或角色 id。条件之间是「与」的关系。\n\n" +
      "`roleName` / `targetName` 是**查询时**关联出来的当前角色名：角色已删则为 null，界面退回显示 id。",
    permissions: [Permission.REPORT_READ],
  })
  @ApiQueryModel(ReportQueryDto)
  @ApiDataResponse(ReportPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: ReportQueryDto): PageResult<ReportDto> {
    return this.reportService.list(query);
  }
}

import { Controller, Get, Query } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { EventLogService } from "./event-log.service";
import { EventLogDto, EventLogPageDto, EventLogQueryDto, EventTypeListDto } from "./dto/event-log.dto";

/**
 * 管理端 · 玩家行为流水（#886 / J3）
 *
 * 只读接口：写入由 `EventLogService` 在各自写入口完成（总线两条 + 直接调用六条），
 * 因此这里没有 `@AuditTarget` —— 查流水不该再造一条审计。
 */
@ApiAudience("admin")
@Controller("admin/event-logs")
export class EventLogController {
  constructor(private readonly eventLogs: EventLogService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEvent.list",
    summary: "玩家行为流水",
    description:
      "按时间倒序返回玩家侧的行为记录（登录 / 进图 / 击杀 / 拾取 / 获得 / 消耗 / 邮件 / 任务）。\n\n" +
      "`keyword`（模糊匹配角色名 / 目标 / 载荷）、`type` / `roleId` / `accountId` / `mapId` / " +
      "`success` / `from` / `to` 均可选，条件之间是「与」的关系。\n\n" +
      "**与「操作日志」页的区别**：那是「管理员点了什么」，这是「玩家做了什么」" +
      "（那一页的数据来自 `audit_logs`，与这张表刻意分开，见 docs/37 B71）。\n\n" +
      "保留策略取服务端 `EVENT_LOG_MAX_ROWS`（默认 10 万条）与 `EVENT_LOG_RETENTION_DAYS`（默认 30 天），" +
      "两者独立生效 —— 所以「三天前的记录查不到」既可能是被条数挤掉、也可能是超了保留天数。",
    permissions: [Permission.EVENT_READ],
  })
  @ApiQueryModel(EventLogQueryDto)
  @ApiDataResponse(EventLogPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: EventLogQueryDto): PageResult<EventLogDto> {
    return this.eventLogs.list(query);
  }

  @Get("types")
  @ApiAdminDoc({
    operationId: "adminEvent.types",
    summary: "事件类型清单",
    description:
      "返回全部事件类型（字典 ∪ 库里出现过的），每条带中文名与当前记录条数。\n\n" +
      "`total = 0` 的类型表示**还没有埋点**：`trade`（交易）/ `enhance`（强化）暂时放置 —— " +
      "服务端还没有这两条业务链路，等模块落地再补发布者（见 docs/37 J3）。",
    permissions: [Permission.EVENT_READ],
  })
  @ApiDataResponse(EventTypeListDto, { description: "类型清单（value / label / total）" })
  types(): EventTypeListDto {
    return this.eventLogs.types();
  }
}

import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { Permission } from "../../common/constants/permission";
import { DROP_RESULTS } from "../../common/constants/drop";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { DROP_RECORD_SORT, sortFieldNames } from "../../database/sort-specs";
import { DropsService } from "./drops.service";
import {
  DropRecordDto,
  DropRecordPageDto,
  DropRecordQueryDto,
  DropRecordSummaryDto,
} from "./dto/drop-record.dto";

/**
 * 管理端 · 掉落流水（#803）
 *
 * 两个只读接口：一页流水 + 一张概况卡。数据来自实时进程写的 `drop_records`
 * （append-only 的终态历史），这里只读、不写、不审计 —— 查流水不该再造一条审计。
 *
 * 区取自请求头 `X-Zone-Id`（`ZoneContextGuard` 校验后放进 `request.zoneId`）：
 * 掉落是分区的，管理端一次只在一个区里干活，切区就能看另一个区，不需要另开权限。
 * **不接受 `?zoneId=`** —— 管理端的区是「当前上下文」，不是单次查询参数（docs/39 §2.4）。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/drops")
export class AdminDropsController {
  constructor(private readonly drops: DropsService) {}

  @Get("records/summary")
  @ApiAdminDoc({
    operationId: "adminDrop.recordSummary",
    summary: "掉落流水概况（按终态分组计数）",
    description:
      "页面顶部的概况卡：按终态（picked / expired / overflow / restart_lost）分组计数。\n\n" +
      "**四个终态恒出现**（没有数据的给 0）：少一格会让运营以为「这种结果不存在」，而 0 一眼能看出「还没发生过」。\n\n" +
      "`result` 筛选在这里**不生效**（刻意）：传了就是「只看 picked」，再按 picked 分组只剩一行。\n" +
      "其余条件（`mapId` / `ownerName` / `goodId` / `from` / `to`）照常生效。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.EVENT_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropRecordQueryDto)
  @ApiDataResponse(DropRecordSummaryDto, { description: "按终态分组的计数 + 合计" })
  summary(@Query() query: DropRecordQueryDto, @ZoneContext() zoneId: number): DropRecordSummaryDto {
    return this.drops.summary(zoneId, query);
  }

  @Get("records")
  @ApiAdminDoc({
    operationId: "adminDrop.recordList",
    summary: "掉落流水",
    description:
      "一页掉落终态记录（一件掉落的一生只有一行）：谁打的、掉在哪张图、在地上待了多久、最后被谁捡走 / 怎么消失的。\n\n" +
      `\`result\` 取 ${DROP_RESULTS.map((item) => `\`${item}\``).join(" / ")}；` +
      "`mapId` / `ownerName`（模糊）/ `goodId`（精确）/ `from` / `to`（按掉落落地时刻）均可选，条件之间是「与」。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(DROP_RECORD_SORT)}，\`order\` 取 asc / desc（默认 \`resolvedAt\` 倒序）。\n\n` +
      "**同 `dropId` 可能有多行**：`dropId` 里的序号每区自增，进程重启后从 1 重新开始 —— 所以两次\n" +
      "进程生命周期里可能生成同一个 `dropId`，而它们的流水都留着。排序与翻页一律按自增 `id`，\n" +
      "**不要按 `dropId` 去重**（docs/18 §3.5）。\n\n" +
      "**保留策略**：每区每图 `DROP_RECORD_KEEP_PER_MAP`（默认 2000）条 + `DROP_RECORD_RETENTION_DAYS`（默认 7 天），" +
      "两道闸取先到 —— 「三天前的记录查不到」既可能是被条数挤掉、也可能是超了保留天数。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.EVENT_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropRecordQueryDto)
  @ApiDataResponse(DropRecordPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: DropRecordQueryDto, @ZoneContext() zoneId: number): PageResult<DropRecordDto> {
    return this.drops.list(zoneId, query);
  }
}

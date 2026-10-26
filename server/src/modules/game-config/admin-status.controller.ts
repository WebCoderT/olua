import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { SKILL_OWNER_LABELS, SKILL_OWNER_VALUES, STATUS_SOURCE_LABELS } from "../../common/constants/game-config";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { STATUS_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { StatusDto, StatusPageDto, StatusQueryDto, UpdateStatusDto } from "./dto/status.dto";

/** 归属 / 来源的中文对照（写进接口文档） */
const LABEL_HINT =
  `owner：${SKILL_OWNER_VALUES.map((value) => `${value}（${SKILL_OWNER_LABELS[value as "role" | "monster"]}）`).join(" / ")}；` +
  `source：${Object.entries(STATUS_SOURCE_LABELS).map(([key, label]) => `${key}（${label}）`).join(" / ")}。`;

/**
 * 管理端 · 状态配置（#367）
 *
 * 与技能同表同取向：角色与怪物按 `owner` 区分，只有 list / update。
 * `combat` 只声明「这个状态在数值上意味着什么」，**结算口径的唯一实现在客户端
 * BattleMath** —— 所以加新的修正维度必须同时改那边，否则存了也不生效（写在 DTO 注释里）。
 * 写操作带 `@AuditTarget("status")`。
 */
@ApiAudience("admin")
@Controller("admin/statuses")
export class AdminStatusController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminStatus.list",
    summary: "状态配置列表",
    description:
      "角色与怪物同一张表，用 `owner` 筛选。\n\n" +
      `${LABEL_HINT}\n\n` +
      "`keyword` 模糊匹配 id / 状态名。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(STATUS_SORT)}，\`order\` 取 asc / desc（默认 id 数值升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(StatusQueryDto)
  @ApiDataResponse(StatusPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: StatusQueryDto): PageResult<StatusDto> {
    return this.gameConfigService.listStatuses(query);
  }

  @Patch(":id")
  @AuditTarget("status")
  @ApiAdminDoc({
    operationId: "adminStatus.update",
    summary: "编辑状态配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `combat`：**整份替换**；不传则不改。三个维度全缺省 = 纯表现状态（不参与伤害结算）。\n" +
      "- `duration`：重复获得时从获得时刻重新计时，不叠层。\n" +
      "- `id` 不存在 → 404（`50030`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "状态 id（如 \"2001\"）" })
  @ApiDataResponse(StatusDto, { description: "更新后的状态配置" })
  update(@Param("id") id: string, @Body() dto: UpdateStatusDto): StatusDto {
    return this.gameConfigService.updateStatus(id, dto);
  }
}

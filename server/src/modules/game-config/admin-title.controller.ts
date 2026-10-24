import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { TITLE_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { TitleDto, TitlePageDto, TitleQueryDto, UpdateTitleDto } from "./dto/title.dto";
import { ACQUIRE_CHANNEL_LABELS, ACQUIRE_CHANNELS } from "../../common/constants/game-config";

/**
 * 管理端 · 称号配置
 *
 * **只有 list / update，没有 create / remove**：称号等级序列固定（1..34，来自客户端配置），
 * 后台只允许改内容 —— 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 404」）。
 * 写操作带 `@AuditTarget("title")`：改的是全服玩家看到的数值，必须可追溯。
 */
@ApiAudience("admin")
@Controller("admin/titles")
export class AdminTitleController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminTitle.list",
    summary: "称号配置列表",
    description:
      "等级序列固定（1..34），**没有创建 / 删除**。`keyword` 模糊匹配名称与描述，" +
      "`acquireChannel` 按获得渠道筛（" +
      ACQUIRE_CHANNELS.map((channel) => `${channel}=${ACQUIRE_CHANNEL_LABELS[channel]}`).join(" / ") +
      "；新库 seed 后全部为 unavailable）。\n\n" +
      "`bindGold` 是「升到该级」消耗的绑定元宝，仅 `upgrade` 渠道实际使用（升级价目表的语义）。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(TITLE_SORT)}，\`order\` 取 asc / desc（默认 level 升序——列表本身就是价目表）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(TitleQueryDto)
  @ApiDataResponse(TitlePageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: TitleQueryDto): PageResult<TitleDto> {
    return this.gameConfigService.listTitles(query);
  }

  @Patch(":level")
  @AuditTarget("title")
  @ApiAdminDoc({
    operationId: "adminTitle.update",
    summary: "编辑称号配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `acquireChannel`：获得渠道（upgrade 称号升级 / grant 系统赠送 / unavailable 无法获取）。" +
      "**赠送逻辑暂未实现**，标成 grant 只是先把渠道记下来；默认 unavailable。\n" +
      "- `bindGold`：升级价格，仅渠道为 upgrade 时在玩家侧实际使用；其余渠道数值保留但不展示入口。\n" +
      "- `attributes`：八项属性，**整份提交、整份替换**；区间型要求 0 ≤ min ≤ max（跨字段校验在服务端）。\n" +
      "- `level` 不存在 → 404（`50010`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "level", description: "称号等级（1..34）" })
  @ApiDataResponse(TitleDto, { description: "更新后的称号配置" })
  update(@Param("level", ParseIntPipe) level: number, @Body() dto: UpdateTitleDto): TitleDto {
    return this.gameConfigService.updateTitle(level, dto);
  }
}

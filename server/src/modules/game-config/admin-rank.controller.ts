import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { RANK_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { RankDto, RankPageDto, RankQueryDto, RANK_TIERS, UpdateRankDto } from "./dto/rank.dto";

/**
 * 管理端 · 军衔配置（#250）
 *
 * 与称号 / 战魂同一取向：**只有 list / update，没有 create / remove**（阶数序列固定 1..100，
 * e2e 会固化「POST/DELETE 404」）。军衔 100 阶全量就是成长链、顺序天然按阶，
 * **没有成长列表重排接口** —— 成长列表在管理端只是主列表的「价格与属性视图」。
 * 写操作带 `@AuditTarget("rank")`：改的是全服玩家的数值，必须可追溯。
 */
@ApiAudience("admin")
@Controller("admin/ranks")
export class AdminRankController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminRank.list",
    summary: "军衔配置列表",
    description:
      "阶数序列固定（1..100），**没有创建 / 删除**。`keyword` 模糊匹配衔名 / 大段名 / 描述，" +
      "`tier` 按大段筛（" +
      RANK_TIERS.join(" / ") +
      "，seed 自客户端配置的 10 大段）。\n\n" +
      "`bindGold` 是「晋到该阶」消耗的绑定元宝（seed 自晋升价格曲线），管理端成长列表里行内修改。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(RANK_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(RankQueryDto)
  @ApiDataResponse(RankPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: RankQueryDto): PageResult<RankDto> {
    return this.gameConfigService.listRanks(query);
  }

  @Patch(":level")
  @AuditTarget("rank")
  @ApiAdminDoc({
    operationId: "adminRank.update",
    summary: "编辑军衔配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `attributes`：八项属性，**整份提交、整份替换**；区间型要求 0 ≤ min ≤ max（跨字段校验在服务端）。\n" +
      "- `bindGold`：晋升价格；管理端编辑弹窗不带价格输入（提交原样带回当前值），唯一修改口是成长列表。\n" +
      "- **改属性会影响军衔等效强度**（军衔按阶映射角色等级再打折，#256 的曲线是它的基准）。\n" +
      "- `level` 不存在 → 404（`50015`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "level", description: "军衔阶数（1..100）" })
  @ApiDataResponse(RankDto, { description: "更新后的军衔配置" })
  update(@Param("level", ParseIntPipe) level: number, @Body() dto: UpdateRankDto): RankDto {
    return this.gameConfigService.updateRank(level, dto);
  }
}

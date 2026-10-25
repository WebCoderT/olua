import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { SOUL_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { SoulDto, SoulPageDto, SoulQueryDto, UpdateSoulDto } from "./dto/soul.dto";
import { UpgradeOrderDto } from "./dto/title.dto";

/**
 * 管理端 · 战魂配置
 *
 * 与称号同构（list / upgrade-list / upgrade-order / update，没有 create / remove）：
 * 37 阶序列固定，只允许改内容。战魂没有「获得渠道」—— 37 阶逐阶购买，渠道语义就是升级本身；
 * 成长列表（#234）与称号同构但全量行都在列表里（没有渠道进出）。
 */
@ApiAudience("admin")
@Controller("admin/souls")
export class AdminSoulController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminSoul.list",
    summary: "战魂配置列表",
    description:
      "阶数序列固定（1..37），**没有创建 / 删除**。`keyword` 模糊匹配名称与描述。\n\n" +
      "`bindGold` 是「升到该阶」消耗的绑定元宝。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(SOUL_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(SoulQueryDto)
  @ApiDataResponse(SoulPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: SoulQueryDto): PageResult<SoulDto> {
    return this.gameConfigService.listSouls(query);
  }

  /** 具名路由必须声明在 @Patch(":level") 之前，否则 upgrade-list / upgrade-order 会被参数路由吞掉 */
  @Get("upgrade-list")
  @ApiAdminDoc({
    operationId: "adminSoul.upgradeList",
    summary: "战魂成长列表",
    description:
      "独立于主列表的「升级链」视图：37 阶**全量**返回（战魂没有渠道语义，全部行都在升级链里），" +
      "按**成长顺序**升序（顺序由 `upgradeOrder` 决定，与阶数解耦 —— 运营拖动排序改的就是它）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(SoulDto, { description: "按成长顺序排列的战魂配置数组", isArray: true })
  upgradeList(): SoulDto[] {
    return this.gameConfigService.listUpgradeSouls();
  }

  @Patch("upgrade-order")
  @AuditTarget("soul")
  @ApiAdminDoc({
    operationId: "adminSoul.reorderUpgradeList",
    summary: "战魂成长列表重排（拖动排序）",
    description:
      "**整串提交**：`levels` 是拖完后的完整阶数顺序。要求**恰好等于全部 37 阶** —— 缺、多、重复都整单拒收" +
      "（`400` / `40000`），不做增量合并，保证运营看到的顺序就是落库的顺序。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(SoulDto, { description: "重排后的成长列表（按新顺序）", isArray: true })
  reorderUpgradeList(@Body() dto: UpgradeOrderDto): SoulDto[] {
    return this.gameConfigService.reorderUpgradeSouls(dto);
  }

  @Patch(":level")
  @AuditTarget("soul")
  @ApiAdminDoc({
    operationId: "adminSoul.update",
    summary: "编辑战魂配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `bindGold`：升到该阶的消耗（绑定元宝）。\n" +
      "- `attributes`：八项属性，**整份提交、整份替换**；区间型要求 0 ≤ min ≤ max。\n" +
      "- `level` 不存在 → 404（`50011`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "level", description: "战魂阶数（1..37）" })
  @ApiDataResponse(SoulDto, { description: "更新后的战魂配置" })
  update(@Param("level", ParseIntPipe) level: number, @Body() dto: UpdateSoulDto): SoulDto {
    return this.gameConfigService.updateSoul(level, dto);
  }
}

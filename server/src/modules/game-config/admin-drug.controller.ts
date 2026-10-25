import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { DRUG_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { DrugDto, DrugPageDto, DrugQueryDto, UpdateDrugDto } from "./dto/drug.dto";

/**
 * 管理端 · 药品配置（#253）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**只有 list / update，没有 create / remove** ——
 * 药品 id 清单固定（被掉落表与背包引用），e2e 会固化「POST/DELETE 404」。
 * `level` 不开放编辑（使用等级需求属客户端成长曲线定标的一部分）；
 * 四项回复量是 effects 数组按键**求和**的单值（客户端 resolveDrugRecovery 逐项累加，语义等价）；
 * **商城售价不在这里**（归商城定价管理）。写操作带 `@AuditTarget("drug")`。
 */
@ApiAudience("admin")
@Controller("admin/drugs")
export class AdminDrugController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminDrug.list",
    summary: "药品配置列表",
    description:
      "id 清单固定（seed 自客户端 configs/drug 的 8 种），**没有创建 / 删除**。" +
      "`keyword` 模糊匹配 id / 名称 / 描述。\n\n" +
      "`sellPrice` 是客户端条目的售卖价（0 = 不可售卖），**商城售价归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(DRUG_SORT)}，\`order\` 取 asc / desc（默认 id 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(DrugQueryDto)
  @ApiDataResponse(DrugPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: DrugQueryDto): PageResult<DrugDto> {
    return this.gameConfigService.listDrugs(query);
  }

  @Patch(":id")
  @AuditTarget("drug")
  @ApiAdminDoc({
    operationId: "adminDrug.update",
    summary: "编辑药品配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label` / `description`：文案。\n" +
      "- `sellPrice`：售卖价（0 = 不可售卖）；**商城售价不在这里** —— 唯一写入口归商城定价管理。\n" +
      "- `maxStack` / `cooldown`：堆叠上限 / 使用冷却秒数（0 = 无冷却）。\n" +
      "- `effectHp` / `effectMp`：固定回复量；`effectHpPercent` / `effectMpPercent`：百分比回复（50 = 50%，≤100）。" +
      "四项都是 effects 数组按键求和后的单值，客户端按逐项累加结算，语义等价。\n" +
      "- `level` 不开放编辑（使用等级需求属客户端成长曲线定标的一部分）。\n" +
      "- `id` 不存在 → 404（`50017`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "药品 id（如 drug_hp_1）" })
  @ApiDataResponse(DrugDto, { description: "更新后的药品配置" })
  update(@Param("id") id: string, @Body() dto: UpdateDrugDto): DrugDto {
    return this.gameConfigService.updateDrug(id, dto);
  }
}

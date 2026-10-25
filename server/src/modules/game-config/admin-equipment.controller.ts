import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { EQUIPMENT_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { EquipmentDto, EquipmentPageDto, EquipmentQueryDto, EQUIPMENT_SLOT_KEYS, UpdateEquipmentDto } from "./dto/equipment.dto";

/**
 * 管理端 · 装备基础件配置（#252）
 *
 * 与称号 / 战魂 / 军衔同一取向：**只有 list / update，没有 create / remove** ——
 * 装备 id / 部位结构固定（变体生成规则在客户端配置，属代码不是运营数据），
 * e2e 会固化「POST/DELETE 404」。**管理的是基础件**（普通的·人级，37 件）：
 * 变体（`_pXsY`）是基础件 × 前后缀倍率展开的，运营只改基础件这一份。
 * **商城售价不在这里**（归商城定价管理），避免一个值两个写入口。
 * 写操作带 `@AuditTarget("equipment")`：改的是全服玩家的数值，必须可追溯。
 */
@ApiAudience("admin")
@Controller("admin/equipments")
export class AdminEquipmentController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipment.list",
    summary: "装备基础件配置列表",
    description:
      "**只收基础件**（普通的·人级，如 `cloth_1`），变体（`cloth_1_p3s2`）不进管理端 —— 它是基础件乘前后缀倍率展开的。" +
      "id / 部位结构固定，**没有创建 / 删除**。\n\n" +
      "`keyword` 模糊匹配 id 与名称；`slot` 按部位筛（" +
      EQUIPMENT_SLOT_KEYS.join(" / ") +
      "）；`minLevel` / `maxLevel` 按穿戴需求等级段筛（均含端）。\n\n" +
      "`sellPrice` 是客户端条目的售卖价（0 = 不可售卖），**商城售价归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(EQUIPMENT_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(EquipmentQueryDto)
  @ApiDataResponse(EquipmentPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: EquipmentQueryDto): PageResult<EquipmentDto> {
    return this.gameConfigService.listEquipments(query);
  }

  @Patch(":id")
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipment.update",
    summary: "编辑装备基础件配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `level`：穿戴需求等级（装备定强的锚点）。\n" +
      "- `sellPrice`：售卖价（0 = 不可售卖）；**商城售价不在这里** —— 唯一写入口归商城定价管理。\n" +
      "- `attributes`：八项基础属性，**整份提交、整份替换**；区间型要求 0 ≤ min ≤ max（跨字段校验在服务端）。" +
      "变体属性 = 基础属性 × 前后缀倍率，改基础件即改全部 15 个变体。\n" +
      "- `slot` / `label` 不开放编辑（部位结构与文案属客户端资源约定）。\n" +
      "- `id` 不存在 → 404（`50016`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "装备基础件 id（如 cloth_1）" })
  @ApiDataResponse(EquipmentDto, { description: "更新后的装备基础件配置" })
  update(@Param("id") id: string, @Body() dto: UpdateEquipmentDto): EquipmentDto {
    return this.gameConfigService.updateEquipment(id, dto);
  }
}

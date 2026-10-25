import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { ITEM_SORT, sortFieldNames } from "../../database/sort-specs";
import { GOOD_TYPE_VALUES } from "../../common/constants/game-config";
import { GameConfigService } from "./game-config.service";
import { ItemDto, ItemPageDto, ItemQueryDto, UpdateItemDto } from "./dto/item.dto";

/**
 * 管理端 · 物品与材料配置（#255）
 *
 * 与称号 / 战魂 / 军衔 / 装备 / 药品同一取向：**只有 list / update，没有 create / remove** ——
 * 物品 id 清单固定（被掉落表与脚本引用），e2e 会固化「POST/DELETE 404」。
 * **只收 MATERIAL / OTHER 大类**（装备 / 药品字段形态不同，各有自己的表与 issue）；
 * `type` / `level` 不开放编辑（大类与等级属客户端结构约定）；
 * **商城售价不在这里**（归商城定价管理）。写操作带 `@AuditTarget("item")`。
 */
@ApiAudience("admin")
@Controller("admin/items")
export class AdminItemController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminItem.list",
    summary: "物品与材料配置列表",
    description:
      "只收 **MATERIAL / OTHER** 大类（装备 / 药品各有自己的表），id 清单固定（seed 自客户端 configs/material），**没有创建 / 删除**。\n\n" +
      "`keyword` 模糊匹配 id / 名称 / 描述；`type` 按物品大类筛（取值：" +
      GOOD_TYPE_VALUES.join(" / ") +
      "）。\n\n" +
      "`sellPrice` 是客户端条目的售卖价（0 = 不可售卖），**商城售价归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(ITEM_SORT)}，\`order\` 取 asc / desc（默认 id 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(ItemQueryDto)
  @ApiDataResponse(ItemPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: ItemQueryDto): PageResult<ItemDto> {
    return this.gameConfigService.listItems(query);
  }

  @Patch(":id")
  @AuditTarget("item")
  @ApiAdminDoc({
    operationId: "adminItem.update",
    summary: "编辑物品与材料配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label` / `description`：文案。\n" +
      "- `sellPrice`：售卖价（0 = 不可售卖）；**商城售价不在这里** —— 唯一写入口归商城定价管理。\n" +
      "- `maxStack`：堆叠上限。\n" +
      "- `type` / `level` 不开放编辑（大类与等级属客户端结构约定）。\n" +
      "- `id` 不存在 → 404（`50018`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "物品 id（如 material_hide）" })
  @ApiDataResponse(ItemDto, { description: "更新后的物品配置" })
  update(@Param("id") id: string, @Body() dto: UpdateItemDto): ItemDto {
    return this.gameConfigService.updateItem(id, dto);
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Put, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { MallPricingService } from "./mall-pricing.service";
import {
  MallPriceItemDto,
  MallPricePageDto,
  MallPriceQueryDto,
  MallPriceRemoveDto,
  MallSettingsDto,
  PutMallPriceDto,
  UpdateMallSettingsDto,
} from "./dto/mall.dto";

/**
 * 管理端 · 商城定价（#251）
 *
 * **与配置表方向相反**：商品清单来自生成物（装备全量变体），价格才是服务端数据 ——
 * 特殊价行**动态增删**（PUT upsert / DELETE 删行回到统一价），这是全后台唯一允许
 * 「增删行」的定价数据（商品本体不归定价管）。未定价的商品走统一价（单行配置）。
 * 客户端购买以服务端复核价为准（客户端展示价仅用于显示，对接等 #248/#249）。
 * 写操作带 `@AuditTarget("mall")`。
 */
@ApiAudience("admin")
@Controller("admin/mall")
export class AdminMallController {
  constructor(private readonly mallPricingService: MallPricingService) {}

  //#region 统一价

  @Get("settings")
  @ApiAdminDoc({
    operationId: "adminMall.getSettings",
    summary: "查询商城统一价",
    description:
      "全场默认售价（绑定元宝/件），seed 自客户端 configs/mall 的 mallPrice。特殊价优先于统一价" +
      "（与客户端 getMallPrice 的取值口径一致）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MallSettingsDto, { description: "统一价配置" })
  getSettings(): MallSettingsDto {
    return this.mallPricingService.getSettings();
  }

  @Patch("settings")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.updateSettings",
    summary: "修改商城统一价",
    description: "全场默认售价（绑定元宝/件，0 = 免费赠送也合法）；**不影响已设置的特殊价**。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MallSettingsDto, { description: "更新后的统一价配置" })
  updateSettings(@Body() dto: UpdateMallSettingsDto): MallSettingsDto {
    return this.mallPricingService.updateSettings(dto);
  }

  //#endregion

  //#region 特殊价（动态增删）

  @Get("prices")
  @ApiAdminDoc({
    operationId: "adminMall.listPrices",
    summary: "商城定价列表（商品 × 价格合并视图）",
    description:
      "商品清单 = 生成物里的装备全量变体（555 件，七部位 × 基础件 × 品质变体），**不在数据库里**；" +
      "`price` 为 null 表示未定价（走统一价）。按 部位序 → 等级 → id 排序（与客户端商城陈列一致）。\n\n" +
      "`keyword` 模糊匹配商品 id / 显示名，`slot` 按部位筛，`priced=true/false` 只看特殊价 / 未定价。" +
      "**注意**：这里的列表接口没有 POST/DELETE 语义约束之外的东西 —— 特殊价的增删就是 PUT / DELETE 两条单件路由。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MallPriceQueryDto)
  @ApiDataResponse(MallPricePageDto, { description: "分页结果（list/total/page/size）" })
  listPrices(@Query() query: MallPriceQueryDto): PageResult<MallPriceItemDto> {
    return this.mallPricingService.listPrices(query);
  }

  @Put("prices/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.putPrice",
    summary: "设置单件特殊价（upsert）",
    description:
      "**动态增删的「增/改」半边**：商品已有特殊价则改价，没有则新增一行。\n\n" +
      "- 商品 id 必须在生成物的装备清单里，否则 404（`50021`）。\n" +
      "- 删除特殊价（回到统一价）用 DELETE。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "商品 id（装备变体 id，如 cloth_1_p3s2）" })
  @ApiDataResponse(MallPriceItemDto, { description: "更新后的商品定价视图" })
  putPrice(@Param("id") id: string, @Body() dto: PutMallPriceDto): MallPriceItemDto {
    return this.mallPricingService.putPrice(id, dto);
  }

  @Delete("prices/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.deletePrice",
    summary: "删除单件特殊价（回到统一价）",
    description:
      "**动态增删的「删」半边**：删掉该商品的特殊价行，之后走统一价。\n\n" +
      "- 商品 id 不在清单里 → 404（`50021`）。\n" +
      "- 该商品本来就没有特殊价 → 404（`50021`，删无可删不静默成功）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "商品 id（装备变体 id，如 cloth_1_p3s2）" })
  @ApiDataResponse(MallPriceRemoveDto, { description: "被删除特殊价的商品 id" })
  removePrice(@Param("id") id: string): { id: string; removed: true } {
    return this.mallPricingService.removePrice(id);
  }

  //#endregion
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { MallPricingService } from "./mall-pricing.service";
import {
  CreateMallCategoryDto,
  CreateMallGoodDto,
  MallCatalogPageDto,
  MallCatalogQueryDto,
  MallCategoryDto,
  MallCategoryRemoveDto,
  MallGoodItemDto,
  MallGoodPageDto,
  MallGoodQueryDto,
  MallGoodRemoveDto,
  MallStockResetDto,
  UpdateMallCategoryDto,
  UpdateMallGoodDto,
} from "./dto/mall.dto";

/**
 * 管理端 · 商城分类与上架商品（#251 / #758）
 *
 * **先建分类，再在分类下上架商品**：分类是运营自建的陈列分组（POST 建行 / PATCH 改名与
 * 排序 / DELETE 删空分类）；商品是**关联数据** —— 上架时从目录里挑一件（装备变体或药品），
 * 之后只许改商城自己的字段（所属分类 / 售价 / 购买等级 / 每日限购 / 库存），
 * 名称/图标/部位归各自的配置页管。下架 = 删行（顺带清已售计数）。
 * 客户端购买以服务端复核为准（快照只管陈列与按钮置灰）。写操作带 `@AuditTarget("mall")`。
 */
@ApiAudience("admin")
@Controller("admin/mall")
export class AdminMallController {
  constructor(private readonly mallPricingService: MallPricingService) {}

  //#region 分类

  @Get("categories")
  @ApiAdminDoc({
    operationId: "adminMall.listCategories",
    summary: "商城分类列表",
    description:
      "运营自建的陈列分组（含每组的上架商品数）。排序 = sort_order 小者在先。" +
      "出厂数据为空 —— 商城开张前必须先建分类（存量库迁移会带一个「默认分类」接住老特殊价）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MallCategoryDto, { description: "分类列表", isArray: true })
  listCategories(): MallCategoryDto[] {
    return this.mallPricingService.listCategories();
  }

  @Post("categories")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.createCategory",
    summary: "新建分类",
    description: "分类 id 由服务端生成，运营只给显示名（1~20 字）与排序值（缺省排到最后）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MallCategoryDto, { description: "新建的分类" })
  createCategory(@Body() dto: CreateMallCategoryDto): MallCategoryDto {
    return this.mallPricingService.createCategory(dto);
  }

  @Patch("categories/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.updateCategory",
    summary: "修改分类（名字 / 排序）",
    description: "分类只是陈列分组，不带任何数值 —— 可改的只有显示名与排序值。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "分类 id" })
  @ApiDataResponse(MallCategoryDto, { description: "更新后的分类" })
  updateCategory(@Param("id") id: string, @Body() dto: UpdateMallCategoryDto): MallCategoryDto {
    return this.mallPricingService.updateCategory(id, dto);
  }

  @Delete("categories/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.deleteCategory",
    summary: "删除分类",
    description:
      "分类下还有上架商品 → 409（`50028`）—— 先移走或下架，不静默搬走运营摆好的货。" +
      "分类不存在 → 404（`50025`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "分类 id" })
  @ApiDataResponse(MallCategoryRemoveDto, { description: "被删除的分类 id" })
  deleteCategory(@Param("id") id: string): { id: string; removed: true } {
    return this.mallPricingService.deleteCategory(id);
  }

  //#endregion

  //#region 上架商品

  @Get("goods")
  @ApiAdminDoc({
    operationId: "adminMall.listGoods",
    summary: "上架商品列表（商品 × 分类 × 售价合并视图）",
    description:
      "商品 = 运营手动上架的装备变体或药品（`mall_goods` 行）；名称 / 图标 / 部位 / 等级来自" +
      "各自的数据表（**只读展示**），分类 / 售价 / 购买等级才是商城字段。\n\n" +
      "- 检索：`categoryId`（**商城分类**）+ `keyword`（id 与名称）+ `level`（物品等级）+ `kind` / `slot`；\n" +
      "- 回包带 `levels`（当前分类范围内出现过的物品等级，给等级下拉用）；\n" +
      "- 排序：分类序 → 物品等级 → id。上架后本体被删的孤儿行照实列出（名称退回 id），便于清理。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MallGoodQueryDto)
  @ApiDataResponse(MallGoodPageDto, { description: "分页结果（list/total/page/size/levels）" })
  listGoods(@Query() query: MallGoodQueryDto): MallGoodPageDto {
    return this.mallPricingService.listGoods(query);
  }

  @Get("catalog")
  @ApiAdminDoc({
    operationId: "adminMall.listCatalog",
    summary: "可上架目录（装备 + 药品，按分类与等级筛）",
    description:
      "上架弹窗的数据源：装备变体（`equipment_variants`）+ 药品（`drugs`）拼成同一形状。\n\n" +
      "- `category` 是**物品自己的分类**：装备填部位 key（weapon / cloth …），药品填 `drug`，留空 = 全部；\n" +
      "- `level` 精确匹配等级（留空 = 全部）；`keyword` 模糊匹配 id 与名称；\n" +
      "- 回包带 `levels`（当前分类下出现过的等级，给等级下拉用）与每行的 `listed`（已在商城上架）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MallCatalogQueryDto)
  @ApiDataResponse(MallCatalogPageDto, { description: "分页结果（list/total/page/size/levels）" })
  listCatalog(@Query() query: MallCatalogQueryDto): MallCatalogPageDto {
    return this.mallPricingService.listCatalog(query);
  }

  @Post("goods")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.createGood",
    summary: "上架商品",
    description:
      "把一件装备变体或一种药品挂到某个分类下（缺省售价 1、购买等级 0 = 不限、" +
      "每日限购 0 = 不限购、库存 -1 = 不限量）。\n\n" +
      "- 商品 id 不在目录（装备变体 + drugs）→ 404（`50021`）；分类不存在 → 404（`50025`）。\n" +
      "- 已上架再上架 → 409（`50026`，一件物品全商城只能挂一行；想换分类直接 PATCH 商品的 `categoryId`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MallGoodItemDto, { description: "上架后的商品视图" })
  createGood(@Body() dto: CreateMallGoodDto): MallGoodItemDto {
    return this.mallPricingService.createGood(dto);
  }

  @Patch("goods/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.updateGood",
    summary: "修改商品（分类 / 售价 / 购买等级 / 每日限购 / 库存）",
    description:
      "**商品是关联数据**：名称 / 图标 / 部位 / 装备等级归各自的配置页管，这里只开放商城自己的" +
      "字段 —— 所属分类（`categoryId`，在陈列里挪位置）、售价（`price`）、购买等级" +
      "（`requiredLevel`）、每日限购（`dailyLimit`，0 = 不限购）、库存（`stock`，-1 = 不限量、" +
      "0 = 售罄停售）；改完立即对购买生效（购买链路现查库）。\n\n" +
      "商品不在上架清单 → 404（`50021`）；目标分类不存在 → 404（`50025`）。" +
      "库存卖完要续货，用「重置库存」而不是把 `stock` 改大 —— 后者会改配置、让客户端重拉快照。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "商品 id（装备变体 id，如 cloth_1_p3s2）" })
  @ApiDataResponse(MallGoodItemDto, { description: "更新后的商品视图" })
  updateGood(@Param("id") id: string, @Body() dto: UpdateMallGoodDto): MallGoodItemDto {
    return this.mallPricingService.updateGood(id, dto);
  }

  @Post("goods/:id/stock-reset")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.resetStock",
    summary: "重置库存（已售件数清零，商品重新可买）",
    description:
      "限量商品卖完之后运营手动续货：把**已售件数**清零，`stock`（总库存）保持不变。\n\n" +
      "- 与「把 `stock` 改大」的区别：改 `stock` 是改配置（快照内容变了）；重置销量只动运行时计数。" +
      "两者都会让配置版本 +1（版本判据是 `gameConfig:write` 这个权限点，不为单个动作开例外）。\n" +
      "- 不限量商品（`stock = -1`）不需要它，调了也是把 0 改成 0。\n" +
      "- 商品不在上架清单 → 404（`50021`）；下架时会自动清零（重新上架 = 新的一轮）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "商品 id（装备变体 id）" })
  @ApiDataResponse(MallStockResetDto, { description: "重置后的已售件数（恒 0）" })
  resetStock(@Param("id") id: string): MallStockResetDto {
    return this.mallPricingService.resetStock(id);
  }

  @Delete("goods/:id")
  @AuditTarget("mall")
  @ApiAdminDoc({
    operationId: "adminMall.deleteGood",
    summary: "下架商品",
    description: "删掉 `mall_goods` 行 = 下架，之后不在商城售卖（装备本体不受影响）。" +
      "不在上架清单 → 404（`50021`，删无可删不静默成功）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "商品 id（装备变体 id）" })
  @ApiDataResponse(MallGoodRemoveDto, { description: "被下架的商品 id" })
  removeGood(@Param("id") id: string): { id: string; removed: true } {
    return this.mallPricingService.removeGood(id);
  }

  //#endregion
}

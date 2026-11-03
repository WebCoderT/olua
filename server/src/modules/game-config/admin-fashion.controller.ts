import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { FASHION_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { FashionDto, FashionPageDto, FashionQueryDto, UpdateFashionDto } from "./dto/fashion.dto";

/**
 * 管理端 · 时装配置（#257）
 *
 * 与称号 / 战魂同一取向：**只有 list / update，没有 create / remove** ——
 * 时装 id 被角色存档（fashion 字段）与未来的穿戴 / 衣柜链路引用，清单固定
 * （seed 自生成物 FASHIONS 的 20 套），e2e 会固化「POST/DELETE 404」。
 *
 * 可改：名称 / 描述 / 售卖价 / 获得渠道（复用称号 AcquireChannel，seed 默认 unavailable）/
 * 八项属性（整份替换）/ 图标与内外观资源路径（#641 起，管理端可视化选择器）。
 * 染色与其它表现层参数仍在客户端。写操作带 `@AuditTarget("fashion")`。
 */
@ApiAudience("admin")
@Controller("admin/fashions")
export class AdminFashionController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminFashion.list",
    summary: "时装配置列表",
    description:
      "id 清单固定（seed 自 shared/fashion-seed.ts 的 20 套），**没有创建 / 删除**。" +
      "`keyword` 模糊匹配 id / 名称，`acquireChannel` 按获得渠道筛。\n\n" +
      "属性 seed 时全 0（原配置就是零加成），在这里运营可改；图标 / 内观 / 外观资源路径同样可改（管理端可视化选择器）。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(FASHION_SORT)}，\`order\` 取 asc / desc（默认 id 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(FashionQueryDto)
  @ApiDataResponse(FashionPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: FashionQueryDto): PageResult<FashionDto> {
    return this.gameConfigService.listFashions(query);
  }

  @Patch(":id")
  @AuditTarget("fashion")
  @ApiAdminDoc({
    operationId: "adminFashion.update",
    summary: "编辑时装配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label`：名称（≤50 字）。\n" +
      "- `description`：描述文案（≤500 字）。\n" +
      "- `sellPrice`：售卖价（绑定元宝/件，0 ≤ 值 ≤ 1 亿）。\n" +
      "- `acquireChannel`：获得渠道（upgrade / grant / unavailable；渠道语义与称号一致）。\n" +
      "- `attributes`：八项属性，**整份提交、整份替换**（要求 0 ≤ min ≤ max）。\n" +
      "- `icon` / `inRes` / `outRes`：资源路径（空串 = 不显示 / 不穿；每项 ≤200 字符）。\n" +
      "- `id` 不存在 → 404（`50022`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "时装 id（如 \"cloth_2\"）" })
  @ApiDataResponse(FashionDto, { description: "更新后的时装配置" })
  update(@Param("id") id: string, @Body() dto: UpdateFashionDto): FashionDto {
    return this.gameConfigService.updateFashion(id, dto);
  }
}

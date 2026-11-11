import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { MONEY_KINDS, MONEY_KIND_LABELS } from "../../common/constants/money-items";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { MONEY_ITEM_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import {
  CreateMoneyItemDto,
  MoneyItemDto,
  MoneyItemPageDto,
  MoneyItemQueryDto,
  RemoveMoneyItemResultDto,
  UpdateMoneyItemDto,
} from "./dto/money-item.dto";

/**
 * 管理端 · 货币物品（#785）
 *
 * 背包里「使用后直接入账」的道具：绑定元宝 × 若干面值。
 * **与药品 / 物品那两页不同，这里有完整的增删改** —— 面值是运营自己的事
 * （想开 2000 就开 2000），而且货币道具不被掉落表按 id 固定引用。
 *
 * 使用行为的权威在服务端（`RolesService.useMoneyItem`）：客户端只说「用背包哪一格」，
 * 金额与货币类型一律读本表 —— 运营把 100000 改成 1，玩家下次使用就只加 1。
 *
 * 写操作带 `@AuditTarget("moneyItem")`；资源路径（icon）由运营手填，
 * `audit-resource-refs` 会逐条核对磁盘上有没有那张图。
 */
@ApiAudience("admin")
@Controller("admin/money-items")
export class AdminMoneyItemController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminMoneyItem.list",
    summary: "货币物品列表",
    description:
      "面值表（出厂 3 种货币 × 8 档 = 24 条）。`keyword` 模糊匹配 id / 名称 / 描述；" +
      "`currency` 只看某种货币（" +
      MONEY_KINDS.map((kind) => `${kind} = ${MONEY_KIND_LABELS[kind]}`).join(" / ") +
      "）。\n\n" +
      "`sellPrice` 是客户端条目的售卖价（0 = 不可售卖），**商城售价归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(MONEY_ITEM_SORT)}，\`order\` 取 asc / desc（默认货币升序，同货币按面值升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MoneyItemQueryDto)
  @ApiDataResponse(MoneyItemPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: MoneyItemQueryDto): PageResult<MoneyItemDto> {
    return this.gameConfigService.listMoneyItems(query);
  }

  @Post()
  @AuditTarget("moneyItem")
  @ApiAdminDoc({
    operationId: "adminMoneyItem.create",
    summary: "新建货币物品（一种货币的一档面值）",
    description:
      "**只填货币类型与面值就能建**：`id` / 名称 / 描述 / 图标都可省，缺省按「货币 + 面值」派生" +
      "（`money_bind_gold_100` / 「绑定元宝（100）」/ `item/currency/bind-gold-100`）。\n\n" +
      "- `id` 手填撞已有行 → 409（`50042`）—— 同一个 id 指到哪一档面值就说不清了。\n" +
      "- `currency` 必须是 " +
      MONEY_KINDS.join(" / ") +
      "；`amount` 1 ~ 1000000。\n" +
      "- `icon` 是 resources 相对路径（不带扩展名），素材放 `client/assets/resources/item/currency/`。\n\n" +
      "建完客户端下次拉快照就能在背包里看到并使用了。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MoneyItemDto, { description: "新建的货币物品" })
  create(@Body() dto: CreateMoneyItemDto): MoneyItemDto {
    return this.gameConfigService.createMoneyItem(dto);
  }

  @Patch(":id")
  @AuditTarget("moneyItem")
  @ApiAdminDoc({
    operationId: "adminMoneyItem.update",
    summary: "编辑货币物品",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label` / `description` / `icon`：文案与图标。\n" +
      "- `currency` / `amount`：入账到哪个账本、加多少 —— **改完立刻生效**（使用结算读库，不读快照）。\n" +
      "- `maxStack` / `sellPrice`：堆叠上限 / 售卖价（0 = 不可出售）。\n" +
      "- **`id` 不可改**（路径参数就是主键）：改 id 等于换一件物品，玩家背包里的旧 id 会全变成认不出的格子。\n" +
      "- `id` 不存在 → 404（`50041`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "货币物品 id（如 money_bind_gold_10）" })
  @ApiDataResponse(MoneyItemDto, { description: "更新后的货币物品" })
  update(@Param("id") id: string, @Body() dto: UpdateMoneyItemDto): MoneyItemDto {
    return this.gameConfigService.updateMoneyItem(id, dto);
  }

  @Delete(":id")
  @AuditTarget("moneyItem")
  @ApiAdminDoc({
    operationId: "adminMoneyItem.delete",
    summary: "删除货币物品",
    description:
      "只删配置行。**不碰玩家存档**：背包里还引用这个 id 的格子会变成「认不出的道具」——" +
      "客户端与结算都只是安静跳过（用不了，也不报错）。\n\n" +
      "`id` 不存在 → 404（`50041`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "货币物品 id（如 money_silver_10）" })
  @ApiDataResponse(RemoveMoneyItemResultDto, { description: "删掉了几行" })
  remove(@Param("id") id: string): RemoveMoneyItemResultDto {
    return this.gameConfigService.removeMoneyItem(id);
  }
}

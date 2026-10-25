import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { MONSTER_DROP_SORT, sortFieldNames } from "../../database/sort-specs";
import { DropConfigService } from "./drop-config.service";
import {
  CreateDropTableDto,
  DropTableDto,
  DropTableListDto,
  MonsterDropDto,
  MonsterDropPageDto,
  MonsterDropQueryDto,
  UpdateDropTableDto,
  UpdateMonsterDropDto,
} from "./dto/drop.dto";

/**
 * 管理端 · 掉落配置（#254）
 *
 * 两组接口两种纪律：
 * - **具名掉落表** `/admin/drop-tables`：完整 CRUD —— 掉落表是运营自建的复用资产
 *   （同 mall_prices 的动态增删定位）；被怪物引用中的表拒绝删除（400 + 引用计数）。
 * - **每怪掉落** `/admin/monster-drops`：与怪物一一对应（key 清单固定不可增删）——
 *   只有 list / PATCH **整份替换**（引用具名表 / 内联条目池 / 清空走兜底 三选一）。
 *
 * `picks` / `entries` 存 JSON（结构校验在 service：goodId 要在物品总表里）。
 * 服务端掉落结算（将来的刀）直读这两张表 —— 改表即时生效，无需客户端更新。
 */
@ApiAudience("admin")
@Controller("admin")
export class AdminDropController {
  constructor(private readonly dropConfigService: DropConfigService) {}

  @Get("drop-tables")
  @ApiAdminDoc({
    operationId: "adminDrop.listTables",
    summary: "具名掉落表列表",
    description:
      "一张表一行（量小不分页）。seed 自 configs/drop 的 common / elite / boss + 兜底表 default；" +
      "运营可自建（POST）与删除（DELETE，被怪物引用中的拒绝删）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(DropTableListDto, { description: "具名掉落表列表（list/total）" })
  listTables(): DropTableListDto {
    return this.dropConfigService.listTables();
  }

  @Post("drop-tables")
  @AuditTarget("dropTable")
  @ApiAdminDoc({
    operationId: "adminDrop.createTable",
    summary: "创建具名掉落表",
    description:
      "`id` 由运营自起（小写字母开头的字母/数字/下划线，≤50 字符）；重复 → 400（40000）。\n" +
      "`entries` 每条的 goodId 必须在物品总表里（装备含前后缀变体 / 药品 / 材料）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(DropTableDto, { description: "创建后的具名掉落表" })
  createTable(@Body() dto: CreateDropTableDto): DropTableDto {
    return this.dropConfigService.createTable(dto);
  }

  @Patch("drop-tables/:id")
  @AuditTarget("dropTable")
  @ApiAdminDoc({
    operationId: "adminDrop.updateTable",
    summary: "编辑具名掉落表",
    description:
      "**部分更新**：只改请求体里出现的字段（picks / entries）。\n" +
      "- `id` 不存在 → 404（`50023`）。\n" +
      "- `entries` 整份替换，goodId 必须在物品总表里。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "具名掉落表 id（如 \"common\"）" })
  @ApiDataResponse(DropTableDto, { description: "更新后的具名掉落表" })
  updateTable(@Param("id") id: string, @Body() dto: UpdateDropTableDto): DropTableDto {
    return this.dropConfigService.updateTable(id, dto);
  }

  @Delete("drop-tables/:id")
  @AuditTarget("dropTable")
  @ApiAdminDoc({
    operationId: "adminDrop.removeTable",
    summary: "删除具名掉落表",
    description:
      "被怪物引用中的表拒绝删除（400，附引用计数）；先把这些怪改回内联或换表再删。\n" +
      "`id` 不存在 → 404（`50023`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "具名掉落表 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  removeTable(@Param("id") id: string): null {
    this.dropConfigService.removeTable(id);
    return null;
  }

  @Get("monster-drops")
  @ApiAdminDoc({
    operationId: "adminDrop.listMonsterDrops",
    summary: "每怪掉落列表",
    description:
      "行与怪物一一对应（key 清单固定），**没有创建 / 删除**。`keyword` 模糊匹配怪物 key，" +
      "`source` 按来源筛（table / entries / none）。\n\n" +
      "`source = table` 引用具名表（tableId 非空）；`entries` 内联条目池；" +
      "`none` 未配置走兜底表。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(MONSTER_DROP_SORT)}，\`order\` 取 asc / desc（默认 key 数值升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MonsterDropQueryDto)
  @ApiDataResponse(MonsterDropPageDto, { description: "分页结果（list/total/page/size）" })
  listMonsterDrops(@Query() query: MonsterDropQueryDto): PageResultShape {
    return this.dropConfigService.listMonsterDrops(query);
  }

  @Patch("monster-drops/:monsterKey")
  @AuditTarget("monsterDrop")
  @ApiAdminDoc({
    operationId: "adminDrop.updateMonsterDrop",
    summary: "整份替换一只怪的掉落配置",
    description:
      "**三选一**：\n" +
      "- `tableId` 非空 → 引用具名表（`picks` 可覆盖件数，`entries` 必须不传）；\n" +
      "- `tableId` 为 null 且 `entries` 非空 → 内联条目池（`picks` 必填）；\n" +
      "- `tableId` 为 null 且 `entries` 为 null → 清空（走兜底表）。\n\n" +
      "- `monsterKey` 不存在 → 404（`50024`）；`tableId` 指向的表不存在 → 404（`50023`）。\n" +
      "- 改完即时生效（服务端掉落结算直读本表）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "monsterKey", description: "怪物 key（如 \"1\"）" })
  @ApiDataResponse(MonsterDropDto, { description: "更新后的每怪掉落配置" })
  updateMonsterDrop(@Param("monsterKey") monsterKey: string, @Body() dto: UpdateMonsterDropDto): MonsterDropDto {
    return this.dropConfigService.updateMonsterDrop(monsterKey, dto);
  }
}

/** PageResult 的形状别名（列表接口的返回与 MonsterDropPageDto 同形，避免重复 import 类型） */
type PageResultShape = { list: MonsterDropDto[]; total: number; page: number; size: number };

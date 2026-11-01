import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { MapDetailDto, MapListDto, MapSummaryDto, SaveMapConfigDto } from "./dto/map.dto";
import { MapService } from "./map.service";

/**
 * 管理端 · 地图管理（#571 观测台 / #573 玩法配置可改）
 *
 * ## 能改的和不能改的
 *
 * 能改的只有**玩法配置**那五个字段：名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶
 * （`PATCH /admin/maps/:id`）。它们以前写在客户端 `configs/map.ts` 里，改一个进入等级
 * 要重打整个客户端包；现在归服务端，保存即生效。
 *
 * 不能改的是**资源本体**：TMX、底图、预览图、图层与对象组。服务端连一列都没有 ——
 * 想改地图长什么样，路只有一条：换资源 → `node tools/import-spawn-areas.cjs`（可带 `--db`
 * 覆盖刷怪区）→ 重新打包客户端。所以这里**没有 POST / DELETE**（e2e 固化它们 404）：
 * 一张图存不存在由客户端的 TMX 决定，后台凭空建一行只会得到一张点开就黑屏的图。
 */
@ApiAudience("admin")
@Controller("admin/maps")
export class AdminMapController {
  constructor(private readonly mapService: MapService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminMap.list",
    summary: "地图列表",
    description:
      "全部地图的概览：名称 / 类型 / 进入条件 / 尺寸 + 各类对象计数。\n\n" +
      "计数分两类，**不要混着看**：\n" +
      "- `npcCount` / `monsterAreaCount` / `collisionCount` / `reviveCount`：客户端 TMX 里的对象数（生成快照）；\n" +
      "- `spawnAreaCount` / `worldMonsterCount`：服务端库表里的行数（`map_spawn_areas` / `world_monsters`）。\n\n" +
      "不分页，按 id **数值**升序（`10` 排在 `9` 后面）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MapListDto, { description: "地图列表（total / list）" })
  list(): MapListDto {
    return this.mapService.list();
  }

  @Get(":id")
  @ApiAdminDoc({
    operationId: "adminMap.detail",
    summary: "地图详情",
    description:
      "列表字段 + 图层 + 对象组 + 刷怪区 + 场上怪物 + **每一块数据的来源**（`sources`）。\n\n" +
      "- `layers` / `groups`：TMX 快照，坐标是 **Tiled 原始口径**（左上角原点、y 向下），用于对着编辑器核对；\n" +
      "- `spawnAreas`：服务端整理后的刷怪区（世界坐标，原点 = 地图左上角、y 轴向上）—— 与上面的\n" +
      "  `groups[monster]` 不是同一份数据，页面并排显示就是为了核对两者是否一致；\n" +
      "- `worldMonsters`：按区聚合的场上实例（进程没跑过世界时为空数组）。\n\n" +
      "地图 id 不存在 → 404（`50032`）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiParam({ name: "id", description: "地图 id（= resources/map 下的目录名，如 0 / 10）" })
  @ApiDataResponse(MapDetailDto, { description: "地图详情" })
  detail(@Param("id") id: string): MapDetailDto {
    return this.mapService.detail(id);
  }

  @Patch(":id")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.save",
    summary: "保存地图玩法配置（整份覆盖）",
    description:
      "改的是**整理结果**：名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶。保存后立刻生效 ——\n" +
      "客户端下次进游戏拉配置快照时拿到新值，传送弹窗与 `changeOnMap` 的拦截就按新条件判。\n\n" +
      "- 四个数值字段都允许 `0`，**0 = 不限制**（安全地图就是 0/0/0，不是 1/0/0）；\n" +
      "- `type` 只能是 `0` 安全 / `1` 等级 / `2` 战斗力 / `3` 战魂；\n" +
      "- **整份覆盖**，不是部分更新：分字段更新会让两个人同时编辑时互相覆盖一半。\n\n" +
      "地图 id 不存在 → 404（`50032`）。**没有新建 / 删除接口**：一张图存不存在由客户端的 TMX 决定。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（必须已有对应 TMX 资源）" })
  @ApiDataResponse(MapSummaryDto, { description: "保存后的这一行（含类型名与计数）" })
  save(@Param("id") id: string, @Body() dto: SaveMapConfigDto, @CurrentUser() actor: AuthenticatedUser): MapSummaryDto {
    return this.mapService.save(id, dto, actor);
  }
}

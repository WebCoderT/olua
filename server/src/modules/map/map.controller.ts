import { Controller, Get, Param } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { MapDetailDto, MapListDto } from "./dto/map.dto";
import { MapService } from "./map.service";

/**
 * 管理端 · 地图管理（#571，**只读**）
 *
 * 定位不是编辑器，是观测台：地图的真相在客户端资源里（TMX + `configs/map.ts`），
 * 服务端存的是对它的整理结果（尺寸 / 刷怪区 / 场上怪物）。所以这里**只有两个 GET**，
 * 没有 POST / PATCH / DELETE —— 这不是「还没做」，是刻意的能力边界（e2e 固化三个写路由 404）。
 *
 * 要改地图，路只有一条：改 TMX → `node tools/import-spawn-areas.cjs`（可带 `--db` 覆盖刷怪区）
 * → 重新打包客户端。绕过这条路的「后台改坐标」会让客户端画面与服务端判定各说一套。
 */
@ApiAudience("admin")
@Controller("admin/maps")
export class AdminMapController {
  constructor(private readonly mapService: MapService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminMap.list",
    summary: "地图列表（只读）",
    description:
      "11 张地图的概览：名称 / 类型 / 进入条件 / 尺寸 + 各类对象计数。\n\n" +
      "计数分两类，**不要混着看**：\n" +
      "- `npcCount` / `monsterAreaCount` / `collisionCount` / `reviveCount`：客户端 TMX 里的对象数（生成快照）；\n" +
      "- `spawnAreaCount` / `worldMonsterCount`：服务端库表里的行数（`map_spawn_areas` / `world_monsters`）。\n\n" +
      "不分页（一共 11 张，按 id 数字升序）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MapListDto, { description: "地图列表（total / list）" })
  list(): MapListDto {
    return this.mapService.list();
  }

  @Get(":id")
  @ApiAdminDoc({
    operationId: "adminMap.detail",
    summary: "地图详情（只读）",
    description:
      "列表字段 + 图层 + 对象组 + 刷怪区 + 场上怪物 + **每一块数据的来源**（`sources`）。\n\n" +
      "- `layers` / `groups`：TMX 快照，坐标是 **Tiled 原始口径**（左上角原点、y 向下），用于对着编辑器核对；\n" +
      "- `spawnAreas`：服务端整理后的刷怪区（世界坐标，原点 = 地图左上角、y 轴向上）—— 与上面的\n" +
      "  `groups[monster]` 不是同一份数据，页面并排显示就是为了核对两者是否一致；\n" +
      "- `worldMonsters`：按区聚合的场上实例（进程没跑过世界时为空数组）。\n\n" +
      "地图 id 不存在 → 404（`50032`）。**没有写接口**。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiParam({ name: "id", description: "地图 id（0~10，= resources/map 下的目录名）" })
  @ApiDataResponse(MapDetailDto, { description: "地图详情" })
  detail(@Param("id") id: string): MapDetailDto {
    return this.mapService.detail(id);
  }
}

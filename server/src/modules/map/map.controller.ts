import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import {
  MapDetailDto,
  MapListDto,
  MapSpawnAreaDeletedDto,
  MapSpawnAreaDto,
  MapSummaryDto,
  SaveMapConfigDto,
  SaveSpawnAreaDto,
} from "./dto/map.dto";
import { MapMonitorDto, MapMonitorQueryDto } from "./dto/map-monitor.dto";
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
 * 想改地图长什么样，路只有一条：换资源 → `node tools/import-map-resources.cjs`（可带 `--db`
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

  @Get(":id/monitor")
  @ApiAdminDoc({
    operationId: "adminMap.monitor",
    summary: "实时地图监控",
    description:
      "这张图**此刻**的样子 + 最近的文字流。数据来自实时进程每秒写的两张投影表（`map_monitor_state` / `map_monitor_events`）。\n\n" +
      "- `monsters`：全部实例（含死亡等重生的），`x` / `y` 是**世界坐标** —— 活着的怪是 AI 模拟位置，" +
      "死掉的怪停在死亡点；`respawnInMs` / `respawnAt` 是「下次什么时候刷」；\n" +
      "- `players`：同区同图的玩家（位置来自客户端 `pos` 帧，已过服务端最小仲裁）；\n" +
      "- `events`：击杀（谁在哪打死了什么、掉了什么、几时刷新）与刷新，按时间升序，用 `cursor` 增量拉；\n" +
      "- `staleMs`：快照距今多久。**没人在那张图里时采集器不采样**，这个值会一直涨 —— 页面必须" +
      "照实说「最后采样 N 秒前」，别把停更的图当成「图里什么都没有」。\n\n" +
      "坐标换算：画到地图上要 `tiledY = -y`（与刷怪区同一套世界坐标口径）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiParam({ name: "id", description: "地图 id（= resources/map 下的目录名，如 0 / 10）" })
  @ApiDataResponse(MapMonitorDto, { description: "这一帧的怪物 / 玩家 / 事件 + 游标与新鲜度" })
  monitor(@Param("id") id: string, @Query() query: MapMonitorQueryDto): MapMonitorDto {
    return this.mapService.monitor(id, query);
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

  @Post(":id/spawn-areas")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.createSpawnArea",
    summary: "新建刷怪区（在图上拖一个框）",
    description:
      "管理端地图页「绘制刷怪区」保存时调它。**入参是世界坐标**（原点 = 地图左上角、y 轴向上，故 `cy` 为负），\n" +
      "与读接口的 `spawnAreas` 完全同构 —— 画布（Tiled 口径）负责换算 `cx = x + w/2`、`cy = -(y + h/2)`。\n\n" +
      "四道校验（失败一律 400，`code` 会区分）：\n" +
      "- 地图存在且有像素尺寸（没跑过 `import-map-resources` 的图挡住，否则越界会报成一句看不懂的话）；\n" +
      "- `monsterKey` 在 `monsters` 表里（`50019`）；\n" +
      "- 同图区域名唯一（`20019`，409）；\n" +
      "- 宽高 ≥ 16px，且**整个矩形在图内**（`40000`，文案带四边越界量）。\n\n" +
      "`count` 落库时同时写进 `min` 与 `max`（播种只读 `max`，`min` 留给将来的动态补怪）。\n\n" +
      "**生效时机**：世界只在该图分域「尚无实例」时按区域播种，所以已有玩家在里面的图不会立刻按新区域补怪 ——\n" +
      "要立刻看到效果，得等该分域卸载（10 分钟没人）或重启实时进程。页面照实提示这一点。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（必须已有对应 TMX 资源）" })
  @ApiDataResponse(MapSpawnAreaDto, { description: "新建的这一行（含 id 与越界判定）" })
  createSpawnArea(
    @Param("id") id: string,
    @Body() dto: SaveSpawnAreaDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapSpawnAreaDto {
    return this.mapService.createSpawnArea(id, dto, actor);
  }

  @Patch(":id/spawn-areas/:areaId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.updateSpawnArea",
    summary: "修改刷怪区（整份覆盖）",
    description:
      "改怪、改数量、改位置尺寸都走它，入参与新建完全一致。**整份覆盖**而不是分字段：\n" +
      "表单一次提交，分字段更新只会让两个标签页同时改时互相截半。\n\n" +
      "区域不属于这张图（或已被别人删掉）→ 404 `50033`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "areaId", description: "刷怪区行 id（详情里的 spawnAreas[].id）" })
  @ApiDataResponse(MapSpawnAreaDto, { description: "更新后的这一行" })
  updateSpawnArea(
    @Param("id") id: string,
    @Param("areaId", ParseIntPipe) areaId: number,
    @Body() dto: SaveSpawnAreaDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapSpawnAreaDto {
    return this.mapService.updateSpawnArea(id, areaId, dto, actor);
  }

  @Delete(":id/spawn-areas/:areaId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.deleteSpawnArea",
    summary: "删除刷怪区",
    description:
      "删掉这张图上的一个刷怪区。**场上已经刷出来的怪不会消失** —— 它们的世界实例还在库里，\n" +
      "要等该分域重新加载（没人 10 分钟后卸载 / 重启实时进程）才会按新的区域表重新播种。\n\n" +
      "行不存在或不属于这张图 → 404 `50033`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "areaId", description: "刷怪区行 id" })
  @ApiDataResponse(MapSpawnAreaDeletedDto, { description: "删除结果（deleted + id）" })
  deleteSpawnArea(
    @Param("id") id: string,
    @Param("areaId", ParseIntPipe) areaId: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapSpawnAreaDeletedDto {
    return this.mapService.deleteSpawnArea(id, areaId, actor);
  }
}

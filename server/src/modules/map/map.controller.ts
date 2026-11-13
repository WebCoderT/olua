import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import {
  MapCollisionDeletedDto,
  MapCollisionDto,
  MapDetailDto,
  MapListDto,
  MapNpcDeletedDto,
  MapNpcDto,
  MapReloadBatchDto,
  MapRevivePointClearedDto,
  MapRevivePointDto,
  MapRulesDto,
  MapSpawnAreaDeletedDto,
  MapSpawnAreaDto,
  MapSummaryDto,
  ReloadWorldDto,
  SaveMapCollisionDto,
  SaveMapConfigDto,
  SaveMapNpcDto,
  SaveMapRulesDto,
  SaveRevivePointDto,
  SaveSpawnAreaDto,
} from "./dto/map.dto";
import { MapMonitorDto, MapMonitorQueryDto } from "./dto/map-monitor.dto";
import { MapService } from "./map.service";

/**
 * 管理端 · 地图管理（#571 观测台 / #573 玩法配置可改 / #667 刷怪区 / #672 点位）
 *
 * ## 能改的和不能改的
 *
 * 能改的是**服务端的整理结果**，三块各有自己的接口：
 * - 玩法配置五字段（名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）→ `PATCH /admin/maps/:id`；
 * - 刷怪区 → `POST/PATCH/DELETE /admin/maps/:id/spawn-areas`（#667，地图页拖框）；
 * - NPC 点位与复活点 → `POST/PATCH/DELETE .../npcs`、`PUT/DELETE .../revive-point`（#672，地图页点放 / 拖动）；
 * - 碰撞盒 → `POST/PATCH/DELETE .../collisions`（#676，地图页拖框）。
 *
 * 不能改的是**资源本体**：TMX、底图、预览图。服务端连一列都没有 ——
 * 想改地图长什么样，路只有一条：换资源 → `node tools/import-map-resources.cjs` → 重新打包客户端。
 * 所以**没有「新建 / 删除地图」**（e2e 固化它们 404）：一张图存不存在由客户端的 TMX 决定，
 * 后台凭空建一行只会得到一张点开就黑屏的图。
 *
 * 历史：NPC 点位与复活点（#672）、碰撞盒（#676）以前都写在 TMX 的对象组里，客户端按组读。
 * 现在**地图文件里一个对象组都没有**（`tools/strip-map-objects.cjs` 整组删除），
 * 「地图 = 瓦片 + 图层」只做显示；点位 / 区域 / 碰撞盒全在各自表里，同一套世界坐标口径。
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
      "计数全部是**服务端库表的行数**（#676 起 TMX 里已经没有对象组了）：\n" +
      "- `spawnAreaCount` / `npcPointCount` / `hasRevivePoint` / `collisionCount`：这张图的配置规模；\n" +
      "- `worldMonsterCount`：场上实例数（运行时）。\n\n" +
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
      "列表字段 + 图层 + 刷怪区 + NPC 点位 + 复活点 + 碰撞盒 + 场上怪物 + **每一块数据的来源**（`sources`）。\n\n" +
      "- `layers`：TMX 的图层结构（地图文件里仅剩的数据）；\n" +
      "- `spawnAreas` / `npcPoints` / `revivePoint` / `collisions`：服务端整理后的地图内容\n" +
      "  （世界坐标，原点 = 地图左上角、y 轴向上，故 `cy` 为负）；\n" +
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

  @Post(":id/reload-world")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.reloadWorld",
    summary: "让这张图的房间按现在的刷怪区重新播种",
    description:
      "改完刷怪区之后**立刻生效**的那一步（#809，收 #669）。不调它也不会错 —— 下次有人进图会按新区域播种；\n" +
      "但在图里的玩家会继续看到改之前的怪，直到换图 / 重进。\n\n" +
      "三种选择：\n" +
      "- `mode=reload`：**立刻**执行，连 AI 运行时一起重载。图里的人会看到怪整体重刷一次（掉落 / 血量不保留）；\n" +
      "- `mode=respawn`（不传 `forceAfterMs`）：**等房里没人**再重载，最多等 5 分钟；\n" +
      "- 不调 = 不重载。\n\n" +
      "`forceAfterMs` 是「等空窗的上限」而不是「延迟多久」：房里没人就立刻执行，有人才排队，到点强制\n" +
      "（`0` = 立刻强制）。每次真正执行完，房里的人都会收到一帧 `world.reload`（`data.forced` 标明是不是\n" +
      "到点强制），客户端据此提示「本图怪物已重新刷新」。\n\n" +
      "**一次发给每一个存活区**：刷怪区是全服共用的配置，但每个区各有一份这张图的世界 —— 只重载区 1\n" +
      "会让其它区继续拿着旧区域。回执里 `items` 每个区一条。\n\n" +
      "`merged=true` 表示与已有的 pending 请求合并了（运营连点两下只重播一次；合并取最新的 mode，\n" +
      "`forceAt` 取更早的那个，所以「先排队再点立即」会立刻执行）。\n\n" +
      "**不受影响的范围**（这是 #669 的核心验收）：其它图、其它区的世界状态、玩家背包与任务进度都不动；\n" +
      "重载只重建**这一个房间**的怪物实例。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiDataResponse(MapReloadBatchDto, { description: "每个存活区一条回执（requestId / roomId / plan / forceAt）" })
  reloadWorld(
    @Param("id") id: string,
    @Body() dto: ReloadWorldDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapReloadBatchDto {
    return this.mapService.reloadWorld(id, dto, actor);
  }

  @Get(":id/rules")
  @ApiAdminDoc({
    operationId: "adminMap.rules",
    summary: "地图玩法规则",
    description:
      "这张图的规则（`map_rules` 一行）。**一行不存在 = 全默认**，此时 `inherited=true` ——\n" +
      "页面要把控件显示成「未覆盖」的灰态，否则运营会以为「这张图单独配了 30 人上限」，\n" +
      "等哪天默认值改了，他会发现这张图「自己变了」。\n\n" +
      "字段分三组：\n" +
      "- **结算倍率**（经验 / 掉落 / 金钱）：只在服务端结算时乘，**不进客户端快照** ——\n" +
      "  否则「客户端算的经验」与「服务端给的经验」迟早不一致；\n" +
      "- **房间形状**（单房间人数上限 / 分线数量）：实时进程每次现读，保存即生效；\n" +
      "- **准入与传送**（PK / 自动挂机 / 拉人 / 掉落 / 传送花费与冷却 / 战斗中禁止传送）。\n\n" +
      "`respawnMsOverride` 是这张图的中间级重生时长（毫秒），`null` = 继承全局。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiDataResponse(MapRulesDto, { description: "规则全量（含 inherited 与落款）" })
  rules(@Param("id") id: string): MapRulesDto {
    return this.mapService.rulesOf(id);
  }

  @Patch(":id/rules")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.saveRules",
    summary: "保存地图玩法规则（整份覆盖）",
    description:
      "15 个字段**整份提交**，不是部分更新：其中 7 个是开关，「没传」与「传了 false」在 JSON 里\n" +
      "长得一样，静默把开关关掉是最难查的一类问题。页面先 `GET .../rules` 拿全量（含默认）再改再交。\n\n" +
      "保存后**不需要**再触发一次重载：改的是「这间房能装几个人、怪掉几倍」，不是「房里有几只怪」。\n" +
      "刷怪区改完要生效请调 `POST .../reload-world`。\n\n" +
      "倍率上限 100（再高就不是倍率，是数值配错）；`maxPlayersPerRoom = 0` 表示不限人数；\n" +
      "`maxChannels = 1` 表示不分线。地图不存在 → 404 `50032`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiDataResponse(MapRulesDto, { description: "保存后的全量（inherited 变 false）" })
  saveRules(
    @Param("id") id: string,
    @Body() dto: SaveMapRulesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapRulesDto {
    return this.mapService.saveRules(id, dto, actor);
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

  @Post(":id/npcs")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.createNpc",
    summary: "放一个 NPC 点位（在图上点一下）",
    description:
      "管理端地图页「放置 NPC」保存时调它。**入参是世界坐标**（原点 = 地图左上角、y 轴向上，故 `cy` 为负），\n" +
      "与读接口的 `npcPoints` 完全同构 —— 画布（Tiled 口径）负责换算 `cx = x`、`cy = -y`。\n\n" +
      "#672 之前 NPC 点位写在 TMX 的 `npc` 对象组里（属性 `id` 关联 `npcs` 表），现在点位归这张表，\n" +
      "TMX 那组对象只剩资源对照。\n\n" +
      "四道校验：\n" +
      "- 地图存在且有像素尺寸（`50032`）；\n" +
      "- `npcId` 在 `npcs` 表里（`50034`，404）；\n" +
      "- 同图同 NPC 唯一（`20020`，409）—— 不同图各放一个是正常的（传送使者就是每图一个）；\n" +
      "- 点位在图内（`40000`，文案带「往哪边偏了多少」）。\n\n" +
      "**生效时机**：客户端在进游戏时拉配置快照、按它摆节点，所以图里的人要换图 / 重进才看得到新点位。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（必须已有对应 TMX 资源）" })
  @ApiDataResponse(MapNpcDto, { description: "新建的这一行（含 id / NPC 名 / 越界判定）" })
  createNpc(
    @Param("id") id: string,
    @Body() dto: SaveMapNpcDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapNpcDto {
    return this.mapService.createNpc(id, dto, actor);
  }

  @Patch(":id/npcs/:npcRowId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.updateNpc",
    summary: "修改 NPC 点位（换 NPC / 挪位置，整份覆盖）",
    description:
      "画布上拖动一个已有 NPC 点，松手就调它（`npcId` 原样带回，只换坐标）。\n" +
      "换 NPC 也走这里 —— 入参与新建完全一致，整份覆盖。\n\n" +
      "点位不属于这张图（或已被别人删掉）→ 404 `50035`；改成同图已存在的 NPC → 409 `20020`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "npcRowId", description: "点位行 id（详情里的 npcPoints[].id）" })
  @ApiDataResponse(MapNpcDto, { description: "更新后的这一行" })
  updateNpc(
    @Param("id") id: string,
    @Param("npcRowId", ParseIntPipe) npcRowId: number,
    @Body() dto: SaveMapNpcDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapNpcDto {
    return this.mapService.updateNpc(id, npcRowId, dto, actor);
  }

  @Delete(":id/npcs/:npcRowId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.deleteNpc",
    summary: "删除 NPC 点位",
    description: "删掉这张图上的一个 NPC 点位。图里的人要换图 / 重进才看不到它。\n\n行不存在或不属于这张图 → 404 `50035`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "npcRowId", description: "点位行 id" })
  @ApiDataResponse(MapNpcDeletedDto, { description: "删除结果（deleted + id）" })
  deleteNpc(
    @Param("id") id: string,
    @Param("npcRowId", ParseIntPipe) npcRowId: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapNpcDeletedDto {
    return this.mapService.deleteNpc(id, npcRowId, actor);
  }

  @Post(":id/collisions")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.createCollision",
    summary: "画一个碰撞盒（在图上拖一个框）",
    description:
      "管理端地图页「绘制碰撞盒」保存时调它。**入参是世界坐标**（原点 = 地图左上角、y 轴向上，故 `cy` 为负），\n" +
      "与读接口的 `collisions` 完全同构 —— 画布（Tiled 口径）负责换算 `cx = x + w/2`、`cy = -(y + h/2)`。\n\n" +
      "#676 之前碰撞矩形只写在 TMX 的 `collision` 对象组里（客户端两处读：生成静态碰撞体、自动战斗的静态障碍），\n" +
      "后台只能看。现在归这张表，**TMX 里已经没有对象组了**。\n\n" +
      "校验只有两条：\n" +
      "- 地图存在且有像素尺寸（`50032`）；\n" +
      "- 宽高 ≥ 1px（`40000`）。\n\n" +
      "**故意不判「在图内」**：每张图四面围墙本来就画在图外（`x = -64`、宽 8320），那是把玩家关在图里的手段。\n" +
      "整块在图外的盒子会在详情里标 `fullyOutside`，但不会被拒。\n\n" +
      "**生效时机**：客户端进游戏时按快照铺碰撞体，图里的人要换图 / 重进才生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（必须已有对应 TMX 资源）" })
  @ApiDataResponse(MapCollisionDto, { description: "新建的这一行（含 id）" })
  createCollision(
    @Param("id") id: string,
    @Body() dto: SaveMapCollisionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapCollisionDto {
    return this.mapService.createCollision(id, dto, actor);
  }

  @Patch(":id/collisions/:boxId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.updateCollision",
    summary: "修改碰撞盒（整份覆盖）",
    description:
      "挪位置与改尺寸是同一次动作，入参与新建完全一致。**整份覆盖**而不是分字段：\n" +
      "表单一次提交，分字段更新只会让两个标签页同时改时互相截半。\n\n" +
      "行不属于这张图（或已被别人删掉）→ 404 `50036`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "boxId", description: "碰撞盒行 id（详情里的 collisions[].id）" })
  @ApiDataResponse(MapCollisionDto, { description: "更新后的这一行" })
  updateCollision(
    @Param("id") id: string,
    @Param("boxId", ParseIntPipe) boxId: number,
    @Body() dto: SaveMapCollisionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapCollisionDto {
    return this.mapService.updateCollision(id, boxId, dto, actor);
  }

  @Delete(":id/collisions/:boxId")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.deleteCollision",
    summary: "删除碰撞盒",
    description:
      "删掉这张图上的一个碰撞盒。图里的人要换图 / 重进才会觉得「这里能过去了」——\n" +
      "碰撞体是客户端进图时按快照铺的。\n\n行不存在或不属于这张图 → 404 `50036`。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiParam({ name: "boxId", description: "碰撞盒行 id" })
  @ApiDataResponse(MapCollisionDeletedDto, { description: "删除结果（deleted + id）" })
  deleteCollision(
    @Param("id") id: string,
    @Param("boxId", ParseIntPipe) boxId: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapCollisionDeletedDto {
    return this.mapService.deleteCollision(id, boxId, actor);
  }

  @Put(":id/revive-point")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.setRevivePoint",
    summary: "设 / 挪复活点",
    description:
      "每张图最多一个复活点（沿用 #672 之前的粒度：TMX 里也是每图一个 `class=revive` 的点）。\n" +
      "`PUT` 即覆盖 —— 「设」与「挪」写的是同一对列，没有单独的新增接口。\n\n" +
      "客户端拿它做两件事：**进图时把角色定位到这里**、死亡后「安全复活」回到这里。\n" +
      "没设的图不做定位（角色停在上次的位置），客户端会打一条 warn。\n\n" +
      "校验：地图存在且有像素尺寸（`50032`）、点位在图内（`40000`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiDataResponse(MapRevivePointDto, { description: "设好之后的复活点（含越界判定）" })
  setRevivePoint(
    @Param("id") id: string,
    @Body() dto: SaveRevivePointDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapRevivePointDto {
    return this.mapService.setRevivePoint(id, dto, actor);
  }

  @Delete(":id/revive-point")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMap.clearRevivePoint",
    summary: "清掉复活点",
    description:
      "把这张图的复活点置空（两列置 NULL，不是删地图行）。**幂等**：本来就没有也返回 `cleared: true` ——\n" +
      "「清空」的目标状态是「没有复活点」，重复点一次不该报错。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id" })
  @ApiDataResponse(MapRevivePointClearedDto, { description: "清空结果（cleared 恒为 true）" })
  clearRevivePoint(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser): MapRevivePointClearedDto {
    return this.mapService.clearRevivePoint(id, actor);
  }
}

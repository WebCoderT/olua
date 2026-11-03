import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { MAP_TYPE_GROUPS, MAP_TYPE_LABELS, MapTypeValue, SPAWN_AREA_LIMITS } from "../../common/constants/map-config";
import { BizException } from "../../common/errors/biz.exception";
import { parseMonitorEvent, parseMonitorSnapshot } from "../../common/map-monitor";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import {
  pointInBounds,
  pointOverflowText,
  spawnAreaInBounds,
  spawnAreaOverflow,
} from "../../common/utils/spawn-area-bounds.util";
import { MapMonitorRepository } from "../../database/repositories/map-monitor.repository";
import { MapNpcRepository } from "../../database/repositories/map-npc.repository";
import { NpcRepository } from "../../database/repositories/npc.repository";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { MapRepository } from "../../database/repositories/map.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { MapNpcRow, MapRow, MapSpawnAreaRow, NpcRow } from "../../database/rows";
import { EMPTY_MAP_CONTENT, EMPTY_MAP_PIXEL_SIZE, MapContent, MapPixelSize } from "./map-content";
import {
  MapMonitorDto,
  MapMonitorEventDto,
  MapMonitorMonsterDto,
  MapMonitorPlayerDto,
} from "./dto/map-monitor.dto";
import {
  MapConfigDto,
  MapDetailDto,
  MapGroupDto,
  MapLayerDto,
  MapListDto,
  MapNpcDeletedDto,
  MapNpcDto,
  MapNpcPointDto,
  MapPositionDto,
  MapRevivePointClearedDto,
  MapRevivePointDto,
  MapSourceDto,
  MapSpawnAreaDto,
  MapSpawnAreaPointDto,
  MapSummaryDto,
  MapWorldMonsterDto,
  SaveMapConfigDto,
  SaveMapNpcDto,
  SaveRevivePointDto,
  SaveSpawnAreaDto,
} from "./dto/map.dto";

/**
 * 地图（#571 观测台 / #573 玩法配置归服务端）
 *
 * ## 这一层现在管什么
 *
 * | 数据 | 存放 | 谁能改 |
 * |---|---|---|
 * | `label` / `type` / `level` / `combat` / `soulOfWar` | `maps` 表 | **管理端**（`save`） |
 * | `layers` / `groups` / 尺寸 | `maps` 表的几何列 + `content` JSON（源自 TMX） | 改 TMX + 跑 `import-map-resources` |
 * | `spawnAreas` | `map_spawn_areas` 表 | **管理端绘制**（`createSpawnArea` / `updateSpawnArea` / `deleteSpawnArea`） |
 * | `npcPoints` | `map_npcs` 表 | **管理端点放 / 拖动**（`createNpc` / `updateNpc` / `deleteNpc`） |
 * | `revivePoint` | `maps.revive_cx/cy` | **管理端点选**（`setRevivePoint` / `clearRevivePoint`） |
 * | `worldMonsters` | `world_monsters` 表 | 世界服务运行时写 |
 *
 * 资源本体（TMX / 底图 / 预览图）仍在客户端资源包里 —— 所以**没有「新建地图」**：
 * 行由出厂快照（`server/data/config-sync.sql`）带进来，一张没有 TMX 的「地图」
 * 在客户端点开就是黑屏，后台不该造得出来。
 *
 * ## 为什么没有「拦连接」的判定（#573 考虑过，故意不做）
 *
 * 直觉上「配置归服务端」就该顺手在 `realtime.worldJoin` 上把进入条件也判了，但这条路
 * 走不通 —— 不是偷懒，是三个硬事实：
 *
 * 1. **登录与传送共用同一条 `worldJoin`**，登录时进的就是玩家**脚下那张图**（存档里的
 *    `onMap`）。所以「拦住不合条件的人」会连带拦住「本来就在里面的人」。
 * 2. **运营改配置会立刻生效**：把某张图的进入等级从 10 调到 50，此刻站在那张图里的
 *    低等级玩家下一次登录就被挡在门外 —— 进游戏即黑屏，且他自己没有任何办法出来。
 *    这个事故不需要玩家做错任何事，只要运营点一次保存。
 * 3. **判据本身在客户端已经有唯一入口**：`StorageManager.changeOnMap` 是所有传送的
 *    必经之路，它读的就是服务端下发的这份配置。也就是说「改客户端配置就能进高级图」
 *    这条路在 #573 之后已经不存在了 —— 要绕过得改包。
 *
 * 想做真正的硬门槛，前提是加一条**独立的「我要换图」消息**（客户端改包，Cocos 只能
 * GUI 打包）或让 `worldJoin` 带上「这是传送不是登录」的显式意图；两件都超出「把配置
 * 搬到服务端」的范围，记在这里等真需要时再做。
 */
@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  constructor(
    private readonly maps: MapRepository,
    private readonly spawnAreas: MapSpawnAreaRepository,
    private readonly npcPoints: MapNpcRepository,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly monsters: MonsterRepository,
    private readonly npcs: NpcRepository,
    private readonly monitorRows: MapMonitorRepository,
  ) {}


  /** 列表：全部图 + 各类对象计数（客户端资源）+ 服务端三处统计 */
  list(): MapListDto {
    const spawnCounts = new Map(this.spawnAreas.countByMap().map((row) => [row.map_id, row.total]));
    const npcCounts = new Map(this.npcPoints.countByMap().map((row) => [row.map_id, row.total]));
    const monsterCounts = this.worldMonsterTotals();

    const list = this.maps
      .listAll()
      .map((row) =>
        this.summaryOf(
          row,
          spawnCounts.get(row.map_id) ?? 0,
          monsterCounts.get(row.map_id) ?? 0,
          npcCounts.get(row.map_id) ?? 0,
        ),
      );
    const dto = new MapListDto();
    dto.total = list.length;
    dto.list = list;
    // 类型下拉的选项（含当下没有图在用的类型 —— 运营得能把一张图改成「战魂地图」）
    dto.types = MAP_TYPE_GROUPS.map((group) => ({ type: group.type, label: group.label }));
    return dto;
  }

  /**
   * 玩法配置的精简列表（**配置快照用**）
   *
   * 客户端进游戏要的是：凭 `id` 拼资源路径、凭 `label` 显示名字、凭 `type` 分桶、
   * 凭三个数值判「能不能进」，以及 #672 起的三块点位（NPC / 复活点 / 刷怪区中心）——
   * 这三样以前客户端是从 TMX 的对象组里读的，现在 TMX 不再是来源。
   * 尺寸与对象数仍然不发：客户端自己有 TMX。
   */
  configs(): MapConfigDto[] {
    return this.maps.listAll().map((row) => ({
      id: row.map_id,
      label: row.label,
      type: row.type,
      typeLabel: MAP_TYPE_LABELS[row.type as MapTypeValue] ?? row.type,
      level: row.level,
      combat: row.combat,
      soulOfWar: row.soul_of_war,
      npcs: this.npcPoints.listByMap(row.map_id).map((point) => this.npcPointDtoOf(point)),
      revive: this.revivePointDtoOf(row),
      spawnAreas: this.spawnAreas.listByMap(row.map_id).map((area) => this.spawnAreaPointDtoOf(area)),
    }));
  }

  /**
   * 实时地图监控（#665）：这张图此刻的样子 + 最近的文字流
   *
   * ## 为什么读库而不是问实时进程
   *
   * 世界状态只活在实时进程内存里，本进程（存档 / 管理端 API）拿不到；两个进程之间只有
   * 共享 SQLite（同 `monster-ai` 顶部说明）。实时进程的 `MapMonitorService` 每秒把状态投影
   * 进 `map_monitor_state`，击杀 / 刷新写 `map_monitor_events` —— 这里只做「读 + 拼」。
   *
   * ## 三个必须照实返回的东西
   *
   * 1. **`staleMs`**：没人在那张图里时采集器不采样，快照会停住。页面必须能说
   *    「最后采样 3 分钟前」，否则一张停更的图看起来和「图里没人、怪也都不在」一模一样；
   * 2. **`zones`**：同一张图每个区各有一份世界（#295），监控得能切区；
   * 3. **`cursor`**：事件按 id 增量拉，页面不会每秒重画 300 行。
   *
   * 快照坏掉（半截 JSON）时返回空列表 + `sampledAt = null`，不抛 500 —— 一张图的镜像
   * 坏了不该让整个监控接口挂掉，页面会显示「没有可用快照」。
   */
  monitor(id: string, query: { zone?: number; since?: number; limit?: number }): MapMonitorDto {
    const row = this.requireRow(id);
    const size = this.sizeOf(row);
    const states = this.monitorRows.listStates(id);
    // 不指定区就用「最新写过快照的那个区」—— 玩家在哪个区，就看到哪个区
    const zoneId = query.zone ?? states[0]?.zone_id ?? 1;
    const state = states.find((item) => item.zone_id === zoneId) ?? null;
    const snapshot = parseMonitorSnapshot(state?.payload);
    const now = Date.now();
    const since = Math.max(0, query.since ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 60));

    const eventRows = this.monitorRows.listEvents(zoneId, id, since, limit);
    const events: MapMonitorEventDto[] = [];
    for (const eventRow of eventRows) {
      const parsed = parseMonitorEvent(eventRow.payload);
      if (!parsed) continue;
      const dto = new MapMonitorEventDto();
      dto.id = eventRow.id;
      dto.at = parsed.at;
      dto.kind = parsed.kind;
      dto.instanceId = parsed.instanceId;
      dto.monsterKey = parsed.monsterKey;
      dto.label = parsed.label;
      dto.x = parsed.x;
      dto.y = parsed.y;
      dto.killer = parsed.kind === "kill" ? parsed.killer : "";
      dto.drops = parsed.kind === "kill" ? parsed.drops : [];
      dto.respawnAt = parsed.kind === "kill" ? parsed.respawnAt : 0;
      events.push(dto);
    }

    const dto = new MapMonitorDto();
    dto.mapId = id;
    dto.mapLabel = row.label;
    dto.width = size.width;
    dto.height = size.height;
    dto.zoneId = zoneId;
    dto.zones = states.map((item) => item.zone_id).sort((left, right) => left - right);
    dto.sampledAt = snapshot?.sampledAt ?? null;
    dto.updatedAt = state?.updated_at ?? null;
    dto.staleMs = state ? Math.max(0, now - state.updated_at) : null;
    dto.monsters = (snapshot?.monsters ?? []).map((monster) => {
      const item = new MapMonitorMonsterDto();
      item.instanceId = monster.instanceId;
      item.monsterKey = monster.monsterKey;
      item.label = monster.label;
      item.x = monster.x;
      item.y = monster.y;
      item.hp = monster.hp;
      item.maxHp = monster.maxHp;
      item.alive = monster.alive;
      // 倒计时按「现在」重算：快照里的 respawnInMs 是采样那一刻的数，页面晚 300ms 打开就偏了
      item.respawnInMs =
        monster.respawnAt === null ? null : Math.max(0, monster.respawnAt - now);
      item.respawnAt = monster.respawnAt;
      return item;
    });
    dto.players = (snapshot?.players ?? []).map((player) => {
      const item = new MapMonitorPlayerDto();
      item.accountId = player.accountId;
      item.name = player.name;
      item.x = player.x;
      item.y = player.y;
      item.hp = player.hp;
      item.maxHp = player.maxHp;
      item.moving = player.moving;
      return item;
    });
    dto.events = events;
    // 没有新事件时游标不能往前跳：原样回传 since，页面下一轮还从老地方问
    const lastId = events.length > 0 ? events[events.length - 1].id : 0;
    dto.cursor = lastId > 0 ? lastId : since;
    return dto;
  }

  /** 详情：基础 + 图层 + 对象组 + 刷怪区 + NPC/复活点 + 场上怪物 + 来源说明 */
  detail(id: string): MapDetailDto {
    const row = this.requireRow(id);
    const content = this.contentOf(row);
    const groups = content.groups.map((group) => {
      const dto = new MapGroupDto();
      dto.name = group.name;
      dto.objects = group.objects.map((object) => ({ ...object, properties: { ...object.properties } }));
      return dto;
    });

    // 越界判定按「这张图的实际像素尺寸」算（maps 表的几何列，与 TMX 头一致）。
    // 判据只在服务端一处：页面直接显示 inBounds，不自己再算一遍 —— 两边各算迟早会分叉。
    const mapPixel = this.sizeOf(row);
    const areas: MapSpawnAreaDto[] = this.spawnAreas.listByMap(id).map((area) => this.areaDtoOf(area, mapPixel));
    const npcPoints: MapNpcDto[] = this.npcPoints.listByMap(id).map((point) => this.npcDtoOf(point, mapPixel));

    const worldMonsters: MapWorldMonsterDto[] = this.worldMonsters
      .countByMap()
      .filter((item) => item.map_id === id)
      .map((item) => ({ zoneId: item.zone_id, total: item.total, alive: Number(item.alive) || 0 }));

    const summary = this.summaryOf(
      row,
      areas.length,
      worldMonsters.reduce((total, item) => total + item.total, 0),
      npcPoints.length,
    );
    const detail = Object.assign(new MapDetailDto(), summary);
    detail.layers = content.layers.map((layer) => {
      const dto = new MapLayerDto();
      dto.name = layer.name;
      dto.width = layer.width;
      dto.height = layer.height;
      return dto;
    });
    detail.groups = groups;
    detail.spawnAreas = areas;
    detail.npcPoints = npcPoints;
    detail.revivePoint = this.revivePointOf(row, mapPixel);
    detail.worldMonsters = worldMonsters;
    detail.sources = this.sources();
    return detail;
  }

  /**
   * 保存一张图的玩法配置（整份覆盖）
   *
   * **读库即最新**：快照接口每次查表，所以保存后下一位进游戏的玩家就按新条件判 ——
   * 不需要「刷新运行时覆盖层」那一层（那是给战斗数值用的，地图没有参与结算的数值）。
   */
  save(id: string, dto: SaveMapConfigDto, actor: AuthenticatedUser): MapSummaryDto {
    const before = this.requireRow(id);
    const row: MapRow = {
      ...before,
      label: dto.label.trim(),
      type: dto.type,
      level: dto.level,
      combat: dto.combat,
      soul_of_war: dto.soulOfWar,
      updated_by: actor.username,
      updated_at: Date.now(),
    };
    this.maps.update(row);
    this.logger.log(
      `地图 ${id} 配置已更新：${before.label} → ${row.label} / 类型 ${before.type}→${row.type} / ` +
        `等级 ${before.level}→${row.level} / 战力 ${before.combat}→${row.combat} / 战魂 ${before.soul_of_war}→${row.soul_of_war}`,
    );
    return this.summaryOf(
      row,
      this.spawnAreas.countByMap().find((item) => item.map_id === id)?.total ?? 0,
      0,
      this.npcPoints.listByMap(id).length,
    );
  }

  //#region 刷怪区（#667：后台直接画）

  /**
   * 新建一个刷怪区
   *
   * 四道校验都在这里，**不放进 DTO**：DTO 只拦格式（非空、范围、数字），
   * 「怪物 key 在不在 monsters 表」「矩形在不在图内」需要读库、读这张图的几何，
   * 属于业务判断。放在一处也让 e2e 能直接对着文案断言。
   */
  createSpawnArea(mapId: string, dto: SaveSpawnAreaDto, actor: AuthenticatedUser): MapSpawnAreaDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const name = dto.name.trim();
    this.requireMonster(dto.monsterKey);
    this.requireNameFree(mapId, name, null);
    const box = this.requireAreaBox(mapPixel, dto);

    const created = this.spawnAreas.insert({
      map_id: mapId,
      name,
      monster_key: dto.monsterKey,
      min: dto.count,
      max: dto.count,
      cx: box.cx,
      cy: box.cy,
      w: box.w,
      h: box.h,
      updated_at: Date.now(),
    });
    this.logger.log(
      `地图 ${mapId} 新增刷怪区 #${created.id}「${name}」：${dto.monsterKey} × ${dto.count} @ ` +
        `(${box.cx}, ${box.cy}) ${box.w}×${box.h}（by ${actor.username}）`,
    );
    return this.areaDtoOf(created, mapPixel);
  }

  /**
   * 改一个刷怪区（整份覆盖，不是部分更新）
   *
   * 位置尺寸也允许改：画完发现框偏了一点，重画一个再删掉旧的太笨。
   */
  updateSpawnArea(mapId: string, areaId: number, dto: SaveSpawnAreaDto, actor: AuthenticatedUser): MapSpawnAreaDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const before = this.requireArea(mapId, areaId);
    const name = dto.name.trim();
    this.requireMonster(dto.monsterKey);
    this.requireNameFree(mapId, name, areaId);
    const box = this.requireAreaBox(mapPixel, dto);

    this.spawnAreas.update({
      ...before,
      name,
      monster_key: dto.monsterKey,
      min: dto.count,
      max: dto.count,
      cx: box.cx,
      cy: box.cy,
      w: box.w,
      h: box.h,
      updated_at: Date.now(),
    });
    this.logger.log(
      `地图 ${mapId} 刷怪区 #${areaId}「${before.name}」已更新：${before.monster_key} × ${before.max} → ` +
        `${dto.monsterKey} × ${dto.count}（by ${actor.username}）`,
    );
    const updated = this.spawnAreas.findById(areaId);
    if (!updated) throw new Error(`刷怪区 #${areaId} 刚更新却读不回来，库状态异常`);
    return this.areaDtoOf(updated, mapPixel);
  }

  /** 删一个刷怪区（删完这张图少一个区域；场上已有的怪不会消失，下一轮加载才按新区域播种） */
  deleteSpawnArea(mapId: string, areaId: number, actor: AuthenticatedUser): { deleted: true; id: number } {
    const before = this.requireArea(mapId, areaId);
    this.spawnAreas.remove(areaId);
    this.logger.log(`地图 ${mapId} 刷怪区 #${areaId}「${before.name}」已删除（by ${actor.username}）`);
    return { deleted: true, id: areaId };
  }

  /**
   * 能画的图：必须存在，且**必须有几何尺寸**
   *
   * 少了后半条会出现最难受的一种失败：图没有像素尺寸 → `spawnAreaInBounds` 把所有矩形都判越界
   * → 报「越出地图边界 8192px」这种看着像坐标算错、实际是「这张图还没导入过几何」的话。
   * 直接说不行，比让人去猜好。
   */
  private requireDrawableMap(mapId: string): { row: MapRow; mapPixel: MapPixelSize } {
    const row = this.requireRow(mapId);
    const mapPixel = this.sizeOf(row);
    if (mapPixel.width <= 0 || mapPixel.height <= 0) {
      throw new BizException(
        BizCode.MAP_NOT_FOUND,
        `地图 ${mapId} 没有像素尺寸（库里几何列是 0），没法判断区域是否在图内 —— 先跑 node tools/import-map-resources.cjs 补齐几何`,
      );
    }
    return { row, mapPixel };
  }

  /** 怪物 key 必须在 monsters 表里（播种时也是同一判据：不认识就跳过并告警，这里提前拦住） */
  private requireMonster(monsterKey: string): void {
    if (!this.monsters.findByKey(monsterKey)) {
      throw BizException.notFound(BizCode.MONSTER_NOT_FOUND, `怪物 ${monsterKey} 不存在（monsters 表里没有这个 key）`);
    }
  }

  /** 同图区域名唯一（`exceptId` = 改的时候排除自己） */
  private requireNameFree(mapId: string, name: string, exceptId: number | null): void {
    const twin = this.spawnAreas.findByName(mapId, name);
    if (twin && twin.id !== exceptId) {
      throw BizException.conflict(BizCode.MAP_SPAWN_AREA_NAME_TAKEN, `这张图里已经有一个叫「${name}」的刷怪区（#${twin.id}）`);
    }
  }

  /**
   * 矩形合法性 + 在图内
   *
   * 越界**直接拒**（#586 只对历史数据告警，是因为那时候区域是导入进来的、拦了会变成
   * 「这张图一只怪都没有」）。现在区域是人在图上画的 —— 画的时候就在图上，
   * 越界只可能是算错了坐标，没有理由放行。数值统一收两位小数，与导入工具的落库口径一致。
   */
  private requireAreaBox(
    mapPixel: MapPixelSize,
    dto: SaveSpawnAreaDto,
  ): { cx: number; cy: number; w: number; h: number } {
    const box = { cx: round2(dto.cx), cy: round2(dto.cy), w: round2(dto.w), h: round2(dto.h) };
    if (box.w < SPAWN_AREA_LIMITS.minSize || box.h < SPAWN_AREA_LIMITS.minSize) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `刷怪区太小（${box.w}×${box.h}），宽高都不能小于 ${SPAWN_AREA_LIMITS.minSize} 像素`,
      );
    }
    if (!spawnAreaInBounds(box, mapPixel)) {
      const overflow = spawnAreaOverflow(box, mapPixel);
      const parts = [
        overflow.left > 0 ? `左 ${overflow.left}` : "",
        overflow.right > 0 ? `右 ${overflow.right}` : "",
        overflow.top > 0 ? `上 ${overflow.top}` : "",
        overflow.bottom > 0 ? `下 ${overflow.bottom}` : "",
      ].filter(Boolean);
      throw new BizException(
        BizCode.PARAM_INVALID,
        `刷怪区超出地图边界（${parts.join("、")} px），地图是 ${mapPixel.width}×${mapPixel.height} —— ` +
          `世界坐标范围 x ∈ [0, ${mapPixel.width}]、y ∈ [-${mapPixel.height}, 0]`,
      );
    }
    return box;
  }

  /** 取一个刷怪区，且必须属于路径里那张图（防止拿 A 图的 areaId 去改 B 图） */
  private requireArea(mapId: string, areaId: number): MapSpawnAreaRow {
    const area = this.spawnAreas.findById(areaId);
    if (!area || area.map_id !== mapId) {
      throw BizException.notFound(BizCode.MAP_SPAWN_AREA_NOT_FOUND, `地图 ${mapId} 没有刷怪区 #${areaId}`);
    }
    return area;
  }

  /** 行 → DTO（越界量与读接口同源：`spawnAreaInBounds` 是唯一判据） */
  private areaDtoOf(area: MapSpawnAreaRow, mapPixel: MapPixelSize): MapSpawnAreaDto {
    return {
      id: area.id,
      name: area.name,
      monsterKey: area.monster_key,
      monsterLabel: this.monsterLabelOf(area.monster_key),
      min: area.min,
      max: area.max,
      cx: area.cx,
      cy: area.cy,
      w: area.w,
      h: area.h,
      inBounds: spawnAreaInBounds(area, mapPixel),
      overflow: spawnAreaOverflow(area, mapPixel),
    };
  }

  //#endregion

  //#region 点位（#672：NPC 与复活点从 TMX 搬到后台）

  /**
   * 放一个 NPC 点位
   *
   * 四道校验与刷怪区同款（图有几何 / NPC 存在 / 同图不重复 / 点在图内），
   * 只是「名字唯一」换成了「(map_id, npc_id) 唯一」—— 同一个 NPC 在一张图摆两份没有意义，
   * 在**不同图**各摆一个是正常的（传送使者就是每张图一个）。
   */
  createNpc(mapId: string, dto: SaveMapNpcDto, actor: AuthenticatedUser): MapNpcDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const npc = this.requireNpc(dto.npcId);
    this.requireNpcFree(mapId, npc.id, null);
    const point = this.requirePointInBounds(mapPixel, dto, "NPC 点位");

    const created = this.npcPoints.insert({
      map_id: mapId,
      npc_id: npc.id,
      cx: point.cx,
      cy: point.cy,
      updated_at: Date.now(),
    });
    this.logger.log(
      `地图 ${mapId} 新增 NPC 点位 #${created.id}：${npc.label}(${npc.id}) @ (${point.cx}, ${point.cy})（by ${actor.username}）`,
    );
    return this.npcDtoOf(created, mapPixel);
  }

  /**
   * 改一个 NPC 点位（整份覆盖：换 NPC 与挪位置是同一次动作）
   *
   * 画布上拖动走的也是它 —— 拖完只提交新坐标，`npcId` 原样带回。
   */
  updateNpc(mapId: string, pointId: number, dto: SaveMapNpcDto, actor: AuthenticatedUser): MapNpcDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const before = this.requireNpcPoint(mapId, pointId);
    const npc = this.requireNpc(dto.npcId);
    this.requireNpcFree(mapId, npc.id, pointId);
    const point = this.requirePointInBounds(mapPixel, dto, "NPC 点位");

    this.npcPoints.update({ ...before, npc_id: npc.id, cx: point.cx, cy: point.cy, updated_at: Date.now() });
    this.logger.log(
      `地图 ${mapId} NPC 点位 #${pointId} 已更新：${before.npc_id} (${before.cx}, ${before.cy}) → ` +
        `${npc.id} (${point.cx}, ${point.cy})（by ${actor.username}）`,
    );
    const updated = this.npcPoints.findById(pointId);
    if (!updated) throw new Error(`NPC 点位 #${pointId} 刚更新却读不回来，库状态异常`);
    return this.npcDtoOf(updated, mapPixel);
  }

  /** 删一个 NPC 点位（客户端下次进图就没有这个 NPC 了；已经在图里的人要换图才生效） */
  deleteNpc(mapId: string, pointId: number, actor: AuthenticatedUser): MapNpcDeletedDto {
    const before = this.requireNpcPoint(mapId, pointId);
    this.npcPoints.remove(pointId);
    this.logger.log(`地图 ${mapId} NPC 点位 #${pointId}（${before.npc_id}）已删除（by ${actor.username}）`);
    return { deleted: true, id: pointId };
  }

  /**
   * 设 / 挪复活点（每张图一个，`PUT` 即覆盖）
   *
   * 没有**独立的**「设」与「挪」：两件事写的是同一对列，多一个接口只会多一条要测的分支。
   */
  setRevivePoint(mapId: string, dto: SaveRevivePointDto, actor: AuthenticatedUser): MapRevivePointDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const point = this.requirePointInBounds(mapPixel, dto, "复活点");
    this.maps.setRevivePoint(mapId, point.cx, point.cy);
    this.logger.log(`地图 ${mapId} 复活点已设为 (${point.cx}, ${point.cy})（by ${actor.username}）`);
    return { cx: point.cx, cy: point.cy, inBounds: pointInBounds(point, mapPixel) };
  }

  /** 清掉复活点（幂等：本来就没有也返回 cleared —— 清空是「变成没有」，不是「删一行」） */
  clearRevivePoint(mapId: string, actor: AuthenticatedUser): MapRevivePointClearedDto {
    this.requireRow(mapId);
    this.maps.setRevivePoint(mapId, null, null);
    this.logger.log(`地图 ${mapId} 复活点已清除（by ${actor.username}）`);
    return { cleared: true };
  }

  /** NPC 必须在 npcs 表里（清单固定，没有「新建 NPC」接口 —— 这里拦住拼错的 id） */
  private requireNpc(npcId: string): NpcRow {
    const npc = this.npcs.findByKey(npcId.trim());
    if (!npc) {
      throw BizException.notFound(BizCode.MAP_NPC_NOT_FOUND, `NPC ${npcId} 不存在（npcs 表里没有这个 id）`);
    }
    return npc;
  }

  /** 同图同 NPC 唯一（`exceptId` = 改的时候排除自己） */
  private requireNpcFree(mapId: string, npcId: string, exceptId: number | null): void {
    const twin = this.npcPoints.findByNpc(mapId, npcId);
    if (twin && twin.id !== exceptId) {
      throw BizException.conflict(
        BizCode.MAP_NPC_DUPLICATED,
        `这张图已经有一个 NPC ${npcId} 了（点位 #${twin.id}）—— 想摆第二个请先挪走或删掉它`,
      );
    }
  }

  /** 取一个点位，且必须属于路径里那张图（防止拿 A 图的点位 id 去改 B 图） */
  private requireNpcPoint(mapId: string, pointId: number): MapNpcRow {
    const point = this.npcPoints.findById(pointId);
    if (!point || point.map_id !== mapId) {
      throw BizException.notFound(BizCode.MAP_NPC_POINT_NOT_FOUND, `地图 ${mapId} 没有 NPC 点位 #${pointId}`);
    }
    return point;
  }

  /**
   * 点位在图内（与刷怪区同一套边界判据、同一个容差）
   *
   * 越界直接拒：点位是在画布上点出来的，点到图外只有两种可能 —— 手滑，或者坐标口径搞错了
   * （y 忘了取反）。报「右 32 / 下 96」而不是只说「越界」，就是为了让人一眼看出是哪种。
   */
  private requirePointInBounds(
    mapPixel: MapPixelSize,
    point: { cx: number; cy: number },
    what: string,
  ): { cx: number; cy: number } {
    const rounded = { cx: round2(point.cx), cy: round2(point.cy) };
    if (!pointInBounds(rounded, mapPixel)) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `${what}超出地图边界（${pointOverflowText(rounded, mapPixel)} px），地图是 ${mapPixel.width}×${mapPixel.height} —— ` +
          `世界坐标范围 x ∈ [0, ${mapPixel.width}]、y ∈ [-${mapPixel.height}, 0]`,
      );
    }
    return rounded;
  }

  /** 行 → DTO（越界结论与读接口同源：`pointInBounds` 是唯一判据） */
  private npcDtoOf(point: MapNpcRow, mapPixel: MapPixelSize): MapNpcDto {
    return {
      id: point.id,
      npcId: point.npc_id,
      npcLabel: this.npcLabelOf(point.npc_id),
      cx: point.cx,
      cy: point.cy,
      inBounds: pointInBounds(point, mapPixel),
    };
  }

  /** 复活点 → DTO（两列任一为空就当没有：它们同生同灭，半截数据按「没有」处理） */
  private revivePointOf(row: MapRow, mapPixel: MapPixelSize): MapRevivePointDto | null {
    if (row.revive_cx === null || row.revive_cy === null) return null;
    const point = { cx: row.revive_cx, cy: row.revive_cy };
    return { ...point, inBounds: pointInBounds(point, mapPixel) };
  }

  /** NPC 名（查不到就回落成 id：删了一行 NPC 配置也不该让地图页 500） */
  private npcLabelOf(npcId: string): string {
    return this.npcs.findByKey(npcId)?.label ?? npcId;
  }

  /** 下发客户端用的点位（只有「谁」和「在哪」；管理端那一份走 `npcDtoOf`，多 id 与越界结论） */
  private npcPointDtoOf(point: MapNpcRow): MapNpcPointDto {
    return { npcId: point.npc_id, x: point.cx, y: point.cy };
  }

  /** 下发客户端用的刷怪区中心（客户端只要「在哪画一个区域名标签」） */
  private spawnAreaPointDtoOf(area: MapSpawnAreaRow): MapSpawnAreaPointDto {
    return { monsterKey: area.monster_key, cx: area.cx, cy: area.cy };
  }

  /** 下发客户端用的复活点（两列任一为空就当没有） */
  private revivePointDtoOf(row: MapRow): MapPositionDto | null {
    if (row.revive_cx === null || row.revive_cy === null) return null;
    return { x: row.revive_cx, y: row.revive_cy };
  }

  //#endregion

  /** 取一行，没有就 404（用 notFound：`new BizException(code, msg)` 默认是 400） */
  private requireRow(id: string): MapRow {
    const row = this.maps.getById(id);
    if (!row) {
      throw BizException.notFound(BizCode.MAP_NOT_FOUND, `地图 ${id} 不存在（资源清单里没有这张图）`);
    }
    return row;
  }

  /** 资源路径（约定：`resources/map/<id>/<id>.tmx`；客户端按同一规则拼，服务端只回显） */
  private srcOf(id: string): string {
    return `map/${id}/${id}`;
  }

  /** 尺寸（`maps` 表的几何列）；一行没补过几何时按 0 展示，并留一条 warn 便于批量排查 */
  private sizeOf(row: MapRow): MapPixelSize {
    if (row.pixel_width > 0 && row.pixel_height > 0) {
      return {
        cols: row.grid_cols,
        rows: row.grid_rows,
        tileWidth: row.tile_width,
        tileHeight: row.tile_height,
        width: row.pixel_width,
        height: row.pixel_height,
      };
    }
    this.logger.warn(`地图 ${row.map_id} 没有几何（重跑 node tools/import-map-resources.cjs）`);
    return EMPTY_MAP_PIXEL_SIZE;
  }

  /** 图层 + 对象组（`maps.content` 列；JSON 坏了只影响这一张图的详情，不让列表 500） */
  private contentOf(row: MapRow): MapContent {
    try {
      const parsed = JSON.parse(row.content || "{}") as Partial<MapContent>;
      if (Array.isArray(parsed.layers) && Array.isArray(parsed.groups)) {
        return { layers: parsed.layers, groups: parsed.groups };
      }
    } catch {
      /* 落到下面的空内容 + warn */
    }
    this.logger.warn(`地图 ${row.map_id} 的内容列不是合法 JSON（重跑 node tools/import-map-resources.cjs）`);
    return EMPTY_MAP_CONTENT;
  }

  private monsterLabelOf(key: string): string {
    // 数值（含名称）的唯一来源是 monsters 表（#588）：表里没有这只怪（种子没灌 / 被删行）就显示 key
    return this.monsters.findByKey(key)?.label ?? key;
  }

  /** map_id → 全场实例数（跨区合计），列表只需要这个数 */
  private worldMonsterTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const row of this.worldMonsters.countByMap()) {
      totals.set(row.map_id, (totals.get(row.map_id) ?? 0) + row.total);
    }
    return totals;
  }

  /** 列表/详情共用的一份基础字段 */
  private summaryOf(
    row: MapRow,
    spawnAreaCount: number,
    worldMonsterCount: number,
    npcPointCount: number,
  ): MapSummaryDto {
    const id = row.map_id;
    const size = this.sizeOf(row);
    const content = this.contentOf(row);

    // npc / revive 的对象类可能落在 npc 组，也可能在早期地图的 objects 组里 —— 按 klass 全组扫
    const allObjects = content.groups.flatMap((group) => group.objects);
    const dto = new MapSummaryDto();
    dto.id = id;
    dto.label = row.label;
    dto.type = row.type;
    dto.typeLabel = MAP_TYPE_LABELS[row.type as MapTypeValue] ?? row.type;
    dto.level = row.level;
    dto.combat = row.combat;
    dto.soulOfWar = row.soul_of_war;
    dto.src = this.srcOf(id);
    dto.cols = size.cols;
    dto.rows = size.rows;
    dto.tileWidth = size.tileWidth;
    dto.tileHeight = size.tileHeight;
    dto.width = size.width;
    dto.height = size.height;
    dto.layerCount = content.layers.length;
    dto.npcCount = allObjects.filter((object) => object.klass === "npc").length;
    dto.npcPointCount = npcPointCount;
    dto.hasRevivePoint = row.revive_cx !== null && row.revive_cy !== null;
    dto.monsterAreaCount = content.groups.find((group) => group.name === "monster")?.objects.length ?? 0;
    dto.collisionCount = content.groups.find((group) => group.name === "collision")?.objects.length ?? 0;
    dto.reviveCount = allObjects.filter((object) => object.klass === "revive").length;
    dto.spawnAreaCount = spawnAreaCount;
    dto.worldMonsterCount = worldMonsterCount;
    return dto;
  }

  /** 每一块数据的来源（页面按 section 匹配并打徽标） */
  private sources(): MapSourceDto[] {
    return [
      {
        section: "config",
        label: "地图玩法配置",
        origin: "db",
        ref: "maps 表",
        note: "名称 / 类型 / 进入条件是服务端的整理结果，**就在这一页改**，保存即生效（服务端进图校验读同一张表）。",
      },
      {
        section: "resource",
        label: "资源本体（TMX / 底图 / 预览图）",
        origin: "config",
        ref: "client/assets/resources/map/<id>/",
        note: "资源在客户端资源包里，后台改不了；换图要换资源，再跑 tools/import-map-resources.cjs 重新生成下面两块。",
      },
      {
        section: "size",
        label: "地图尺寸",
        origin: "db",
        ref: "maps 表（几何列）",
        note: "由 tools/import-map-resources.cjs 从 TMX 头直接写库；换图后重跑工具即可，页面只读。",
      },
      {
        section: "layers",
        label: "图层",
        origin: "db",
        ref: "maps 表（content 列）",
        note: "TMX 的图层结构（JSON）；瓦片数据留在客户端资源里，这里只列结构。",
      },
      {
        section: "groups",
        label: "对象组（Tiled 原始坐标）",
        origin: "db",
        ref: "maps 表（content 列）",
        note: "坐标是 Tiled 原始口径（左上角、y 向下），用来对着编辑器核对；不是服务端在用的世界坐标。#672 起 npc 组只是资源对照（点位归下面的两张表），碰撞盒仍由客户端读它生成。",
      },
      {
        section: "spawnAreas",
        label: "刷怪区（服务端整理后）",
        origin: "db",
        ref: "map_spawn_areas 表",
        note: "在地图页上拖框绘制（#667 起归后台）；世界播种直接读它。改动在该图世界实例重新加载后生效。",
      },
      {
        section: "npcPoints",
        label: "NPC 点位（服务端整理后）",
        origin: "db",
        ref: "map_npcs 表",
        note: "在地图页上点放 / 拖动（#672 起归后台）；客户端进游戏按快照摆节点。改动下次进游戏生效。",
      },
      {
        section: "revivePoint",
        label: "复活点（服务端整理后）",
        origin: "db",
        ref: "maps 表（revive_cx / revive_cy）",
        note: "在地图页上点选（#672 起归后台）；客户端用它做进图定位与安全复活。没设 = 不进图定位。",
      },
      {
        section: "worldMonsters",
        label: "场上怪物实例",
        origin: "db",
        ref: "world_monsters 表",
        note: "服务端世界运行时独家写入；进程重启后按刷怪区重新播种，本页只读。",
      },
    ];
  }
}

/**
 * 坐标收两位小数
 *
 * 画布拖出来的是浮点（`1234.5678`），表里存两位就够了 —— 与导入工具当年的
 * `round()` 同一口径，也让「重画一次同样的框」落库后逐字节一致（对比 / 重放都省心）。
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

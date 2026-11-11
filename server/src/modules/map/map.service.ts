import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import {
  COLLISION_BOX_LIMITS,
  MAP_TYPE_GROUPS,
  MAP_TYPE_LABELS,
  MapTypeValue,
  SPAWN_AREA_LIMITS,
} from "../../common/constants/map-config";
import { BizException } from "../../common/errors/biz.exception";
import { parseMonitorEvent, parseMonitorSnapshot } from "../../common/map-monitor";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import {
  pointInBounds,
  pointOverflowText,
  rectFullyOutside,
  spawnAreaInBounds,
  spawnAreaOverflow,
} from "../../common/utils/spawn-area-bounds.util";
import { spawnTargetOf } from "../../common/utils/spawn-density.util";
import { MapCollisionRepository } from "../../database/repositories/map-collision.repository";
import { MapMonitorRepository } from "../../database/repositories/map-monitor.repository";
import { MapNpcRepository } from "../../database/repositories/map-npc.repository";
import { NpcRepository } from "../../database/repositories/npc.repository";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { MapRepository } from "../../database/repositories/map.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { MapCollisionRow, MapNpcRow, MapRow, MapSpawnAreaRow, NpcRow } from "../../database/rows";
import { EMPTY_MAP_CONTENT, EMPTY_MAP_PIXEL_SIZE, MapContent, MapPixelSize } from "./map-content";
import {
  MapMonitorDto,
  MapMonitorEventDto,
  MapMonitorMonsterDto,
  MapMonitorPlayerDto,
} from "./dto/map-monitor.dto";
import {
  MapCollisionBoxDto,
  MapCollisionDeletedDto,
  MapCollisionDto,
  MapConfigDto,
  MapDetailDto,
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
  SaveMapCollisionDto,
  SaveMapConfigDto,
  SaveMapNpcDto,
  SaveRevivePointDto,
  SaveSpawnAreaDto,
} from "./dto/map.dto";

/**
 * 新手村的地图 id
 *
 * 客户端新号默认落在这里（`entities/Role.ts` 的 `onMap = "0"`），服务端对「还没有位置记录」
 * 的号也只准进这张 —— 见 `RealtimeService.mapEnterRejectOf`（#859）。
 * 配在 `maps` 表里的是它 1 级的门槛（`level = 1`），所以新号自己就走得过。
 */
export const START_MAP_ID = "0";

/**
 * 进图被拒的原因（#606）
 *
 * 只给「哪一项 / 差多少 / 图名」，不给完整中文句子：文案归客户端（`configs/texts` 的
 * `reject_map_level` / `reject_map_combat` / `reject_map_soul` / `reject_map_unknown` /
 * `reject_map_start`），服务端给结构化字段，换语言 / 改措辞不用改服务端。
 *
 * `unknown` / `start` 两个「不是数值门槛」的取值是 #859 加的：前者是「这张图配置里没有」，
 * 后者是「你还没有位置记录，只能进新手村」。它们跟等级 / 战力 / 战魂不同 —— 没有「差多少」
 * （`need` 恒 0），客户端只看 `field` 选文案。
 */
export interface MapEnterReject {
  /** 缺哪一项（决定客户端取哪条文案） */
  field: "level" | "combat" | "soul" | "unknown" | "start";
  /** 这张图要求的值（`unknown` / `start` 恒 0） */
  need: number;
  /** 图名（客户端提示里要用；`unknown` 时是客户端报上来的那个 id） */
  mapLabel: string;
}

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
 * | `collisions` | `map_collisions` 表 | **管理端绘制**（`createCollision` / `updateCollision` / `deleteCollision`） |
 * | `worldMonsters` | `world_monsters` 表 | 世界服务运行时写 |
 *
 * 资源本体（TMX / 底图 / 预览图）仍在客户端资源包里 —— 所以**没有「新建地图」**：
 * 行由出厂快照（`server/data/config-sync.sql`）带进来，一张没有 TMX 的「地图」
 * 在客户端点开就是黑屏，后台不该造得出来。
 *
 * ## 进图条件（#606：判定在服务端，客户端只是提前提示）
 *
 * #573 把配置搬上来了，但判定留在客户端 `StorageManager.changeOnMap` —— 数据在服务端、
 * 判定在客户端是**权威倒挂**：改个包（或干脆调自己的 `changeOnMap`）就能进任意地图。
 * 所以现在 `enterRejectOf` 是唯一判据，两处消费：
 *
 * - 实时通道的 `mapEnter`（换图**意图**）：客户端切场景**之前**先问一句，被拒就原地提示、
 *   不切图 —— 这样被拦的人不会先进一张空图再被踢回来；
 * - 实时通道的 `worldJoin`（真正落地那一刻）：再判一次。绕过 `mapEnter` 直发 worldJoin
 *   的改包走的就是这条，它必须拦得住。
 *
 * 客户端 `GameHelper.getMapEnterRejectReason` 保留一份同顺序的判据，只做**即时反馈**
 * （点了就有反应，不必等一个往返），不是权威。
 *
 * 三条边界（#573 踩出来的，动之前先读）：
 *
 * 1. **登录不算换图**：`worldJoin` 的目标图 == 服务端记下的位置（`data.mapAt`）时一律放行，
 *    哪怕运营刚把门槛调到这个人够不着 —— 否则站在图里的低等级玩家下次登录就黑屏，
 *    而且他自己没有任何办法出来。这不是放水，是「他已经在那里」这个事实优先于配置。
 * 2. **服务端还没有位置记录时只准进新手村**（刚建号 / 老档第一次上线，#859）：以前是
 *    「一律放行」——那一刻玩家在哪由客户端决定，于是「新号直接落到任意图」成了门槛的
 *    永久后门（`setMapAt` 还会把这次放行记下来，下一次就按新位置判）。收窄成新手村不挡人
 *    （新号本来就在那儿，客户端默认位置也是 `0`）。位置一旦记下就不再接受客户端的
 *    改口 —— `mapAt` 是服务端独占字段（见 `role-authority.ts`），只有「被接受的 worldJoin」
 *    与「管理端摆位」能写它。
 * 3. **不认识的图直接拒**（#859）：以前是「没有配置行就没有门槛」+ 世界层给它建一份空图 ——
 *    等于「拼错一个地图 id 就能进一张没有地形、没有怪、没有复活点的表外世界」，而且运营
 *    永远不知道有人在那儿。现在拒绝（`field = unknown`）。代价是加新图必须先配 `maps` 行
 *    （跑 `import-map-resources` / 出厂快照），但那本来就是这张表的唯一入口 ——
 *    没有 TMX 的图在客户端点开就是黑屏，放行也没意义。
 */
@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  constructor(
    private readonly maps: MapRepository,
    private readonly spawnAreas: MapSpawnAreaRepository,
    private readonly npcPoints: MapNpcRepository,
    private readonly collisions: MapCollisionRepository,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly monsters: MonsterRepository,
    private readonly npcs: NpcRepository,
    private readonly monitorRows: MapMonitorRepository,
  ) {}


  /** 列表：全部图 + 各类对象计数（客户端资源）+ 服务端三处统计 */
  list(): MapListDto {
    const spawnCounts = new Map(this.spawnAreas.countByMap().map((row) => [row.map_id, row.total]));
    const npcCounts = new Map(this.npcPoints.countByMap().map((row) => [row.map_id, row.total]));
    const collisionCounts = new Map(this.collisions.countByMap().map((row) => [row.map_id, row.total]));
    const monsterCounts = this.worldMonsterTotals();

    const list = this.maps
      .listAll()
      .map((row) =>
        this.summaryOf(
          row,
          spawnCounts.get(row.map_id) ?? 0,
          monsterCounts.get(row.map_id) ?? 0,
          npcCounts.get(row.map_id) ?? 0,
          collisionCounts.get(row.map_id) ?? 0,
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
   * 凭三个数值判「能不能进」，以及点位与碰撞盒（NPC / 复活点 / 刷怪区中心 / 碰撞矩形）——
   * 这四样以前客户端是从 TMX 的对象组里读的。**#676 起 TMX 里一个对象组都没了**
   * （地图文件只做显示），所以客户端除了瓦片之外的一切都来自这一段。
   * 尺寸与图层数仍然不发：客户端自己有 TMX。
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
      collisions: this.collisions.listByMap(row.map_id).map((box) => this.collisionBoxDtoOf(box)),
    }));
  }

  //#region 进图条件（#606）

  /**
   * 能不能进这张图（`null` = 可以进）
   *
   * 判定项与顺序：**等级 → 战斗力 → 战魂阶**，与客户端 `GameHelper.getMapEnterRejectReason`
   * 完全同一套（客户端那份只做提前提示）。数值 `0` = 不限制（安全地图就是 0/0/0），
   * 所以判据是「配置 > 0 且配置 > 角色值」。三条边界见类顶部。
   *
   * 返回「哪一项不够 + 差多少 + 图名」而不是一句中文：客户端按 `field` 取自己的文案 key
   * （`reject_map_level` 等）拼提示，服务端不生产面向玩家的句子 —— 文案归客户端，
   * 与其余实时帧同一口径。
   *
   * @param mapId 目标地图 id
   * @param role  角色当前的三项门槛值（等级取行里的索引列，战斗力按服务端口径现算）
   */
  enterRejectOf(mapId: string, role: { level: number; combat: number; soulOfWar: number }): MapEnterReject | null {
    const row = this.maps.getById(mapId);
    // 不认识的图：拒（#859）。放行会让「拼错 id」变成一条进空白世界的通道，见类顶部边界 3
    if (!row) return { field: "unknown", need: 0, mapLabel: mapId };
    if (row.level > 0 && row.level > role.level) return { field: "level", need: row.level, mapLabel: row.label };
    if (row.combat > 0 && row.combat > role.combat) return { field: "combat", need: row.combat, mapLabel: row.label };
    if (row.soul_of_war > 0 && row.soul_of_war > role.soulOfWar) {
      return { field: "soul", need: row.soul_of_war, mapLabel: row.label };
    }
    return null;
  }

  /**
   * 这张图存在吗（#859）
   *
   * 进图放行的**第一道**判据要用它，而不是「先查位置再查门槛」：`enterRejectOf` 里那条
   * `unknown` 只在「换图」时才走到，新号拿着不存在的 id 会先撞上「只准进新手村」，
   * 报出的原因就成了「你不在新手村」—— 语义完全不对（他压根没说要去哪张图）。
   */
  exists(mapId: string): boolean {
    return !!this.maps.getById(mapId);
  }

  /** 地图名（客户端提示里要用）；没有这张图就回 id 本身 —— 提示里总要有个能念出来的东西 */
  labelOf(mapId: string): string {
    return this.maps.getById(mapId)?.label ?? mapId;
  }

  /**
   * 一张图的**可行走几何**（#854：怪物 AI 的移动碰撞与边界钳制要用）
   *
   * 返回世界坐标口径的尺寸与碰撞矩形：一张图占 `x ∈ [0, width]`、`y ∈ [-height, 0]`
   * （左上角原点、y 轴向上，与刷怪区的 `pointInBounds` 同一套约定）；`boxes` 就是
   * `map_collisions` 的矩形（中心 + 宽高），客户端建静态碰撞体用的是同一批数据。
   *
   * **为什么由地图域给**：可行走区是地图的事实，不是 AI 的事实。AI 自己拼一份
   * 「图多大、墙在哪」，早晚会和客户端那一份对不上（客户端撞不过去的地方，怪能穿过去）。
   *
   * 没有几何列（`pixel_width = 0`，导入工具没跑）时返回 `null`：调用方按「不判碰撞」处理，
   * 与 `sizeOf` 的既有兜底一致 —— 拿 0 当图宽会把所有怪钳到原点。
   */
  walkGeometryOf(mapId: string): {
    width: number;
    height: number;
    boxes: Array<{ cx: number; cy: number; w: number; h: number }>;
  } | null {
    const row = this.maps.getById(mapId);
    if (!row || !(row.pixel_width > 0) || !(row.pixel_height > 0)) return null;
    return {
      width: row.pixel_width,
      height: row.pixel_height,
      boxes: this.collisions.listByMap(mapId).map((box) => ({ cx: box.cx, cy: box.cy, w: box.w, h: box.h })),
    };
  }

  //#endregion

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
      // 不适用的字段一律给默认值（DTO 注释里的同一口径）：前端不必为每种 kind 判 undefined
      dto.killer = "";
      dto.drops = [];
      dto.respawnAt = 0;
      dto.attacker = "";
      dto.skillId = "";
      dto.skillLabel = "";
      dto.amount = 0;
      dto.hpBefore = 0;
      dto.hpAfter = 0;
      dto.maxHp = 0;
      dto.killed = false;
      dto.pushDistance = 0;
      dto.target = "";
      dto.targetAccountId = "";
      dto.phase = "";
      dto.reason = "";
      dto.distance = 0;
      switch (parsed.kind) {
        case "kill":
          dto.killer = parsed.killer;
          dto.drops = parsed.drops;
          dto.respawnAt = parsed.respawnAt;
          break;
        case "damage":
          dto.attacker = parsed.attacker;
          dto.skillId = parsed.skillId;
          dto.skillLabel = parsed.skillLabel;
          dto.amount = parsed.amount;
          dto.hpBefore = parsed.hpBefore;
          dto.hpAfter = parsed.hpAfter;
          dto.maxHp = parsed.maxHp;
          dto.killed = parsed.killed;
          dto.pushDistance = parsed.pushDistance;
          break;
        case "chase":
          dto.target = parsed.target;
          dto.targetAccountId = parsed.targetAccountId;
          dto.phase = parsed.phase;
          dto.reason = parsed.reason;
          dto.distance = parsed.distance;
          break;
        case "cast":
          dto.skillId = parsed.skillId;
          dto.skillLabel = parsed.skillLabel;
          dto.target = parsed.target;
          dto.targetAccountId = parsed.targetAccountId;
          dto.amount = parsed.damage;
          dto.hpBefore = parsed.hpBefore;
          dto.hpAfter = parsed.hpAfter;
          dto.maxHp = parsed.maxHp;
          dto.killed = parsed.killed;
          break;
        case "hit":
          dto.target = parsed.target;
          dto.targetAccountId = parsed.targetAccountId;
          dto.amount = parsed.damage;
          dto.hpBefore = parsed.hpBefore;
          dto.hpAfter = parsed.hpAfter;
          dto.maxHp = parsed.maxHp;
          dto.killed = parsed.killed;
          break;
        default:
          break;
      }
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

  /** 详情：基础 + 图层 + 刷怪区 + NPC/复活点 + 碰撞盒 + 场上怪物 + 来源说明 */
  detail(id: string): MapDetailDto {
    const row = this.requireRow(id);
    const content = this.contentOf(row);

    // 越界判定按「这张图的实际像素尺寸」算（maps 表的几何列，与 TMX 头一致）。
    // 判据只在服务端一处：页面直接显示 inBounds，不自己再算一遍 —— 两边各算迟早会分叉。
    const mapPixel = this.sizeOf(row);
    const areas: MapSpawnAreaDto[] = this.spawnAreas.listByMap(id).map((area) => this.areaDtoOf(area, mapPixel));
    const npcPoints: MapNpcDto[] = this.npcPoints.listByMap(id).map((point) => this.npcDtoOf(point, mapPixel));
    const collisions: MapCollisionDto[] = this.collisions.listByMap(id).map((box) => this.collisionDtoOf(box, mapPixel));

    const worldMonsters: MapWorldMonsterDto[] = this.worldMonsters
      .countByMap()
      .filter((item) => item.map_id === id)
      .map((item) => ({ zoneId: item.zone_id, total: item.total, alive: Number(item.alive) || 0 }));

    const summary = this.summaryOf(
      row,
      areas.length,
      worldMonsters.reduce((total, item) => total + item.total, 0),
      npcPoints.length,
      collisions.length,
    );
    const detail = Object.assign(new MapDetailDto(), summary);
    detail.layers = content.layers.map((layer) => {
      const dto = new MapLayerDto();
      dto.name = layer.name;
      dto.width = layer.width;
      dto.height = layer.height;
      return dto;
    });
    detail.spawnAreas = areas;
    detail.npcPoints = npcPoints;
    detail.revivePoint = this.revivePointOf(row, mapPixel);
    detail.collisions = collisions;
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
      this.collisions.listByMap(id).length,
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
      // #852：min 固定 0（目标是 max × 密度系数 × 人数系数，下限留 0 才降得下来）
      min: 0,
      max: dto.count,
      ...this.densityOf(dto),
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
      min: 0,
      max: dto.count,
      ...this.densityOf(dto),
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

  /**
   * 密度字段的落库形态（#852）
   *
   * 三个都可不填：空 = 1.0 / 无峰谷，等于「这一区不配密度」（目标恒等于 max，与加字段前一样）。
   * `peakHours` 的格式在这里拦：写错了会让这一区静默退化成「无峰谷」—— 运营以为配了峰谷、
   * 实际没生效，比直接报错难查得多。
   */
  private densityOf(dto: SaveSpawnAreaDto): {
    density_peak: number | null;
    density_off: number | null;
    peak_hours: string | null;
  } {
    const peakHours = dto.peakHours?.trim() ?? "";
    if (peakHours !== "" && !SPAWN_AREA_LIMITS.peakHours.test(peakHours)) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `高峰时段写法不对（${peakHours}），应为 19:00-23:00 这种（支持跨零点 22:00-02:00），留空表示没有峰谷`,
      );
    }
    return {
      density_peak: dto.densityPeak ?? null,
      density_off: dto.densityOff ?? null,
      peak_hours: peakHours === "" ? null : peakHours,
    };
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
      densityPeak: area.density_peak,
      densityOff: area.density_off,
      peakHours: area.peak_hours,
      // 此刻目标几只：与 tick 同一份公式、同一个人数（查看这张管理页的人不在图里，按 1 人算）
      targetNow: spawnTargetOf(area, 1, Date.now()),
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

  //#region 碰撞盒（#676：碰撞区域从 TMX 搬到后台）

  /**
   * 画一个碰撞盒
   *
   * 只有两道校验（图有几何 / 宽高不是零），**故意没有「在图内」那一条**：
   * 每张图四面围墙本来就画在图外（`x = -64`、宽 8320），那是「把玩家关在图里」的手段。
   * 拿刷怪区那条判据套上来，第一张图就会被判 4 个错 —— 判据错了比没有判据更糟。
   */
  createCollision(mapId: string, dto: SaveMapCollisionDto, actor: AuthenticatedUser): MapCollisionDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const box = this.requireBox(dto);

    const created = this.collisions.insert({
      map_id: mapId,
      cx: box.cx,
      cy: box.cy,
      w: box.w,
      h: box.h,
      updated_at: Date.now(),
    });
    this.logger.log(
      `地图 ${mapId} 新增碰撞盒 #${created.id}：${box.w}×${box.h} @ (${box.cx}, ${box.cy})（by ${actor.username}）`,
    );
    return this.collisionDtoOf(created, mapPixel);
  }

  /**
   * 改一个碰撞盒（整份覆盖：挪位置与改尺寸是同一次动作）
   *
   * 画布上拖动走的也是它 —— 拖完只提交新中心，宽高原样带回。
   */
  updateCollision(mapId: string, boxId: number, dto: SaveMapCollisionDto, actor: AuthenticatedUser): MapCollisionDto {
    const { mapPixel } = this.requireDrawableMap(mapId);
    const before = this.requireCollision(mapId, boxId);
    const box = this.requireBox(dto);

    this.collisions.update({ ...before, cx: box.cx, cy: box.cy, w: box.w, h: box.h, updated_at: Date.now() });
    this.logger.log(
      `地图 ${mapId} 碰撞盒 #${boxId} 已更新：(${before.cx}, ${before.cy}) ${before.w}×${before.h} → ` +
        `(${box.cx}, ${box.cy}) ${box.w}×${box.h}（by ${actor.username}）`,
    );
    const updated = this.collisions.findById(boxId);
    if (!updated) throw new Error(`碰撞盒 #${boxId} 刚更新却读不回来，库状态异常`);
    return this.collisionDtoOf(updated, mapPixel);
  }

  /**
   * 删一个碰撞盒
   *
   * **立刻生效**（不是「下次进图」）：碰撞体是客户端进图时按快照铺的，图里的人要换图 / 重进
   * 才没有它 —— 与点位同一条生效时机，页面照实提示。
   */
  deleteCollision(mapId: string, boxId: number, actor: AuthenticatedUser): MapCollisionDeletedDto {
    this.requireCollision(mapId, boxId);
    this.collisions.remove(boxId);
    this.logger.log(`地图 ${mapId} 碰撞盒 #${boxId} 已删除（by ${actor.username}）`);
    return { deleted: true, id: boxId };
  }

  /**
   * 碰撞盒的数值校验
   *
   * 数值统一收两位小数（与刷怪区同一口径：拖出来的 `123.4567` 进库没有意义，
   * 也让 e2e 能直接对数字）。下限 1px —— 碰撞盒可以是一条贴墙的缝。
   */
  private requireBox(dto: SaveMapCollisionDto): { cx: number; cy: number; w: number; h: number } {
    const box = { cx: round2(dto.cx), cy: round2(dto.cy), w: round2(dto.w), h: round2(dto.h) };
    if (!Number.isFinite(box.cx) || !Number.isFinite(box.cy)) {
      throw new BizException(BizCode.PARAM_INVALID, "碰撞盒的中心必须是数字");
    }
    if (box.w < COLLISION_BOX_LIMITS.minSize || box.h < COLLISION_BOX_LIMITS.minSize) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `碰撞盒太小（${box.w}×${box.h}），宽高都不能小于 ${COLLISION_BOX_LIMITS.minSize} 像素`,
      );
    }
    return box;
  }

  /** 取一个碰撞盒，且必须属于路径里那张图（防止拿 A 图的行 id 去改 B 图） */
  private requireCollision(mapId: string, boxId: number): MapCollisionRow {
    const box = this.collisions.findById(boxId);
    if (!box || box.map_id !== mapId) {
      throw BizException.notFound(BizCode.MAP_COLLISION_NOT_FOUND, `地图 ${mapId} 没有碰撞盒 #${boxId}`);
    }
    return box;
  }

  /** 行 → 管理端 DTO（`fullyOutside` 与读接口同源，只此一处判） */
  private collisionDtoOf(box: MapCollisionRow, mapPixel: MapPixelSize): MapCollisionDto {
    return {
      id: box.id,
      cx: box.cx,
      cy: box.cy,
      w: box.w,
      h: box.h,
      fullyOutside: rectFullyOutside(box, mapPixel),
    };
  }

  /** 行 → 下发客户端的矩形（字段名对齐客户端的 `MapCollisionBox`：直接建节点） */
  private collisionBoxDtoOf(box: MapCollisionRow): MapCollisionBoxDto {
    return { x: box.cx, y: box.cy, w: box.w, h: box.h };
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
    collisionCount: number,
  ): MapSummaryDto {
    const id = row.map_id;
    const size = this.sizeOf(row);
    const content = this.contentOf(row);

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
    dto.npcPointCount = npcPointCount;
    dto.hasRevivePoint = row.revive_cx !== null && row.revive_cy !== null;
    dto.collisionCount = collisionCount;
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
        note: "资源在客户端资源包里，后台改不了；换图要换资源，再跑 tools/import-map-resources.cjs 重新读几何与图层。**#676 起 TMX 里只有瓦片与图层**（对象组已整组删除），所以这张图的一切配置都在下面几块里。",
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
        note: "TMX 的图层结构（JSON）；瓦片数据留在客户端资源里，这里只列结构。这是「地图文件」里仅剩的数据。",
      },
      {
        section: "collisions",
        label: "碰撞盒（服务端整理后）",
        origin: "db",
        ref: "map_collisions 表",
        note: "在地图页上拖框绘制（#676 起归后台）；客户端按快照建静态碰撞体、自动战斗也拿它当静态障碍。允许超出地图边界（四面围墙就在图外），只有「整块在图外」会标出来。",
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

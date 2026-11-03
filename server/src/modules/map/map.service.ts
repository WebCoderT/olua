import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { MAP_TYPE_GROUPS, MAP_TYPE_LABELS, MapTypeValue } from "../../common/constants/map-config";
import { BizException } from "../../common/errors/biz.exception";
import { parseMonitorEvent, parseMonitorSnapshot } from "../../common/map-monitor";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { spawnAreaInBounds, spawnAreaOverflow } from "../../common/utils/spawn-area-bounds.util";
import { MapMonitorRepository } from "../../database/repositories/map-monitor.repository";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { MapRepository } from "../../database/repositories/map.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { MapRow } from "../../database/rows";
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
  MapSourceDto,
  MapSpawnAreaDto,
  MapSummaryDto,
  MapWorldMonsterDto,
  SaveMapConfigDto,
} from "./dto/map.dto";

/**
 * 地图（#571 观测台 / #573 玩法配置归服务端）
 *
 * ## 这一层现在管什么
 *
 * | 数据 | 存放 | 谁能改 |
 * |---|---|---|
 * | `label` / `type` / `level` / `combat` / `soulOfWar` | `maps` 表 | **管理端**（`save`） |
 * | `layers` / `groups` / 尺寸 | `maps` 表的几何列 + `content` JSON（源自 TMX） | 改 TMX + 跑 `import-spawn-areas` |
 * | `spawnAreas` | `map_spawn_areas` 表 | 导入工具写入 |
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
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly monsters: MonsterRepository,
    private readonly monitorRows: MapMonitorRepository,
  ) {}


  /** 列表：全部图 + 各类对象计数（客户端资源）+ 服务端两处统计 */
  list(): MapListDto {
    const spawnCounts = new Map(this.spawnAreas.countByMap().map((row) => [row.map_id, row.total]));
    const monsterCounts = this.worldMonsterTotals();

    const list = this.maps
      .listAll()
      .map((row) => this.summaryOf(row, spawnCounts.get(row.map_id) ?? 0, monsterCounts.get(row.map_id) ?? 0));
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
   * 客户端进游戏要的就是这七个字段：凭 `id` 拼资源路径、凭 `label` 显示名字、
   * 凭 `type` 分桶、凭三个数值判「能不能进」。尺寸与对象数不发 —— 客户端自己有 TMX。
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

  /** 详情：基础 + 图层 + 对象组 + 刷怪区 + 场上怪物 + 来源说明 */
  detail(id: string): MapDetailDto {
    const row = this.requireRow(id);
    const content = this.contentOf(row);
    const groups = content.groups.map((group) => {
      const dto = new MapGroupDto();
      dto.name = group.name;
      dto.objects = group.objects.map((object) => ({ ...object, properties: { ...object.properties } }));
      return dto;
    });

    // 越界判定按「这张图的实际像素尺寸」算（MAP_PIXEL_SIZES 生成快照，与 TMX 头一致）。
    // 判据只在服务端一处：页面直接显示 inBounds，不自己再算一遍 —— 两边各算迟早会分叉。
    const mapPixel = this.sizeOf(row);
    const areas: MapSpawnAreaDto[] = this.spawnAreas.listByMap(id).map((area) => ({
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
    }));

    const worldMonsters: MapWorldMonsterDto[] = this.worldMonsters
      .countByMap()
      .filter((item) => item.map_id === id)
      .map((item) => ({ zoneId: item.zone_id, total: item.total, alive: Number(item.alive) || 0 }));

    const summary = this.summaryOf(
      row,
      areas.length,
      worldMonsters.reduce((total, item) => total + item.total, 0),
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
    return this.summaryOf(row, this.spawnAreas.countByMap().find((item) => item.map_id === id)?.total ?? 0, 0);
  }

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
    this.logger.warn(`地图 ${row.map_id} 没有几何（重跑 node tools/import-spawn-areas.cjs）`);
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
    this.logger.warn(`地图 ${row.map_id} 的内容列不是合法 JSON（重跑 node tools/import-spawn-areas.cjs）`);
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
  private summaryOf(row: MapRow, spawnAreaCount: number, worldMonsterCount: number): MapSummaryDto {
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
        note: "资源在客户端资源包里，后台改不了；换图要换资源，再跑 tools/import-spawn-areas.cjs 重新生成下面两块。",
      },
      {
        section: "size",
        label: "地图尺寸",
        origin: "db",
        ref: "maps 表（几何列）",
        note: "由 tools/import-spawn-areas.cjs 从 TMX 头直接写库；换图后重跑工具即可，页面只读。",
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
        note: "坐标是 Tiled 原始口径（左上角、y 向下），用来对着编辑器核对；不是服务端在用的世界坐标。",
      },
      {
        section: "spawnAreas",
        label: "刷怪区（服务端整理后）",
        origin: "db",
        ref: "map_spawn_areas 表",
        note: "由导入工具按世界坐标写入（y 已取反、含区域中心与尺寸）；世界播种直接读它。",
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

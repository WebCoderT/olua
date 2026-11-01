import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { MAPS, MONSTERS } from "../../shared/game-data.generated";
import { MAP_CONTENTS, MapContent } from "../../shared/map-content.generated";
import { MAP_PIXEL_SIZES, MapPixelSize } from "../../shared/map-sizes.generated";
import {
  MapDetailDto,
  MapGroupDto,
  MapLayerDto,
  MapListDto,
  MapSourceDto,
  MapSpawnAreaDto,
  MapSummaryDto,
  MapWorldMonsterDto,
} from "./dto/map.dto";

/** 生成物 `MAPS` 的形状（JSON 表在生成物里是 `Record<string, unknown>`） */
interface MapMeta {
  label: string;
  src: string;
  type: string;
  /** 类型名（生成时已按客户端 mapTypeGroups 拼好，这里不再维护第二份码表） */
  typeLabel: string;
  level: number;
  combat: number;
  soulOfWar: number;
}

/** 生成物 `MONSTERS` 里用得到的部分（只取名字，数值不在这页展示） */
interface MonsterMeta {
  label?: string;
}

/**
 * 地图查询（#571）
 *
 * ## 只读，而且是刻意的
 *
 * 地图的真相在客户端资源里（`resources/map/*.tmx` + `configs/map.ts`），服务端存的是
 * **对这份资源的整理结果**：尺寸、刷怪区（世界坐标）、场上怪物实例。管理端这边
 * 「改」没有意义 —— 改 TMX 要走客户端资源 + 重新导入，改刷怪区要走导入工具，
 * 所以这一层不提供任何写入口（e2e 固化 POST / PATCH / DELETE 都是 404）。
 *
 * ## 一次请求里拼了三份来源
 *
 * | 字段 | 来源 | 能不能改 |
 * |---|---|---|
 * | `label` / `type` / `level` / `combat` / `soulOfWar` / `src` | `MAPS`（客户端 `configs/map.ts` 的快照） | 改客户端配置 + 重新生成 |
 * | `layers` / `groups` | `MAP_CONTENTS`（TMX 的生成快照） | 改 TMX + 跑 `import-spawn-areas` |
 * | `spawnAreas` | `map_spawn_areas` 表 | 导入工具写入（运营面暂不开放手改） |
 * | `worldMonsters` | `world_monsters` 表 | 世界服务运行时写 |
 *
 * 每块都带 `sources` 说明，页面按它打徽标 —— 「这个数字是谁的」写在接口里，
 * 不靠读者去猜（这一页最容易犯的错就是把客户端资源当成服务端数据）。
 */
@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  constructor(
    private readonly spawnAreas: MapSpawnAreaRepository,
    private readonly worldMonsters: WorldMonsterRepository,
  ) {}

  /** 列表：11 张图 + 各类对象计数（客户端资源）+ 服务端两处统计 */
  list(): MapListDto {
    const spawnCounts = new Map(this.spawnAreas.countByMap().map((row) => [row.map_id, row.total]));
    const monsterCounts = this.worldMonsterTotals();

    const list = this.mapIds().map((id) =>
      this.summaryOf(id, spawnCounts.get(id) ?? 0, monsterCounts.get(id) ?? 0),
    );
    const dto = new MapListDto();
    dto.total = list.length;
    dto.list = list;
    return dto;
  }

  /** 详情：基础 + 图层 + 对象组 + 刷怪区 + 场上怪物 + 来源说明 */
  detail(id: string): MapDetailDto {
    if (!this.metaOf(id)) {
      // 用 notFound：`new BizException(code, msg)` 默认是 400 —— 那张图不存在是「找不到」，
      // 不是「参数不合法」，状态码错了会让客户端把提示写成「参数错误」（e2e 钉着 404）。
      throw BizException.notFound(BizCode.MAP_NOT_FOUND, `地图 ${id} 不存在（清单由客户端 configs/map.ts 固定）`);
    }

    const content = this.contentOf(id);
    const groups = content.groups.map((group) => {
      const dto = new MapGroupDto();
      dto.name = group.name;
      dto.objects = group.objects.map((object) => ({ ...object, properties: { ...object.properties } }));
      return dto;
    });

    const areas: MapSpawnAreaDto[] = this.spawnAreas.listByMap(id).map((row) => ({
      id: row.id,
      name: row.name,
      monsterKey: row.monster_key,
      monsterLabel: this.monsterLabelOf(row.monster_key),
      min: row.min,
      max: row.max,
      cx: row.cx,
      cy: row.cy,
      w: row.w,
      h: row.h,
    }));

    const worldMonsters: MapWorldMonsterDto[] = this.worldMonsters
      .countByMap()
      .filter((row) => row.map_id === id)
      .map((row) => ({ zoneId: row.zone_id, total: row.total, alive: Number(row.alive) || 0 }));

    const summary = this.summaryOf(
      id,
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

  /** 地图 id 列表（数字升序；id 在客户端是字符串，排序必须按数值，否则 10 会排到 2 前面） */
  private mapIds(): string[] {
    return Object.keys(MAPS).sort((a, b) => Number(a) - Number(b));
  }

  private metaOf(id: string): MapMeta | null {
    const meta = (MAPS as Record<string, MapMeta>)[id];
    return meta ?? null;
  }

  /** 尺寸快照；缺一张图时不让整个列表 500 —— 记一条 warn 并按 0 展示 */
  private sizeOf(id: string): MapPixelSize {
    const size = MAP_PIXEL_SIZES[id];
    if (size) return size;
    this.logger.warn(`地图 ${id} 没有尺寸快照（tools/import-spawn-areas.cjs 漏了这张图？）`);
    return { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0, width: 0, height: 0 };
  }

  private contentOf(id: string): MapContent {
    const content = MAP_CONTENTS[id];
    if (content) return content;
    this.logger.warn(`地图 ${id} 没有内容快照（assets 里缺 TMX？）`);
    return { layers: [], groups: [] };
  }

  private monsterLabelOf(key: string): string {
    const monster = (MONSTERS as Record<string, MonsterMeta>)[key];
    return monster?.label ?? key;
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
  private summaryOf(id: string, spawnAreaCount: number, worldMonsterCount: number): MapSummaryDto {
    const meta = this.metaOf(id) ?? { label: id, src: "", type: "", typeLabel: "", level: 0, combat: 0, soulOfWar: 0 };
    const size = this.sizeOf(id);
    const content = this.contentOf(id);

    // npc / revive 的对象类可能落在 npc 组，也可能在早期地图的 objects 组里 —— 按 klass 全组扫
    const allObjects = content.groups.flatMap((group) => group.objects);
    const dto = new MapSummaryDto();
    dto.id = id;
    dto.label = meta.label;
    dto.type = meta.type;
    dto.typeLabel = meta.typeLabel || meta.type;
    dto.level = meta.level;
    dto.combat = meta.combat;
    dto.soulOfWar = meta.soulOfWar;
    dto.src = meta.src;
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
        label: "地图基础配置",
        origin: "config",
        ref: "client/assets/configs/map.ts",
        note: "名称 / 类型 / 进入条件 / 资源路径来自客户端配置；改它要改客户端并重新打包，管理端不提供编辑。",
      },
      {
        section: "size",
        label: "地图尺寸",
        origin: "snapshot",
        ref: "server/src/shared/map-sizes.generated.ts",
        note: "由 tools/import-spawn-areas.cjs 从 TMX 头生成（随仓库提交）；换图后重跑工具即可，页面只读。",
      },
      {
        section: "layers",
        label: "图层",
        origin: "snapshot",
        ref: "server/src/shared/map-content.generated.ts",
        note: "TMX 的图层结构快照；瓦片数据留在客户端资源里，这里只列结构。",
      },
      {
        section: "groups",
        label: "对象组（Tiled 原始坐标）",
        origin: "snapshot",
        ref: "server/src/shared/map-content.generated.ts",
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

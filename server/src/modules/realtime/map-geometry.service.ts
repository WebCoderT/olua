import { Injectable, Logger } from "@nestjs/common";
import { MapService } from "../map/map.service";
import {
  pointInPolygon,
  pointToPolygonEdgesDistance,
  polygonBBox,
  segmentHitsEdge,
  type PolyPoint,
} from "../../common/utils/polygon.util";

/** 一张图的可行走几何（#854；#1190 起碰撞是**任意简单多边形**，与 `map_collisions.points` 同形） */
export interface WalkGeometry {
  width: number;
  height: number;
  polys: PolyPoint[][];
}

/**
 * 寻路用的可走网格（按 `cellSize` 切格、按 `clearance` 外扩障碍后烙平）
 *
 * 形状刻意与客户端 `ui/utils/map/PathGrid` 对齐（同一套 `cellSize` / `clearance` /
 * 「格子中心落在矩形内即阻挡」/ 原点在左上角、y 向上）：两端用同一组参数建同一张网格，
 * 服务端算出的路点客户端才敢照走（详见 `PathService` 顶部）。
 */
export interface WalkGrid {
  /** 格子边长（像素） */
  cellSize: number;
  /** 列数 */
  cols: number;
  /** 行数 */
  rows: number;
  /** 网格原点 y（世界坐标；地图范围是 y ∈ [-height, 0]） */
  originY: number;
  /** 可走标记（1 = 可走，0 = 阻挡），按行铺平 */
  walkable: Uint8Array;
}

/** 几何与网格的缓存时长：与怪物 AI 的 `GEOMETRY_CACHE_TTL_MS` 同一个口径 */
const GEOMETRY_CACHE_TTL_MS = 5000;

/**
 * 地图几何（#811）：位移校验与寻路共用的**一份**几何副本
 *
 * ## 为什么不各自查库
 * 穿墙校验是 4Hz × 在线人数的调用量，服务端 A* 每次点击都要一份网格 —— 两边各查一次
 * `map_collisions`（最多的图 265 行）等于把「每秒几十次全表扫」写进热点路径。
 * 这里按 mapId 缓存 5 秒：运营改碰撞盒最多晚 5 秒生效，而刷新不需要重启。
 *
 * ## 与 `MonsterAiService.geometryOf` 的关系（暂时放置）
 * 怪物 AI 那侧有一份同形状的缓存（它只做「怪撞不撞墙」，不需要网格）。本文件起来之后
 * 两份是重复的，但合并要动 AI 的 tick 路径（每 100ms × 145 只怪），风险与收益不成比例，
 * 所以**暂时放置**：等 AI 侧需要寻路（或几何缓存要加失效通知）时，让 AI 改成注本服务。
 * 重开条件：`MonsterAiService` 要读 `WalkGrid`，或几何缓存需要「改完立刻生效」。
 *
 * ## 只认 `map_collisions`
 * 客户端建网格时会额外烙上 NPC 占位盒（`autoBattle.npcObstacleSize`），那是客户端自己的
 * 表演向约定，服务端没有 NPC 体型数据 —— 所以服务端算出的路可能从 NPC 身上穿过。
 * **暂时放置**：NPC 不参与服务端碰撞判定（`blockedIn` 也不含它们），走上去既不会被闸拦、
 * 也不会卡住。重开条件：`map_npcs` 有体型字段，或玩家反馈「自动寻路从 NPC 身上碾过去」。
 */
@Injectable()
export class MapGeometryService {
  private readonly logger = new Logger(MapGeometryService.name);
  /** mapId → 几何（5 秒 TTL；null 表示这张图没有可用几何） */
  private readonly geometries = new Map<string, { at: number; geo: WalkGeometry | null }>();
  /** `mapId:cellSize:clearance` → 网格（5 秒 TTL） */
  private readonly grids = new Map<string, { at: number; grid: WalkGrid | null }>();

  constructor(private readonly maps: MapService) {}

  /**
   * 一张图的几何（5 秒缓存）
   *
   * 读库失败 / 图不存在一律返回 null，调用方按「不判碰撞」处理 —— 几何是加固手段，
   * 不能因为它挂了就让人走不动路。
   */
  geometryOf(mapId: string): WalkGeometry | null {
    const now = Date.now();
    const cached = this.geometries.get(mapId);
    if (cached && now - cached.at < GEOMETRY_CACHE_TTL_MS) return cached.geo;
    let geo: WalkGeometry | null = null;
    try {
      geo = this.maps.walkGeometryOf(mapId);
    } catch (error) {
      this.logger.warn(`读取地图 ${mapId} 的可行走几何失败（本轮不判碰撞）：${error instanceof Error ? error.message : String(error)}`);
    }
    this.geometries.set(mapId, { at: now, geo });
    return geo;
  }

  /** 这个点在不在某个碰撞多边形里（**原始形状**，不外扩：闸门只挡真的穿过去的） */
  blockedIn(geo: WalkGeometry, x: number, y: number): boolean {
    for (const poly of geo.polys) {
      if (pointInPolygon(x, y, poly)) return true;
    }
    return false;
  }

  /**
   * 从 `from` 到 `to` 的位移是否**穿过**了碰撞多边形（#1190 起按边判）
   *
   * 三条口径（与矩形版一脉相承）：
   * - **起点在形内就不判**：那是数据改坏 / 人已经在墙里，判它等于把人锁死在原地
   *   （issue 的「站在碰撞区内部不往外推」）；
   * - **出图也算撞墙**：`x ∉ [0, width]` 或 `y ∉ [-height, 0]` 直接算穿墙 ——
   *   客户端本来就钳在图内，能报出图外坐标只有改包。⚠️ 世界坐标的 y **恒为负**
   *   （原点在左上角、y 向上），所以下界是 `-height`、上界是 `0`：写成 `y < 0` 会把
   *   每一个合法点都判成出图（第一次实现就踩了，e2e 里 25px 的正常小步全被判 wall）；
   * - **线段与每条边做精确相交**（端点接触也算），不是按步长采样 —— 采样步长再小
   *   也存在「一步跨过薄墙」的缝隙，而这条路是给作弊者准备的，缝隙就等于没有。
   */
  crossesWall(mapId: string, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const geo = this.geometryOf(mapId);
    if (geo === null) return false;
    if (to.x < 0 || to.x > geo.width || to.y > 0 || to.y < -geo.height) return true;
    if (this.blockedIn(geo, from.x, from.y)) return false;
    // 包围盒先粗筛：绝大多数多边形根本不在这条线段附近（最多的图 265 个碰撞行）
    for (const poly of geo.polys) {
      const bbox = polygonBBox(poly);
      if (to.x < bbox.minX && from.x < bbox.minX) continue;
      if (to.x > bbox.maxX && from.x > bbox.maxX) continue;
      if (to.y < bbox.minY && from.y < bbox.minY) continue;
      if (to.y > bbox.maxY && from.y > bbox.maxY) continue;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (segmentHitsEdge(from, to, poly[j], poly[i])) return true;
      }
    }
    return false;
  }

  /**
   * 一张图的可走网格（按 `cellSize` / `clearance` 缓存；参数变了另建一份）
   *
   * 烙格规则与客户端 `PathGrid.stampRect` **逐行对齐**：障碍矩形先按 `clearance` 外扩，
   * 再按「格子中心是否落在矩形内」标阻挡。两端不一致的话，同一个目标点吸附到的
   * 最近可站立格会不同 —— 客户端预判「能到」、服务端算出「不可达」。
   */
  gridOf(mapId: string, cellSize: number, clearance: number): WalkGrid | null {
    const key = `${mapId}:${cellSize}:${clearance}`;
    const now = Date.now();
    const cached = this.grids.get(key);
    if (cached && now - cached.at < GEOMETRY_CACHE_TTL_MS) return cached.grid;
    const geo = this.geometryOf(mapId);
    let grid: WalkGrid | null = null;
    if (geo !== null) {
      grid = buildGrid(geo, cellSize, clearance);
    }
    this.grids.set(key, { at: now, grid });
    return grid;
  }

  /** 清掉缓存（管理端改完碰撞盒 / 图尺寸后调；目前只有 e2e 与排查脚本用得上） */
  invalidate(mapId?: string): void {
    if (mapId === undefined) {
      this.geometries.clear();
      this.grids.clear();
      return;
    }
    this.geometries.delete(mapId);
    for (const key of Array.from(this.grids.keys())) {
      if (key.startsWith(`${mapId}:`)) this.grids.delete(key);
    }
  }
}

// #1190：线段-矩形相交（segmentHitsAabb）已删，判定改走 polygon.util 的逐边相交。

/** 按客户端 `PathGrid` 的口径烙一张可走网格（#1190：障碍是多边形，两端同一条「形内或贴边 ≤ clearance」规则） */
function buildGrid(geo: WalkGeometry, cellSize: number, clearance: number): WalkGrid {
  const cols = Math.max(1, Math.ceil(geo.width / cellSize));
  const rows = Math.max(1, Math.ceil(geo.height / cellSize));
  const originY = -geo.height;
  const walkable = new Uint8Array(cols * rows).fill(1);
  for (const poly of geo.polys) {
    // 多边形包围盒按 clearance 外扩出候选格范围，再逐格判「中心在形内 / 到任一边 ≤ clearance」。
    // 这条规则与客户端 PathGrid.stampPolygon 逐行对齐（两端不一致 = 同一个点吸附到不同格）
    const bbox = polygonBBox(poly);
    const x = bbox.minX - clearance;
    const y = bbox.minY - clearance;
    const width = bbox.maxX - bbox.minX + clearance * 2;
    const height = bbox.maxY - bbox.minY + clearance * 2;
    const startCol = Math.max(0, Math.ceil((x - 0) / cellSize - 0.5));
    const endCol = Math.min(cols - 1, Math.floor((x + width - 0) / cellSize - 0.5));
    const startRow = Math.max(0, Math.ceil((y - originY) / cellSize - 0.5));
    const endRow = Math.min(rows - 1, Math.floor((y + height - originY) / cellSize - 0.5));
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cx = (col + 0.5) * cellSize;
        const cy = originY + (row + 0.5) * cellSize;
        if (pointInPolygon(cx, cy, poly) || pointToPolygonEdgesDistance(cx, cy, poly) <= clearance) {
          walkable[row * cols + col] = 0;
        }
      }
    }
  }
  return { cellSize, cols, rows, originY, walkable };
}

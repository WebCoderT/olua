import { Injectable, Logger } from "@nestjs/common";
import { MapService } from "../map/map.service";

/** 一张图的可行走几何（碰撞矩形：中心 + 宽高，与 `map_collisions` 同形） */
export interface WalkGeometry {
  width: number;
  height: number;
  boxes: Array<{ cx: number; cy: number; w: number; h: number }>;
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

  /** 这个点在不在某个碰撞盒里（**原始盒**，不外扩：闸门只挡真的穿过去的） */
  blockedIn(geo: WalkGeometry, x: number, y: number): boolean {
    for (const box of geo.boxes) {
      if (Math.abs(x - box.cx) <= box.w / 2 && Math.abs(y - box.cy) <= box.h / 2) return true;
    }
    return false;
  }

  /**
   * 从 `from` 到 `to` 的位移是否**穿过**了碰撞盒（swept-AABB）
   *
   * 三条口径：
   * - **起点在盒里就不判**：那是数据改坏 / 人已经在墙里，判它等于把人锁死在原地
   *   （issue 的「站在碰撞盒内部不往外推」）；
   * - **出图也算撞墙**：`x ∉ [0, width]` 或 `y ∉ [-height, 0]` 直接算穿墙 ——
   *   客户端本来就钳在图内，能报出图外坐标只有改包。⚠️ 世界坐标的 y **恒为负**
   *   （原点在左上角、y 向上），所以下界是 `-height`、上界是 `0`：写成 `y < 0` 会把
   *   每一个合法点都判成出图（第一次实现就踩了，e2e 里 25px 的正常小步全被判 wall）；
   * - **线段与盒做精确相交**（Liang-Barsky 裁剪），不是按步长采样 —— 采样步长再小
   *   也存在「一步跨过薄墙」的缝隙，而这条路是给作弊者准备的，缝隙就等于没有。
   */
  crossesWall(mapId: string, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const geo = this.geometryOf(mapId);
    if (geo === null) return false;
    if (to.x < 0 || to.x > geo.width || to.y > 0 || to.y < -geo.height) return true;
    if (this.blockedIn(geo, from.x, from.y)) return false;
    // 位移的包围盒先粗筛：绝大多数盒根本不在这条线段附近（最多的图 265 个盒）
    for (const box of geo.boxes) {
      const minX = box.cx - box.w / 2;
      const maxX = box.cx + box.w / 2;
      const minY = box.cy - box.h / 2;
      const maxY = box.cy + box.h / 2;
      if (segmentHitsAabb(from.x, from.y, to.x, to.y, minX, minY, maxX, maxY)) return true;
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

/** 线段与轴对齐矩形是否相交（Liang-Barsky；端点接触也算相交） */
export function segmentHitsAabb(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tMin = 0;
  let tMax = 1;
  // 四条边：p 为方向在该轴的分量取反，q 为「起点到边界的距离」
  const edges: Array<[number, number]> = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      // 与该边平行：起点在外面就直接否掉
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > tMax) return false;
      if (r > tMin) tMin = r;
    } else {
      if (r < tMin) return false;
      if (r < tMax) tMax = r;
    }
  }
  return true;
}

/** 按客户端 `PathGrid` 的口径烙一张可走网格 */
function buildGrid(geo: WalkGeometry, cellSize: number, clearance: number): WalkGrid {
  const cols = Math.max(1, Math.ceil(geo.width / cellSize));
  const rows = Math.max(1, Math.ceil(geo.height / cellSize));
  const originY = -geo.height;
  const walkable = new Uint8Array(cols * rows).fill(1);
  for (const box of geo.boxes) {
    // Rect 形状（左下角 + 宽高）→ 外扩 → 再按格子中心判定
    const x = box.cx - box.w / 2 - clearance;
    const y = box.cy - box.h / 2 - clearance;
    const width = box.w + clearance * 2;
    const height = box.h + clearance * 2;
    const startCol = Math.max(0, Math.ceil((x - 0) / cellSize - 0.5));
    const endCol = Math.min(cols - 1, Math.floor((x + width - 0) / cellSize - 0.5));
    const startRow = Math.max(0, Math.ceil((y - originY) / cellSize - 0.5));
    const endRow = Math.min(rows - 1, Math.floor((y + height - originY) / cellSize - 0.5));
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        walkable[row * cols + col] = 0;
      }
    }
  }
  return { cellSize, cols, rows, originY, walkable };
}

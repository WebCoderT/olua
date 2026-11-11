import { Injectable, Logger } from "@nestjs/common";
import { AutoBattleParams } from "../../common/constants/runtime-params";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MapGeometryService, WalkGrid } from "./map-geometry.service";

/** 一个路点（世界坐标） */
export interface PathPoint {
  x: number;
  y: number;
}

/** 一次寻路的结果 */
export interface PathResult {
  /** 路点序列（世界坐标，**不含起点**，已做视线拉直）；不可达时为空数组 */
  points: PathPoint[];
  /** 目标不可达（被墙围死 / 起点与终点不在同一块连通区） */
  unreachable: boolean;
  /** 目标点落在墙里，已吸附到最近的可站立格（客户端据此决定是否提示「走不到那儿」） */
  snapped: boolean;
  /** 搜索耗时（毫秒；排查「谁写了 O(n²)」用） */
  costMs: number;
  /** 不可达 / 没算的原因（可达时为 null） */
  reason: "unreachable" | "no-geometry" | "bad-point" | null;
}

/** 八方向偏移（对角线代价 √2，与客户端同一张表） */
const NEIGHBOR_OFFSETS: Array<{ dc: number; dr: number; cost: number }> = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

/** 超出这个耗时就是实现有问题（64×64 上应该 < 2ms，见 issue 的口径） */
const SLOW_PATH_WARN_MS = 16;

/**
 * 服务端 A*（#811 第三道：寻路的权威）
 *
 * ===========================================================================
 * 为什么服务端也要会寻路
 * ===========================================================================
 * 客户端原本自己 A*（`ui/utils/map/PathGrid`），路点完全由它决定 —— 于是「绕开怪物
 * 走过去」这件事在服务端眼里就是「直线穿过一堆格子」，穿墙校验没法判、也判不准
 * （它只知道起终点，不知道中间怎么走的）。所以：**路点由服务端给**，客户端只负责
 * 「能不能到」的即时预判与表现。
 *
 * ===========================================================================
 * 与客户端 PathGrid 的同一口径（刻意逐行对齐）
 * ===========================================================================
 * - 格子尺寸 / 通行余量读**同一组** `runtime_params.auto_battle.cellSize` / `clearance`
 *   （出厂 40 / 20）—— 服务端不写第二份常量，改配置两端一起变；
 * - 八方向、对角 √2、**禁止切角**（两个正交邻格都得可走）、octile 启发、小顶堆开放集；
 * - 起点 / 目标格被挡住时就近改寻可行走格（起点 4 圈、目标 6 圈），目标格没被挪过时
 *   末尾补上精确目标点；
 * - 结果按「视线采样」拉直（采样步长 `cellSize / 2`）。
 * 两端一致的好处：客户端预判「能到」时，服务端大概率也「能到」；不一致时以服务端为准。
 *
 * ===========================================================================
 * 刻意不做
 * ===========================================================================
 * - **不给怪物寻路**：145 只怪每 100ms 各跑一次 A* 直接打满单核。怪仍用直线追击 +
 *   卡住重选（#853~#858）；
 * - **不烙动态障碍**（场上的怪物不占格）：怪物会移动，烙进去等于每次请求都要重建网格；
 *   而且「从怪身上穿过去」在服务端不是违规（碰撞几何只有 `map_collisions`）。
 *   暂时放置：重开条件 = 出现「必须绕开某只怪」的玩法（例如精英怪实体阻挡）。
 */
@Injectable()
export class PathService {
  private readonly logger = new Logger(PathService.name);

  constructor(
    private readonly runtimeParams: RuntimeParamsRepository,
    private readonly geometry: MapGeometryService,
  ) {}

  /**
   * 从 `from` 到 `to` 的行走路点
   *
   * `from` 由调用方给**服务端权威坐标**（在场表里被接受的那份），不信客户端自报 ——
   * 否则「报一个假起点再要一条路」就能把路点算到墙里去。
   */
  pathOf(mapId: string, from: PathPoint, to: PathPoint): PathResult {
    const startedAt = Date.now();
    if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
      return this.empty("bad-point", startedAt);
    }
    const gridSize = this.gridSize();
    const grid = this.geometry.gridOf(mapId, gridSize.cellSize, gridSize.clearance);
    if (grid === null) return this.empty("no-geometry", startedAt);

    const startCell = toCell(grid, from.x, from.y);
    const goalCell = toCell(grid, to.x, to.y);
    if (!startCell || !goalCell) return this.empty("bad-point", startedAt);
    // 起点 / 目标被挡住时就近改寻可行走格：贴墙站（起点）与点进墙里（目标）都是常态
    const start = nearestWalkableCell(grid, startCell.col, startCell.row, 4);
    const goal = nearestWalkableCell(grid, goalCell.col, goalCell.row, 6);
    if (!start || !goal) return this.empty("unreachable", startedAt);
    const snapped = goal.col !== goalCell.col || goal.row !== goalCell.row;
    const cells = search(grid, start, goal);
    if (cells.length === 0 && !(start.col === goal.col && start.row === goal.row)) {
      return this.empty("unreachable", startedAt);
    }
    const points = cells.map((cell) => cellCenter(grid, cell.col, cell.row));
    // 目标格没被挪过就补上精确目标点：尽量贴近「真的走到那儿」而不是走到格心
    if (!snapped) points.push({ x: to.x, y: to.y });
    const smoothed = smooth(grid, points);
    const costMs = Date.now() - startedAt;
    if (costMs > SLOW_PATH_WARN_MS) {
      this.logger.warn(
        `寻路耗时 ${costMs}ms（${mapId}，${grid.cols}×${grid.rows} 格）：超过 ${SLOW_PATH_WARN_MS}ms 说明搜索写成了 O(n²)` +
          `，先从路点数 ${points.length} 与网格规模查起`,
      );
    }
    return { points: smoothed, unreachable: false, snapped, costMs, reason: null };
  }

  /** 格子尺寸与通行余量（读客户端同一组参数；缺键按出厂 40 / 20） */
  private gridSize(): { cellSize: number; clearance: number } {
    const raw = this.runtimeParams.get()?.auto_battle;
    let parsed: Partial<AutoBattleParams> = {};
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Partial<AutoBattleParams>;
      } catch {
        parsed = {};
      }
    }
    const cellSize = Number(parsed.cellSize);
    const clearance = Number(parsed.clearance);
    return {
      // 下限 8px：格太小会把 265 个盒烙成一整张「都不可走」的网，还不如按出厂值
      cellSize: Number.isFinite(cellSize) && cellSize >= 8 ? cellSize : 40,
      clearance: Number.isFinite(clearance) && clearance >= 0 ? clearance : 20,
    };
  }

  private empty(reason: PathResult["reason"], startedAt: number): PathResult {
    return { points: [], unreachable: true, snapped: false, costMs: Date.now() - startedAt, reason };
  }
}

/** 世界坐标 → 格子（网格外返回 null） */
function toCell(grid: WalkGrid, x: number, y: number): { col: number; row: number } | null {
  const col = Math.floor(x / grid.cellSize);
  const row = Math.floor((y - grid.originY) / grid.cellSize);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;
  return { col, row };
}

/** 格子中心的世界坐标 */
function cellCenter(grid: WalkGrid, col: number, row: number): PathPoint {
  return { x: (col + 0.5) * grid.cellSize, y: grid.originY + (row + 0.5) * grid.cellSize };
}

/** 格子是否可走（越界一律不可走） */
function isWalkable(grid: WalkGrid, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return false;
  return grid.walkable[row * grid.cols + col] === 1;
}

/** 世界坐标处是否可走（网格外不可走） */
function isWalkableAt(grid: WalkGrid, x: number, y: number): boolean {
  const cell = toCell(grid, x, y);
  return cell !== null && isWalkable(grid, cell.col, cell.row);
}

/** 就近找可走格（自身可走直接返回；否则按切比雪夫距离逐圈外扩） */
function nearestWalkableCell(grid: WalkGrid, col: number, row: number, radius: number): { col: number; row: number } | null {
  if (isWalkable(grid, col, row)) return { col, row };
  for (let ring = 1; ring <= radius; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        // 只扫当前圈：切比雪夫距离恰好等于 ring
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        if (isWalkable(grid, col + dc, row + dr)) return { col: col + dc, row: row + dr };
      }
    }
  }
  return null;
}

/** 八分图启发（octile） */
function heuristic(col: number, row: number, goalCol: number, goalRow: number): number {
  const dx = Math.abs(col - goalCol);
  const dy = Math.abs(row - goalRow);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * 八方向 A*（禁止切角），返回从起点到终点的格子序列（**不含起点格**）
 *
 * 每次搜索独立分配三张定长数组（gScore / cameFrom / closed）：按网格规模一次性
 * `Float32Array` 分配比 Map 快一个数量级，而一次点击的规模（最多几万格）完全吃得住。
 */
function search(grid: WalkGrid, start: { col: number; row: number }, goal: { col: number; row: number }): Array<{ col: number; row: number }> {
  const total = grid.cols * grid.rows;
  const startIndex = start.row * grid.cols + start.col;
  const goalIndex = goal.row * grid.cols + goal.col;
  const gScore = new Float32Array(total).fill(Infinity);
  const fScore = new Float32Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  gScore[startIndex] = 0;
  fScore[startIndex] = heuristic(start.col, start.row, goal.col, goal.row);
  const open = new MinHeap(fScore);
  open.push(startIndex);
  while (open.size > 0) {
    const current = open.pop();
    if (current === goalIndex) break;
    if (closed[current]) continue;
    closed[current] = 1;
    const col = current % grid.cols;
    const row = Math.floor(current / grid.cols);
    for (const offset of NEIGHBOR_OFFSETS) {
      const nextCol = col + offset.dc;
      const nextRow = row + offset.dr;
      if (!isWalkable(grid, nextCol, nextRow)) continue;
      // 对角不允许切角：两个正交邻格都必须可走（否则会斜着穿过墙角）
      if (offset.dc !== 0 && offset.dr !== 0) {
        if (!isWalkable(grid, col + offset.dc, row) || !isWalkable(grid, col, row + offset.dr)) continue;
      }
      const nextIndex = nextRow * grid.cols + nextCol;
      if (closed[nextIndex]) continue;
      const tentative = gScore[current] + offset.cost;
      if (tentative >= gScore[nextIndex]) continue;
      gScore[nextIndex] = tentative;
      fScore[nextIndex] = tentative + heuristic(nextCol, nextRow, goal.col, goal.row);
      cameFrom[nextIndex] = current;
      open.push(nextIndex);
    }
  }
  // 终点不可达（cameFrom 没有记录，且终点不是起点）
  if (goalIndex !== startIndex && cameFrom[goalIndex] < 0) return [];
  const cells: Array<{ col: number; row: number }> = [];
  let node = goalIndex;
  while (node !== startIndex && node >= 0) {
    cells.push({ col: node % grid.cols, row: Math.floor(node / grid.cols) });
    node = cameFrom[node];
  }
  cells.reverse();
  return cells;
}

/** 两点间视线是否通畅（按 cellSize/2 采样可走格） */
function hasLineOfSight(grid: WalkGrid, from: PathPoint, to: PathPoint): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / (grid.cellSize / 2)));
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    if (!isWalkableAt(grid, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) return false;
  }
  return true;
}

/** 视线拉直：每个路点尽量直连最远的可视路点（去掉拐弯抹角的中间点） */
function smooth(grid: WalkGrid, points: PathPoint[]): PathPoint[] {
  if (points.length <= 2) return points;
  const result: PathPoint[] = [points[0]];
  let current = 0;
  while (current < points.length - 1) {
    let next = current + 1;
    for (let candidate = points.length - 1; candidate > next; candidate--) {
      if (hasLineOfSight(grid, points[current], points[candidate])) {
        next = candidate;
        break;
      }
    }
    result.push(points[next]);
    current = next;
  }
  return result;
}

/** 二叉小顶堆（按 f 值排序；只服务一次搜索） */
class MinHeap {
  private readonly heap: number[] = [];

  constructor(private readonly fScore: Float32Array) {}

  get size(): number {
    return this.heap.length;
  }

  push(index: number): void {
    const heap = this.heap;
    heap.push(index);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.fScore[heap[parent]] <= this.fScore[heap[child]]) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
  }

  pop(): number {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && this.fScore[heap[left]] < this.fScore[heap[smallest]]) smallest = left;
        if (right < heap.length && this.fScore[heap[right]] < this.fScore[heap[smallest]]) smallest = right;
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
        parent = smallest;
      }
    }
    return top;
  }
}

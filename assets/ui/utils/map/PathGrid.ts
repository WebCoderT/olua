import { Rect, Vec2 } from "cc";

/** 格子（列/行） */
interface GridCell {
  col: number;
  row: number;
}

/** 八方向移动的偏移与代价（对角线代价 √2） */
const NEIGHBOR_OFFSETS: { dc: number; dr: number; cost: number }[] = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

/**
 * 简单二叉小顶堆（A* 开放集，按 f 值排序）
 * 只服务一次搜索（fScore 数组由搜索持有），不入堆的索引不参与排序
 */
class MinHeap {
  private heap: number[] = [];

  constructor(private fScore: Float32Array) {}

  get size(): number {
    return this.heap.length;
  }

  push(index: number) {
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

/**
 * A* 寻路网格（自动战斗走位用，纯工具）
 * 把地图范围（世界坐标，原点为网格左下角）切成 cellSize 见方的格子，可走格记 1、阻挡格记 0；
 * 静态障碍（Tiled 碰撞区、NPC 占位）构建时烙进网格，动态障碍（场上怪物碰撞盒）每次寻路前
 * 随 rebuild 重烙，因此怪物围成的「墙」也会被绕开。
 * 搜索为 8 方向 A*（禁止切角），结果用视线检测拉直成尽量少的路点（世界坐标，不含起点）；
 * 目标格本身被挡住时（怪物贴墙）自动改寻最近的可行走格，尽量贴近目标。
 * 目标不可达时 findPath 返回空数组，由调用方决定退化策略（如直线趋近）。
 */
export default class PathGrid {
  /** 网格原点 x（世界坐标） */
  private readonly originX: number;
  /** 网格原点 y */
  private readonly originY: number;
  /** 格子边长（像素） */
  private readonly cellSize: number;
  /** 列数 */
  private readonly cols: number;
  /** 行数 */
  private readonly rows: number;
  /** 视线检测采样步长（像素） */
  private readonly losStep: number;
  /** 静态障碍（世界坐标，已按通行余量外扩） */
  private readonly staticRects: Rect[];
  /** 可走格（1 = 可走，0 = 阻挡），按行铺平 */
  private walkable: Uint8Array;

  constructor(bounds: Rect, cellSize: number, clearance: number, staticRects: Rect[]) {
    this.originX = bounds.x;
    this.originY = bounds.y;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(bounds.width / cellSize));
    this.rows = Math.max(1, Math.ceil(bounds.height / cellSize));
    this.losStep = cellSize / 2;
    this.staticRects = staticRects.map((rect) => this.inflate(rect, clearance));
    this.walkable = new Uint8Array(this.cols * this.rows);
  }

  /** 重算可走格（每次寻路前调用：静态障碍 + 本次的动态障碍一起烙进网格） */
  rebuild(dynamicRects: Rect[]) {
    this.walkable.fill(1);
    this.staticRects.forEach((rect) => this.stampRect(rect, 0));
    dynamicRects.forEach((rect) => this.stampRect(rect, 0));
  }

  /** 世界坐标处是否可走（网格外一律不可走） */
  isWalkableAt(x: number, y: number): boolean {
    const cell = this.toCell(x, y);
    return !!cell && this.isWalkableCell(cell.col, cell.row);
  }

  /**
   * 计算从 from 到 to 的行走路径（世界坐标路点，不含起点，已做视线拉直）
   * 目标不可达时返回空数组
   */
  findPath(from: Vec2, to: Vec2): Vec2[] {
    const startCell = this.toCell(from.x, from.y);
    const goalCell = this.toCell(to.x, to.y);
    if (!startCell || !goalCell) return [];
    // 起点/目标格被挡住时（贴墙站、目标被怪围住）就近改寻可行走格
    const start = this.nearestWalkableCell(startCell.col, startCell.row, 4);
    const goal = this.nearestWalkableCell(goalCell.col, goalCell.row, 6);
    if (!start || !goal) return [];
    const cells = this.search(start, goal);
    if (!cells.length) return [];
    const points = cells.map((cell) => this.cellCenter(cell));
    // 目标格没有被调整过时补上精确目标点，尽量贴近目标（贴近过程中被挡住会停在接触位置）
    if (goal.col === goalCell.col && goal.row === goalCell.row) points.push(new Vec2(to.x, to.y));
    return this.smooth(points);
  }

  /** 障碍矩形按通行余量外扩（负数收缩，只用于外扩场景） */
  private inflate(rect: Rect, clearance: number): Rect {
    return new Rect(rect.x - clearance, rect.y - clearance, rect.width + clearance * 2, rect.height + clearance * 2);
  }

  /** 把矩形覆盖到的格子标记为 value（按格子中心点是否落在矩形内判定） */
  private stampRect(rect: Rect, value: number) {
    const startCol = Math.max(0, Math.ceil((rect.x - this.originX) / this.cellSize - 0.5));
    const endCol = Math.min(this.cols - 1, Math.floor((rect.x + rect.width - this.originX) / this.cellSize - 0.5));
    const startRow = Math.max(0, Math.ceil((rect.y - this.originY) / this.cellSize - 0.5));
    const endRow = Math.min(this.rows - 1, Math.floor((rect.y + rect.height - this.originY) / this.cellSize - 0.5));
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        this.walkable[row * this.cols + col] = value;
      }
    }
  }

  /** 格子是否可走（越界视为不可走） */
  private isWalkableCell(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false;
    return this.walkable[row * this.cols + col] === 1;
  }

  /** 世界坐标 -> 格子（网格外返回 null） */
  private toCell(x: number, y: number): GridCell | null {
    const col = Math.floor((x - this.originX) / this.cellSize);
    const row = Math.floor((y - this.originY) / this.cellSize);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    return { col, row };
  }

  /** 格子中心的世界坐标 */
  private cellCenter(cell: GridCell): Vec2 {
    return new Vec2(this.originX + (cell.col + 0.5) * this.cellSize, this.originY + (cell.row + 0.5) * this.cellSize);
  }

  /** 就近找一个可行走格（自身可走直接返回；否则按切比雪夫距离逐圈外扩，最多 radius 圈） */
  private nearestWalkableCell(col: number, row: number, radius: number): GridCell | null {
    if (this.isWalkableCell(col, row)) return { col, row };
    for (let ring = 1; ring <= radius; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          // 只扫当前圈（切比雪夫距离恰好等于 ring 的格子）
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          if (this.isWalkableCell(col + dc, row + dr)) return { col: col + dc, row: row + dr };
        }
      }
    }
    return null;
  }

  /** 八方向 A*（禁止切角），返回从起点到终点的格子序列（不含起点格） */
  private search(start: GridCell, goal: GridCell): GridCell[] {
    const total = this.cols * this.rows;
    const startIndex = start.row * this.cols + start.col;
    const goalIndex = goal.row * this.cols + goal.col;
    const gScore = new Float32Array(total).fill(Infinity);
    const fScore = new Float32Array(total).fill(Infinity);
    const cameFrom = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    gScore[startIndex] = 0;
    fScore[startIndex] = this.heuristic(start.col, start.row, goal.col, goal.row);
    const open = new MinHeap(fScore);
    open.push(startIndex);
    while (open.size > 0) {
      const current = open.pop();
      if (current === goalIndex) break;
      if (closed[current]) continue;
      closed[current] = 1;
      const col = current % this.cols;
      const row = Math.floor(current / this.cols);
      for (const offset of NEIGHBOR_OFFSETS) {
        const nextCol = col + offset.dc;
        const nextRow = row + offset.dr;
        if (!this.isWalkableCell(nextCol, nextRow)) continue;
        // 对角移动不允许切角：两个正交邻格都必须可走（否则会斜着穿过墙角）
        if (offset.dc !== 0 && offset.dr !== 0) {
          if (!this.isWalkableCell(col + offset.dc, row) || !this.isWalkableCell(col, row + offset.dr)) continue;
        }
        const nextIndex = nextRow * this.cols + nextCol;
        if (closed[nextIndex]) continue;
        const tentative = gScore[current] + offset.cost;
        if (tentative >= gScore[nextIndex]) continue;
        gScore[nextIndex] = tentative;
        fScore[nextIndex] = tentative + this.heuristic(nextCol, nextRow, goal.col, goal.row);
        cameFrom[nextIndex] = current;
        open.push(nextIndex);
      }
    }
    // 终点不可达（cameFrom 没有记录且终点不是起点）
    if (goalIndex !== startIndex && cameFrom[goalIndex] < 0) return [];
    const cells: GridCell[] = [];
    let node = goalIndex;
    while (node !== startIndex && node >= 0) {
      cells.push({ col: node % this.cols, row: Math.floor(node / this.cols) });
      node = cameFrom[node];
    }
    cells.reverse();
    return cells;
  }

  /** 八分图启发函数（octile distance，对角按 √2 计） */
  private heuristic(col: number, row: number, goalCol: number, goalRow: number): number {
    const dx = Math.abs(col - goalCol);
    const dy = Math.abs(row - goalRow);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  }

  /** 两点间视线是否通畅（按 losStep 逐步采样可走格） */
  private hasLineOfSight(from: Vec2, to: Vec2): boolean {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / this.losStep));
    for (let index = 0; index <= steps; index++) {
      const t = index / steps;
      if (!this.isWalkableAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) return false;
    }
    return true;
  }

  /** 视线拉直：从每个路点尽量直连最远的可视路点，去掉拐弯抹角的中间点 */
  private smooth(points: Vec2[]): Vec2[] {
    if (points.length <= 2) return points;
    const result: Vec2[] = [points[0]];
    let current = 0;
    while (current < points.length - 1) {
      let next = current + 1;
      for (let candidate = points.length - 1; candidate > next; candidate--) {
        if (this.hasLineOfSight(points[current], points[candidate])) {
          next = candidate;
          break;
        }
      }
      result.push(points[next]);
      current = next;
    }
    return result;
  }
}

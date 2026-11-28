import { Rect, Vec2 } from "cc";

/** 多边形顶点（世界坐标；与服务端 `polygon.util` 的 PolyPoint 同形，#1190） */
export interface PolyPoint {
  x: number;
  y: number;
}

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
  /** 通行余量（像素）：静态多边形的贴边外扩在烙格时按它算（#1190） */
  private readonly clearance: number;
  /** 静态障碍矩形（世界坐标，已按通行余量外扩；NPC 占位仍是矩形） */
  private readonly staticRects: Rect[];
  /** 静态障碍多边形（#1190：快照里的碰撞多边形，顶点世界坐标，首尾自动闭合） */
  private readonly staticPolys: PolyPoint[][];
  /** 可走格（1 = 可走，0 = 阻挡），按行铺平 */
  private walkable: Uint8Array;
  /**
   * 静态层快照（#1352）：静态障碍（碰撞多边形 + NPC 占位）烙出来的可走格。
   * 大图的全图尺度多边形逐格烙一遍是百万级运算（46 号图 ~350 万次），而静态障碍
   * 永远不变——构建时烙一次存快照，之后 rebuild 只做一次数组拷贝再烙动态矩形。
   */
  private readonly staticLayer: Uint8Array;
  /** A\* 复用数组（#1352）：按网格规模一次分配，搜索间用代次戳区分新旧状态，不再每轮重分配 */
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  /** 最近一次触碰代次（= 当前代次才算「gScore/cameFrom 有效」） */
  private readonly touchGen: Uint32Array;
  /** 最近一次关闭代次（= 当前代次才算「已在 closed 集」） */
  private readonly closedGen: Uint32Array;
  /** 当前搜索代次（每次 search 自增） */
  private searchGen = 0;

  constructor(bounds: Rect, cellSize: number, clearance: number, staticRects: Rect[] = [], staticPolys: PolyPoint[][] = []) {
    this.originX = bounds.x;
    this.originY = bounds.y;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(bounds.width / cellSize));
    this.rows = Math.max(1, Math.ceil(bounds.height / cellSize));
    this.losStep = cellSize / 2;
    this.clearance = clearance;
    this.staticRects = staticRects.map((rect) => this.inflate(rect, clearance));
    this.staticPolys = staticPolys;
    this.walkable = new Uint8Array(this.cols * this.rows);
    // Uint8Array 零初始化 = 全阻挡，先铺满可走再烙静态障碍（原 fill(1) 在 rebuild 里，#1352 上移）
    this.walkable.fill(1);
    // 静态层只在构建时烙一次（多边形逐格判定是重活，#1352 起不再随 rebuild 重复）
    this.staticRects.forEach((rect) => this.stampRect(rect, 0));
    this.staticPolys.forEach((poly) => this.stampPolygon(poly, 0));
    this.staticLayer = this.walkable.slice();
    const total = this.cols * this.rows;
    this.gScore = new Float32Array(total);
    this.fScore = new Float32Array(total);
    this.cameFrom = new Int32Array(total);
    this.touchGen = new Uint32Array(total);
    this.closedGen = new Uint32Array(total);
  }

  /** 重算可走格（每次寻路前调用）：静态层快照直接拷回，再烙本次的动态障碍（#1352） */
  rebuild(dynamicRects: Rect[]) {
    this.walkable.set(this.staticLayer);
    dynamicRects.forEach((rect) => this.stampRect(rect, 0));
  }

  /** 世界坐标处是否可走（网格外一律不可走） */
  isWalkableAt(x: number, y: number): boolean {
    const cell = this.toCell(x, y);
    return !!cell && this.isWalkableCell(cell.col, cell.row);
  }

  /**
   * 取世界坐标附近最近的可行走点（传送落点吸附用：点击点落在墙里/障碍里时挪到最近能站的位置）
   * @param x 世界坐标 x
   * @param y 世界坐标 y
   * @param radiusCells 逐圈外扩的最大半径（格），附近全是障碍时返回 null
   */
  findNearestWalkablePoint(x: number, y: number, radiusCells: number): Vec2 | null {
    const cell = this.toCell(x, y);
    if (!cell) return null;
    const nearest = this.nearestWalkableCell(cell.col, cell.row, radiusCells);
    return nearest ? this.cellCenter(nearest) : null;
  }

  /**
   * 计算从 from 到 to 的行走路径（世界坐标路点，不含起点，已做视线拉直）
   * 目标不可达时返回空数组
   *
   * `options.keepCells`（#1334 经典走路模式）：返回**逐格格心**、不拉直、不补精确目标点 ——
   * 一格一步的格子走动要求每步恰好是「相邻两格中心的连线」（直格 cellSize / 斜格 √2×cellSize），
   * 拉直与精确目标点都会让步长变得忽长忽短。
   */
  findPath(from: Vec2, to: Vec2, options?: { keepCells?: boolean }): Vec2[] {
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
    // 经典走路模式：一格一步，逐格格心原样返回
    if (options?.keepCells) return points;
    // 目标格没有被调整过时补上精确目标点，尽量贴近目标（贴近过程中被挡住会停在接触位置）
    if (goal.col === goalCell.col && goal.row === goalCell.row) points.push(new Vec2(to.x, to.y));
    return this.smooth(points);
  }

  /** 世界坐标所在格（网格外返回 null；AutoBattle 判「追怪目标换格才重算」用，#1352） */
  cellIndexOf(x: number, y: number): { col: number; row: number } | null {
    return this.toCell(x, y);
  }

  /**
   * 展示路线拉直（#1352）：贪心「最远可视」，返回保留路点的下标序列（升序，含首尾）。
   * 经典模式路径逐格 200+ 点，指示线每帧复制 + 重绘还要按弧长铺点，展示层先拉直成
   * 十几个关键拐点再画；**只影响显示，行走数据仍走逐格路径**。
   */
  simplifyIndices(points: Vec2[]): number[] {
    if (points.length <= 2) return points.map((_, index) => index);
    const kept: number[] = [0];
    let current = 0;
    while (current < points.length - 1) {
      let next = current + 1;
      for (let candidate = points.length - 1; candidate > next; candidate--) {
        if (this.hasLineOfSight(points[current], points[candidate])) {
          next = candidate;
          break;
        }
      }
      kept.push(next);
      current = next;
    }
    return kept;
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

  /**
   * 把多边形覆盖到的格子标记为 value（#1190）
   *
   * **烙格规则必须与服务端 `MapGeometryService.buildGrid` 逐行对齐**：格子中心在形内、
   * 或到任一边的距离 ≤ `clearance`，都标阻挡 —— 两端不一致的话，同一个目标点
   * 吸附到的最近可站立格会不同（客户端预判「能到」、服务端算出「不可达」）。
   * 多边形没有现成的「外扩形状」，用「到边距离」表达与矩形外扩盒同一个语义。
   */
  private stampPolygon(poly: PolyPoint[], value: number) {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const minX = Math.min(...xs) - this.clearance;
    const minY = Math.min(...ys) - this.clearance;
    const maxX = Math.max(...xs) + this.clearance;
    const maxY = Math.max(...ys) + this.clearance;
    const startCol = Math.max(0, Math.ceil((minX - this.originX) / this.cellSize - 0.5));
    const endCol = Math.min(this.cols - 1, Math.floor((maxX - this.originX) / this.cellSize - 0.5));
    const startRow = Math.max(0, Math.ceil((minY - this.originY) / this.cellSize - 0.5));
    const endRow = Math.min(this.rows - 1, Math.floor((maxY - this.originY) / this.cellSize - 0.5));
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cx = this.originX + (col + 0.5) * this.cellSize;
        const cy = this.originY + (row + 0.5) * this.cellSize;
        if (pointInPolygon(cx, cy, poly) || pointToPolygonEdgesDistance(cx, cy, poly) <= this.clearance) {
          this.walkable[row * this.cols + col] = value;
        }
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
    const startIndex = start.row * this.cols + start.col;
    const goalIndex = goal.row * this.cols + goal.col;
    // #1352：gScore/fScore/cameFrom 按网格规模一次分配、跨搜索复用，代次戳区分新旧状态——
    // 大图（1.8 万格）每轮搜索重新分配三张定长数组是几百 KB 的 GC 垫背；代次戳让
    // 「未触碰格」天然等价于「gScore = Infinity / cameFrom 无效 / 未关闭」
    const gen = ++this.searchGen;
    const { gScore, fScore, cameFrom, touchGen, closedGen } = this;
    gScore[startIndex] = 0;
    touchGen[startIndex] = gen;
    fScore[startIndex] = this.heuristic(start.col, start.row, goal.col, goal.row);
    const open = new MinHeap(fScore);
    open.push(startIndex);
    while (open.size > 0) {
      const current = open.pop();
      if (current === goalIndex) break;
      if (closedGen[current] === gen) continue;
      closedGen[current] = gen;
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
        if (closedGen[nextIndex] === gen) continue;
        const known = touchGen[nextIndex] === gen ? gScore[nextIndex] : Infinity;
        const tentative = gScore[current] + offset.cost;
        if (tentative >= known) continue;
        gScore[nextIndex] = tentative;
        touchGen[nextIndex] = gen;
        fScore[nextIndex] = tentative + this.heuristic(nextCol, nextRow, goal.col, goal.row);
        cameFrom[nextIndex] = current;
        open.push(nextIndex);
      }
    }
    // 终点不可达：终点从未被本轮触碰（代次对不上），且终点不是起点
    if (goalIndex !== startIndex && touchGen[goalIndex] !== gen) return [];
    const cells: GridCell[] = [];
    let node = goalIndex;
    while (node !== startIndex && node >= 0 && touchGen[node] === gen) {
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

/**
 * 射线法判点在多边形内（even-odd；#1190）
 *
 * **必须与服务端 `polygon.util.pointInPolygon` 逐行同形**：边界上的点不算严格「在内」，
 * 碰撞判定关心的是「这一步撞不撞墙」，边界差半像素没有 gameplay 意义。
 */
function pointInPolygon(px: number, py: number, poly: PolyPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[i].x;
    const ay = poly[i].y;
    const bx = poly[j].x;
    const by = poly[j].y;
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 点到多边形各边的最小距离（#1190）
 *
 * **必须与服务端 `polygon.util.pointToPolygonEdgesDistance` 逐行同形**：
 * 烙格的「贴边外扩」靠它，两端数字不一样 = 同一个格子两端可走性不同。
 */
function pointToPolygonEdgesDistance(px: number, py: number, poly: PolyPoint[]): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x;
    const ay = poly[j].y;
    const bx = poly[i].x;
    const by = poly[i].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const dist = lengthSq === 0 ? Math.hypot(px - ax, py - ay) : (() => {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    })();
    if (dist < min) min = dist;
  }
  return min;
}

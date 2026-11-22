/**
 * 任意简单多边形的几何纯函数（#1190：碰撞盒从矩形升级为多边形）
 *
 * 三条口径（**必须**与客户端逐行对齐，两端规则不一致 = 客户端预判能到、服务端算不可达）：
 * - 世界坐标：原点在地图左上角、x 向右、y 轴向上（故 y 恒为负）；
 * - 点判用**射线法**（even-odd），顶点顺序不要求（顺逆时针都行）；
 * - 多边形只约束「**简单**」（不自交）：自交的多边形射线法判定会碎成
 *   「哪边算里面都说不清」，所以入库前直接拒绝，而不是在判定时硬吃。
 *
 * 全部是无状态纯函数：单测直接喂坐标断言，不需要起服。
 */

/** 平面点（世界坐标；y 轴向上） */
export interface PolyPoint {
  x: number;
  y: number;
}

/**
 * 射线法判点在多边形内（even-odd）
 *
 * 从点向 x 正方向引一条射线，数它与各边的交点：奇数 = 在内。边界上的点不算严格
 * 「在内」，但碰撞判定关心的是「这一步撞不撞墙」，边界差半个像素没有 gameplay 意义，
 * 不为它做专门的 on-edge 分支（穿墙校验那边线段与边相交才算撞，口径互补）。
 */
export function pointInPolygon(px: number, py: number, poly: Array<PolyPoint>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[i].x;
    const ay = poly[i].y;
    const bx = poly[j].x;
    const by = poly[j].y;
    // 边跨过射线所在的水平线（一上一下），再算交点落在点的右侧与否
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 线段与线段是否相交（**端点接触也算**：贴边走过与穿墙只差半像素，按撞算）
 *
 * 标准方向叉积法：先快速排斥（包围盒不叠 = 不可能相交），再用四组叉积判两侧。
 * 与旧矩形版的 Liang-Barsky 同一「接触即相交」口径（#1190 换多边形后保留）。
 */
export function segmentIntersectsSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // 退化共线且端点落在对方包围盒内 = 接触，也算相交（Liang-Barsky 版的端点接触同口径）
  if (d1 === 0 && onSegment(cx, cy, ax, ay, dx, dy)) return true;
  if (d2 === 0 && onSegment(cx, cy, bx, by, dx, dy)) return true;
  if (d3 === 0 && onSegment(ax, ay, cx, cy, bx, by)) return true;
  if (d4 === 0 && onSegment(ax, ay, dx, dy, bx, by)) return true;
  return false;
}

/** 点 q 是否在线段 p-r 上（q 已确认与 pr 共线时才用） */
function onSegment(px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean {
  return Math.min(px, rx) <= qx && qx <= Math.max(px, rx) && Math.min(py, ry) <= qy && qy <= Math.max(py, ry);
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** 线段 ab 是否与线段 cd 相交（含端点接触）的便捷别名（crossesWall 用） */
export function segmentHitsEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  a: PolyPoint,
  b: PolyPoint,
): boolean {
  return segmentIntersectsSegment(from.x, from.y, to.x, to.y, a.x, a.y, b.x, b.y);
}

/**
 * 多边形是否**自交**（除首尾相接的相邻边外，任何两边相交都算）
 *
 * 只在入库校验时跑（顶点 ≤ 64 → 边对边至多 2016 对，O(n²) 完全够），判定路径不碰它。
 * 相邻边共享一个端点、闭合边与首边共享起点终点，这些「合法共享」要跳过。
 */
export function polygonSelfIntersects(poly: Array<PolyPoint>): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 跳过共享端点的边对：相邻边（j = i+1）与首尾闭合边（i=0 且 j=n-1）
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const b1 = poly[j];
      const b2 = poly[(j + 1) % n];
      if (segmentIntersectsSegment(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)) return true;
    }
  }
  return false;
}

/**
 * 点到多边形**各边**的最小距离（点在形内时也返回到边的距离，调用方自己先判内）
 *
 * 烙格的「外扩」用：格子中心在形内、或到任一边 ≤ clearance，都标阻挡 ——
 * 与旧矩形版「外扩盒 + 格心在盒内」的意图一致（多边形没有现成的外扩形状，
 * 用「到边距离」表达同一个语义）。
 */
export function pointToPolygonEdgesDistance(px: number, py: number, poly: Array<PolyPoint>): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = pointToSegmentDistance(px, py, poly[j].x, poly[j].y, poly[i].x, poly[i].y);
    if (d < min) min = d;
  }
  return min;
}

/** 点到线段的最短距离（垂足落在线段外时取到较近端点的距离） */
export function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  // 垂足参数 clamp 到 [0, 1]：落在外面就贴到端点
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 多边形包围盒（粗筛用：绝大多数格子 / 线段根本不在这个框附近） */
export function polygonBBox(poly: Array<PolyPoint>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 多边形是否**整块**落在地图外（画面上完全看不到它）
 *
 * 地图占 `x ∈ [0, width]`、`y ∈ [-height, 0]`（左上角原点、y 轴向上）。按包围盒判：
 * 允许部分越界（四面围墙本来就画在图外），只有整块都出去才是「画面上找不到」的数据错误。
 * 空顶点（坏 JSON）按「整块在图外」算 —— 展示层宁可多警示，也不把坏数据画成隐形。
 */
export function polygonBBoxFullyOutside(
  poly: Array<PolyPoint>,
  size: { width: number; height: number },
): boolean {
  if (poly.length === 0) return true;
  const box = polygonBBox(poly);
  return box.maxX <= 0 || box.minX >= size.width || box.maxY <= -size.height || box.minY >= 0;
}

/**
 * 解析库里的 points JSON（`[[x,y],...]`）
 *
 * 坏数据返回 null（调用方按「这一行没有几何」跳过并告警），**不抛**：
 * 碰撞几何是加固手段，一行坏了不能把整张图的判定搞挂。
 */
export function parsePolygonPoints(json: string | null | undefined): Array<PolyPoint> | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const poly: Array<PolyPoint> = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [x, y] = item as unknown[];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    poly.push({ x, y });
  }
  return poly;
}

/** 顶点序列 → 紧凑 JSON（[[x,y],...]；入库统一两位小数，由调用方先 round） */
export function polygonPointsJson(poly: Array<PolyPoint>): string {
  return JSON.stringify(poly.map((p) => [p.x, p.y]));
}

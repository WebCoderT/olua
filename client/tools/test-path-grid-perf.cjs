#!/usr/bin/env node
/**
 * 大图自动寻路性能优化回归单测（#1352）
 *
 * 沙瀑废村（46 号图 6336×4608px，cellSize 40 约 1.8 万格）自动寻路周期性卡顿的根源：
 * - 每次 rebuild 把全图尺度碰撞多边形逐格重烙一遍 ≈ 350 万次运算，repathInterval 400ms
 *   一次 = 每秒 ~875 万次纯主线程运算；
 * - 本地 A* 每轮重新分配 ~500KB 定长数组；
 * - 经典模式逐格路径 200+ 点，指示线每帧全量复制 + 按弧长铺点逐点 fill。
 *
 * 本测试读源码静态断言锁住四个修法：
 * 1. 静态烙格只发生在构建时（rebuild = 拷静态层 + 烙动态）；
 * 2. A* 数组按网格规模一次分配、代次戳复用（搜索体内不允许再分配）；
 * 3. 重寻路按需触发（needRepath：点击寻路有路不算、追怪目标换格才算）；
 * 4. 展示路线拉直缓存（经典模式 getRoutePoints 走 displayRoute 切片）+ 点状线批量单次 fill。
 *
 * 用法：node client/tools/test-path-grid-perf.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");
const SERVER_ROOT = path.resolve(__dirname, "..", "..", "server");

/**
 * cc 垫片追加段：基础垫片已有 Vec2 / Size / Color，这里补 PathGrid 用到的 Rect
 * （写法与 test-collision-polygon.cjs 同款）
 */
const CC_EXTRA = `
class Rect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}
module.exports.Rect = Rect;
`;

/** 读一份 assets 下的源码（静态断言用） */
function readSrc(rel) {
  return fs.readFileSync(path.join(ASSETS, rel), "utf8");
}

/** 从源码里截取某个方法的函数体（按方法名起点到下一个「\n  }」收口，足够本测试的粒度） */
function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const end = src.indexOf("\n  }", start);
  return end < 0 ? null : src.slice(start, end);
}

/** 截取「起点签名 → 终点签名」之间的片段（跨方法结构用） */
function sliceBetween(src, startSig, endSig) {
  const start = src.indexOf(startSig);
  if (start < 0) return null;
  const end = src.indexOf(endSig, start);
  return end < 0 ? null : src.slice(start, end);
}

function main() {
  const gridSrc = readSrc("ui/utils/map/PathGrid.ts");
  const battleSrc = readSrc("ui/core/AutoBattle.ts");
  const partsSrc = readSrc("ui/helpers/parts/minimap-parts.ts");
  console.log("\n=== 1. 静态烙格缓存：重活只在构建时干一次 ===");
  const ctorBody = sliceBetween(gridSrc, "constructor(bounds: Rect", "staticLayer = this.walkable.slice()");
  check(!!ctorBody, "构造函数里烙静态障碍并落快照（staticLayer = walkable.slice()）");
  check(!!ctorBody && /stampPolygon\(poly, 0\)/.test(ctorBody), "多边形逐格烙格在构造函数里（只发生一次）");
  const rebuildBody = extractMethod(gridSrc, "rebuild(dynamicRects: Rect[])");
  check(!!rebuildBody, "rebuild 存在");
  check(!!rebuildBody && /walkable\.set\(this\.staticLayer\)/.test(rebuildBody), "rebuild 拷静态层快照（350 万次运算 → 一次数组拷贝）");
  check(!!rebuildBody && !/stampPolygon/.test(rebuildBody), "rebuild 不再重烙静态多边形（每 400ms 一次的重活已移除）");
  check(!!rebuildBody && /dynamicRects\.forEach/.test(rebuildBody), "动态障碍（怪物）仍每次烙进网格");

  console.log("\n=== 2. A* 数组复用：代次戳代替每轮重分配 ===");
  const searchBody = extractMethod(gridSrc, "search(start: GridCell");
  check(!!searchBody, "search 存在");
  check(!!searchBody && !/new (Float|Int|Uint)\d+Array/.test(searchBody), "搜索体内不再分配定长数组（大图每轮 ~500KB GC 垫背已消）");
  check(!!searchBody && /touchGen\[nextIndex\] === gen \? gScore\[nextIndex\] : Infinity/.test(searchBody), "未触碰格按 gScore = Infinity 处理（代次戳语义）");
  check(!!searchBody && /closedGen\[current\] === gen/.test(searchBody) && /closedGen\[goalIndex\]|touchGen\[goalIndex\]/.test(searchBody), "closed 集与不可达判定都走代次戳");
  check(/touchGen = new Uint32Array/.test(gridSrc) && /closedGen = new Uint32Array/.test(gridSrc), "代次数组按网格规模一次分配（实例字段）");

  console.log("\n=== 3. 重寻路按需触发 ===");
  const needBody = extractMethod(battleSrc, "needRepath(to: Vec2");
  check(!!needBody, "AutoBattle.needRepath 存在");
  check(!!needBody && /lastRepathAt === 0\) return true/.test(needBody), "首轮 / 卡住强制（lastRepathAt 清零）必算");
  check(!!needBody && /repathInterval\) return false/.test(needBody), "repathInterval 退化为最小节流间隔");
  check(!!needBody && /pathIndex >= this\.path\.length\) return true/.test(needBody), "路走完还没到必算（点击寻路被截断 / 追怪目标挪走）");
  check(!!needBody && /pendingPoint\) return false/.test(needBody), "点击寻路目标不动：有路就不算");
  check(!!needBody && /cellIndexOf\(to\.x, to\.y\)/.test(needBody), "追怪按目标格变化触发（不按时间盲算）");
  const advanceBody = extractMethod(battleSrc, "advance(roleDisplay: RoleDisplay");
  check(!!advanceBody && /needRepath\(to, now\)/.test(advanceBody), "advance 走 needRepath（时间盲算已删）");
  check(!/lastRepathAt === 0 \|\| now - this\.lastRepathAt >= autoBattle\.repathInterval/.test(advanceBody), "旧的按时间盲算判据已移除");
  const repathBody = extractMethod(battleSrc, "repathTo(roleDisplay: RoleDisplay");
  check(!!repathBody && /lastTargetCell = grid\.cellIndexOf\(to\.x, to\.y\)/.test(repathBody), "重寻路时记录目标格（换格判据的基准）");

  console.log("\n=== 4. 展示路线拉直缓存 + 点状线批量 fill ===");
  const routeBody = extractMethod(battleSrc, "getRoutePoints(): Vec2[]");
  check(!!routeBody && /displayRoute\.length > 0/.test(routeBody) && /displayIndices\[start\] < this\.pathIndex/.test(routeBody), "经典模式 getRoutePoints 走拉直缓存切片（跳过已走过）");
  const rebuildRouteBody = extractMethod(battleSrc, "rebuildDisplayRoute(grid: PathGrid)");
  check(!!rebuildRouteBody && /simplifyIndices\(this\.path\)/.test(rebuildRouteBody), "展示路线 = 逐格路径视线拉直（只影响画线，不影响行走数据）");
  const routeCallers = sliceBetween(battleSrc, "private static repathTo", "裁掉已越过的前导路点（#1346");
  check(!!routeCallers && /rebuildDisplayRoute\(grid\)/.test(routeCallers), "本地重算落地后重建展示路线");
  const serverBody = extractMethod(battleSrc, "applyServerPath(frame:");
  check(!!serverBody && /rebuildDisplayRoute/.test(serverBody), "服务端回执落地后同样重建");
  check(/simplifyIndices\(points: Vec2\[\]\)/.test(gridSrc), "PathGrid.simplifyIndices 存在（贪心最远可视）");
  const drawBody = extractMethod(partsSrc, "drawRouteLine(graphics: Graphics");
  check(!!drawBody, "drawRouteLine 存在");
  const dotLoop = sliceBetween(partsSrc, "for (let offset = carried", "carried = gap -");
  check(!!dotLoop && !/fill\(\)/.test(dotLoop), "铺点循环内不再逐点 fill（大图 270+ 点 × 30 重绘/秒的提交风暴）");
  check(!!drawBody && /graphics\.fill\(\);\s*\n\s*\}/.test(drawBody), "批量点一次 fill（圆点自带 moveTo，不会连成多边形）");

  console.log("\n=== 5. 行为验证：A* 代次戳跨搜索复用（真跑 PathGrid）===");
  let outDir;
  try {
    outDir = prepare("olua-path-grid-perf", ["ui/utils/map/PathGrid.ts"], CC_EXTRA);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }
  const PathGrid = require(path.join(outDir, "ui/utils/map/PathGrid.js")).default;
  const cc = require(path.join(path.dirname(outDir), "node_modules", "cc"));
  const grid = new PathGrid(new cc.Rect(0, -1000, 1000, 1000), 100, 0, [], []);
  const v = (x, y) => new cc.Vec2(x, y);

  // 同一张网格连续两次搜索（代次戳 gen=1 → gen=2）：结果必须一致（复用数组没被上一轮污染）
  const first = grid.findPath(v(50, -950), v(950, -50));
  const second = grid.findPath(v(50, -950), v(950, -50));
  check(first.length > 0, "首次搜索出路径（10×10 对角）");
  check(first.length === second.length, "同一网格连续两次搜索结果一致（代次戳复用无状态泄漏）");

  // 上一轮搜过「可达」之后，再搜「不可达」：代次戳的不可达判定（touchGen 对不上）必须正确
  grid.rebuild([new cc.Rect(400, -600, 300, 500)]); // 中间横一道墙，把上下隔断
  const walled = grid.findPath(v(50, -950), v(950, -50));
  check(walled.length === 0 || walled[walled.length - 1].y > -600, "烙上墙后不再穿墙直达（绕行或不可达）");
  grid.rebuild([]);
  const restored = grid.findPath(v(50, -950), v(950, -50));
  check(restored.length > 0, "墙撤掉后同一张网格还能继续搜（复用数组跨轮次可用）");
  // 不可达用例：目标格 (9,9) 的两个邻格 (8,9)/(9,8) 都烙死 → 空路径；
  // 随后再搜可达点必须恢复正常（代次戳的「未触碰=不可达」不残留）
  grid.rebuild([
    new cc.Rect(800, -100, 100, 100),  // 格 (8,9)，格心 (850,-50)
    new cc.Rect(900, -200, 100, 100),  // 格 (9,8)，格心 (950,-150)
  ]);
  const blocked = grid.findPath(v(50, -950), v(950, -100));
  check(blocked.length === 0, "围死的目标搜不出路径");
  const after = grid.findPath(v(50, -950), v(150, -950));
  // 相邻格：A* 路点 1 个 + findPath 补的精确目标点 = 2 个重合点（既有行为，见 PathGrid.findPath）
  check(after.length === 2 && after[0].x === 150, "不可达之后紧接一次近距搜索仍正常（上一轮的代次戳不污染下一轮）");

  finish();
}

main();

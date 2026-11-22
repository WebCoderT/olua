#!/usr/bin/env node
/**
 * 碰撞多边形回归单测（#1190）
 *
 * 被测对象是**真实模块** `ui/utils/map/PathGrid.ts`（沙箱里编译后 require，不复制一份逻辑）。
 * `cc` 垫片只提供 PathGrid 用到的 `Rect` / `Vec2` 最小形状。
 *
 * 覆盖：
 * A. **烙格规则**（与服务端 `MapGeometryService.buildGrid` 必须逐行对齐的那条）：
 *    格心在形内 → 阻挡；格心在形外但到边 ≤ clearance → 阻挡；再远一格 → 可走。
 *    两端规则不一致的表现是「客户端预判能到、服务端算不可达」—— A 节的数字就是那条缝。
 * B. **点判与贴边距离与服务端 `polygon.util` 逐行同形**（源码断言：关键表达式两边都在，
 *    谁单方改了公式这里就红）。
 * C. **接线**：Spawner 用 PolygonCollider2D + 包围盒中心；ObstacleCollider 有多边形版；
 *    AutoBattle 把快照多边形原样交给 PathGrid；管理端画布的封闭 / 插点 / 删点回调都在。
 *
 * 用法：node client/tools/test-collision-polygon.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");
const SERVER_ROOT = path.resolve(__dirname, "..", "..", "server");

/** 读一份源码（接线断言用） */
function readSrc(rel) {
  return fs.readFileSync(path.join(ASSETS, rel), "utf8");
}
function readServer(rel) {
  return fs.readFileSync(path.join(SERVER_ROOT, rel), "utf8");
}

/**
 * cc 垫片追加段：基础垫片已有 Vec2 / Size / Color，这里补 PathGrid 用到的 Rect
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

function main() {
  let outDir;
  try {
    outDir = prepare("olua-collision-polygon", ["ui/utils/map/PathGrid.ts"], CC_EXTRA);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const PathGrid = require(path.join(outDir, "ui/utils/map/PathGrid.js")).default;
  const cc = require(path.join(path.dirname(outDir), "node_modules", "cc"));

  //#region A. 烙格规则（真跑 PathGrid）

  console.log("\n— A. 烙格：形内阻挡、贴边 ≤ clearance 阻挡、再远一格可走 —");

  // 网格：x ∈ [0, 1000]、y ∈ [-1000, 0]（世界坐标，y 轴向上），cellSize 100。
  // 障碍多边形 = (100,-900)~(300,-700) 的四边形（首尾自动闭合）
  const bounds = new cc.Rect(0, -1000, 1000, 1000);
  const square = [
    { x: 100, y: -900 },
    { x: 300, y: -900 },
    { x: 300, y: -700 },
    { x: 100, y: -700 },
  ];

  // clearance = 0：只有形内的格心被烙。格心是 50/150/250/…（列）与 -950/-850/-750/…（行），
  // 形内 [100,300]×[-900,-700] 的格心 = (150,-850) (250,-850) (150,-750) (250,-750) 四格
  {
    const grid = new PathGrid(bounds, 100, 0, [], [square]);
    grid.rebuild([]);
    check(grid.isWalkableAt(150, -850) === false, "形内格心 (150,-850) → 阻挡");
    check(grid.isWalkableAt(250, -750) === false, "形内格心 (250,-750) → 阻挡");
    check(grid.isWalkableAt(50, -850) === true, "形外一格 (50,-850) → 可走（clearance=0 不外扩）");
    check(grid.isWalkableAt(150, -650) === true, "形外一格 (150,-650) → 可走");
    check(grid.isWalkableAt(150, -950) === true, "形外一格 (150,-950) → 可走");
    check(grid.isWalkableAt(350, -850) === true, "形外一格 (350,-850) → 可走");
  }

  // clearance = 60：形内 + 到任一边 ≤60 都算阻挡（「外扩」的语义由到边距离表达，#1190）。
  // (350,-850) 到右边 x=300 距离 50 ≤ 60 → 阻挡；(450,-850) 距离 150 → 可走
  {
    const grid = new PathGrid(bounds, 100, 60, [], [square]);
    grid.rebuild([]);
    check(grid.isWalkableAt(150, -850) === false, "clearance=60：形内仍然阻挡");
    check(grid.isWalkableAt(350, -850) === false, "clearance=60：贴边 50px 的格心 (350,-850) → 阻挡（外扩语义）");
    check(grid.isWalkableAt(50, -850) === false, "clearance=60：贴边 50px 的格心 (50,-850) → 阻挡");
    check(grid.isWalkableAt(450, -850) === true, "clearance=60：离边 150px (450,-850) → 可走");
  }

  // 多边形混矩形（NPC 占位仍是矩形）：两路静态障碍同时烙
  {
    const grid = new PathGrid(bounds, 100, 0, [{ x: 500, y: -700, width: 200, height: 200 }], [square]);
    grid.rebuild([]);
    check(grid.isWalkableAt(150, -850) === false, "多边形障碍照常烙");
    check(grid.isWalkableAt(600, -600) === false, "矩形障碍（NPC 占位）照常烙");
    check(grid.isWalkableAt(400, -400) === true, "两块障碍之间的开阔地可走");
  }

  // rebuild 重烙：动态矩形清场后障碍不会消失（staticPolys 与 staticRects 每次都重烙）
  {
    const grid = new PathGrid(bounds, 100, 0, [], [square]);
    grid.rebuild([]);
    grid.rebuild([{ x: 400, y: -800, width: 100, height: 100 }]);
    check(grid.isWalkableAt(150, -850) === false, "rebuild 后静态多边形障碍仍在");
    check(grid.isWalkableAt(450, -750) === false, "rebuild 的动态矩形也烙上了");
    grid.rebuild([]);
    check(grid.isWalkableAt(450, -750) === true, "动态矩形撤掉后那一格恢复可走");
  }

  //#endregion

  //#region B. 两端公式同形（源码断言）

  console.log("\n— B. 两端公式同形：PathGrid ↔ 服务端 polygon.util / buildGrid —");

  const clientGrid = readSrc("ui/utils/map/PathGrid.ts");
  const serverPoly = readServer("src/common/utils/polygon.util.ts");
  const serverGeometry = readServer("src/modules/realtime/map-geometry.service.ts");

  // 射线法的关键式（两边逐字符同构，谁单方改判定谁先红）
  check(
    /ay > py !== by > py && px < \(\(bx - ax\) \* \(py - ay\)\) \/ \(by - ay\) \+ ax/.test(clientGrid) &&
      /ay > py !== by > py && px < \(\(bx - ax\) \* \(py - ay\)\) \/ \(by - ay\) \+ ax/.test(serverPoly),
    "射线法 even-odd 关键式两边同形（点判不一致 = 两端可走性分叉）",
  );
  // 贴边距离的关键式（垂足参数 clamp 到 [0,1] 再算距离）
  check(
    /Math\.max\(0, Math\.min\(1, \(\(px - ax\) \* dx \+ \(py - ay\) \* dy\) \/ lengthSq\)/.test(clientGrid) &&
      /Math\.max\(0, Math\.min\(1, \(\(px - ax\) \* dx \+ \(py - ay\) \* dy\) \/ lengthSq\)/.test(serverPoly),
    "点到线段距离（垂足 clamp）两边同形（贴边外扩不一致 = 同一目标吸附到不同格）",
  );
  // 烙格判定式：格心在形内 **或** 到任一边 ≤ clearance
  check(
    /pointInPolygon\(cx, cy, poly\) \|\| pointToPolygonEdgesDistance\(cx, cy, poly\) <= (this\.)?clearance/.test(clientGrid) &&
      /pointInPolygon\(cx, cy, poly\) \|\| pointToPolygonEdgesDistance\(cx, cy, poly\) <= (this\.)?clearance/.test(serverGeometry),
    "烙格判定式（形内 ∨ 贴边 ≤ clearance）两边同形",
  );

  //#endregion

  //#region C. 接线

  console.log("\n— C. 接线：Spawner / ObstacleCollider / AutoBattle / 管理端画布 —");

  const spawner = readSrc("ui/components/map/CollisionAreaSpawner.ts");
  check(/PolygonCollider2D|addPolygonObstacleCollider/.test(spawner), "Spawner 用多边形碰撞体（不再是 BoxCollider2D）");
  check(/setWorldPosition\(centerX, centerY, 0\)/.test(spawner), "节点摆在顶点包围盒中心（与烙格/校验同一套中心口径）");
  check(/points\.length < 3/.test(spawner), "封闭不了的多边形（<3 点）跳过不建（快照再守一道）");

  const collider = readSrc("ui/utils/physics/ObstacleCollider.ts");
  check(/PolygonCollider2D/.test(collider) && /collider\.points = points/.test(collider), "ObstacleCollider 提供多边形版（静态刚体 + 顶点相对节点）");

  const autoBattle = readSrc("ui/core/AutoBattle.ts");
  check(/polys\.push\(poly\.points\.map/.test(autoBattle), "AutoBattle 把快照多边形顶点原样交给 PathGrid");
  check(/new PathGrid\(bounds, autoBattle\.cellSize, autoBattle\.clearance, obstacles\.rects, obstacles\.polys\)/.test(autoBattle), "PathGrid 同时收矩形（NPC 占位）与多边形（静态碰撞）");

  const canvas = fs.readFileSync(path.join(ASSETS, "..", "..", "admin/src/components/map/MapCanvas.tsx"), "utf8");
  check(/onDrawCollisionPolygon\?\.\(polyDraft\)/.test(canvas), "画布点第一个点（≥3 点）封闭 → 整份提交");
  check(/Math\.hypot\(point\.x - polyDraft\[0\]\.x, point\.y - polyDraft\[0\]\.y\) <= closeRadius/.test(canvas), "封闭判定 = 点到第一个点距离 ≤ closeRadius");
  check(/onInsertCollisionVertex\?\.\(box, i\)/.test(canvas) && /onDeleteCollisionVertex\?\.\(box, i\)/.test(canvas), "双击边插点 / 双击顶点删点的回调都在");

  const form = fs.readFileSync(path.join(ASSETS, "..", "..", "admin/src/components/map/CollisionForm.tsx"), "utf8");
  check(/numbers\.length >= 3/.test(form) && /Math\.hypot\(q\.x - p\.x, q\.y - p\.y\) >= 1/.test(form), "表单校验顶点 ≥3 且相邻间距 ≥1px（与服务端 COLLISION_POLY_LIMITS 同口径）");

  //#endregion

  finish("✅ 碰撞多边形（#1190）：烙格 / 两端公式同形 / 接线");
}

try {
  main();
} catch (error) {
  fail(String((error && error.stack) || error));
}

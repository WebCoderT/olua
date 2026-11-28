#!/usr/bin/env node
/**
 * 经典走路模式·路点障碍卡「移动中」回归单测（#1366）
 *
 * 现象：经典模式自动寻路，下一个路点上有 NPC/墙时角色顶在障碍上一直播走路动画。
 *
 * 三个叠加根因，本测试逐个锁住修法：
 * 1. 卡住判据看「总位移」——贴着障碍打滑（分轴滑动/物理滑动）时位移不小，
 *    stuckCount 永远被清零，永远不判卡。修法 = 判「朝路点推进量」：
 *    距路点距离的减少量 < stuckDistance 才判卡；路点换坐标才重置基准
 *    （按值比较，repathTo 每次新建 Vec2 不能按引用）。
 * 2. NPC 不在寻路网格——NPC 是物理障碍（addObstacleCollider）但 rebuild 只烙怪物，
 *    A* 路径径直穿过 NPC 格。修法 = MapObjectSpawner 登记进 AutoBattle，
 *    repathTo / findWalkablePoint 的 rebuild 合并 NPC 矩形。
 * 3. 服务端路径回执不认识 NPC——回执整体替换本地已绕开 NPC 的路径，顶住 → 重寻路 →
 *    本地绕开 → 回执又顶掉 → 无限震荡，路点来回换连 stuckCount 都攒不满。
 *    修法 = applyServerPath 里任一路点落在 NPC 阻挡矩形内整条拒收，保留本地路径。
 *
 * 用法：node client/tools/test-classic-obstacle-stuck.cjs
 */
const fs = require("fs");
const path = require("path");
const { check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");

/** 从源码里截取某个方法的函数体（按方法名起点到下一个「\n  }」收口，足够本测试的粒度） */
function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const end = src.indexOf("\n  }", start);
  return end < 0 ? null : src.slice(start, end);
}

function main() {
  const battlePath = path.join(ASSETS, "ui/core/AutoBattle.ts");
  const spawnerPath = path.join(ASSETS, "ui/components/map/MapObjectSpawner.ts");
  for (const p of [battlePath, spawnerPath]) {
    if (!fs.existsSync(p)) {
      fail(`找不到 ${p}`);
      return;
    }
  }
  const battle = fs.readFileSync(battlePath, "utf8");
  const spawner = fs.readFileSync(spawnerPath, "utf8");

  console.log("\n=== 卡住判据 = 朝路点推进量（advance）===");
  const advanceBody = extractMethod(battle, "advance(roleDisplay: RoleDisplay");
  check(!!advanceBody, "AutoBattle.advance 存在（方法名写错会拿到空串，一律判失败）");
  check(
    !!advanceBody && /this\.lastStuckDist - stuckDistance < autoBattle\.stuckDistance/.test(advanceBody),
    "判卡看「距路点距离的减少量 < stuckDistance」（推进量不足才判卡，原地顶住与贴障打滑都覆盖）",
  );
  check(
    !!advanceBody && /!!this\.lastStuckWaypoint/.test(advanceBody) && /< 1/.test(advanceBody),
    "路点按坐标值比较（差 < 1px 算同一路点）：repathTo 每次新建 Vec2，按引用比较会把同一个格心误判成换路点",
  );
  check(
    !!advanceBody && /this\.path\[this\.pathIndex\] \?\? to/.test(advanceBody),
    "推进基准是当前路点（路走完退化为最终目标点）",
  );
  check(
    !!advanceBody && !/lastStuckX|lastStuckY/.test(advanceBody) && !/lastStuckX|lastStuckY/.test(battle),
    "「总位移」判据（lastStuckX/lastStuckY）不回潮",
  );

  console.log("\n=== NPC 烙进寻路网格 ===");
  check(
    /registerNpcObstacle|clearNpcObstacles|getNpcBlockingRects/.test(battle),
    "AutoBattle 有 NPC 障碍登记三件套（register/clear/getNpcBlockingRects）",
  );
  const repathBody = extractMethod(battle, "repathTo(roleDisplay: RoleDisplay");
  check(
    !!repathBody && /getNpcBlockingRects\(\)/.test(repathBody),
    "repathTo 的 rebuild 合并 NPC 阻挡矩形（A* 路径不再穿过 NPC 格）",
  );
  const walkableBody = extractMethod(battle, "findWalkablePoint(point: Vec2");
  check(
    !!walkableBody && /getNpcBlockingRects\(\)/.test(walkableBody),
    "findWalkablePoint（传送/突进落点吸附）同样避开 NPC",
  );
  const spawnerAll = extractMethod(spawner, "spawnAll()");
  check(
    !!spawnerAll && /AutoBattle\.clearNpcObstacles\(\)/.test(spawnerAll),
    "spawnAll 开头清上一张图的 NPC 登记（换图重建，不残留已销毁节点）",
  );
  const spawnerNpc = extractMethod(spawner, "spawnNpc(id: string");
  check(
    !!spawnerNpc && /AutoBattle\.registerNpcObstacle/.test(spawnerNpc),
    "spawnNpc 生成后登记进寻路障碍",
  );
  check(
    /getWorldColliderRect/.test(battle),
    "NPC 矩形从碰撞盒取（getWorldColliderRect，与怪物同口径 raw rect）",
  );

  console.log("\n=== 服务端回执 NPC 一致性校验（applyServerPath）===");
  const serverBody = extractMethod(battle, "applyServerPath(frame:");
  check(!!serverBody, "applyServerPath 存在");
  check(
    !!serverBody && /getNpcBlockingRects\(\)/.test(serverBody),
    "回执路径先过 NPC 校验（任一路点落在 NPC 阻挡矩形内）",
  );
  check(
    !!serverBody && /rect\.contains/.test(serverBody),
    "逐路点判 containment（rect.contains）",
  );
  // 拒收必须发生在「整体替换本地路径」之前：校验代码在 this.path = frame.points 赋值之前出现
  const rejectIdx = serverBody ? serverBody.indexOf("getNpcBlockingRects()") : -1;
  const applyIdx = serverBody ? serverBody.indexOf("this.path = frame.points") : -1;
  check(rejectIdx >= 0 && applyIdx > rejectIdx, "拒收分支在路径赋值之前（拒收时保留本地路径，不被顶掉）");

  finish("PASS：卡住判据推进量化 / NPC 烙进寻路网格 / 服务端回执 NPC 校验全部通过");
}

main();

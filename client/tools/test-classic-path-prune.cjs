#!/usr/bin/env node
/**
 * 经典走路模式·前导路点裁剪回归单测（#1346 / #1349）
 *
 * #1346 第一版判据（距路点[0] ≤ cellSize 且比路点[0]更接近路点[1]）只治得住本地重寻路
 * （起点 = 当前位置所在格，路点[0] 至多前方一格）；服务端权威路径回执（#811）从
 * 「服务端最后一次接受的位置」起算——4Hz pos 上报 + RTT，回执到达时角色已走出
 * 0.5~1.5 格甚至更远，前置的「≤ cellSize」不成立就一个都裁不掉，照过期路点走回头路，
 * 重寻路 400ms 一次 + 回执一次，往返形成来回折返（#1349）。
 *
 * #1349 换投影判据、不限距离：路点[0]→路点[1] 方向上角色位置的投影分量 > 0 就裁，
 * 循环裁到第一个没越过的路点；严格 > 0 保拐角（垂直拐弯的下一段与来向正交，
 * 贴来向走到拐角前投影恰为 0）。本测试读源码静态断言锁住这个修法：
 * - 判据必须是「点积投影」，不允许距离上限（cellSize / Math.hypot 判据）回潮；
 * - 严格 > 0（≤ 0 即停），不误裁拐角；
 * - 零向量防御（路点重复时不能拿零向量做投影）；
 * - 本地重寻路与服务端回执两条落地路径都必须在 classicWalkMode 开启时才裁
 *   （连续移动模式行为不变）。
 *
 * 用法：node client/tools/test-classic-path-prune.cjs
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
  const srcPath = path.join(ASSETS, "ui/core/AutoBattle.ts");
  if (!fs.existsSync(srcPath)) {
    fail(`找不到 ${srcPath}`);
    return;
  }
  const src = fs.readFileSync(srcPath, "utf8");

  console.log("\n=== 裁剪方法本体（#1349 投影判据）===");
  const body = extractMethod(src, "prunePassedWaypoints(position: Vec2)");
  check(!!body, "AutoBattle.prunePassedWaypoints 存在（方法名写错会拿到空串，一律判失败）");
  check(!!body && /\(position\.x - current\.x\) \* dx/.test(body), "判据是点积投影（位置相对路点[0]的偏移 · 路点[0]→路点[1] 方向）");
  check(!!body && /<= 0\) break/.test(body), "严格 > 0 才裁：投影 ≤ 0 即停（拐角前投影恰为 0，不误裁拐角路点）");
  check(!!body && /dx === 0 && dy === 0/.test(body) && /break/.test(body), "零向量防御：路点重复时不做投影");
  check(!!body && !/cellSize/.test(body), "不允许距离上限回潮（#1346 的「距路点[0] ≤ cellSize」裁不动超过一格的滞后回执）");
  check(!!body && !/Math\.hypot/.test(body), "不允许距离比较判据回潮（距离判据在垂直拐弯处会误裁拐角）");
  check(!!body && /while \(this\.path\.length >= 2\)/.test(body) && /this\.path\.shift\(\)/.test(body), "循环裁到第一个没越过的路点（回执滞后几格都裁得干净）");

  console.log("\n=== 落地路径：本地重寻路 + 服务端回执都要裁，且只在经典模式 ===");
  const repathBody = extractMethod(src, "repathTo(roleDisplay: RoleDisplay");
  check(!!repathBody && /autoBattle\.classicWalkMode\) this\.prunePassedWaypoints/.test(repathBody), "repathTo 在 classicWalkMode 开启时裁（连续模式不 prune，行为不变）");
  const serverBody = extractMethod(src, "applyServerPath(frame:");
  check(!!serverBody, "applyServerPath 存在（服务端权威路径的落地点）");
  check(!!serverBody && /classicWalkMode/.test(serverBody) && /prunePassedWaypoints/.test(serverBody), "服务端回执落地后同样在 classicWalkMode 开启时裁");
  const callCount = (src.match(/this\.prunePassedWaypoints\(/g) || []).length;
  check(callCount === 2, `裁剪只从这两条路径调用（当前 ${callCount} 处，多了要回来补断言）`);

  finish();
}

main();

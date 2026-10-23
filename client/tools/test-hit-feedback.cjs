#!/usr/bin/env node
/**
 * 玩家受击反馈回归单测（issue #13）
 *
 * 两层断言：
 * 1. 配置层（configs-sandbox 编真实表跑断言）：
 *    · 飘字错峰表 offsetXs 非空、全为有限数字（错峰轮转的前提）
 *    · 红闪配置字段齐全且取值合理（maxOpacity ∈ (0,1]、时长 > 0、限频 ≥ 0）
 *    · 角色侧受击动画链路真实可用：roleAnimationMap 每个方向都有 injured 片段（2 帧）、
 *      受击不需要武器（无武器外观也能播）、speedRate.INJURED 有效（受击时长口径存在）
 * 2. 接线层（读源码静态断言，跑不了引擎就盯住关键行）：
 *    · 受击动作的优先级守卫（施法/死亡不播）在 RoleDisplay.playInjured 里真实存在
 *    · RoleAppearance.playInjured 不改写宿主动作状态（否则受击会被 FINISHED 续播无限重播）
 *    · MonsterAI 命中玩家后调用 onPlayerHit 与红闪；组合根 Game 接线并在卸载时摘除
 *
 * 用法：node client/tools/test-hit-feedback.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");

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

function main() {
  let outDir;
  try {
    outDir = prepare("olua-hit-feedback", ["configs/effect.ts", "configs/layout/theme.ts", "configs/animation.ts", "configs/role.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { uiTheme } = require(path.join(outDir, "configs/layout/theme.js"));
  const { hitScreenFlash } = require(path.join(outDir, "configs/effect.js"));
  const { roleAnimationMap, actionNeedWeapon } = require(path.join(outDir, "configs/animation.js"));
  const { defaultRoleSpeedRate } = require(path.join(outDir, "configs/role.js"));
  console.log("\n=== 数值反馈：飘字错峰表（configs/layout/theme）===");
  const offsetXs = uiTheme.floatingText.damage.offsetXs;
  check(Array.isArray(offsetXs) && offsetXs.length >= 2, "offsetXs 至少给出两个落点（否则错峰不生效）");
  check(offsetXs.every((value) => typeof value === "number" && Number.isFinite(value)), "offsetXs 全为有限数字");
  check(new Set(offsetXs).size === offsetXs.length, "offsetXs 无重复（重复项等于浪费一个落点）");

  console.log("\n=== 屏幕反馈：红闪配置（configs/effect.hitScreenFlash）===");
  check(!!hitScreenFlash.color, "color 已配置");
  check(typeof hitScreenFlash.maxOpacity === "number" && hitScreenFlash.maxOpacity > 0 && hitScreenFlash.maxOpacity <= 1, "maxOpacity ∈ (0, 1]（薄红提示，不能盖住画面）");
  check(hitScreenFlash.fadeIn > 0 && hitScreenFlash.fadeOut > 0, "淡入/淡出时长均 > 0");
  check(hitScreenFlash.cooldownMs >= 0, "限频间隔 ≥ 0");
  check(hitScreenFlash.overscan >= 1, "overscan ≥ 1（铺满可视区防边缘露底）");

  console.log("\n=== 动作反馈：受击动画链路（configs/animation + configs/role）===");
  const directions = ["up", "right_up", "right", "right_down", "down", "left_down", "left", "left_up"];
  directions.forEach((direction) => {
    const frames = roleAnimationMap.get(`injured_${direction}`);
    check(!!frames && frames.length === 2, `injured_${direction} 有受击片段（2 帧）`);
  });
  check(actionNeedWeapon.injured === false, "受击动作不需要武器（空手/无武器外观也能播）");
  const injuredRate = defaultRoleSpeedRate?.injured;
  check(typeof injuredRate === "number" && injuredRate > 0, `defaultRoleSpeedRate.injured 有效（受击时长口径存在，当前 ${injuredRate}）`);

  console.log("\n=== 接线层：优先级规则与组合根接线（读源码静态断言）===");
  const injuredBody = extractMethod(readSrc("ui/components/role/RoleDisplay.ts"), "playInjured()");
  check(!!injuredBody, "RoleDisplay.playInjured 存在");
  check(!!injuredBody && /this\.dead \|\| this\.attacking/.test(injuredBody), "受击守卫：死亡或施法/普攻中不播（issue #13：不能打断正在做的事）");
  const appearanceBody = extractMethod(readSrc("ui/components/role/RoleAppearance.ts"), "playInjured(direction: DIRECTION)");
  check(!!appearanceBody, "RoleAppearance.playInjured 存在");
  check(!!appearanceBody && !/this\.action\s*=/.test(appearanceBody), "受击不改写宿主动作状态（否则 FINISHED 续播会把受击无限重播）");
  check(!!appearanceBody && /getState\(animationName\)/.test(appearanceBody) && /isPlaying/.test(appearanceBody), "已在受击动画中时不重启（连环挨打不抖成筛子）");
  const monsterAiSrc = readSrc("ui/core/MonsterAI.ts");
  check(/onPlayerHit\?\.\(player\)/.test(monsterAiSrc), "MonsterAI 命中玩家后触发 onPlayerHit 接线");
  check(/showHitScreenFlash\(\)/.test(monsterAiSrc), "MonsterAI 命中玩家后触发屏幕红闪");
  const gameSrc = readSrc("ui/Game.ts");
  check(/MonsterAI\.onPlayerHit = /.test(gameSrc), "组合根 Game 接线受击出口");
  check(/MonsterAI\.onPlayerHit = null/.test(gameSrc), "场景卸载时摘除受击出口（避免跨场景残留）");

  finish("PASS：受击反馈三件套配置齐全、受击动画链路真实可用、优先级守卫与组合根接线在位。");
}

main();

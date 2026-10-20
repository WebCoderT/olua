#!/usr/bin/env node
/**
 * 伤害结算上移单测（client/tools/test-combat-settle.cjs，issue #34）
 *
 * 盯的不变量（改伤害结算链路后必须全绿）：
 * A. skillDamageBand（BattleMath 纯函数）：双跑对账的「合法带」口径钉死 ——
 *    下限 = max(0, round(min攻×rate − max防))，上限 = max(0, round(max攻×rate − min防))；
 *    区间颠倒自动纠正、三种攻击属性各映射到对应防御、负伤害截到 0；
 *    且 calcSkillDamage 的每一次真实随机结果都必须落在带内（带漏了 = 合法伤害被误报越界）
 * B. 出手与结算接线（源码断言）：warrior.ts 通道可用时 sendCast 后 return（不许本地再扣一次），
 *    回滚路径保留；MonsterManager.applyServerSettle 走 skillDamageBand 对账、死亡清索引；
 *    Game.ts 接 onSettle、RealtimeClient 转发 settle 帧、CombatChannel.castSeq 单调
 * C. 服务端快照与守卫：MONSTER_COMBAT 进了生成物（220 只怪）、audit-shared-data 守着这张表、
 *    生成器 SOURCE_FILES 收了 configs/monster；e2e-combat 依赖的怪物 "1" 数值锚在快照上
 *
 * 沙箱机制：A 段复用 lib/configs-sandbox.cjs 的 prepare（真实 BattleMath + cc 垫片，
 * 只用到 Vec2 的构造，BoxCollider2D/Node 只在不会调用的函数里出现）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

// ==============================================================================
//  A. skillDamageBand 纯函数口径
// ==============================================================================

console.log("\n— A. skillDamageBand：双跑对账的合法带 —");

const outDir = prepare("olua-combat-settle", ["ui/utils/battle/BattleMath.ts"]);
const { skillDamageBand, calcSkillDamage } = require(path.join(outDir, "ui/utils/battle/BattleMath.js"));

check(typeof skillDamageBand === "function" && typeof calcSkillDamage === "function", "BattleMath 两个纯函数可从沙箱加载");

/** 属性表便捷构造（只填要断言的项，其余给 0 区间避免干扰） */
const attrs = (values) => ({
  physicalAttack: [0, 0], magicAttack: [0, 0], taoistAttack: [0, 0],
  physicalDefense: [0, 0], magicDefense: [0, 0], taoistDefense: [0, 0],
  ...values,
});

{
  // e2e-combat 的锚：1 级角色物攻 [14,20] × 倍率 1，怪物 1 物防 [4,6] → [8, 16]
  const [low, high] = skillDamageBand(attrs({ physicalAttack: [14, 20] }), attrs({ physicalDefense: [4, 6] }), "physicalAttack", 1);
  check(low === 8 && high === 16, "锚点口径：物攻 [14,20] × 1 − 物防 [4,6] → [8, 16]（与 e2e-combat 同源）", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ physicalAttack: [14, 20] }), attrs({ physicalDefense: [4, 6] }), "physicalAttack", 2);
  check(low === 22 && high === 36, "倍率乘在攻击上：×2 → [22, 36]", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ physicalAttack: [20, 14] }), attrs({ physicalDefense: [6, 4] }), "physicalAttack", 1);
  check(low === 8 && high === 16, "区间上下限颠倒时自动纠正（结果与正写一致）", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ physicalAttack: [1, 2] }), attrs({ physicalDefense: [5, 9] }), "physicalAttack", 1);
  check(low === 0 && high === 0, "防御压过攻击：带截到 [0, 0]（伤害不为负）", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ magicAttack: [10, 12] }), attrs({ magicDefense: [2, 3] }), "magicAttack", 1);
  check(low === 7 && high === 10, "magicAttack 对位 magicDefense", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ taoistAttack: [10, 12] }), attrs({ taoistDefense: [2, 3] }), "taoistAttack", 1);
  check(low === 7 && high === 10, "taoistAttack 对位 taoistDefense", `[${low}, ${high}]`);
}
{
  const [low, high] = skillDamageBand(attrs({ physicalAttack: [10.5, 10.5] }), attrs({ physicalDefense: [0.2, 0.2] }), "physicalAttack", 1);
  check(low === 10 && high === 10, "结果四舍五入取整（round(10.3) = 10）", `[${low}, ${high}]`);
}
{
  // 带必须罩住公式的每一次真实随机：500 掷采样，任何一次出带 = 对账口径漏了
  const attacker = attrs({ physicalAttack: [14, 20] });
  const victim = attrs({ physicalDefense: [4, 6] });
  const [low, high] = skillDamageBand(attacker, victim, "physicalAttack", 1);
  let escaped = 0;
  for (let i = 0; i < 500; i++) {
    const damage = calcSkillDamage(attacker, victim, "physicalAttack", 1);
    if (damage < low || damage > high) escaped += 1;
  }
  check(escaped === 0, `calcSkillDamage 连掷 500 次全部落在带内（出带 ${escaped} 次）`);
}

// ==============================================================================
//  B. 出手与结算接线（源码断言）
// ==============================================================================

console.log("\n— B. 出手与结算接线 —");

const warriorSource = read(path.join("assets", "skills", "warrior.ts"));
const monsterSource = read(path.join("assets", "ui", "core", "MonsterManager.ts"));
const gameSource = read(path.join("assets", "ui", "Game.ts"));
const realtimeSource = read(path.join("assets", "ui", "utils", "net", "RealtimeClient.ts"));
const channelSource = read(path.join("assets", "ui", "utils", "net", "CombatChannel.ts"));
const skillTypeSource = read(path.join("assets", "types", "skill.ts"));

check(
  /if \(CombatChannel\.active\) \{\s*\n\s*CombatChannel\.sendCast\(config\.id, monster\.instanceId, monster\.id\);\s*\n\s*return;/.test(warriorSource),
  "通道可用：sendCast(config.id, instanceId, monsterKey) 后 return（本地不许再扣一次血）",
);
check(
  /calcSkillDamage\(role, monster, "physicalAttack", rate\)/.test(warriorSource) && /MonsterManager\.hurt\(target, damage\)/.test(warriorSource),
  "本地回滚路径保留（通道不可用时走与上移前同一套公式）",
);
check(
  /static applyServerSettle\(/.test(monsterSource) && /skillDamageBand\(role, monster, "physicalAttack", rate\)/.test(monsterSource),
  "applyServerSettle 用 skillDamageBand 对账（越界 [combat-parity] 可观测，不静默吞）",
);
check(
  /this\.instanceIndex\.clear\(\)/.test(monsterSource) && /this\.instanceIndex\.delete\(monster\.instanceId\)/.test(monsterSource),
  "目标索引生命周期：reset 清空、死亡移除（死怪不再接 settle 帧）",
);
check(
  /CombatChannel\.onSettle = MonsterManager\.applyServerSettle;/.test(gameSource) && /CombatChannel\.onSettle = null;/.test(gameSource),
  "Game.ts 接线 onSettle（start 接上、onDestroy 摘掉）",
);
check(/CombatChannel\.dispatchSettle\(frame\.data\)/.test(realtimeSource), "RealtimeClient 把 settle 帧转发给 CombatChannel");
check(/castSeq \+= 1/.test(channelSource), "CombatChannel.castSeq 单调递增（castId 只会更大）");
check(/id: SkillId;/.test(skillTypeSource), "SkillConfig 声明 id 字段（技能实现 sendCast(config.id) 的来源）");

// ==============================================================================
//  C. 服务端快照与守卫
// ==============================================================================

console.log("\n— C. 服务端快照与守卫 —");

const generated = read(path.join("..", "server", "src", "shared", "game-data.generated.ts"));
const auditSource = read(path.join("..", "tools", "audit-shared-data.cjs"));
const genSource = read(path.join("..", "tools", "gen-shared-data.cjs"));

check(/export const MONSTER_COMBAT = \{/.test(generated), "生成物导出 MONSTER_COMBAT（怪物数值随快照下发服务端）");
check(/"MONSTER_COMBAT"/.test(auditSource), "audit-shared-data 的 REQUIRED_EXPORTS 收了 MONSTER_COMBAT（表漂移会被守卫抓）");
check(/"monster"/.test(genSource), "gen-shared-data 的 SOURCE_FILES 收了 configs/monster（源头在客户端配置）");

{
  const block = generated.slice(generated.indexOf("export const MONSTER_COMBAT"));
  const body = block.slice(0, block.indexOf("\n};"));
  const entryCount = (body.match(/\{"level":/g) || []).length;
  check(entryCount === 220, `快照收录 220 只怪的战斗数值（实得 ${entryCount}）`);
  check(/"1": \{"level":1,"tier":"normal","maxHp":65,/.test(body), "怪物 \"1\" 的锚点数值在快照里（maxHp 65，e2e-combat 依赖）");
  check(/"1": \{.*"physicalDefense":\[4,6\]/.test(body), "怪物 \"1\" 物防 [4,6]（e2e 区间 [8,16] 的怪侧一半）");
}

finish("PASS：伤害结算上移（skillDamageBand 带口径、出手/结算接线、快照与守卫）全部通过。");

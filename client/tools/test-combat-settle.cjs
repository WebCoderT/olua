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
 * C. 快照与守卫：#655 起怪物数值**服务端独有** —— 代码里不再有 shared/ 目录（数值只在库里）、
 *    audit-shared-data 同步收窄；e2e-combat 依赖的怪物 "1" 锚点直接从配置快照取
 *
 * 沙箱机制：A 段复用 lib/configs-sandbox.cjs 的 prepare（真实 BattleMath + cc 垫片，
 * 只用到 Vec2 的构造，BoxCollider2D/Node 只在不会调用的函数里出现）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

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
const roleDisplaySource = read(path.join("assets", "ui", "components", "role", "RoleDisplay.ts"));
const roleConfigSource = read(path.join("assets", "configs", "role.ts"));
const applySnapshotSource = read(path.join("assets", "configs", "apply-snapshot.ts"));

check(
  /CombatChannel\.sendCast\(config\.id, monster\.instanceId, monster\.id\);/.test(warriorSource),
  "出手只发 sendCast(config.id, instanceId, monsterKey)（伤害由服务端算）",
);
// #581：本地扣血那条回滚已删 —— 怪物只在服务端生成，断线时场上根本没有怪可打，
// 留着「算一遍本地伤害」只会让人以为客户端还能自己打怪
check(
  !/calcSkillDamage\(/.test(warriorSource) && !/MonsterManager\.hurt\(/.test(warriorSource) && !/static hurt\(/.test(monsterSource),
  "客户端没有本地扣血路径（skills 不算伤害、MonsterManager 没有 hurt）",
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
  /CombatChannel\.onSettle = MonsterManager\.applyServerSettle\.bind\(MonsterManager\);/.test(gameSource) && /CombatChannel\.onSettle = null;/.test(gameSource),
  "Game.ts 接线 onSettle（start 接上、onDestroy 摘掉）",
);
check(/CombatChannel\.dispatchSettle\(frame\.data\)/.test(realtimeSource), "RealtimeClient 把 settle 帧转发给 CombatChannel");
check(
  // #804 起 onWorld 多了一段「地面掉落物按快照重建」，于是从裸 bind 改成箭头函数；
  // 断言随之允许两种写法，但**必须**满足其中一种：要么 bind 上 MonsterManager，
  // 要么在箭头里显式写 `MonsterManager.applyWorldState(` —— 回调由 CombatChannel 触发，
  // 裸方法引用会让 this 丢成 CombatChannel（#222，这才是这条断言真正守的东西）
  (/CombatChannel\.onWorld = MonsterManager\.applyWorldState\.bind\(MonsterManager\);/.test(gameSource) ||
    /CombatChannel\.onWorld = \(snapshot\) => \{[^}]*MonsterManager\.applyWorldState\(snapshot\)/.test(gameSource)) &&
    /CombatChannel\.onWorld = null;/.test(gameSource),
  "Game.ts 接线 onWorld（start 接上、onDestroy 摘掉）——receiver 必须显式（bind 或箭头里点名 MonsterManager），裸赋值会让 this 丢成 CombatChannel（#222）",
);
check(/castSeq \+= 1/.test(channelSource), "CombatChannel.castSeq 单调递增（castId 只会更大）");
check(/id: SkillId;/.test(skillTypeSource), "SkillConfig 声明 id 字段（技能实现 sendCast(config.id) 的来源）");

// ==============================================================================
//  C2. 出手被拒的反馈（#1133：蓝量权威在服务端，被拒帧是唯一反馈通道）
// ==============================================================================

// 本地扣蓝预测已删（#1133）：耗蓝由 cast 帧的服务端施法闸（#813 spendCastMp）扣，
// 权威值经 roleUpdate 帧回传 —— 本地扣一份再被帧覆盖就是「蓝量弹回」的根源
const skillManagerSource = read(path.join("assets", "ui", "core", "SkillManager.ts"));
check(
  !/MpHelper\.spend\(/.test(skillManagerSource) && /MpHelper\.hasEnough\(context\.role, config\.mpCost\)/.test(skillManagerSource),
  "SkillManager 不再本地扣蓝（MpHelper.spend 已删；hasEnough 只作快捷预判保留）",
);
check(
  /static alignCooldown\(/.test(skillManagerSource) && /remainMs/.test(skillManagerSource),
  "SkillManager.alignCooldown 按服务端权威 remainMs 对齐本地冷却钟（防两时钟漂移后反复被拒）",
);
check(
  /pendingCasts/.test(channelSource) && /pendingCasts\.set\(this\.castSeq, skillId\)/.test(channelSource) && /pendingCasts\.delete\(settle\.castId\)/.test(channelSource),
  "CombatChannel 记 castId→skillId 对账表（拒绝帧不带 skillId，回帧反查后清账）",
);
check(
  /onCastRejected\?\.\(\{/.test(channelSource) && /onCastRejected: \(\(rejected: CastRejected\) => void\) \| null = null/.test(channelSource),
  "CombatChannel 有 onCastRejected 出口（settle ok=false 交给上层表现，没接线时只 warn）",
);
check(
  /CombatChannel\.onCastRejected = \(\{ skillId, rejected, remainMs, need, have \}\) => \{[\s\S]*?SkillManager\.alignCooldown\(skillId, remainMs \?\? 0\)[\s\S]*?skill_mp_tip/.test(gameSource) &&
    /CombatChannel\.onCastRejected = null;/.test(gameSource),
  "Game.ts 接线 onCastRejected（mp 拒绝飘「蓝不足」、cooldown 对齐冷却；onDestroy 摘掉）",
);

// ==============================================================================
//  C1.五. 冷却收权（#1137 批次 2：冷却显示全由服务端值驱动，本地不自起时钟）
// ==============================================================================

console.log("\n— C1.五. 冷却收权（#1137 批次 2）—");

check(
  !/cooldowns\.set\(skillId, Date\.now\(\)\)/.test(skillManagerSource),
  "tryCast 不再本地起冷却钟（本地钟与 lastCastAt 漂移是 #1133 弹回的推手；表只写服务端给来的值）",
);
check(
  /static noteServerCooldown\(/.test(skillManagerSource) && /ServerClock\.skew/.test(skillManagerSource),
  "SkillManager.noteServerCooldown 用 ServerClock 换算 settle-ok 的权威 cooldownUntilMs（冷却显示的主入口）",
);
check(
  /static applyServerCooldowns\(/.test(skillManagerSource) && /!\(key in cooldowns\)/.test(skillManagerSource),
  "SkillManager.applyServerCooldowns 整表对齐 roleUpdate 快照（表外技能 = 服务端判定已就绪，清本地残留）",
);
check(
  /onCastAccepted\?\.\(\{ skillId, cooldownUntilMs: ok\.cooldownUntilMs \}\)/.test(channelSource) &&
    /CombatChannel\.onCastAccepted = \(\{ skillId, cooldownUntilMs \}\) => \{/.test(gameSource) &&
    /CombatChannel\.onCastAccepted = null;/.test(gameSource),
  "Game.ts 接线 onCastAccepted（settle-ok 带回权威冷却结束时刻；onDestroy 摘掉）",
);
check(
  /SkillManager\.applyServerCooldowns\(update\.cooldowns\)/.test(gameSource),
  "Game.ts 把 roleUpdate 的冷却表交给 SkillManager 对齐（进图/重连的存量冷却来源）",
);

// ==============================================================================
//  C1.六. 移动意图收权（#1138 批次 3：客户端只报「往哪走」，步进在服务端）
// ==============================================================================

console.log("\n— C1.六. 移动意图收权（#1138 批次 3）—");

check(
  /static sendMoveIntent\(dx: number, dy: number, run: boolean\)/.test(channelSource) &&
    /kind: "dir"/.test(channelSource) &&
    /static sendMoveStop\(\)/.test(channelSource),
  "CombatChannel.sendMoveIntent / sendMoveStop（意图帧走 dir 形状，seq 自增）",
);
check(
  /onMoveIntent: \(\(intent: \{ dx: number; dy: number; run: boolean \} \| null\) => void\) \| null = null/.test(roleDisplaySource) &&
    /private reportMoveIntent\(\)/.test(roleDisplaySource),
  "RoleDisplay.onMoveIntent 出口 + reportMoveIntent（意图变化才发，不是每帧）",
);
check(
  /const blocked = this\.dead \|\| this\.attacking \|\| this\.controlLocked;/.test(roleDisplaySource),
  "死亡 / 攻击锁 / 被控期间意图恒为 null（服务端不步进，避免「本地站着打、别人看到滑步」）",
);
check(
  /this\.roleDisplay\.onMoveIntent = \(intent\) => \{/.test(gameSource) &&
    /CombatChannel\.sendMoveIntent\(intent\.dx, intent\.dy, intent\.run\)/.test(gameSource) &&
    /CombatChannel\.sendMoveStop\(\);/.test(gameSource),
  "Game.ts 在 roleDisplay 创建之后接线 onMoveIntent（转成协议帧）",
);
check(
  /export let ROLE_WALK_SPEED/.test(roleConfigSource) &&
    /export function setPlayerMoveSpeeds\(/.test(roleConfigSource) &&
    /PHYSICS_PTM = 32/.test(roleConfigSource),
  "configs/role.ts 移速改为快照可覆写（setPlayerMoveSpeeds 除以 PTM 32 落进刚体）",
);
check(
  /setPlayerMoveSpeeds\(params\.playerMove\.walkSpeedPxPerS, params\.playerMove\.runSpeedPxPerS\)/.test(applySnapshotSource),
  "apply-snapshot 把 runtimeParams.playerMove 覆写进本地移速（速度权威在服务端）",
);

// ==============================================================================
//  C1.七. 自机表演化（#1139 批次 4：位置/动画全按服务端帧回放，本地零物理）
// ==============================================================================

const moveBlockingSource = read(path.join("assets", "ui", "utils", "physics", "MoveBlocking.ts"));

console.log("\n— C1.七. 自机表演化（#1139 批次 4）—");

check(
  !/RigidBody2D/.test(roleDisplaySource) &&
    !/resolveBlockedVelocity/.test(roleDisplaySource) &&
    !/updateWorldPosition/.test(roleDisplaySource),
  "RoleDisplay 本地位移物理整体退场（无刚体 / 无阻挡预测 / 无 updateWorldPosition）",
);
check(
  /private readonly positions = new SnapshotInterpolator\(/.test(roleDisplaySource) &&
    /applyServerPosition\(x: number, y: number, moving: boolean, t: number\)/.test(roleDisplaySource) &&
    /positions\.sample\(ServerClock\.renderTime\(/.test(roleDisplaySource),
  "自机位置走 SnapshotInterpolator 回放（与别人 / 怪物同一套按服务端时间插值）",
);
check(
  /SELF_SNAP_DISTANCE = 64/.test(roleDisplaySource) &&
    /Math\.hypot\(x - newest\.x, y - newest\.y\) > SELF_SNAP_DISTANCE\) this\.positions\.reset\(\)/.test(roleDisplaySource),
  "帧间距 > 64px 判瞬移：清缓冲直接落位（突进 / 复活传送不滑行，行走永远到不了线）",
);
check(
  /const self = frame\.players\.find\(\(entry\) => entry\.a === selfId\);/.test(gameSource) &&
    /applyServerPosition\(self\.x, self\.y, self\.mv, frame\.t\)/.test(gameSource) &&
    /applyServerPosition\(selfEntry\.x, selfEntry\.y, selfEntry\.mv, ServerClock\.now\(\)\)/.test(gameSource),
  "Game.ts 把 players / entityEnter 帧里自己那条喂给主角回放（自机与别人同一条帧流）",
);
check(
  !/reportPosition/.test(gameSource) &&
    !/positionReportTimer/.test(gameSource) &&
    !/lastReportedPosition/.test(gameSource),
  "4Hz 周期位置上报整体删除（reportPosition / 计时器 / 上次位置缓存都不在了）",
);
check(
  /CombatChannel\.sendPosition\(current\.onMap, position\.x, position\.y, current\.hp, false\)/.test(gameSource),
  "复活收尾发一次性 pos 帧（服务端复活分支靠它知道原地/回城落点，周期上报的唯一残留）",
);
check(
  /setWorldPositionByTransfer\(worldPosition: Vec3\) \{[\s\S]*?this\.positions\.reset\(\)/.test(roleDisplaySource),
  "传送落点清插值缓冲（不清会被旧快照拽回传送前）",
);
check(
  !/resolveBlockedVelocity|resolveBlockedMove/.test(moveBlockingSource) &&
    /export function getWorldColliderRect/.test(moveBlockingSource),
  "MoveBlocking 只剩碰撞盒查询（自动战斗寻路网格用；位移阻挡预测随本地物理一起退场）",
);
check(
  !/roleRigid/.test(roleConfigSource) && !/gravityScale/.test(roleConfigSource),
  "configs/role.ts 刚体参数删除（角色不进物理世界了）",
);

// ==============================================================================
//  C. 服务端快照与守卫
// ==============================================================================

console.log("\n— C. 服务端快照与守卫 —");

const auditSource = read(path.join("..", "tools", "audit-shared-data.cjs"));
const rootDir = path.join(PROJECT_ROOT, "..");

check(!fs.existsSync(path.join(PROJECT_ROOT, "..", "server", "src", "shared")), "服务端没有 shared/ 目录（#655：出厂数值只在库里，代码不留第二份副本）");
check(!fs.existsSync(path.join(rootDir, "tools", "gen-shared-data.cjs")), "生成链已删除（tools/gen-shared-data.cjs 不再存在）");
check(/config-sync\.sql/.test(auditSource), "audit-shared-data 改为盯配置快照（守点跟着数据源搬家）");
check(!/MONSTERS[ :]/.test(auditSource), "守卫不收怪物数值表（怪物数值服务端独有，客户端零本地副本）");

{
  // 怪物锚点从配置快照取：e2e-combat 的 [8,16] 区间依赖这两个值，
  // 库里改了它们就该在这里先红，而不是等 e2e 跑到一半才发现区间不对
  const monsters = factory.monsters();
  check(monsters.length === 220, `快照收录 220 只怪（实得 ${monsters.length}）`);
  const row = monsters.find((item) => String(item.id) === "1");
  check(row?.maxHp === 65, `怪物 "1" 的锚点 maxHp 65（e2e-combat 依赖）`, String(row?.maxHp));
  check(
    JSON.stringify(row?.attributes?.physicalDefense) === '{"min":4,"max":6}',
    `怪物 "1" 物防 [4,6]（e2e 区间 [8,16] 的怪侧一半）`,
    JSON.stringify(row?.attributes?.physicalDefense),
  );
}

finish("PASS：伤害结算上移（skillDamageBand 带口径、出手/结算接线、快照与守卫）全部通过。");

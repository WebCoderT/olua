#!/usr/bin/env node
/**
 * 技能 / 状态配置覆写与释放限制回归单测（#367）
 *
 * 跑的是**真实配置表与真实覆写函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的四条口径：
 * · 技能**整表重建**（#603 第十一域起客户端零出厂行）—— 数值 / 文案 / 释放限制 / 职业归属 /
 *   击退全部跟着服务端行；快照有几行就几行，行序也跟着快照；改职业归属要能立刻改出技能栏
 * · 怪物技能（#372）—— 同表下发，靠 owner 区分；角色技能与怪物技能不各留一份
 * · 状态覆写生效 —— 时长 / 文案 / 特效 / 三项战斗修正（缺省维度是 undefined，不是 0）
 * · 接线钉死 —— 快照覆写后要重建 skills Map（**行对象都是新建的**，不重建读到的还是旧的），
 *   释放限制三处落点都在
 *
 * 用法：node client/tools/test-skill-snapshot.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
const factory = require("./lib/factory-data.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/** 一条角色技能的服务端行（字段与 SkillDto 一一对应；默认值取 1000 的 seed 形状） */
function skillRow(patch = {}) {
  return {
    id: "1000",
    owner: "role",
    label: "基础剑术",
    icon: "skill/icon/1001",
    category: "0",
    targetType: "1",
    action: "attack_near",
    effect: "",
    effectOnSelf: false,
    cooldown: 1,
    mpCost: 0,
    distance: 10,
    levelReq: 1,
    description: "普通单体攻击技能",
    damageCoefficients: [{ baseType: "physicalAttack", baseTypeRate: 1 }],
    statusId: "",
    castLockMs: 0,
    requireTarget: true,
    canAuto: true,
    occupation: "1",
    pushDistance: 0,
    updatedAt: 0,
    ...patch,
  };
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-skill-snapshot", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const cfg = require(path.join(outDir, "configs/game-config.js"));
  const { skillData, oeccupationSkills, statuses } = cfg;
  // 每段的落库方法在 game-config（#626），总入口 / 组合入口在 apply-snapshot
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));
  // #603 起客户端 configs/game-config 只剩空 Map（数据唯一书写处是服务端 statuses 表），
  // 先把出厂行灌进去，还原「快照到达前端」与「覆写是原地改」这两个前提
  for (const { id, ...rest } of factory.statuses()) statuses.set(id, rest);

  console.log("\n=== 技能：整表重建（快照是唯一来源，#603 第十一域）===");
  // 沙箱按线上同一条路灌好了种子（prepare → hydrateSnapshotTables），与「快照已到」同形；
  // 客户端自身零出厂行（出厂数据唯一书写处是服务端 server/src/shared/skill-seed.ts）
  check(skillData.length > 0, "沙箱里的技能表由配置快照灌好（不是客户端写死的行）", String(skillData.length));
  const SKILL_SEED_ROWS = factory.skills();
  cfg.applySkillRows(SKILL_SEED_ROWS);
  check(skillData.length === SKILL_SEED_ROWS.length, "整表重建后行数 = 快照行数", `${skillData.length} / ${SKILL_SEED_ROWS.length}`);
  check(
    JSON.stringify(skillData.map((item) => item.id)) === JSON.stringify(SKILL_SEED_ROWS.map((row) => row.id)),
    "行序跟着快照走（客户端不再自己排序）",
  );

  const before = skillData.find((item) => item.id === "1000");
  check(before.oeccupation === "1", "职业归属来自快照（客户端不再手写这份映射）", String(before.oeccupation));
  // #670：击退改成服务端模拟（MonsterAiService.applyPush），客户端技能数据里**不再有**击退字段，
  // 快照里的 push_distance 也刻意不落到客户端 —— 这里同时守「没冒出来」与「没被顺手带进来」
  check(before.push === undefined && before.pushDistance === undefined, "客户端技能数据不带击退（击退在服务端模拟，#670）", `${String(before.push)} / ${String(before.pushDistance)}`);
  check(oeccupationSkills.get("1")?.length === 12 && oeccupationSkills.get("2")?.length === 0, "职业技能映射按快照行重建（战士 12 / 法师空）", String(oeccupationSkills.get("1")?.length));

  snapshotApi.applySkillSnapshot({
    // #604：分段入口要求「本入口要的段都在」—— 技能与状态同表下发，缺一段就是契约破坏
    statuses: [],
    skills: [
      skillRow({
        label: "测试基础剑术",
        cooldown: 2.5,
        mpCost: 3,
        distance: 12,
        levelReq: 2,
        description: "改过的描述",
        damageCoefficients: [
          { baseType: "physicalAttack", baseTypeRate: 9 },
          { baseType: "physicalAttack", baseTypeRate: 9.5 },
        ],
        castLockMs: 700,
        requireTarget: false,
        canAuto: false,
        effectOnSelf: true,
        effect: "effect/skill/s_1006@0",
        occupation: "2",
        pushDistance: 60,
      }),
    ],
  });
  const after = skillData.find((item) => item.id === "1000");
  check(skillData.length === 1, "快照只给 1 行 → 表里就只剩这 1 行（管理端删掉的技能会如实消失）", String(skillData.length));
  check(after !== before, "行对象是新建的（所以必须重建 skills Map，不能指望原地改）");
  check(after.label === "测试基础剑术" && after.description === "改过的描述", "名称与描述已覆写", after.label);
  check(after.cooldown === 2.5 && after.mpCost === 3 && after.distance === 12, "冷却 / 耗蓝 / 距离已覆写", `${after.cooldown} / ${after.mpCost} / ${after.distance}`);
  check(after.level === 2, "服务端 levelReq 落到客户端的 level 字段", String(after.level));
  check(
    after.damageCoefficients.length === 2 && after.damageCoefficients[1].baseTypeRate === 9.5,
    "伤害系数整份替换（下标仍是等级 - 1）",
    JSON.stringify(after.damageCoefficients),
  );
  check(after.effect === "effect/skill/s_1006@0" && after.effectIsOnSelf === true, "特效与「播在自己身上」已覆写", after.effect);
  check(after.oeccupation === "2", "职业归属跟着快照走", after.oeccupation);
  // 快照行带 pushDistance=60，但客户端照旧不带 push —— 击退的唯一执行方是服务端 AI（#670）
  check(after.push === undefined, "快照里的击退距离不下发到客户端（浮空位移由服务端模拟）", String(after.push));
  check(
    oeccupationSkills.get("2")?.length === 1 && oeccupationSkills.get("1")?.length === 0,
    "改了职业归属，技能栏映射立刻跟着变（派生视图，不是第二份清单）",
    JSON.stringify([oeccupationSkills.get("1"), oeccupationSkills.get("2")]),
  );

  console.log("\n=== 释放限制：动作锁 / 目标要求 / 自动释放 ===");
  check(after.castLockMs === 700, "动作锁毫秒数已覆写（客户端按它做兜底超时）", String(after.castLockMs));
  check(after.requireTarget === false, "「要求目标」已关掉（自身 / 状态型技能不再要求选中）", String(after.requireTarget));
  check(after.canAuto === false, "「可自动释放」已关掉", String(after.canAuto));
  snapshotApi.applySkillSnapshot({ statuses: [], skills: [skillRow({ castLockMs: 0 })] });
  check(
    skillData.find((item) => item.id === "1000").castLockMs === 0,
    "动作锁填 0 = 跟动画走（保持 0，不变成 undefined）",
    String(skillData.find((item) => item.id === "1000").castLockMs),
  );

  console.log("\n=== 挂载状态：statusId 空串 = 不挂（不是空字符串） ===");
  snapshotApi.applySkillSnapshot({ statuses: [], skills: [skillRow({ id: "1011", statusId: "2001", category: "2" })] });
  check(skillData.find((item) => item.id === "1011").statusId === "2001", "statusId 已覆写（技能 1011 挂到 2001）", String(skillData.find((item) => item.id === "1011").statusId));
  snapshotApi.applySkillSnapshot({ statuses: [], skills: [skillRow({ id: "1011", statusId: "" })] });
  check(
    skillData.find((item) => item.id === "1011").statusId === undefined,
    "空串清成 undefined（消费方判 `if (config.statusId)` 即可）",
    String(skillData.find((item) => item.id === "1011").statusId),
  );

  console.log("\n=== 怪物技能（#372）：同表下发，靠 owner 区分 ===");
  // 快照里角色与怪物行一起下发：表 = 快照，分归属只影响「进不进技能栏」
  snapshotApi.applySkillSnapshot({
    // #604：分段入口要求「本入口要的段都在」—— 技能与状态同表下发，缺一段就是契约破坏
    statuses: [],
    skills: [
      skillRow({ id: "1000" }),
      skillRow({ id: "9001", owner: "monster", cooldown: 12, label: "改过的猛击", action: "attack_skill_1", occupation: "4" }),
      skillRow({ id: "9010", owner: "monster", label: "新技能", action: "attack_skill_1", occupation: "4" }),
    ],
  });
  const monsterAfter = skillData.find((item) => item.id === "9001");
  check(monsterAfter.cooldown === 12 && monsterAfter.label === "改过的猛击", "怪物技能行同样被整表重建", `${monsterAfter.cooldown} / ${monsterAfter.label}`);
  check(monsterAfter.owner === "monster", "重建后仍带 owner=monster（不被打回 role）", String(monsterAfter.owner));
  const added = skillData.find((item) => item.id === "9010");
  check(Boolean(added) && added.action === "attack_skill_1", "管理端新建的怪物技能跟着快照进来（客户端能演新动作 / 特效）", added ? String(added.action) : "缺失");
  check(skillData.length === 3, "行数 = 快照行数（角色与怪物同表，不各留一份）", String(skillData.length));
  check(
    oeccupationSkills.get("1")?.length === 1 && oeccupationSkills.get("2")?.length === 0,
    "怪物技能不进技能栏（职业映射只收 owner=role 的行）",
    JSON.stringify([oeccupationSkills.get("1"), oeccupationSkills.get("2")]),
  );

  console.log("\n=== 状态：时长 / 文案 / 特效 / 三项战斗修正 ===");
  const statusBefore = statuses.get("2001");
  const statusBeforeObject = statusBefore;
  cfg.applyStatusRows([
    {
      id: "2001",
      owner: "role",
      label: "测试护体神盾",
      icon: "skill/icon/2009",
      duration: 20,
      source: "skill",
      description: "改过的状态描述",
      effect: "",
      effectHoldLast: false,
      combat: { blockChance: 0.4, blockFactor: 0.45, defenseMultiplier: 1.2 },
      updatedAt: 0,
    },
  ]);
  const statusAfter = statuses.get("2001");
  // #604：状态表也是整表重建（与技能同口径），所以换的是**新对象**。
  // 已经在身上生效的状态靠 statusId 现读这份注册表（StatusManager 只记到期时间戳），
  // 所以换对象不影响「生效中的状态也读新配置」—— 判据从「同一个对象」改成「按 id 读得到新值」。
  check(
    statusAfter !== statusBeforeObject && statusAfter.duration === 20 && statuses.get("2001") === statusAfter,
    "整表重建后按 id 读得到新配置（生效中的状态同理，它每次结算都重新查表）",
    String(statusAfter.duration),
  );
  check(statusAfter.duration === 20 && statusAfter.label === "测试护体神盾", "时长与名称已覆写", `${statusAfter.duration} / ${statusAfter.label}`);
  check(statusAfter.combat.blockChance === 0.4 && statusAfter.combat.blockFactor === 0.45, "格挡概率与系数已覆写", JSON.stringify(statusAfter.combat));
  check(statusAfter.combat.defenseMultiplier === 1.2, "防御倍率已覆写", String(statusAfter.combat.defenseMultiplier));
  check(statusAfter.effect === undefined, "特效传空串 = 清掉（只在图标栏显示）", String(statusAfter.effect));

  cfg.applyStatusRows([
    {
      id: "2001",
      owner: "role",
      label: "纯表现状态",
      icon: "skill/icon/2009",
      duration: 5,
      source: "skill",
      description: "",
      effect: "",
      effectHoldLast: false,
      combat: {},
      updatedAt: 0,
    },
  ]);
  const pureStatus = statuses.get("2001");
  check(
    pureStatus.combat.blockChance === undefined && pureStatus.combat.defenseMultiplier === undefined,
    "没配的维度是 undefined（不是 0：0 会让格挡必定发生 / 防御归零）",
    JSON.stringify(pureStatus.combat),
  );

  console.log("\n=== 幂等 + 契约（#604） ===");
  const snapshot = { statuses: [], skills: [skillRow({ cooldown: 3 })] };
  snapshotApi.applySkillSnapshot(snapshot);
  const once = JSON.stringify(skillData.find((item) => item.id === "1000"));
  snapshotApi.applySkillSnapshot(snapshot);
  check(JSON.stringify(skillData.find((item) => item.id === "1000")) === once, "同一份快照覆写两次结果一致");
  const cooldownBefore = skillData.find((item) => item.id === "1000").cooldown;
  // #604：整份快照缺段是契约破坏（applyConfigSnapshot 会抛）；分段入口要求本入口的段都在。
  // 以前这里断言「空快照保留当前值」—— 那条兜底就是「改了没生效」类问题的来源。
  let contractError = "";
  try {
    snapshotApi.applyConfigSnapshot({});
  } catch (error) {
    contractError = String((error && error.message) || error);
  }
  check(contractError.indexOf("skills") >= 0, "整份快照缺段 → 抛错并点名 skills（#604）", contractError.slice(0, 50));
  check(skillData.find((item) => item.id === "1000").cooldown === cooldownBefore, "抛错前不落库（技能表还是上一份的样子）");
  // 表 = 快照：快照里有几行就是几行，id 不认识也照样进表（它没有释放实现，本地放不出来）
  snapshotApi.applySkillSnapshot({ statuses: [], skills: [skillRow({ id: "1999", label: "不存在的角色技能" })] });
  check(skillData.length === 1 && skillData[0].id === "1999", "不认识的 id 也按快照进表（表是快照的镜像，不做本地白名单）", JSON.stringify(skillData.map((item) => item.id)));

  console.log("\n=== 接线钉死（源码断言：这三处不接上，配了也不会生效） ===");
  const configLoader = read("assets/ui/utils/net/ConfigLoader.ts");
  check(/rebuildSkills/.test(configLoader), "ConfigLoader 引入了 rebuildSkills");
  // 顺序判据用「先出现 applyConfigSnapshot，后出现 rebuildSkills」—— 别用窗口长度（注释一长就假红）
  check(
    configLoader.indexOf("applyConfigSnapshot(") >= 0 && configLoader.indexOf("applyConfigSnapshot(") < configLoader.lastIndexOf("rebuildSkills()"),
    "rebuildSkills 在 applyConfigSnapshot 之后调用（Map 里的副本不重建就读不到新数值）",
  );

  const roleDisplay = read("assets/ui/components/role/RoleDisplay.ts");
  check(
    /startAttack\([\s\S]{0,200}?lockMs/.test(roleDisplay),
    "RoleDisplay.startAttack 接受 lockMs（动作锁的落点：同时锁移动与再次出手）",
  );

  const skillManager = read("assets/ui/core/SkillManager.ts");
  check(
    /requireTarget !== false/.test(skillManager),
    "SkillManager 的单体分支读 requireTarget（关掉后不再要求选中目标）",
  );

  const warrior = read("assets/skills/warrior.ts");
  check(/config\.statusId/.test(warrior), "技能释放实现从配置读 statusId（手写映射表已废除）");
  check(/castLockMs/.test(warrior), "技能释放实现把 castLockMs 传给动作锁");

  // 怪物侧（#372）：服务端广播 → 演出。这三处不接上，怪物放技能在画面上什么都没有
  const monsterManager = read("assets/ui/core/MonsterManager.ts");
  check(/data\.casts/.test(monsterManager), "MonsterManager 消费 casts 帧（技能动作 / 特效的入口）");
  check(/findSkillConfig\(cast\.skillId\)/.test(monsterManager), "技能配置按 id 查（怪物技能不在 skills Map 里）");
  check(/applyStatusEffect\(cast\.instanceId/.test(monsterManager), "状态型技能挂到怪物身上播特效");
  const combatChannel = read("assets/ui/utils/net/CombatChannel.ts");
  check(/casts\?: MonsterCastEntry\[\]/.test(combatChannel), "CombatChannel 的 AI 帧带 casts（旧服务端不带时按空数组）");
  const serverAi = read("../server/src/modules/realtime/monster-ai.service.ts");
  check(/pendingCasts/.test(serverAi) && /castSkill\(/.test(serverAi), "服务端 AI 攒 casts 并释放技能");
  check(/defenseMultiplierOf/.test(serverAi), "服务端按怪物状态修正防御（CombatSettlement 取它）");

  finish("技能 / 状态快照覆写：全部断言通过");
}

main();

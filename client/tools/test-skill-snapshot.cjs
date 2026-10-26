#!/usr/bin/env node
/**
 * 技能 / 状态配置覆写与释放限制回归单测（#367）
 *
 * 跑的是**真实配置表与真实覆写函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的四条口径：
 * · 技能覆写生效并原地改 —— 名字 / 冷却 / 耗蓝 / 距离 / 等级 / 倍率 / 挂载状态 / 释放限制
 * · 怪物技能（#372）—— 同表一起覆写；本地没有的怪物行追加（管理端能新建），角色行仍不追加
 * · 状态覆写生效 —— 时长 / 文案 / 特效 / 三项战斗修正（缺省维度是 undefined，不是 0）
 * · 接线钉死 —— 快照覆写后要重建 skills Map（副本），释放限制三处落点都在
 *
 * 用法：node client/tools/test-skill-snapshot.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

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

  const { skillData } = require(path.join(outDir, "configs/skill-data.js"));
  const { statuses } = require(path.join(outDir, "configs/status.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  console.log("\n=== 技能：数值 / 文案 / 释放限制都跟着服务端走 ===");
  const before = skillData.find((item) => item.id === "1000");
  const beforeObject = before;
  snapshotApi.applySkillSnapshot({
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
      }),
    ],
  });
  const after = skillData.find((item) => item.id === "1000");
  check(after === beforeObject, "原地覆写（数组元素对象不换，引用保持）", "消费方持有的引用不会失效");
  check(after.label === "测试基础剑术" && after.description === "改过的描述", "名称与描述已覆写", after.label);
  check(after.cooldown === 2.5 && after.mpCost === 3 && after.distance === 12, "冷却 / 耗蓝 / 距离已覆写", `${after.cooldown} / ${after.mpCost} / ${after.distance}`);
  check(after.level === 2, "服务端 levelReq 落到客户端的 level 字段", String(after.level));
  check(
    after.damageCoefficients.length === 2 && after.damageCoefficients[1].baseTypeRate === 9.5,
    "伤害系数整份替换（下标仍是等级 - 1）",
    JSON.stringify(after.damageCoefficients),
  );
  check(after.effect === "effect/skill/s_1006@0" && after.effectIsOnSelf === true, "特效与「播在自己身上」已覆写", after.effect);

  console.log("\n=== 释放限制：动作锁 / 目标要求 / 自动释放 ===");
  check(after.castLockMs === 700, "动作锁毫秒数已覆写（客户端按它做兜底超时）", String(after.castLockMs));
  check(after.requireTarget === false, "「要求目标」已关掉（自身 / 状态型技能不再要求选中）", String(after.requireTarget));
  check(after.canAuto === false, "「可自动释放」已关掉", String(after.canAuto));
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ castLockMs: 0 })] });
  check(
    skillData.find((item) => item.id === "1000").castLockMs === 0,
    "动作锁填 0 = 跟动画走（保持 0，不变成 undefined）",
    String(skillData.find((item) => item.id === "1000").castLockMs),
  );

  console.log("\n=== 挂载状态：statusId 空串 = 不挂（不是空字符串） ===");
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "1011", statusId: "2001", category: "2" })] });
  const skill1011 = skillData.find((item) => item.id === "1011");
  check(skill1011.statusId === "2001", "statusId 已覆写（技能 1011 挂到 2001）", String(skill1011.statusId));
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "1011", statusId: "" })] });
  check(skill1011.statusId === undefined, "空串清成 undefined（消费方判 `if (config.statusId)` 即可）", String(skill1011.statusId));

  console.log("\n=== 怪物技能（#372）：同表一起覆写，本地没有的怪物行追加 ===");
  // 已有行（9001 在客户端配置里）→ 原地覆写：服务端执行技能，但动作 / 特效 / 施法硬直要看新配置
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "9001", owner: "monster", cooldown: 12, label: "改过的猛击" })] });
  const monsterAfter = skillData.find((item) => item.id === "9001");
  check(monsterAfter.cooldown === 12 && monsterAfter.label === "改过的猛击", "怪物技能行同样被覆写", `${monsterAfter.cooldown} / ${monsterAfter.label}`);
  check(monsterAfter.owner === "monster", "覆写后仍带 owner=monster（不被打回 role）", String(monsterAfter.owner));

  // 本地没有的怪物行 → 追加：管理端能新建怪物技能，客户端必须能演新动作
  const countBeforeMonster = skillData.length;
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "9010", owner: "monster", label: "新技能", action: "attack_skill_1" })] });
  const appended = skillData.find((item) => item.id === "9010");
  check(skillData.length === countBeforeMonster + 1, "本地没有的怪物技能被追加（管理端新建的技能也能演）", String(skillData.length));
  check(appended && appended.action === "attack_skill_1", "追加行的动作 / 特效来自快照", appended ? String(appended.action) : "缺失");

  // 本地没有的角色行 → 忽略：角色技能清单固定在配置里，凭空多一行不会有人释放它
  const countBeforeRole = skillData.length;
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "1999", owner: "role", label: "不存在的角色技能" })] });
  check(skillData.length === countBeforeRole, "本地没有的角色技能行被忽略（清单固定在配置里）", String(skillData.length));

  console.log("\n=== 状态：时长 / 文案 / 特效 / 三项战斗修正 ===");
  const statusBefore = statuses.get("2001");
  const statusBeforeObject = statusBefore;
  snapshotApi.applyStatusRows([
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
  check(statusAfter === statusBeforeObject, "原地覆写注册表元素（已在身上生效的状态也读新配置）", String(statusAfter.duration));
  check(statusAfter.duration === 20 && statusAfter.label === "测试护体神盾", "时长与名称已覆写", `${statusAfter.duration} / ${statusAfter.label}`);
  check(statusAfter.combat.blockChance === 0.4 && statusAfter.combat.blockFactor === 0.45, "格挡概率与系数已覆写", JSON.stringify(statusAfter.combat));
  check(statusAfter.combat.defenseMultiplier === 1.2, "防御倍率已覆写", String(statusAfter.combat.defenseMultiplier));
  check(statusAfter.effect === undefined, "特效传空串 = 清掉（只在图标栏显示）", String(statusAfter.effect));

  snapshotApi.applyStatusRows([
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

  console.log("\n=== 幂等与兜底 ===");
  const snapshot = { skills: [skillRow({ cooldown: 3 })] };
  snapshotApi.applySkillSnapshot(snapshot);
  const once = JSON.stringify(skillData.find((item) => item.id === "1000"));
  snapshotApi.applySkillSnapshot(snapshot);
  check(JSON.stringify(skillData.find((item) => item.id === "1000")) === once, "同一份快照覆写两次结果一致");
  const hpBeforeEmpty = skillData.find((item) => item.id === "1000").cooldown;
  snapshotApi.applySkillSnapshot({});
  check(skillData.find((item) => item.id === "1000").cooldown === hpBeforeEmpty, "空快照保留当前值（旧服务端不下发技能表也不炸）");
  const countBeforeUnknown = skillData.length;
  snapshotApi.applySkillSnapshot({ skills: [skillRow({ id: "不存在的技能" })] });
  check(skillData.length === countBeforeUnknown, "未知 id 被忽略，不新增行", String(skillData.length));

  console.log("\n=== 接线钉死（源码断言：这三处不接上，配了也不会生效） ===");
  const configLoader = read("assets/ui/utils/net/ConfigLoader.ts");
  check(/rebuildSkills/.test(configLoader), "ConfigLoader 引入了 rebuildSkills");
  check(
    /applyConfigSnapshot\([\s\S]{0,200}?rebuildSkills\(\)/.test(configLoader),
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

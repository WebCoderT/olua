/**
 * 技能数值数据表（#31 从 configs/skill 拆出）
 *
 * 定位：**纯数据模块** —— 只放数值 / 文案 / 映射，零引擎 import（不 import skills/warrior，
 * 也不 import 任何 ui/ 运行时），可被 Node 沙箱直接 require 跑断言（见 client/tools/test-skill-decouple.cjs）。
 * 释放实现不在这里：configs/skill.ts 的 skillHandlers 按 id 接上，合成消费方要的 skills Map。
 */
import { OECCUPATION } from "../types/role";
import { SkillData, SkillId, SkillTargetType, SkillType } from "../types/skill";
import { ACTION } from "../types/animation";

/** 职业技能映射 */
export const oeccupationSkills = new Map<OECCUPATION, SkillId[]>();
/** 战士技能映射 */
oeccupationSkills.set(OECCUPATION.ZHAN, ["1000", "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011"]);
/** 法师技能映射 */
oeccupationSkills.set(OECCUPATION.FA, []);
/** 道士技能映射 */
oeccupationSkills.set(OECCUPATION.DAO, []);

/**
 * 普攻技能（左键点击怪物直接释放的那个技能，见 components/input/ScreenClickInput）
 * 走 SkillManager.release 统一入口：冷却/魔法值/距离校验都在里面，超出距离时 canAuto 会委托 AutoBattle 走过去继续打
 */
export const basicAttackSkillId: SkillId = "1000";

/** 技能类型文案（技能详情弹窗用，见 ui/core/HoverTipManager） */
export const skillTypeLabels: Record<SkillType, string> = {
  [SkillType.PROACTIVE]: "主动",
  [SkillType.PASSIVE]: "被动",
  [SkillType.STATUS]: "状态",
  [SkillType.REPLY]: "回复",
};

/** 技能目标类型文案（技能详情弹窗用） */
export const skillTargetTypeLabels: Record<SkillTargetType, string> = {
  [SkillTargetType.PLACE]: "区域",
  [SkillTargetType.SINGLE]: "单体",
  [SkillTargetType.MUTIPLE]: "群体",
  [SkillTargetType.SELF]: "自身",
};

/**
 * 技能数据表
 * id 只做关联（技能栏/快捷键/AutoBattle 都用它引用），与怪物/装备同一约定。
 */
export const skillData: Array<SkillData & { id: SkillId }> = [
  {
    id: "1000",
    label: "‌基础剑术",
    icon: "skill/icon/1001",
    cooldown: 1,
    mpCost: 0,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 1,
    description: "普通单体攻击技能，通过挥砍手中武器，对敌人直接造成普通物理伤害，伤害与物理攻击相关",
    type: SkillType.PROACTIVE,
    distance: 10,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 1 },
      { baseType: "physicalAttack", baseTypeRate: 1.1 },
      { baseType: "physicalAttack", baseTypeRate: 1.2 },
      { baseType: "physicalAttack", baseTypeRate: 1.3 },
      { baseType: "physicalAttack", baseTypeRate: 1.4 },
      { baseType: "physicalAttack", baseTypeRate: 1.5 },
      { baseType: "physicalAttack", baseTypeRate: 1.6 },
      { baseType: "physicalAttack", baseTypeRate: 1.7 },
      { baseType: "physicalAttack", baseTypeRate: 1.8 },
      { baseType: "physicalAttack", baseTypeRate: 1.9 },
      { baseType: "physicalAttack", baseTypeRate: 2 },
    ],
    action: ACTION.ATTACK_NEAR,
    canAuto: true,
  },

  {
    id: "1001",
    label: "烈火剑法",
    icon: "skill/icon/1006",
    cooldown: 1,
    mpCost: 8,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "战士标志性爆发技能，10级可造成‌280%~560%‌ 攻击伤害，附带15%暴击率，觉醒后还会附加灼烧效果，是PK秒杀、打BOSS爆发的核心招式",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 10,
    action: ACTION.ATTACK_SKILL_1,
    // 示例：命中后把目标击退 120 像素（技能击退是场上唯一能推动怪物的途径，删掉这行就不击退）
    push: { distance: 120 },
    canAuto: false,
    effect: "effect/skill/s_1006@0",
    effectIsOnSelf: true,
  },

  {
    id: "1002",
    label: "刺杀剑术",
    icon: "skill/icon/1003",
    cooldown: 1,
    mpCost: 6,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "公认的破防神技，隔位释放的第二格剑气为无属性攻击，可无视目标防御，直接穿透法师的魔法盾，是克制远程职业、挑战高防BOSS的必备技能",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1003",
    label: "莲月剑法",
    icon: "skill/icon/2003",
    cooldown: 1,
    mpCost: 6,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "传奇3版本特色技能，可打出两段连击，总伤害达300%，目标防御越高伤害增幅越明显，适合团战持续黏人输出、残血收割",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1004",
    label: "‌擒龙手‌",
    icon: "skill/icon/3010",
    cooldown: 1,
    mpCost: 10,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "高阶特色技能，可将远处的目标直接拉到身边并附加眩晕，同时给自己增加攻击buff，是团战中强切敌方后排的神技",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 100000,
    action: ACTION.ATTACK_FAR,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: false,
  },

  {
    id: "1005",
    label: "野蛮冲撞",
    icon: "skill/icon/1010",
    cooldown: 1,
    mpCost: 8,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "全版本通用的核心控场技能，10级可冲撞4格，65%概率将等级低于自身的目标撞飞并眩晕0.8秒，用于追击敌人、分割敌方阵型、抢BOSS卡位都非常实用",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1006",
    label: "逐日剑法‌",
    icon: "skill/icon/2202",
    cooldown: 1,
    mpCost: 8,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "四格范围内的突进突袭技能，可快速拉近与远程职业的距离，弥补战士手短的短板，是PK中追击残血目标的利器",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1007",
    label: "狮子吼",
    icon: "skill/icon/3007",
    cooldown: 1,
    mpCost: 12,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "范围麻痹技能，可震开并麻痹周围3格内的敌人，等级高于目标时必中，被围攻时能快速脱身，团战中可打乱敌方后排输出节奏",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1008",
    label: "十步一杀",
    icon: "skill/icon/1005",
    cooldown: 1,
    mpCost: 10,
    targetType: SkillTargetType.PLACE,
    oeccupation: OECCUPATION.ALL,
    level: 10,
    description: "高阶专属技能，突进目标后有概率触发麻痹效果，是后期版本中打先手控制的神技",
    type: SkillType.PROACTIVE,
    damageCoefficients: [],
    distance: 200,
    action: ACTION.ATTACK_FAR,
    canAuto: false,
    // 区域技能的特效位置由技能实现决定（十步一杀播在突进落点），SkillManager 不代播，见 EffectManager.playAt
    effect: "effect/skill/s_3010@0",
  },

  {
    id: "1009",
    label: "半月弯刀",
    icon: "skill/icon/1004",
    cooldown: 1,
    mpCost: 6,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "扇形范围群攻技能，可同时攻击身前半圆内的多个敌人，挂机清怪效率极高，被围时贴身释放也能快速清场突围",
    type: SkillType.PROACTIVE,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.STAND,
    canAuto: false,
    effect: "effect/skill/s_1002@0",
    effectIsOnSelf: true,
  },

  {
    id: "1010",
    label: "‌护体神盾",
    icon: "skill/icon/2009",
    cooldown: 60,
    mpCost: 15,
    targetType: SkillTargetType.SELF,
    oeccupation: OECCUPATION.ZHAN,
    level: 1,
    description: "被动减伤技能，概率格挡 incoming 伤害，大幅提升战士的生存能力，是后期团战中站得住脚的关键保障",
    type: SkillType.STATUS,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.ATTACK_FAR,
    canAuto: false,
    // 自身状态技能（#367）：挂配置里的状态；不需要选中敌人才能给自己上盾
    statusId: "2001",
    requireTarget: false,
  },

  {
    id: "1011",
    label: "金刚护体",
    icon: "skill/icon/1008",
    cooldown: 1,
    mpCost: 15,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ZHAN,
    level: 10,
    description: "主动防御buff，开启后短时间内可提升40%物防、30%魔防，附带25%减伤效果，能硬抗法师多套技能，打BOSS和团战前必开",
    type: SkillType.STATUS,
    damageCoefficients: [
      { baseType: "physicalAttack", baseTypeRate: 3 },
      { baseType: "physicalAttack", baseTypeRate: 3.1 },
      { baseType: "physicalAttack", baseTypeRate: 3.2 },
      { baseType: "physicalAttack", baseTypeRate: 3.3 },
      { baseType: "physicalAttack", baseTypeRate: 3.4 },
      { baseType: "physicalAttack", baseTypeRate: 3.5 },
      { baseType: "physicalAttack", baseTypeRate: 3.6 },
      { baseType: "physicalAttack", baseTypeRate: 3.7 },
      { baseType: "physicalAttack", baseTypeRate: 3.8 },
      { baseType: "physicalAttack", baseTypeRate: 3.9 },
      { baseType: "physicalAttack", baseTypeRate: 4 },
    ],
    distance: 0,
    action: ACTION.ATTACK_FAR,
    canAuto: false,
    // 自身状态技能（#367）：机制上仍是「给自己挂状态」，不要求有敌人在场
    statusId: "2002",
    requireTarget: false,
  },

  //#region 怪物技能（#372；9000 段，owner = monster）
  /*
   * 怪物技能与角色技能**同表**（#367 定的口径）：差别只在 owner 与消费方。
   * - 客户端不为它们提供释放实现（`configs/skill` 的 handler 表只收角色 id），
   *   它们由服务端 `MonsterAiService` 按挂载表释放，客户端收到 casts 帧后按这里的
   *   action / effect / castLockMs 演出；
   * - 技能等级固定 1（怪物不练级），所以 damageCoefficients 只需要一条；
   * - 挂载关系（哪只怪放哪些、优先级、冷却覆写）在 `configs/monster-skills`。
   *
   * 数值口径：伤害型 = round(怪物物攻区间随机值 × 倍率 − 玩家物防区间随机值)，与角色一致；
   * 状态型 = 给自己挂 statusId 指向的状态，服务端按 combat 修正后续伤害。
   */
  {
    id: "9001",
    owner: "monster",
    label: "跃鼠猛击",
    icon: "skill/icon/1006",
    cooldown: 6,
    mpCost: 0,
    targetType: SkillTargetType.SINGLE,
    oeccupation: OECCUPATION.ALL,
    level: 1,
    description: "蓄力扑击，对目标造成 1.8 倍物理攻击伤害",
    type: SkillType.PROACTIVE,
    damageCoefficients: [{ baseType: "physicalAttack", baseTypeRate: 1.8 }],
    distance: 90,
    action: ACTION.ATTACK_SKILL_1,
    effect: "effect/skill/s_1008@0",
    effectIsOnSelf: false,
    // 施法硬直：扑出去之后站定 0.8 秒，比普攻（0.6 秒）更久，给玩家反应窗口
    castLockMs: 800,
    canAuto: false,
  },
  {
    id: "9002",
    owner: "monster",
    label: "狂怒",
    icon: "skill/icon/2009",
    cooldown: 15,
    mpCost: 0,
    targetType: SkillTargetType.SELF,
    oeccupation: OECCUPATION.ALL,
    level: 1,
    description: "进入狂怒，持续时间内物理攻击 ×1.5",
    type: SkillType.STATUS,
    damageCoefficients: [],
    distance: 0,
    action: ACTION.A1,
    effect: "effect/status/s_2004@0",
    effectIsOnSelf: true,
    statusId: "9001",
    castLockMs: 600,
    // 状态型不要求目标（但服务端仍要「已在战斗中」才会放，见 MonsterAiService）
    requireTarget: false,
    canAuto: false,
  },
  {
    id: "9003",
    owner: "monster",
    label: "硬化皮肤",
    icon: "skill/icon/1008",
    cooldown: 15,
    mpCost: 0,
    targetType: SkillTargetType.SELF,
    oeccupation: OECCUPATION.ALL,
    level: 1,
    description: "皮肤硬化，持续时间内防御 ×1.5",
    type: SkillType.STATUS,
    damageCoefficients: [],
    distance: 0,
    action: ACTION.A1,
    effect: "effect/skill/s_1008@0",
    effectIsOnSelf: true,
    statusId: "9002",
    castLockMs: 600,
    requireTarget: false,
    canAuto: false,
  },
  //#endregion
];

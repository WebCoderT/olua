/**
 * 技能数值数据表（#31 从 configs/skill 拆出；#603 第十一域起**客户端零出厂数据**）
 *
 * 定位：**纯数据模块** —— 只放数值 / 文案 / 映射，零引擎 import（不 import skills/warrior，
 * 也不 import 任何 ui/ 运行时），可被 Node 沙箱直接 require 跑断言（见 client/tools/test-skill-decouple.cjs）。
 * 释放实现不在这里：configs/skill.ts 的 roleSkillHandlers 按 id 接上，合成消费方要的 skills Map。
 *
 * ===========================================================================
 * #603 第十一域：数据搬走，算法留下
 * ===========================================================================
 * 名称 / 图标 / 分类 / 目标类型 / 动作 / 特效 / 冷却 / 魔法消耗 / 施法距离 / 学习等级 /
 * 描述 / 伤害倍率 / 挂载状态 / 施法锁 / 释放限制 / **职业归属 / 击退距离** 的唯一书写处是
 * 服务端 `server/src/shared/skill-seed.ts` → `skills` 表（管理端「技能配置」可改）→
 * `GET /game-config` 快照的 `skills` 段 → 这里整表重建（`applySkillData`）。
 *
 * 留在本文件的是**对枚举值的翻译**（技能类型 / 目标类型文案）与**派生规则**（职业 → 技能 id），
 * 它们不是运营数据：改一次数值不该要重打客户端包，而改一句「主动」的措辞本来就该改代码。
 *
 * **客户端加载期 `skillData` 是空的** —— 进游戏前 `skills` Map 里一个技能都没有不是 bug，
 * 那只是快照还没到。
 */
import { OECCUPATION } from "../types/role";
import { ACTION } from "../types/animation";
import { DamageCoefficient, SkillData, SkillId, SkillTargetType, SkillType } from "../types/skill";

/** 服务端技能行（快照 `skills` 段；与 `skill-seed.ts` 的 `SkillSeedRow` 同形） */
export interface SkillSeedLike {
  id: string;
  /** 归属：role | monster（同一张表，靠它区分技能栏里的技能与怪物 AI 放的技能） */
  owner: string;
  label: string;
  icon: string;
  /** 客户端 SkillType 原值（"0" 主动 / "1" 被动 / "2" 状态 / "3" 回复） */
  category: string;
  /** 客户端 SkillTargetType 原值（"0" 区域 / "1" 单体 / "2" 群体 / "3" 自身） */
  targetType: string;
  /** 客户端动画动作键（如 attack_near） */
  action: string;
  /** 特效图集路径（空串 = 无） */
  effect: string;
  effectOnSelf: boolean;
  cooldown: number;
  mpCost: number;
  distance: number;
  /** 学习 / 开启等级（客户端字段名是 level） */
  levelReq: number;
  description: string;
  damageCoefficients: Array<{ baseType: string; baseTypeRate: number }>;
  /** 挂载的状态 id（空串 = 不挂） */
  statusId: string;
  castLockMs: number;
  requireTarget: boolean;
  canAuto: boolean;
  /** 职业归属（"1" 战士 / "2" 法师 / "3" 道士 / "4" 全职业） */
  occupation: string;
  /** 击退距离（像素；0 = 不击退） */
  pushDistance: number;
}

/** 技能数值表（内容全部来自服务端；加载期为空） */
export const skillData: Array<SkillData & { id: SkillId }> = [];

/** 技能栏的三种职业（`OECCUPATION.ALL` 的技能进全部三栏，见 `rebuildOccupationSkills`） */
const SKILL_BAR_OCCUPATIONS: OECCUPATION[] = [OECCUPATION.ZHAN, OECCUPATION.FA, OECCUPATION.DAO];

/**
 * 职业技能映射（职业 → 技能 id，技能栏 / 技能列表面板按它列条目）
 *
 * #603 第十一域起不再手写：它是 `skillData` 的**派生视图**，由 `rebuildOccupationSkills()`
 * 在每次整表重建后重算。以前这份清单与技能行分开维护，新增一个技能要改两处，
 * 漏一处就是「技能学了不显示」。
 */
export const oeccupationSkills = new Map<OECCUPATION, SkillId[]>();

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

/** 服务端行 → 客户端数值行（不含 onClick：释放实现由 configs/skill 按 id 接上） */
function toSkillData(row: SkillSeedLike): SkillData & { id: SkillId } {
  const pushDistance = Number(row.pushDistance) || 0;
  return {
    id: row.id as SkillId,
    // 归属缺省 role：绝大多数技能是角色技能，只有怪物 AI 放的才显式写 monster
    owner: row.owner === "monster" ? "monster" : "role",
    label: String(row.label ?? ""),
    icon: String(row.icon ?? ""),
    cooldown: Number(row.cooldown) || 0,
    mpCost: Number(row.mpCost) || 0,
    targetType: row.targetType as SkillTargetType,
    oeccupation: (row.occupation || OECCUPATION.ALL) as OECCUPATION,
    level: Number(row.levelReq) || 1,
    description: String(row.description ?? ""),
    type: row.category as SkillType,
    damageCoefficients: (row.damageCoefficients || []).map(
      (entry): DamageCoefficient => ({
        baseType: entry.baseType as DamageCoefficient["baseType"],
        baseTypeRate: Number(entry.baseTypeRate) || 0,
      }),
    ),
    distance: Number(row.distance) || 0,
    action: row.action as ACTION,
    // 0 = 不击退（不是「击退 0 像素」）：留着空对象会让 SkillManager 走一遍击退流程
    push: pushDistance > 0 ? { distance: pushDistance } : undefined,
    canAuto: row.canAuto === true,
    effect: row.effect || undefined,
    effectIsOnSelf: row.effectOnSelf === true,
    statusId: row.statusId || undefined,
    castLockMs: Number(row.castLockMs) || 0,
    // 缺省 true：绝大多数技能都要有目标才能放；自身 / 状态型技能在表里显式写 false
    requireTarget: row.requireTarget !== false,
  };
}

/**
 * 整表重建技能（#603 第十一域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有
 * （管理端下架/删掉的技能会如实消失）。数组是同一个引用（`skillData` 只 clear + push）。
 *
 * 重建后必须让 `configs/skill` 重算 `skills` Map（那里有 onClick）—— 快照链路里由
 * ConfigLoader 调 `rebuildSkills()`，本函数只负责数值表与职业技能映射。
 */
export function applySkillData(rows: SkillSeedLike[]): void {
  skillData.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    skillData.push(toSkillData(row));
  }
  rebuildOccupationSkills();
}

/**
 * 按当前 `skillData` 重建「职业 → 技能 id」
 *
 * - 怪物技能不进技能栏（它们由服务端 AI 释放，客户端只演）；
 * - `OECCUPATION.ALL` 的技能进全部三种职业；
 * - 每个职业的键**总是存在**（哪怕是空数组）：技能列表面板 `oeccupationSkills.get(职业)`
 *   拿到 undefined 会直接抛错，空数组才是「这个职业还没技能」。
 */
export function rebuildOccupationSkills(): void {
  oeccupationSkills.clear();
  for (const code of SKILL_BAR_OCCUPATIONS) oeccupationSkills.set(code, []);
  for (const skill of skillData) {
    if (skill.owner === "monster") continue;
    const codes = skill.oeccupation === OECCUPATION.ALL ? SKILL_BAR_OCCUPATIONS : [skill.oeccupation];
    for (const code of codes) {
      const list = oeccupationSkills.get(code);
      if (list && list.indexOf(skill.id) < 0) list.push(skill.id);
    }
  }
}

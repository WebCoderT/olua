/**
 * 技能出厂数据（#603 第十一域）—— **唯一书写处**
 *
 * ===========================================================================
 * 这张表管什么、不管什么
 * ===========================================================================
 * - **数值与表现参数**（名称 / 图标 / 分类 / 目标类型 / 动作 / 特效 / 冷却 / 魔法消耗 /
 *   施法距离 / 学习等级 / 描述 / 伤害倍率 / 挂载状态 / 施法锁 / 释放限制 / **职业归属** /
 *   **击退距离**）→ 本文件 → `skills` 表（管理端「技能配置」可改）→ `GET /game-config` 快照。
 * - **释放实现**（点一下技能到底发生什么）→ **不在表里**：`client/assets/skills/*` 的
 *   `roleSkillHandlers`（`Record<RoleSkillId, fn>`）。技能是「数据 + 代码」两半，
 *   数据搬走的是前一半；后一半跟着代码走，改表改不出新技能。
 * - **技能类型 / 目标类型的文案**（主动 / 单体…）→ 客户端 `configs/skill-data` 的枚举文案，
 *   那是对枚举值的翻译，不是运营数据。
 *
 * ===========================================================================
 * 职业归属（occupation）为什么必须入库
 * ===========================================================================
 * 客户端技能栏是「按职业列 id」画出来的（`oeccupationSkills`）。以前那是手写的一份映射,
 * 与技能行分开维护 —— 新增一个技能要同时改两处，漏一处就是「技能学了不显示」。
 * 现在 `occupation` 跟着技能行走（1 战士 / 2 法师 / 3 道士 / 4 全职业），客户端按行走重建
 * 那份映射，不存在第二份清单。
 *
 * ===========================================================================
 * id 清单为什么固定
 * ===========================================================================
 * - 角色技能（1000~1011）的 id 就是**释放实现**的键（`Record<RoleSkillId>`，缺实现编译不过）；
 * - 怪物技能（9001+）由服务端 AI 释放，但 id 被 `monster_skills` 挂载表引用。
 * 所以管理端只提供**修改**，不提供新建 / 删除（e2e 钉死 POST / DELETE 路由不存在）。
 */
export interface SkillSeedRow {
  /** 技能 id（如 "1000"；主键，不可增删行） */
  id: string;
  /** 归属：role | monster（同一张表，管理端可切换查看） */
  owner: string;
  /** 技能名 */
  label: string;
  /** 技能图标资源路径（resources 相对路径） */
  icon: string;
  /** 分类：客户端 SkillType 原值（"0" 主动 / "1" 被动 / "2" 状态 / "3" 回复） */
  category: string;
  /** 目标类型：客户端 SkillTargetType 原值（"0" 区域 / "1" 单体 / "2" 群体 / "3" 自身） */
  targetType: string;
  /** 施法动作（客户端动画动作键，如 attack_near） */
  action: string;
  /** 技能特效图集路径（空串 = 无） */
  effect: string;
  /** 特效是否播在自己身上 */
  effectOnSelf: boolean;
  /** 冷却（秒） */
  cooldown: number;
  /** 释放一次消耗的魔法值 */
  mpCost: number;
  /** 施法距离（0 = 不限距离） */
  distance: number;
  /** 学习 / 开启等级 */
  levelReq: number;
  /** 技能描述（运营文案） */
  description: string;
  /** 各等级的伤害系数（下标 = 技能等级 - 1） */
  damageCoefficients: Array<{ baseType: string; baseTypeRate: number }>;
  /** 命中后挂载的状态 id（空串 = 不挂） */
  statusId: string;
  /** 施法动作锁（毫秒；0 = 不锁） */
  castLockMs: number;
  /** 是否必须有目标（状态类技能为 false） */
  requireTarget: boolean;
  /** 是否允许挂机自动释放 */
  canAuto: boolean;
  /** 职业归属（"1" 战士 / "2" 法师 / "3" 道士 / "4" 全职业） */
  occupation: string;
  /** 命中后的击退距离（像素；0 = 不击退。只对单体技能生效，见 client/types/skill SkillPushConfig） */
  pushDistance: number;
}

/**
 * 技能出厂行（15 条：角色 12 + 怪物 3）
 *
 * 数值表的「为什么是这些数」分散在客户端 `assets/skills/*` 的实现注释里,
 * 这里只保存运营看得懂的那一层；改数值不需要动代码，改实现才需要。
 */
export const SKILL_SEED_ROWS: SkillSeedRow[] = [
  {"id":"1000","owner":"role","label":"‌基础剑术","icon":"skill/icon/1001","category":"0","targetType":"1","action":"attack_near","effect":"","effectOnSelf":false,"cooldown":1,"mpCost":0,"distance":10,"levelReq":1,"description":"普通单体攻击技能，通过挥砍手中武器，对敌人直接造成普通物理伤害，伤害与物理攻击相关","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":1},{"baseType":"physicalAttack","baseTypeRate":1.1},{"baseType":"physicalAttack","baseTypeRate":1.2},{"baseType":"physicalAttack","baseTypeRate":1.3},{"baseType":"physicalAttack","baseTypeRate":1.4},{"baseType":"physicalAttack","baseTypeRate":1.5},{"baseType":"physicalAttack","baseTypeRate":1.6},{"baseType":"physicalAttack","baseTypeRate":1.7},{"baseType":"physicalAttack","baseTypeRate":1.8},{"baseType":"physicalAttack","baseTypeRate":1.9},{"baseType":"physicalAttack","baseTypeRate":2}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":true,"occupation":"1","pushDistance":0},
  {"id":"1001","owner":"role","label":"烈火剑法","icon":"skill/icon/1006","category":"0","targetType":"1","action":"attack_skill_1","effect":"effect/skill/s_1006@0","effectOnSelf":true,"cooldown":1,"mpCost":8,"distance":10,"levelReq":10,"description":"战士标志性爆发技能，10级可造成‌280%~560%‌ 攻击伤害，附带15%暴击率，觉醒后还会附加灼烧效果，是PK秒杀、打BOSS爆发的核心招式","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":120},
  {"id":"1002","owner":"role","label":"刺杀剑术","icon":"skill/icon/1003","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":6,"distance":0,"levelReq":10,"description":"公认的破防神技，隔位释放的第二格剑气为无属性攻击，可无视目标防御，直接穿透法师的魔法盾，是克制远程职业、挑战高防BOSS的必备技能","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1003","owner":"role","label":"莲月剑法","icon":"skill/icon/2003","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":6,"distance":0,"levelReq":10,"description":"传奇3版本特色技能，可打出两段连击，总伤害达300%，目标防御越高伤害增幅越明显，适合团战持续黏人输出、残血收割","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1004","owner":"role","label":"‌擒龙手‌","icon":"skill/icon/3010","category":"0","targetType":"1","action":"attack_far","effect":"effect/skill/s_1002@0","effectOnSelf":false,"cooldown":1,"mpCost":10,"distance":100000,"levelReq":10,"description":"高阶特色技能，可将远处的目标直接拉到身边并附加眩晕，同时给自己增加攻击buff，是团战中强切敌方后排的神技","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1005","owner":"role","label":"野蛮冲撞","icon":"skill/icon/1010","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":8,"distance":0,"levelReq":10,"description":"全版本通用的核心控场技能，10级可冲撞4格，65%概率将等级低于自身的目标撞飞并眩晕0.8秒，用于追击敌人、分割敌方阵型、抢BOSS卡位都非常实用","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1006","owner":"role","label":"逐日剑法‌","icon":"skill/icon/2202","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":8,"distance":0,"levelReq":10,"description":"四格范围内的突进突袭技能，可快速拉近与远程职业的距离，弥补战士手短的短板，是PK中追击残血目标的利器","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1007","owner":"role","label":"狮子吼","icon":"skill/icon/3007","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":12,"distance":0,"levelReq":10,"description":"范围麻痹技能，可震开并麻痹周围3格内的敌人，等级高于目标时必中，被围攻时能快速脱身，团战中可打乱敌方后排输出节奏","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1008","owner":"role","label":"十步一杀","icon":"skill/icon/1005","category":"0","targetType":"0","action":"attack_far","effect":"effect/skill/s_3010@0","effectOnSelf":false,"cooldown":1,"mpCost":10,"distance":200,"levelReq":10,"description":"高阶专属技能，突进目标后有概率触发麻痹效果，是后期版本中打先手控制的神技","damageCoefficients":[],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1009","owner":"role","label":"半月弯刀","icon":"skill/icon/1004","category":"0","targetType":"1","action":"stand","effect":"effect/skill/s_1002@0","effectOnSelf":true,"cooldown":1,"mpCost":6,"distance":0,"levelReq":10,"description":"扇形范围群攻技能，可同时攻击身前半圆内的多个敌人，挂机清怪效率极高，被围时贴身释放也能快速清场突围","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"","castLockMs":0,"requireTarget":true,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1010","owner":"role","label":"‌护体神盾","icon":"skill/icon/2009","category":"2","targetType":"3","action":"attack_far","effect":"","effectOnSelf":false,"cooldown":60,"mpCost":15,"distance":0,"levelReq":1,"description":"被动减伤技能，概率格挡 incoming 伤害，大幅提升战士的生存能力，是后期团战中站得住脚的关键保障","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"2001","castLockMs":0,"requireTarget":false,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"1011","owner":"role","label":"金刚护体","icon":"skill/icon/1008","category":"2","targetType":"1","action":"attack_far","effect":"","effectOnSelf":false,"cooldown":1,"mpCost":15,"distance":0,"levelReq":10,"description":"主动防御buff，开启后短时间内可提升40%物防、30%魔防，附带25%减伤效果，能硬抗法师多套技能，打BOSS和团战前必开","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":3},{"baseType":"physicalAttack","baseTypeRate":3.1},{"baseType":"physicalAttack","baseTypeRate":3.2},{"baseType":"physicalAttack","baseTypeRate":3.3},{"baseType":"physicalAttack","baseTypeRate":3.4},{"baseType":"physicalAttack","baseTypeRate":3.5},{"baseType":"physicalAttack","baseTypeRate":3.6},{"baseType":"physicalAttack","baseTypeRate":3.7},{"baseType":"physicalAttack","baseTypeRate":3.8},{"baseType":"physicalAttack","baseTypeRate":3.9},{"baseType":"physicalAttack","baseTypeRate":4}],"statusId":"2002","castLockMs":0,"requireTarget":false,"canAuto":false,"occupation":"1","pushDistance":0},
  {"id":"9001","owner":"monster","label":"跃鼠猛击","icon":"skill/icon/1006","category":"0","targetType":"1","action":"attack_skill_1","effect":"effect/skill/s_1008@0","effectOnSelf":false,"cooldown":6,"mpCost":0,"distance":90,"levelReq":1,"description":"蓄力扑击，对目标造成 1.8 倍物理攻击伤害","damageCoefficients":[{"baseType":"physicalAttack","baseTypeRate":1.8}],"statusId":"","castLockMs":800,"requireTarget":true,"canAuto":false,"occupation":"4","pushDistance":0},
  {"id":"9002","owner":"monster","label":"狂怒","icon":"skill/icon/2009","category":"2","targetType":"3","action":"a1","effect":"effect/status/s_2004@0","effectOnSelf":true,"cooldown":15,"mpCost":0,"distance":0,"levelReq":1,"description":"进入狂怒，持续时间内物理攻击 ×1.5","damageCoefficients":[],"statusId":"9001","castLockMs":600,"requireTarget":false,"canAuto":false,"occupation":"4","pushDistance":0},
  {"id":"9003","owner":"monster","label":"硬化皮肤","icon":"skill/icon/1008","category":"2","targetType":"3","action":"a1","effect":"effect/skill/s_1008@0","effectOnSelf":true,"cooldown":15,"mpCost":0,"distance":0,"levelReq":1,"description":"皮肤硬化，持续时间内防御 ×1.5","damageCoefficients":[],"statusId":"9002","castLockMs":600,"requireTarget":false,"canAuto":false,"occupation":"4","pushDistance":0}
];

/**
 * 状态注册表种子（#603 起服务端唯一书写处）
 *
 * #603 之前这张表写在客户端 `configs/status`（纯数据，客户端只做表现与本地数值修正），
 * 生成器抄进 game-data.generated → 服务端 statuses 表 seed → 管理端可改 → 快照回填客户端。
 * 归属反了 4 次之多的链路上只该有一个手写处 —— 现在**只在这里手写**。
 *
 * 客户端 `configs/status.ts` 只剩一个空的运行时表，快照 `statuses` 段填充
 * （角色与怪物同表，见 apply-snapshot.applyStatusRows）。
 *
 * ## 语义
 * - `owner` 由生成器按 #367 规则固定为 `role`（怪物状态由管理端自建同表 owner=monster）；
 * - `source` 与客户端 `StatusSource` 枚举值同构（skill / equipment / vip / other）；
 * - `combat` 是**战斗数值**的唯一来源：角色侧由客户端 BattleMath 读、怪物侧由
 *   MonsterAiService 读，两边同一套连乘语义（blockChance / blockFactor /
 *   defenseMultiplier / attackMultiplier，缺省 = 不参与）；
 * - `effect` 是表现层资源路径（`effect/xxx@帧`），与客户端约定一致。
 */

/** 一条状态配置 */
export interface StatusSeedRow {
  /** 状态编号（1000~8999 角色、9000+ 怪物，与技能编号同一分段习惯） */
  id: string;
  label: string;
  icon: string;
  /** 持续秒数（0 = 常驻，由技能/装备移除） */
  duration: number;
  /** 来源：skill / equipment / vip / other */
  source: string;
  description: string;
  /** 身上特效资源（`effect/xxx@帧`）；空 = 不播 */
  effect?: string;
  /** 特效播完停在尾帧（只播一遍） */
  effectHoldLast?: boolean;
  /** 战斗数值修正（缺省不参与） */
  combat?: {
    blockChance?: number;
    blockFactor?: number;
    defenseMultiplier?: number;
    attackMultiplier?: number;
  };
}

export const STATUS_SEED_ROWS: StatusSeedRow[] = [
  //#region 角色状态（2000 段）
  {
    id: "2001",
    label: "护体神盾",
    icon: "skill/icon/2009",
    duration: 10,
    source: "skill",
    description: "护体神盾：释放技能后获得，持续时间内 30% 概率格挡，格挡时本次受到的伤害减半；重复释放刷新持续时间",
    effect: "effect/status/s_2004@0",
    // 神盾特效播完就是完整形态：只播一遍停在尾帧，不循环
    effectHoldLast: true,
    // 格挡：30% 概率触发，触发时伤害 ×0.5（口径见 types/status.StatusCombatConfig 与 client/FAQ.md）
    combat: { blockChance: 0.3, blockFactor: 0.5 },
  },
  {
    id: "2002",
    label: "金刚护体",
    icon: "skill/icon/1008",
    duration: 8,
    source: "skill",
    description: "金刚护体：释放技能后获得，持续时间内防御 ×1.5；重复释放刷新持续时间",
    effect: "effect/skill/s_1008@0",
    // 防御乘法系数：生效于「攻 - 防」的防御项（乘法口径，多状态连乘）
    combat: { defenseMultiplier: 1.5 },
  },
  //#endregion
  //#region 怪物状态（#372；9000 段，与怪物技能同时进表）
  /*
   * 怪物状态与角色状态同表：客户端只负责在怪物身上播 effect、在血条旁不做图标栏，
   * 数值生效在服务端（MonsterAiService 按 combat 连乘攻防），与角色侧同一套语义。
   */
  {
    id: "9001",
    label: "狂怒",
    icon: "skill/icon/2009",
    duration: 10,
    source: "skill",
    description: "狂怒：持续时间内物理攻击 ×1.5，怪物放完这套状态后打人更疼",
    effect: "effect/status/s_2004@0",
    combat: { attackMultiplier: 1.5 },
  },
  {
    id: "9002",
    label: "硬化皮肤",
    icon: "skill/icon/1008",
    duration: 10,
    source: "skill",
    description: "硬化皮肤：持续时间内防御 ×1.5，玩家打它更吃力",
    effect: "effect/skill/s_1008@0",
    combat: { defenseMultiplier: 1.5 },
  },
  //#endregion
];

import { Injectable, Logger } from "@nestjs/common";
import { MONSTER_COMBAT, SKILLS } from "../../shared/game-data.generated";
import { summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import type { RealtimeSettleData } from "./realtime.protocol";

/**
 * 伤害结算（#34：客户端发指令，服务端算结果）
 *
 * ===========================================================================
 * 这条服务做什么
 * ===========================================================================
 * 客户端不再自己决定伤害：出手经实时通道送上来，这里按**服务端自己的属性表**算出
 * 一次出手的伤害与目标剩余血量，把结果发回去 —— 客户端只负责把数字演出来。
 *
 * 输入的每一项都来自服务端那份权威：
 * - 攻击者的六项攻防区间：`summarizeRoleAttributes`（#29/#30 的产物，对齐客户端 combatCalc，
 *   素材来自生成物的等级 / 装备 / 战魂 / 称号 / 军衔表）；
 * - 目标（怪物）的 maxHp 与六项防御：生成物 `MONSTER_COMBAT`（#34 起怪物战斗数值进了
 *   单一来源链路，`monsterStats(level, tier)` 打底 + 条目覆盖已展开）；
 * - 技能倍率：生成物 `SKILLS`（`damageCoefficients` 下标 = 技能等级）。
 *
 * ===========================================================================
 * 世界权威之前的取舍（#35 会收编的部分）
 * ===========================================================================
 * 怪物实例**还在客户端**刷（世界状态未上服务端），所以：
 * - 目标的**身份**由客户端给（`targetId` 会话内唯一），但目标的**数值**只认服务端表 ——
 *   客户端报 `monsterKey`，服务端查不到就拒，血量从服务端表的 maxHp 起算；
 * - 死亡由**服务端判**（血量到 0），掉落 / 经验的结算仍在客户端（收到 `killed` 后走既有流程），
 *   这一步挪到服务端要等世界持有掉落表，不与「伤害上移」混在一刀里；
 * - 怪打人（MonsterAI → applyHitDamage）仍走客户端：怪物出手时机由客户端 AI 驱动，
 *   服务端还不知道「这只怪什么时候挥了这一下」—— tick 循环是 #35 的事。
 *
 * ===========================================================================
 * 幂等
 * ===========================================================================
 * 同一 `castId` 的重复投递（网络重传 / 客户端重发）**不重复结算**：每个账号记最近
 * `CAST_DEDUPE_CAPACITY` 次结果，重复的原样重发（`duplicate: true`），血量不会扣两次。
 * 序号由客户端按会话单调递增生成；断线重连后从新会话重新计数（服务端清掉旧账）。
 *
 * ===========================================================================
 * 目标登记簿的生命周期
 * ===========================================================================
 * - 首次打到某 `targetId` 时登记（血量 = MONSTER_COMBAT[key].maxHp）；
 * - 死亡后**保留登记**（血量 0）：再打同一个 id 报 `target_dead`，由换图清账 / 断线 / 兜底清理移除；
 * - 换图时客户端发 `targetsReset` 清空（旧图的怪不该再结算）；
 * - 连接断开时整账号清空（重连后会重新报目标）；
 * - 兜底：登记项带最近活跃时间，定时清理长时间没动静的（防泄漏）。
 */
@Injectable()
export class CombatSettlementService {
  private readonly logger = new Logger(CombatSettlementService.name);

  /** 每个账号记着的目标：targetId → 血量与怪物 key */
  private readonly targets = new Map<string, Map<string, TrackedTarget>>();
  /** 每个账号最近的结算结果（castId → 结果，幂等重发用） */
  private readonly recentSettles = new Map<string, Map<number, RealtimeSettleData>>();
  /** 兜底清理定时器 */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly roles: RolesService) {}

  onApplicationBootstrap(): void {
    // unref：定时器不该成为「进程退不出去」的理由（与 realtime 的心跳同一口径）
    this.sweepTimer = setInterval(() => this.sweep(), TARGET_SWEEP_INTERVAL_MS).unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.targets.clear();
    this.recentSettles.clear();
  }

  /** 结算一次出手（结果直接作为 settle 帧的 data 发回） */
  settle(accountId: string, raw: unknown): RealtimeSettleData {
    const cast = parseCast(raw);
    if (!cast) {
      return { castId: extractCastId(raw), ok: false, code: "bad_request", message: "cast 消息缺 castId / skillId / targetId / monsterKey" };
    }

    // 幂等：同一 castId 原样重发，不重复结算
    const previous = this.recentSettles.get(accountId)?.get(cast.castId);
    if (previous) {
      return previous.ok ? { ...previous, duplicate: true } : previous;
    }

    const result = this.settleNew(accountId, cast);
    this.remember(accountId, cast.castId, result);
    return result;
  }

  /** 换图：本账号记着的目标全部作废（幂等键与结算账也一起清 —— 新图从 0 开始计） */
  resetTargets(accountId: string): void {
    this.targets.delete(accountId);
    this.recentSettles.delete(accountId);
  }

  /** 连接断开：整账号清空（重连后客户端会重新报目标） */
  dropAccount(accountId: string): void {
    this.targets.delete(accountId);
    this.recentSettles.delete(accountId);
  }

  //#region 内部实现

  private settleNew(accountId: string, cast: ParsedCast): RealtimeSettleData {
    const fail = (code: string, message: string): RealtimeSettleData => ({ castId: cast.castId, ok: false, code, message });

    // 技能：存在 + 已学习 + 该等级有伤害系数
    const skill = SKILLS[cast.skillId as keyof typeof SKILLS];
    if (!skill) return fail("unknown_skill", `技能不存在：${cast.skillId}`);

    // 目标：查战斗数值表 + 取登记簿（首次打到就登记，血量从服务端表的 maxHp 起算）
    const stats = MONSTER_COMBAT[cast.monsterKey as keyof typeof MONSTER_COMBAT];
    if (!stats) return fail("unknown_target", `目标怪物不存在：${cast.monsterKey}`);
    const book = this.targets.get(accountId) ?? new Map<string, TrackedTarget>();
    this.targets.set(accountId, book);
    const tracked = book.get(cast.targetId);
    if (tracked && tracked.monsterKey !== cast.monsterKey) {
      return fail("unknown_target", `目标 ${cast.targetId} 已登记为怪物 ${tracked.monsterKey}，与本次的 ${cast.monsterKey} 不符`);
    }
    if (tracked && tracked.hp <= 0) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    // 角色：在线角色 + 等级可汇总 + 技能已学习
    const role = this.roles.online(accountId);
    if (!role) return fail("no_role", "当前没有在线角色，无法结算");
    const summary = summarizeRoleAttributes(role);
    if (!summary) return fail("no_role", `角色等级 ${role.level} 不在成长曲线里，算不出属性`);
    const skillLevel = readSkillLevel(role.data, cast.skillId);
    if (!skillLevel) return fail("skill_not_learned", `技能 ${cast.skillId} 尚未学习`);
    const coefficient = readDamageCoefficient(skill, skillLevel);
    if (coefficient === null) return fail("bad_request", `技能 ${cast.skillId} 等级 ${skillLevel} 没有伤害系数`);

    // 目标血量：登记簿里有就用（接续扣血），没有就按满血登记
    const hp = tracked ? tracked.hp : Number(stats.maxHp);
    const maxHp = Number(stats.maxHp);

    // 伤害公式与客户端 BattleMath.calcSkillDamage 同一口径：
    //   round(攻击区间随机值 × 倍率 − 防御区间随机值)，下限 0
    // 攻击用哪项属性以**生成物里系数的 baseType** 为准（不信任客户端传参），防御按同名映射取
    const attack = rollRange(readRange(summary, coefficient.baseType));
    const defense = rollRange(readMonsterRange(stats, coefficient.baseType));
    const damage = Math.max(0, Math.round(attack * coefficient.baseTypeRate - defense));
    const remaining = Math.max(0, hp - damage);
    const killed = remaining <= 0;

    // 死亡：血量归零后**保留登记**（后续同一目标的出手报 target_dead），由换图清账 / 断线 / 兜底清理移除
    book.set(cast.targetId, { monsterKey: cast.monsterKey, hp: remaining, updatedAt: Date.now() });

    this.logger.debug(
      `结算：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) → 目标 ${cast.targetId}(${cast.monsterKey}) 伤害 ${damage}，血量 ${remaining}/${maxHp}${killed ? "，击杀" : ""}`,
    );

    return { castId: cast.castId, ok: true, skillId: cast.skillId, targetId: cast.targetId, damage, hp: remaining, maxHp, killed, duplicate: false };
  }

  /** 记住一次结算结果（每账号限量，超出挤掉最旧的） */
  private remember(accountId: string, castId: number, result: RealtimeSettleData): void {
    let book = this.recentSettles.get(accountId);
    if (!book) {
      book = new Map<number, RealtimeSettleData>();
      this.recentSettles.set(accountId, book);
    }
    if (book.size >= CAST_DEDUPE_CAPACITY) {
      const oldest = book.keys().next().value;
      if (oldest !== undefined) book.delete(oldest);
    }
    book.set(castId, result);
  }

  /** 兜底清理：长时间没有动静的目标（正常流程里死亡 / 换图 / 断线都会清，这里只防泄漏） */
  private sweep(): void {
    const deadline = Date.now() - TARGET_TTL_MS;
    for (const [accountId, book] of this.targets) {
      for (const [targetId, target] of book) {
        if (target.updatedAt < deadline) book.delete(targetId);
      }
      if (book.size === 0) this.targets.delete(accountId);
    }
  }

  //#endregion
}

//#region 类型与小工具（纯函数，e2e 可对照）

/** 登记簿里的一项目标 */
interface TrackedTarget {
  /** 怪物 key（登记时锁定，之后同一 targetId 换 key 视为异常） */
  monsterKey: string;
  /** 服务端记着的当前血量 */
  hp: number;
  /** 最近活跃时刻（毫秒），兜底清理用 */
  updatedAt: number;
}

/** 客户端 cast 消息解析后的形状 */
interface ParsedCast {
  castId: number;
  skillId: string;
  targetId: string;
  monsterKey: string;
}

type AttackAttribute = "physicalAttack" | "magicAttack" | "taoistAttack";

const ATTACK_ATTRIBUTES: AttackAttribute[] = ["physicalAttack", "magicAttack", "taoistAttack"];
/** 幂等账本容量：足够盖住任何合理的重传窗口，又不会随游玩时长无限涨 */
const CAST_DEDUPE_CAPACITY = 256;
/** 目标登记的兜底存活时间（毫秒）：死亡 / 换图 / 断线之外的最后一道清理 */
const TARGET_TTL_MS = 30 * 60_000;
/** 兜底清理周期（毫秒） */
const TARGET_SWEEP_INTERVAL_MS = 5 * 60_000;

function parseCast(raw: unknown): ParsedCast | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const castId = data.castId;
  if (typeof castId !== "number" || !Number.isFinite(castId)) return null;
  if (typeof data.skillId !== "string" || typeof data.targetId !== "string" || typeof data.monsterKey !== "string") return null;
  if (!data.skillId || !data.targetId || !data.monsterKey) return null;
  return { castId, skillId: data.skillId, targetId: data.targetId, monsterKey: data.monsterKey };
}

/** 解析失败时尽量把 castId 带回去（客户端要靠它把拒绝结果对回某次出手）。
 *  settle() 收到的 raw 就是 cast 消息的 data 对象（RealtimeService 已剥掉外层帧），所以直接读 castId */
function extractCastId(raw: unknown): number {
  const castId = (raw as { castId?: unknown } | null)?.castId;
  return typeof castId === "number" && Number.isFinite(castId) ? castId : 0;
}

/** 从角色存档里读技能等级（data.skills 是客户端写的技能表：skillId → 等级） */
function readSkillLevel(data: Record<string, unknown>, skillId: string): number | null {
  const skills = data?.skills;
  if (!skills || typeof skills !== "object") return null;
  const level = (skills as Record<string, unknown>)[skillId];
  return typeof level === "number" && level >= 1 ? Math.trunc(level) : null;
}

/** 取技能在该等级的伤害系数（damageCoefficients 下标 = 技能等级 − 1，与客户端一致） */
function readDamageCoefficient(
  skill: { damageCoefficients?: unknown },
  skillLevel: number,
): { baseType: AttackAttribute; baseTypeRate: number } | null {
  const list = skill?.damageCoefficients;
  if (!Array.isArray(list)) return null;
  const item = list[skillLevel - 1];
  if (!item || typeof item !== "object") return null;
  const rate = (item as { baseTypeRate?: unknown }).baseTypeRate;
  const baseType = (item as { baseType?: unknown }).baseType;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  if (typeof baseType !== "string" || !ATTACK_ATTRIBUTES.includes(baseType as AttackAttribute)) return null;
  return { baseType: baseType as AttackAttribute, baseTypeRate: rate };
}

/** 服务端角色属性摘要里的攻防区间（区间上下限颠倒时按交换处理） */
function readRange(source: object, attribute: AttackAttribute): [number, number] {
  const value = (source as Record<string, unknown>)[attribute];
  if (!Array.isArray(value) || value.length < 2) return [0, 0];
  return [Number(value[0]) || 0, Number(value[1]) || 0];
}

/** 怪物战斗数值里的攻防区间（攻与防同名：物理攻击对物理防御——客户端 defenseAttributeByAttack 的映射关系） */
function readMonsterRange(stats: Record<string, unknown>, attribute: AttackAttribute): [number, number] {
  const defenseKey = attribute === "physicalAttack" ? "physicalDefense" : attribute === "magicAttack" ? "magicDefense" : "taoistDefense";
  return readRange(stats, defenseKey as AttackAttribute);
}

/**
 * 属性区间随机取整数（与客户端 BattleMath.rollAttributeRange 同一口径：含两端、自动纠正颠倒）
 */
function rollRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

//#endregion

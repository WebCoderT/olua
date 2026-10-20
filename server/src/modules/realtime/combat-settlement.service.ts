import { Injectable, Logger } from "@nestjs/common";
import { MONSTER_COMBAT, SKILLS } from "../../shared/game-data.generated";
import { summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import { WorldService } from "../world/world.service";
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
 * - 目标（怪物）：**世界服务持有的实例**（#35 起）—— 身份由服务端发牌（`worldJoin` 的
 *   instanceId），血量 / 存活都在那里；战斗数值来自生成物 `MONSTER_COMBAT`；
 * - 技能倍率：生成物 `SKILLS`（`damageCoefficients` 下标 = 技能等级）。
 *
 * ===========================================================================
 * 目标状态的归属（#35 之后的边界）
 * ===========================================================================
 * 怪物的血量 / 存活**只在世界服务里**（tick 负责重生、SQLite 负责持久化）——
 * 本服务不再自留一份账号维度的登记簿（#34 的过渡形态已删）：两份血量必然漂移。
 * 这里只保留**幂等账**（castId → 上次结果），它是每账号的会话状态，与世界无关。
 *
 * 掉落 / 经验的结算仍在客户端（收到 `killed` 后走既有流程）；怪打人（MonsterAI →
 * applyHitDamage）也仍在客户端 —— 怪物出手时机由客户端 AI 驱动，那是后续刀的事。
 *
 * ===========================================================================
 * 幂等
 * ===========================================================================
 * 同一 `castId` 的重复投递（网络重传 / 客户端重发）**不重复结算**：每个账号记最近
 * `CAST_DEDUPE_CAPACITY` 次结果，重复的原样重发（`duplicate: true`），血量不会扣两次。
 * 序号由客户端按会话单调递增生成；断线重连 / 换图（worldJoin）后清掉旧账重新计数。
 */
@Injectable()
export class CombatSettlementService {
  private readonly logger = new Logger(CombatSettlementService.name);

  /** 每个账号最近的结算结果（castId → 结果，幂等重发用） */
  private readonly recentSettles = new Map<string, Map<number, RealtimeSettleData>>();

  constructor(
    private readonly roles: RolesService,
    private readonly world: WorldService,
  ) {}

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

  /** 清掉本账号的幂等账（换图 worldJoin / 旧消息 targetsReset 都会走到；世界状态不受影响） */
  resetTargets(accountId: string): void {
    this.recentSettles.delete(accountId);
  }

  /** 连接断开：清幂等账（世界状态是共享的，不随任何账号的连接断开而清） */
  dropAccount(accountId: string): void {
    this.recentSettles.delete(accountId);
  }

  //#region 内部实现

  private settleNew(accountId: string, cast: ParsedCast): RealtimeSettleData {
    const fail = (code: string, message: string): RealtimeSettleData => ({ castId: cast.castId, ok: false, code, message });

    // 技能：存在 + 已学习 + 该等级有伤害系数
    const skill = SKILLS[cast.skillId as keyof typeof SKILLS];
    if (!skill) return fail("unknown_skill", `技能不存在：${cast.skillId}`);

    // 目标：战斗数值表里要有这只怪，世界里要有这只实例（instanceId 由服务端发牌，
    // 伪造的 / 已被卸载图的一律 unknown_target），且 key 与实例登记的一致
    const stats = MONSTER_COMBAT[cast.monsterKey as keyof typeof MONSTER_COMBAT];
    if (!stats) return fail("unknown_target", `目标怪物不存在：${cast.monsterKey}`);
    const target = this.world.find(cast.targetId);
    if (!target) return fail("unknown_target", `目标实例不存在：${cast.targetId}`);
    if (target.monsterKey !== cast.monsterKey) {
      return fail("unknown_target", `目标 ${cast.targetId} 是怪物 ${target.monsterKey}，与本次的 ${cast.monsterKey} 不符`);
    }
    if (!target.alive) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    // 角色：在线角色 + 等级可汇总 + 技能已学习
    const role = this.roles.online(accountId);
    if (!role) return fail("no_role", "当前没有在线角色，无法结算");
    const summary = summarizeRoleAttributes(role);
    if (!summary) return fail("no_role", `角色等级 ${role.level} 不在成长曲线里，算不出属性`);
    const skillLevel = readSkillLevel(role.data, cast.skillId);
    if (!skillLevel) return fail("skill_not_learned", `技能 ${cast.skillId} 尚未学习`);
    const coefficient = readDamageCoefficient(skill, skillLevel);
    if (coefficient === null) return fail("bad_request", `技能 ${cast.skillId} 等级 ${skillLevel} 没有伤害系数`);

    // 伤害公式与客户端 BattleMath.calcSkillDamage 同一口径：
    //   round(攻击区间随机值 × 倍率 − 防御区间随机值)，下限 0
    // 攻击用哪项属性以**生成物里系数的 baseType** 为准（不信任客户端传参），防御按同名映射取
    const attack = rollRange(readRange(summary, coefficient.baseType));
    const defense = rollRange(readMonsterRange(stats, coefficient.baseType));
    const damage = Math.max(0, Math.round(attack * coefficient.baseTypeRate - defense));

    // 扣血与世界状态（血量 / 死亡判定都在世界服务里，这里只拿结果演）
    const applied = this.world.applyDamage(cast.targetId, damage);
    if (!applied) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    this.logger.debug(
      `结算：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) → 目标 ${cast.targetId}(${cast.monsterKey}) 伤害 ${damage}，血量 ${applied.hp}/${target.maxHp}${applied.killed ? "，击杀" : ""}`,
    );

    return { castId: cast.castId, ok: true, skillId: cast.skillId, targetId: cast.targetId, damage, hp: applied.hp, maxHp: target.maxHp, killed: applied.killed, duplicate: false };
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

  //#endregion
}

//#region 类型与小工具（纯函数，e2e 可对照）

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

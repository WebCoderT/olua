import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MonsterPresentationRepository } from "../../database/repositories/monster-presentation.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MonsterSkillRepository } from "../../database/repositories/monster-skill.repository";
import { SkillRepository } from "../../database/repositories/skill.repository";
import { StatusRepository } from "../../database/repositories/status.repository";
import { MonsterRow, SkillRow, StatusRow } from "../../database/rows";
import { parseCoefficientsJson, parseCombatJson, parseControlFlagsJson, parseTickEffectJson } from "../../common/config-json";
import { DEFENSE_BY_ATTACK, MONSTER_STAT_COLUMN } from "../../common/constants/game-enums";
import type { MonsterAiRuntimeParams } from "../../common/constants/runtime-params";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { resolveIncomingDamage } from "../combat/status-combat";
import { RolesService } from "../roles/roles.service";
import { WorldService } from "../world/world.service";
import type { WorldMonster } from "../world/world-monster";
import { PUBLIC_SLOT, roomKey, splitRoomKey } from "../../common/utils/room-key.util";
import { MapService } from "../map/map.service";
import { PlayerPresenceService } from "./player-presence.service";
import type { RealtimeDropEntry, RealtimeMonsterAiEntry, RealtimeMonsterCast, RealtimeMonsterHit, RealtimeMonsterKill, RealtimeStatusEntry } from "./realtime.protocol";

/**
 * 怪物 AI 参数（`runtime_params.monster_ai` 列，管理端「运行时参数」页可改）
 *
 * 形状定义在 `common/constants/runtime-params`（那里是键清单的唯一来源，
 * 管理端 DTO 也用它）；这一组值是**运营数据**，出厂值在 `server/data/config-sync.sql`，
 * 代码不存第二份。
 */
type MonsterAiParams = MonsterAiRuntimeParams;

/**
 * 表里缺列 / 坏列时的**最小可用**参数
 *
 * 这不是「出厂值的第二份副本」（出厂值在 SQL 快照里）：它只在 `runtime_params.monster_ai`
 * 读不出来时兜住进程 —— 全部取 0 会让怪物每 tick 出手一次（打爆玩家），比不跑更糟。
 * 读到兜底值时 `refreshConfig` 会 warn 一次，让人去修数据。
 */
const FALLBACK_AI: MonsterAiParams = {
  attackInterval: 2000,
  attackRange: 60,
  attackActionTime: 400,
  pushDuration: 200,
  idleMoveInterval: [4000, 9000],
  idleMoveDuration: [300, 800],
  idleMoveSpeedScale: 0.5,
  wanderRadius: 60,
  // 三个默认值与 docs/27 §2.5.1 的表一致：600px 远大于普攻距离（60）又远小于图宽，
  // 1.5 倍速让「拖着怪遛」不再是稳赚的策略，20 秒是「被墙角卡死」的兜底时长
  leashRange: 600,
  returnSpeedRate: 1.5,
  returnTimeoutMs: 20000,
};

/**
 * 到家判定（像素）：离出生点这么近就算回去了
 *
 * 取 16 而不是 0：坐标是浮点运算出来的，直线走过去永远差一点点；用 0 会让怪在出生点
 * 附近来回微调，看起来像抽搐（docs/27 §2.5.1 就是这个数）。
 */
const HOME_ARRIVE_PX = 16;

/** 卡住判定：连续这么多帧**一步都没动**（不足 0.01px）才算卡住（单帧抖动不算） */
const STUCK_FRAMES = 3;
/** 卡住后换切线的次数上限（每侧 ±60°，两次都失败就停在原地待机） */
const STUCK_TURNS = 2;
/** 换切线的角度（弧度，±60°） */
const DETOUR_ANGLE = Math.PI / 3;
/** 换切线后按新方向走的帧数（够它绕过矩形的一个角；走完还没进展就再换） */
const DETOUR_TICKS = 6;
/** 同一个目标连续出手失败几次之后放弃（#856：计数按目标维度存在**这一只怪**身上） */
const FAIL_LIMIT = 3;

/**
 * 冻结多久之后回收运行时（#857）
 *
 * 冻结期内存的是「血量之外的战斗状态」（buff 计时、击退游标、索敌目标）—— 十分钟没人
 * 看过这张图，那些东西已经不再有意义（人都换了一批），而运行时本来就不落盘，
 * 回收不需要任何持久化动作。**不是**「无人就看就删」：那正是刷血的来源。
 */
const FREEZE_RECYCLE_MS = 10 * 60 * 1000;

/** 地图几何缓存的 TTL（#854）：碰撞盒是管理端画的低频数据，5 秒足够跟上改动 */
const GEOMETRY_CACHE_TTL_MS = 5000;

/**
 * 拉人的终点留多宽（像素，#826 第三批）
 *
 * 拉到施法者身上会让两个精灵完全重叠、互相遮挡，看起来像「怪消失了」。40px 大约是一个
 * 角色身位的一半 —— 与掉落散落距离（52）不是一回事，那个管的是「两件东西不叠在一起」。
 */
const PULL_STOP_GAP = 40;

/** 一只怪的 AI 视觉参数（`monster_presentation` 表的一行，摊平成 AI 用得上的三个字段） */
interface MonsterAiConfig {
  aggressive: boolean;
  detectRange: number;
  moveSpeed: number;
}

/**
 * 技能 / 挂载 / 状态的读库缓存时长（毫秒）
 *
 * 为什么需要缓存：管理端与实时进程是**两个进程**（3100 / 3101），只能通过共享的 SQLite
 * 交换改动，没法直接通知。每 tick 都查三张表（skills / statuses / monster_skills）在
 * 一张图上几十只怪时是纯浪费；1 秒 TTL 换来「改完最多 1 秒生效」，与 #258 的读库口径一致。
 */
const SKILL_CACHE_TTL_MS = 1000;

/**
 * 怪物侧周期状态一次最多补几拍（#826 第三批）
 *
 * 图没人看时 AI 冻结（进度严格停住），回来时 `tickedAt` 可能落后很多拍。
 * 一次补齐会让「离开十分钟再回来」变成「怪被烧掉半管血」，所以设上限 ——
 * 与角色侧 `RoleStatusService.MAX_CATCH_UP_TICKS` 取同一个数（两端口径必须一致，
 * 否则同一次灼烧在两种实体上算出不同的总伤害）。
 */
const MAX_MONSTER_CATCH_UP_TICKS = 5;

/**
 * 没有任何运行时的房间返回它（共享的空 Map，别改）
 *
 * `liveRuntimesOf` 每 100ms 会被 AOI 调一次（包括「图里没人看、运行时已回收」的情形），
 * 每次都 `new Map()` 只是给 GC 添活；空表是只读的，一份就够。
 */
const EMPTY_RUNTIMES: ReadonlyMap<string, { x: number; y: number; hp: number; maxHp: number }> = new Map();

/**
 * 一个可释放技能的运行时快照（技能行 + 挂载条目 + 状态行合并后的结果）
 *
 * 提前合并的理由：AI 每 tick 每只怪都要判断「能不能放、放哪个」，不该在那里做 JSON 解析。
 */
interface CastPlan {
  skillId: string;
  /** 技能名（事件日志要显示「放了什么」，读库时就带上，别在 tick 里查） */
  label: string;
  /** 分类原值：0 主动（打伤害）/ 2 状态（给自己挂 buff）。其它分类不参与怪物 AI */
  category: string;
  priority: number;
  /** 冷却（秒）：挂载条目覆写优先，其次技能自身的 cooldown */
  cooldown: number;
  /** 施法距离（像素；状态型忽略距离） */
  distance: number;
  /** 施法硬直（毫秒）：0 = 回落到普攻动作时长 this.ai.attackActionTime */
  castLockMs: number;
  /** 伤害系数（取等级 1 的第一条；怪物不练级） */
  baseType: string;
  rate: number;
  statusId: string;
  /** 状态持续（秒） */
  statusDuration: number;
}

/**
 * 怪物身上一条生效中的状态（#826 第三批）
 *
 * 与角色侧 `role_status` 的差别是**不落库**：怪物状态本来就被定义为「这一轮表现」
 * （见 `RoleStatusService` 类注释的对照），重生即重建、图没人看就冻结 —— 存库反而要
 * 处理「重启后凭空多一个 buff」与「冻结期间到期算不算」两件事。
 *
 * 记 `sourceAccountId` 是为了「谁烧的」能追溯（周期伤害日志与后续接击杀归属都要它）；
 * 怪物自己放的状态型技能没有施加者，留空串。
 */
interface MonsterStatusEffect {
  /** 到期时刻（毫秒） */
  expiresAt: number;
  /** 层数（1 ~ `statuses.max_stacks`） */
  stacks: number;
  /** 上一次周期结算的时刻（毫秒；0 = 还没结算过） */
  tickedAt: number;
  /** 施加者账号（空串 = 怪物自己 / 无主） */
  sourceAccountId: string;
}

/** 一只怪的服务端 AI 运行时（内存态，**不落盘**：坐标的持久真相是出生点，见 world.service） */
interface MonsterRuntime {
  /** 身份三件套 + 实例 id：事件日志要带「哪张图哪只怪」
   *  （运行时不随重生保留 —— 重生即重建，所以这里是快照值而不是引用） */
  zoneId: number;
  mapId: string;
  instanceId: string;
  monsterKey: string;
  /** 当前模拟坐标（世界坐标；首次创建时 = 出生点） */
  x: number;
  y: number;
  /** 当前追击目标账号（null = 没有目标，待机游走） */
  target: string | null;
  /** 最后一次打伤过这只怪的账号（被动怪的记恨；主动怪不依赖它） */
  provoked: string | null;
  /**
   * 状态机的当前态（#853）
   *
   * `return` 是新增的一档：**回家途中不索敌、不接受新威胁**，只朝出生点直线走。
   * 没有它的话「脱战」只是把 target 置空，怪会停在玩家把它拉到的位置继续游走 ——
   * 下一个人过来看到的是一只离出生点半张图的怪。
   */
  state: "idle" | "chase" | "return";
  /** 开始回家的时刻（毫秒）；`state !== "return"` 时为 0（判超时吸附用） */
  returningSince: number;
  /**
   * 连续出手失败的次数（账号 → 次数；#856）
   *
   * 按**目标维度**存在这一只怪身上，不是全局共享的一张表：某个玩家结算不出来
   * （下线瞬间 / 已倒下）只该让**这只怪**放弃他，不该让全图的怪一起掉头（旧实现
   * 是把整张 `positions` 里那个人删掉，全图所有盯他的怪同时脱战）。
   * 累计到 `FAIL_LIMIT` 就把记恨一并清掉 —— 那是「这个人现在打不了」的结论。
   */
  failCounts: Map<string, number>;
  /** 卡住判定的连续无位移帧数（#854） */
  stuckFrames: number;
  /** 本轮卡住已经换过几次切线（0~`STUCK_TURNS`） */
  stuckTurns: number;
  /** 换切线后的剩余帧数（> 0 时按 `detourDir` 走，而不是朝目标直线走） */
  detourTicks: number;
  /** 换切线方向（单位向量） */
  detourDirX: number;
  detourDirY: number;
  /** 下一次可普攻的时刻（毫秒） */
  nextAttackAt: number;
  /** 待机游走的停留点（追击结束从这里重新游走） */
  anchorX: number;
  anchorY: number;
  /** 本轮随机走动的截止时刻（毫秒）；<= now 表示站定 */
  idleMoveEndAt: number;
  idleMoveDirectionX: number;
  idleMoveDirectionY: number;
  /** 下一次触发随机走动的时刻（毫秒） */
  nextIdleMoveAt: number;
  /** 上次广播的位置与移动标记（增量广播的判据） */
  sentX: number;
  sentY: number;
  sentMoving: boolean;
  /** 本轮 tick 是否在移动（待机游走 / 追击位移；站定与出手为 false） */
  movingNow: boolean;
  /** 技能冷却（skillId → 可再次释放的时刻，毫秒；#372） */
  skillReadyAt: Map<string, number>;
  /**
   * 自己身上的状态（statusId → 运行时记账；#372 起的自 buff + #826 第三批玩家施加的
   * 控制 / 灼烧都落在这里）
   *
   * 为什么不落库：见 `MonsterStatusEffect` 的说明。
   */
  statuses: Map<string, MonsterStatusEffect>;
  /** 施法硬直到期时刻（毫秒）：期间既不移动也不出手（#372） */
  castEndAt: number;
  /** 击退结束时刻（毫秒；#670 技能击退，期间只按击退方向位移） */
  pushEndAt: number;
  /** 击退开始时刻（毫秒）：与 pushedUntil 一起把位移按 tick 补齐（#826 第二批） */
  pushStartAt: number;
  /** 已按击退位移推进到的时刻（毫秒）：tick 粒度比击退窗口粗时靠它补齐、不重复不遗漏 */
  pushedUntil: number;
  /** 击退方向（单位向量，世界坐标） */
  pushDirX: number;
  pushDirY: number;
  /** 击退速度（像素/秒，由击退距离与时长换算） */
  pushSpeed: number;
  /**
   * 上一拍 tick 读到的血量与上限（#670：随位置一起广播，观看者据此刷血条）
   *
   * 世界观层的血量是权威（玩家打怪走 settle 落账），AI 只是**读者**：每 tick 抄一份到
   * 运行时里，广播时不必再去世界层逐只反查（200ms 一拍，几十只怪）。
   */
  hp: number;
  maxHp: number;
  /** 上次广播出去的血量（增量广播的第三个判据；-1 = 还没广播过） */
  sentHp: number;
}

/** 一张图的可行走几何（`MapService.walkGeometryOf` 的形状；`null` = 不用判碰撞） */
type WalkGeometry = { width: number; height: number; boxes: Array<{ cx: number; cy: number; w: number; h: number }> };

/** 读一列 JSON 对象（坏数据返回 null，由调用方决定兜底） */
function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 正数取值（0 / 负数 / 非数字 → 兜底） */
function positiveOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `[min, max]` 区间取值（两端都要是有限数字，且 min ≤ max） */
function rangeOr(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  const min = Number(value[0]);
  const max = Number(value[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return fallback;
  return [min, max];
}

function randomBetween(range: [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

/**
 * 怪物「该项攻击」的区间（行里是拍平的 `*_attack_min` / `*_attack_max` 两列）
 *
 * `baseType` 来自技能系数；普攻与认不出的值都按物理 —— 与 `readMonsterRange`（玩家打怪那侧）
 * 相反的方向、同一张映射表（`game-enums`）。
 */
function monsterAttackRange(stats: MonsterRow, baseType: string): [number, number] {
  const column = MONSTER_STAT_COLUMN[baseType] ?? "physical_attack";
  return [Number(stats[`${column}_min`]) || 0, Number(stats[`${column}_max`]) || 0];
}

/**
 * 这只怪「该项攻击」配没配（上限 > 0 才算配了）
 *
 * 用途是挡住「法攻全是 0 的怪挂了法术技能」——放出去伤害恒等于 −防御→0，玩家看到的是
 * 「怪对着我放了个法术，我一点血没掉」。宁可这只怪不放这个技能（回落到普攻并 warn），
 * 也不要留一颗哑弹（#823 拍板口径：法/道攻由运营配，0 = 未配）。
 */
function hasAttackFor(stats: MonsterRow | undefined, baseType: string): boolean {
  if (!stats) return false;
  return monsterAttackRange(stats, baseType)[1] > 0;
}

/** 属性区间随机取整数（与结算侧 rollRange 同一口径：含两端、自动纠正颠倒） */
function rollRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * 技能行 + 挂载条目 → 可执行的 CastPlan（不可用返回 null）
 *
 * 三种「配了也放不出来」的组合在这里挡掉，省得 AI 每 tick 白跑：
 * - 分类不是主动 / 状态（被动与回复不归怪物 AI 管）；
 * - 主动技能没有伤害系数（放出去伤害恒 0，与角色侧 `assertSkillConsistency` 同一理由）；
 * - 状态型技能指向的状态行不存在（被删了 / 改了 id）。
 */
function buildCastPlan(skill: SkillRow, priority: number, cooldownOverride: number | null, status: StatusRow | undefined): CastPlan | null {
  if (skill.category !== "0" && skill.category !== "2") return null;
  const coefficients = parseCoefficientsJson(skill.damage_coefficients);
  const first = coefficients[0];
  const rate = first ? Number(first.baseTypeRate) || 0 : 0;
  if (skill.category === "0" && rate <= 0) return null;
  if (skill.category === "2" && (!status || !skill.status_id)) return null;
  return {
    skillId: skill.id,
    label: String(skill.label ?? ""),
    category: skill.category,
    priority,
    cooldown: cooldownOverride ?? (Number(skill.cooldown) || 0),
    distance: Number(skill.distance) || 0,
    castLockMs: Number(skill.cast_lock_ms) || 0,
    baseType: String(first?.baseType ?? "physicalAttack"),
    rate,
    statusId: skill.status_id,
    statusDuration: status ? Number(status.duration) || 0 : 0,
  };
}

/**
 * AI 侧发生的事（#745：给「实时地图监控」用的进程内回调）
 *
 * 为什么不用协议帧：这些是**给人看的日志**，客户端一个字节都不需要 —— 走 `monster-ai` 帧
 * 会把每一下伤害都塞进 200ms 一拍的广播里，几十只怪时是纯浪费带宽。回调只喂给
 * `MapMonitorService`（同一进程），它转成 `map_monitor_events` 的一行文字。
 *
 * 为什么不注入 `MapMonitorService`：那个服务本身依赖本服务（采样要读实时坐标），
 * 构造注入就成了循环依赖。用 `onLog` 这种单向回调（与 `onBroadcast` 同一手法），
 * 谁需要谁在 `onApplicationBootstrap` 里接线，AI 不关心有没有人听。
 */
export type MonsterAiLogEvent =
  | {
      type: "chase";
      at: number;
      phase: "start" | "end";
      zoneId: number;
      mapId: string;
      instanceId: string;
      monsterKey: string;
      x: number;
      y: number;
      /** 被追 / 被放弃的账号 */
      accountId: string;
      /** 结束原因由 AI 判定（页面直接显示这几个字，不再让前端猜） */
      reason: string;
      /** 这一刻双方距离（像素，取整） */
      distance: number;
    }
  | {
      type: "cast";
      at: number;
      zoneId: number;
      mapId: string;
      instanceId: string;
      monsterKey: string;
      x: number;
      y: number;
      /** 目标账号（状态型技能给自己上 buff，取当前目标或空串） */
      accountId: string;
      skillId: string;
      skillLabel: string;
      /** 对玩家造成的伤害（状态型为 0） */
      damage: number;
      /** 挨打之后玩家的血量与上限（状态型为 0） */
      hp: number;
      maxHp: number;
    }
  | {
      type: "hit";
      at: number;
      zoneId: number;
      mapId: string;
      instanceId: string;
      monsterKey: string;
      x: number;
      y: number;
      accountId: string;
      damage: number;
      /** 挨打之后玩家的血量与上限 */
      hp: number;
      maxHp: number;
    };

/**
 * 怪物 AI（#323：目标选择 / 移动 / 普攻与玩家受击的权威都在服务端；#372 起还会放技能）
 *
 * ===========================================================================
 * 服务端模拟什么
 * ===========================================================================
 * 每只**有人看的图**上的存活怪，跑一套与客户端旧 MonsterAI 同口径的状态机：
 * - 目标选择：主动怪常驻发现；被动怪被打伤后记恨打它的人（结算侧 provoke 进来）；
 *   **坐标一律读在场表**（`PlayerPresenceService`，#855）—— AI 自己不再存一份原始坐标，
 *   位置仲裁（#596）不通过的人根本不会出现在候选里；
 *   **出手结算不出来（玩家已经倒下 / 不在线）即当作目标作废**（#670）：清记恨、
 *   且这次出手整次不发 —— 包括技能（见 `forgetTarget`）；
 * - 脱战与回家（#853 / docs/27 E3）：目标距离 > `leashRange`（默认 600px）→ 脱战，
 *   清目标与记恨（#858），直线走回**出生点**（速度 × `returnSpeedRate`），途中不索敌、
 *   不接受新威胁；16px 内算到家，恢复待机。回家超过 `returnTimeoutMs`（默认 20 秒）还没走到
 *   （被地形挡住 / 出生点本身在碰撞盒里）→ 直接吸附到出生点，不许永久卡在半路；
 * - 移动与碰撞（#854 / docs/27 E4）：直线趋近 + 碰撞滑行（撞墙保留平行分量），
 *   连续 3 帧一步都没动（不足 0.01px）→ 换切线方向（±60°）重试 2 次，仍不行就停在那里待机；
 *   门槛不能定成「1px」：出厂 `move_speed` 是个位数，2px/s 的怪每帧只走 0.1px，
 *   坐标恒钳在 `[0, mapWidth] × [-mapHeight, 0]`；击退也走同一套碰撞（被挡则原地）。
 *   **不做 A\***：一张图的障碍是十几个矩形，直线 + 滑行已经够用，寻路是另一个量级的东西；
 * - 无人看就**冻结**（#857）：不推进、不删运行时 —— 删掉等于「反复进出图免费回血回 buff」。
 *   冻结超过 `FREEZE_RECYCLE_MS` 才回收（运行时本来不落盘，回收不需要持久化）；
 *   速度用快照里每只怪的 `moveSpeed`（像素/秒，与客户端同一数值）；
 * - 出手：进入距离后**先试技能、再普攻**（#372，见下节）；普攻伤害 = 怪物物攻区间随机值
 *   （monsters 表，#258 起读库即时生效）× 攻击倍率 − 玩家物防区间随机值 × 玩家防御倍率，
 *   再过一道格挡（#822），受击走 `RolesService.applyMonsterHit` 落账（血量权威在服务端，revision 不推进）。
 *
 * ===========================================================================
 * 技能（#372）
 * ===========================================================================
 * 依据三张表（都读库、1 秒 TTL）：`monster_skills`（哪只怪放哪些、优先级、冷却覆写）、
 * `skills`（owner=monster 的技能行：动作 / 特效 / 倍率 / 距离 / 施法硬直 / 挂载状态）、
 * `statuses`（状态持续时长与战斗修正）。
 *
 * - **顺序**：状态型整体先于伤害型（buff 先上），同类型内按 priority 升序；
 *   已经在身上的状态不重复放（等它到期）；
 * - **距离**：伤害型要够得着（技能 distance，钳到普攻距离下限）；状态型不看距离 ——
 *   追击路上就能给自己上 buff；
 * - **硬直**：`castLockMs`（0 回落 `this.ai.attackActionTime`）期间不移动不出手，
 *   同时把普攻间隔一并推后（普攻与施法共用同一个「出手」窗口）；
 * - **状态生效**：`attackMultiplier` 乘伤害、`defenseMultiplier` 乘被玩家打时的防御
 *   （`CombatSettlementService` 通过 `defenseMultiplierOf` 取），到期惰性清理。
 *
 * ===========================================================================
 * 刻意不做的
 * ===========================================================================
 * - **玩家侧状态由 `role_status` 提供，不在本服务里存**（#822）：本服务只调
 *   `RolesService.statusModifiersOf` 拿防御倍率与格挡，状态的施加 / 到期 / 清空都在存档域 ——
 *   人物的状态要跨进程、跨重启活着，放这里会与存档进程各执一份。
 * - **位置只有一份**（#855）：在场表（`PlayerPresenceService`）是位置与血量的唯一副本，
 *   本服务只读不存。曾经这里也有一张 `positions`，问题是它存的是**客户端原始坐标** ——
 *   一份伪造的 `pos` 同时骗过互见与索敌，位置仲裁（#596）等于白做；
 * - **位置不落盘**：坐标的持久真相是出生点（世界服务的既有边界），重启后怪物回出生点
 *   重新游走 —— 几秒钟的表现层状态，不值得为它加一张表；
 * - 超时没上报的玩家视作离场，怪物丢失目标（判据在在场表里，`aiTargetsOn` 已过滤）；
 * - 怪物不消耗魔法值：技能表的 `mpCost` 只对角色生效（怪物没有资源系统）。
 *
 * ===========================================================================
 * 广播
 * ===========================================================================
 * 按 `MONSTER_AI_BROADCAST_MS` 节流：只发**有变化**的怪（位置变了、移动标记变了或血量变了）
 * 加上这段时间的命中事件、技能释放与玩家击杀（#689）—— 站着的怪不发第二遍。帧形状见 protocol 的
 * `RealtimeMonsterAiMessage`；发谁由观看者集合决定（RealtimeService 接线）。
 */
@Injectable()
export class MonsterAiService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonsterAiService.name);

  /** `zone:mapId` → 该图各怪的 AI 运行时（与世界服务的分域键同构；没人看的图**冻结**不删，#857） */
  private readonly runtimes = new Map<string, Map<string, MonsterRuntime>>();  /** `zone:mapId` → 冻结起始时刻（毫秒；#857 回收阈值用） */
  private readonly frozenAt = new Map<string, number>();
  /** mapId → 可行走几何（#854；碰撞盒是低频数据，5 秒 TTL） */
  private readonly geometryCache = new Map<string, { at: number; geo: WalkGeometry | null }>();
  private aiTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  /** 本轮 tick 攒下的命中事件（`zone:mapId` → hits），广播时一并发出 */
  private readonly pendingHits = new Map<string, RealtimeMonsterHit[]>();
  /** 本轮 tick 攒下的技能释放（`zone:mapId` → casts），广播时一并发出 */
  private readonly pendingCasts = new Map<string, RealtimeMonsterCast[]>();
  /** 本轮攒下的玩家击杀（`zone:mapId` → kills，#689），广播时一并发出 */
  private readonly pendingKills = new Map<string, RealtimeMonsterKill[]>();

  /** 技能缓存（#372）：怪物 key → 按释放顺序排好的 CastPlan；`loadedAt` 做 TTL */
  private skillPlans = new Map<string, CastPlan[]>();
  /** 状态行缓存（#372）：statusId → 行（算状态修正时不再查库） */
  private statusRows = new Map<string, StatusRow>();
  /** 怪物表现参数缓存（#655 起读 `monster_presentation` 表，与技能缓存同一个 TTL） */
  private presentationByKey = new Map<string, MonsterAiConfig>();
  /** 怪物 AI 参数（`runtime_params.monster_ai`，同一 TTL） */
  private ai: MonsterAiParams = FALLBACK_AI;
  private skillCacheLoadedAt = 0;
  /** 只在第一次读到兜底参数时喊一次，别每 tick 刷日志 */
  private aiFallbackWarned = false;
  /** 已经为「法术技能但法攻打 0」告警过的 `monsterKey:skillId`（缓存每秒重建，不去重就是刷屏） */
  private readonly warnedNoAttack = new Set<string>();

  /**
   * 监控日志出口（#745：实时地图监控的「精细日志」）。MapMonitorService 启动时接线；
   * 未接线时事件照常产生、只是没人记 —— 与 `onBroadcast` 同一条理由。
   */
  onLog: ((event: MonsterAiLogEvent) => void) | null = null;

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时 AI 照常跑，只是没人收到帧。
   */
  onBroadcast:
    | ((
        roomId: string,
        data: {
          mapId: string;
          monsters: RealtimeMonsterAiEntry[];
          hits: RealtimeMonsterHit[];
          casts: RealtimeMonsterCast[];
          kills: RealtimeMonsterKill[];
        },
      ) => void)
    | null = null;

  /**
   * 状态推送出口（#826 第三批）：怪物把眩晕 / 灼烧挂到某个玩家身上时，要把**整份**状态
   * 快照推给他本人 —— 否则那个玩家要等到下一次出手被拒（`stunned`）才知道自己动不了。
   *
   * 与 `onBroadcast` 同一条手法：AI 不认识连接，RealtimeService 启动时接线。
   * 未接线时状态照常生效（服务端权威），只是客户端图标栏晚一步刷新。
   */
  onStatuses: ((accountId: string, statuses: RealtimeStatusEntry[]) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly world: WorldService,
    private readonly roles: RolesService,
    private readonly monsterConfigs: MonsterRepository,
    private readonly skillsRepo: SkillRepository,
    private readonly statusesRepo: StatusRepository,
    private readonly monsterSkillsRepo: MonsterSkillRepository,
    private readonly presentationRepo: MonsterPresentationRepository,
    private readonly runtimeParamsRepo: RuntimeParamsRepository,
    // #855：位置与血量的唯一副本就是在场表 —— AI 只读它，不再自己存一份原始坐标
    private readonly presence: PlayerPresenceService,
    // #854：可行走几何（图多大、墙在哪）属于地图域，AI 不自己拼
    private readonly maps: MapService,
  ) {}

  onApplicationBootstrap(): void {
    this.aiTimer = setInterval(() => this.tick(), this.tickMs()).unref();
    this.broadcastTimer = setInterval(() => this.broadcast(), this.broadcastMs()).unref();
    this.logger.log(`怪物 AI 已启动（tick ${this.tickMs()}ms / 广播 ${this.broadcastMs()}ms / 位置超时 ${this.posStaleMs()}ms）`);
  }

  onApplicationShutdown(): void {
    if (this.aiTimer) clearInterval(this.aiTimer);
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.aiTimer = null;
    this.broadcastTimer = null;
  }

  //#region 输入（结算侧调用）

  // 这里**曾经**有 `updatePosition` / `dropAccount` 两个入口（#855 之前 AI 自己存一份
  // 玩家坐标与血量）。现在位置只在 `PlayerPresenceService` 里有一份：`pos` 帧由通道
  // 直接喂在场表，断线由通道直接调 `presence.dropAccount` —— AI 侧不再需要任何入口，
  // 也就不存在「两份坐标谁更新」的问题。

  /**
   * 被动怪的记恨（结算侧在玩家打伤怪后调用）：之后这只怪在检测范围内会追击这个玩家
   */
  provoke(instanceId: string, accountId: string): void {
    const monster = this.world.find(instanceId);
    if (!monster) return;
    const runtime = this.runtimeOf(monster);
    runtime.provoked = accountId;
    // 又被打了一下 = 重新给一次机会（#856 的失败账本按目标维度清）：
    // 之前因为「连着几次结算不出来」被跳过的玩家，只要还能打中这只怪就重新进候选
    runtime.failCounts.delete(accountId);
    // 记恨意味着刚被打过：它此刻可能正在回家（脱战），得回到战斗态才追得上去
    if (runtime.state === "return") {
      runtime.state = "idle";
      runtime.returningSince = 0;
    }
  }

  /**
   * 技能击退（#670：位移也只能由服务端产生，否则同图两个人看到的落点不一样）
   *
   * 由结算侧在「带 `push_distance` 的技能打中」之后调用。方向 = 施法者 → 怪（取不到施法者
   * 位置就放弃这次击退：位置上报还没到，宁可不推也不要推错方向）。
   *
   * 语义与客户端旧版 `MonsterAI.push` 一致：按「距离 / 时长」换算匀速位移，期间只走击退、
   * 不出手、不受硬直影响 —— 击退本身就是打断。落点会随普通的位置广播发给所有人，
   * 客户端照常趋近（`MonsterAI.stepServer`），因此**不需要新的协议帧**。
   */
  applyPush(instanceId: string, fromAccountId: string, distance: number): void {
    if (!(distance > 0)) return;
    const monster = this.world.find(instanceId);
    if (!monster || !monster.alive) return;
    // 位置只有一份（#855）：推方向要用「被接受过的」玩家坐标，不能用客户端原始值
    const from = this.presence.positionOf(fromAccountId);
    if (!from) {
      // 在场表里没有他 = 从没报过位置，或已经超时被当离场（客户端正常 4Hz，走不到这里）
      this.logger.debug(`怪物 ${instanceId} 的击退作废：施法者 ${fromAccountId} 没有可用的在场位置`);
      return;
    }
    const runtime = this.runtimeOf(monster);
    const offsetX = runtime.x - from.x;
    const offsetY = runtime.y - from.y;
    const length = Math.hypot(offsetX, offsetY);
    // 完全重叠时没有方向可推（与旧口径一致：站在一起的怪不会被「推」到自己身上）
    if (length <= 0.001) return;
    const duration = this.ai.pushDuration;
    runtime.pushDirX = offsetX / length;
    runtime.pushDirY = offsetY / length;
    runtime.pushSpeed = distance / (duration / 1000);
    runtime.pushStartAt = Date.now();
    runtime.pushEndAt = Date.now() + duration;
    runtime.pushedUntil = runtime.pushStartAt;
    // 击退打断手上的动作：硬直清零，落点后重新开始（下一次出手仍受普攻间隔约束）
    runtime.castEndAt = 0;
    runtime.movingNow = true;
  }

  /**
   * 把怪物朝施法者拉回来（#826 第三批：擒龙手这类「拉人」技能）
   *
   * 与 `applyPush` 共用同一套位移运行时（`pushDirX/Y` + `pushedUntil` 游标），只有方向相反：
   * 推是「怪 → 远离施法者」，拉是「怪 → 朝施法者」。共用而不是另开一套的理由 ——
   * 位移的执行与边界钳制（`slideMove` / `clampToMap`）已经在那里，再写一份必然漂移。
   *
   * **不会拉到重叠**：留 `PULL_STOP_GAP` 的间隔，超出的距离截掉。否则怪会叠在玩家身上，
   * 客户端画面上两个精灵完全重合并互相遮挡，看起来像「怪消失了」。
   * 被墙挡住时由 `slideMove` 原地卡住（与推同一行为：位移由服务端算，撞墙就停）。
   *
   * @returns 真正要移动的距离（像素）—— 已经贴到 `PULL_STOP_GAP` 内、或拿不到施法者
   *          位置时是 0。回执的 `pullDistance` 直接用它：**不要**把配置值发回客户端，
   *          配置 300 而实际只拉了 80 时，按下发数算落点会让客户端把怪画到墙里。
   */
  applyPull(instanceId: string, fromAccountId: string, distance: number): number {
    if (!(distance > 0)) return 0;
    const monster = this.world.find(instanceId);
    if (!monster || !monster.alive) return 0;
    const from = this.presence.positionOf(fromAccountId);
    if (!from) {
      this.logger.debug(`怪物 ${instanceId} 的拉人作废：施法者 ${fromAccountId} 没有可用的在场位置`);
      return 0;
    }
    const runtime = this.runtimeOf(monster);
    // 方向 = 怪 → 施法者（与推相反的符号）
    const offsetX = from.x - runtime.x;
    const offsetY = from.y - runtime.y;
    const length = Math.hypot(offsetX, offsetY);
    if (length <= 0.001) return 0;
    const actual = Math.min(distance, Math.max(0, length - PULL_STOP_GAP));
    if (actual <= 0) return 0;
    const duration = this.ai.pushDuration;
    runtime.pushDirX = offsetX / length;
    runtime.pushDirY = offsetY / length;
    runtime.pushSpeed = actual / (duration / 1000);
    runtime.pushStartAt = Date.now();
    runtime.pushEndAt = Date.now() + duration;
    runtime.pushedUntil = runtime.pushStartAt;
    // 被拉的人（怪）手上的动作打断：与推同一口径
    runtime.castEndAt = 0;
    runtime.movingNow = true;
    return actual;
  }

  /**
   * 怪物被击杀：AI 运行时作废（重生回出生点后按新的一轮游走重新开始，身上的状态一并清掉）；
   * 带击杀事件（#689，结算侧在奖励结算完后调用）时攒进待广播队列，
   * 同图观看者的下一拍 monster-ai 帧会带上 —— 死亡清场与掉落铺场的跨端演出全靠它。
   */
  onMonsterKilled(
    instanceId: string,
    kill?: {
      zoneId: number;
      mapId: string;
      /** 线（#809；不传按公共线 —— 结算侧拿得到 monster.slot，老调用点也能照旧） */
      slot?: string;
      accountId: string;
      x: number;
      y: number;
      drops: RealtimeDropEntry[];
    },
  ): void {
    const now = Date.now();
    for (const map of this.runtimes.values()) {
      const runtime = map.get(instanceId);
      // 它正在追人的话，这一死就是那次追击的结局（日志里否则会留下一条没有结束的追击）
      if (runtime?.target) this.logChaseEnd(runtime, runtime.target, "怪物被击杀", now, this.presence.positionOf(runtime.target));
      map.delete(instanceId);
    }
    if (!kill) return;
    const key = roomKey(kill.zoneId, kill.mapId, kill.slot ?? PUBLIC_SLOT);
    const list = this.pendingKills.get(key) ?? [];
    list.push({ i: instanceId, a: kill.accountId, x: kill.x, y: kill.y, dp: kill.drops });
    this.pendingKills.set(key, list);
  }

  /**

   * 一只怪此刻的模拟坐标（#665 实时地图监控用；没跑过 AI 的怪返回 null）
   *
   * 为什么监控要就地读它：`world_monsters.x/y` 是**出生点**（世界里唯一稳定的真相），
   * 而这只怪现在被拉到哪了只有 AI 运行时知道（`MonsterRuntime.x/y`，不落盘）。
   * 读不到 = 这只怪还没被 AI 驱动过（刚播种 / 图没人看），调用方退回出生点即可。
   *
   * 只读：不创建运行时（`runtimeOf` 会建，这里用 `findRuntime`），不然监控页一开
   * 就会替全图的怪把 AI 运行时建出来 —— 那是 AI tick 的活，不是观察者的副作用。
   */
  livePositionOf(instanceId: string): { x: number; y: number; moving: boolean } | null {
    const runtime = this.findRuntime(instanceId);
    if (!runtime) return null;
    return { x: runtime.x, y: runtime.y, moving: runtime.movingNow };
  }

  /**
   * 一间房里所有怪此刻的坐标与血量（#810：AOI 索引每拍刷新视线用）
   *
   * 返回内部 Map 本身（只读口径）：AOI 每 100ms 要把整间房的怪同步进格子索引，如果这里
   * 复制一份出来，就是「145 只 × 10Hz」的对象分配，纯属喂 GC。调用方承诺只读有两个理由：
   * ① 它只是拿去算格子与距离；② 真正改这些字段的是 AI tick 自己（同一个事件循环，
   * 不存在并发读写）。`ReadonlyMap` 在类型上把这条承诺写死。
   *
   * 死掉的怪不在里面（`killMonster` 会把运行时删掉）—— 需要「死亡中的怪」的一方
   * （AOI 发快照）应该回世界层取，那里有存活标记与重生倒计时。
   */
  liveRuntimesOf(roomId: string): ReadonlyMap<string, { x: number; y: number; hp: number; maxHp: number }> {
    return this.runtimes.get(roomId) ?? EMPTY_RUNTIMES;
  }

  //#endregion

  //#region 状态修正（#372：结算侧查询怪物身上的 buff）

  /**
   * 怪物当前受到的攻击倍率（多个状态连乘；没有状态 = 1）
   *
   * 与客户端 `BattleMath.collectStatusCombatModifiers` 同口径：越界 / 非数字忽略，
   * 到期立即不计入（惰性清理，不靠定时器）。
   */
  attackMultiplierOf(instanceId: string): number {
    return this.statusMultiplier(instanceId, "attackMultiplier");
  }

  /**
   * 怪物当前的防御倍率（玩家打它时乘在防御项上）
   *
   * `CombatSettlementService` 在算「攻击 - 防御」时取它 —— 没有这条，
   * 怪物放「硬化皮肤」就只是客户端动画。
   */
  defenseMultiplierOf(instanceId: string): number {
    return this.statusMultiplier(instanceId, "defenseMultiplier");
  }

  private statusMultiplier(instanceId: string, key: "attackMultiplier" | "defenseMultiplier"): number {
    const runtime = this.findRuntime(instanceId);
    if (!runtime || runtime.statuses.size === 0) return 1;
    this.refreshSkillCache(Date.now());
    let multiplier = 1;
    for (const entry of this.activeStatuses(runtime, Date.now())) {
      const value = parseCombatJson(entry.row.combat)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) multiplier *= value;
    }
    return multiplier;
  }

  /**
   * 怪物身上**当前生效**的状态（顺手剔掉已到期的行）
   *
   * 到期判定只在这里做一次：所有消费方（数值修正 / 控制 / 周期结算 / 自 buff 去重）
   * 都走它，谁也不会读到一条过期状态 —— 各判一次必然有一处忘记判（图标还在、控制还在）。
   */
  private activeStatuses(runtime: MonsterRuntime, now: number): Array<{ statusId: string; effect: MonsterStatusEffect; row: StatusRow }> {
    const list: Array<{ statusId: string; effect: MonsterStatusEffect; row: StatusRow }> = [];
    for (const [statusId, effect] of runtime.statuses) {
      if (effect.expiresAt <= now) {
        runtime.statuses.delete(statusId);
        continue;
      }
      const row = this.statusRows.get(statusId);
      // 状态行被删了（运营删配置）→ 当作不存在，同样剔掉：留着它只会在控制判据里
      // 变成一个「查不到 flags 所以永远不生效」的幽灵行
      if (!row) {
        runtime.statuses.delete(statusId);
        continue;
      }
      list.push({ statusId, effect, row });
    }
    return list;
  }

  /**
   * 给怪物挂一个状态（#826 第三批：玩家技能命中时由结算侧调用）
   *
   * 与角色侧 `RoleStatusService.apply` 同一套叠层口径：同 id 再加一层 → +1（封顶
   * `max_stacks`），**刷新到期**，到期按整层一起消失。`tickedAt` 只在第一次挂上时初始化，
   * 重复施加不重置 —— 否则每刷新一层就多结算一拍，五层 = 五倍伤害的错觉。
   *
   * @returns 挂上后的层数与持续时长；`null` = 怪物不在 / 已死 / 状态不存在 / 持续时间为 0
   *          （后者是配置错误，调用方**不要**静默当成已生效）
   */
  applyStatusToMonster(
    instanceId: string,
    statusId: string,
    sourceAccountId = "",
  ): { statusId: string; stacks: number; durationMs: number } | null {
    if (!statusId) return null;
    const monster = this.world.find(instanceId);
    if (!monster || !monster.alive) return null;
    this.refreshSkillCache(Date.now());
    const row = this.statusRows.get(statusId);
    if (!row) return null;
    const durationMs = Math.round((Number(row.duration) || 0) * 1000);
    if (!(durationMs > 0)) return null;

    const now = Date.now();
    const runtime = this.runtimeOf(monster);
    const previous = runtime.statuses.get(statusId);
    const maxStacks = Math.max(1, Math.floor(Number(row.max_stacks) || 1));
    const stacks = Math.min(maxStacks, Math.max(1, (previous?.stacks ?? 0) + 1));
    runtime.statuses.set(statusId, {
      expiresAt: now + durationMs,
      stacks,
      tickedAt: previous ? previous.tickedAt : now,
      // 施加者只在第一次记下：后续叠层的人是同一个人（同一发技能的连击），
      // 换人叠层时更新成新的施加者会让「谁烧死的」这件事在日志里来回跳
      sourceAccountId: sourceAccountId || previous?.sourceAccountId || "",
    });
    return { statusId, stacks, durationMs };
  }

  /**
   * 怪物此刻被控制成什么样（#826 第三批）
   *
   * 与角色侧 `RoleStatusService.controlOf` 同一套语义：`stun` 既禁移动也禁出手，
   * `root` 只禁移动，`silence` 只禁出手（怪物侧的「出手」= 技能 + 普攻）。
   */
  private controlOf(runtime: MonsterRuntime, now: number): { stunned: boolean; rooted: boolean; silenced: boolean } {
    let stunned = false;
    let rooted = false;
    let silenced = false;
    for (const entry of this.activeStatuses(runtime, now)) {
      const flags = parseControlFlagsJson(entry.row.control_flags);
      if (flags.stun) stunned = true;
      if (flags.root) rooted = true;
      if (flags.silence) silenced = true;
    }
    return { stunned, rooted: rooted || stunned, silenced: silenced || stunned };
  }

  /**
   * 周期状态结算（#826 第三批）：灼烧这类 DoT 打在怪身上
   *
   * 三条口径：
   * - **补拍**：按 `tickedAt` 算「过了几拍」，最多补 `MAX_MONSTER_CATCH_UP_TICKS` 拍 ——
   *   图没人看时 AI 冻结，回来一口气补十拍会把怪秒了；
   * - **不致死**：伤害夹到「至少留 1 血」。理由不是手感而是**归属**：掉落账本按 `castId`
   *   记账，而状态伤害发生在 tick 里、没有 settle 帧可发 —— 让它打死就只剩「地上有东西
   *   但客户端不知道 castId」的死账。最后一击必须有人打（重开条件：出现一条不依赖 settle
   *   帧的掉落下发通道）；
   * - **层数乘在总量上**：五层灼烧 = 五倍，不是「每拍扣五次」（后者 tickedAt 记不过来）。
   */
  private applyStatusTicks(runtime: MonsterRuntime, monster: WorldMonster, now: number): void {
    if (runtime.statuses.size === 0) return;
    const entries = this.activeStatuses(runtime, now);
    if (entries.length === 0) return;
    let total = 0;
    for (const entry of entries) {
      const interval = Math.max(0, Math.floor(Number(entry.row.tick_ms) || 0));
      if (interval <= 0) continue;
      const start = entry.effect.tickedAt > 0 ? entry.effect.tickedAt : now;
      const elapsed = now - start;
      if (elapsed < interval) continue;
      const ticks = Math.min(MAX_MONSTER_CATCH_UP_TICKS, Math.floor(elapsed / interval));
      if (ticks <= 0) continue;
      const effect = parseTickEffectJson(entry.row.tick_effect);
      const amount =
        ((Number(effect.hp) || 0) + Math.round(monster.maxHp * (Number(effect.hpPercent) || 0))) * ticks * entry.effect.stacks;
      entry.effect.tickedAt = start + ticks * interval;
      if (amount < 0) total += -amount;
    }
    if (total <= 0) return;
    // 留 1 血：见上面「不致死」那一条
    const damage = Math.min(Math.floor(total), Math.max(0, monster.hp - 1));
    if (damage <= 0) return;
    this.world.applyDamage(monster.instanceId, damage);
    runtime.hp = Math.max(1, monster.hp);
    this.logger.debug(`怪物 ${monster.instanceId}(${monster.monsterKey}) 被周期状态扣 ${damage} 血 → ${runtime.hp}/${monster.maxHp}`);
  }

  private findRuntime(instanceId: string): MonsterRuntime | undefined {
    for (const map of this.runtimes.values()) {
      const runtime = map.get(instanceId);
      if (runtime) return runtime;
    }
    return undefined;
  }

  //#endregion

  //#region tick：目标选择 → 移动/技能/普攻 → 攒事件

  private tick(): void {
    const now = Date.now();
    this.refreshSkillCache(now);
    const viewed = this.world.viewedRooms();
    const viewedKeys = new Set<string>();

    for (const room of viewed) {
      const key = room.roomId;
      viewedKeys.add(key);
      // 有人看：解除冻结（#857）。冻结期间什么都没推进，回来直接接着跑
      this.frozenAt.delete(key);
      let runtimes = this.runtimes.get(key);
      if (!runtimes) {
        runtimes = new Map<string, MonsterRuntime>();
        this.runtimes.set(key, runtimes);
      }
      // 这间房里「位置新鲜且活着」的玩家（AI 的目标候选）—— **只读在场表**（#855）：
      // 用的是仲裁之后被接受的坐标，伪造的 `pos` 帧在这里已经被挡掉了
      const players = this.presence.aiTargetsOn(room.roomId);
      const geometry = this.geometryOf(room.mapId);
      for (const monster of room.monsters.values()) {
        if (!monster.alive) {
          // 死了的怪没有运行时可言（重生回出生点后按新的一轮重新开始）
          runtimes.delete(monster.instanceId);
          continue;
        }
        const config = this.presentationByKey.get(monster.monsterKey);
        if (!config) continue;
        const runtime = this.runtimeOf(monster);
        // 血量抄一份到运行时（#670）：世界层是权威，AI 只读 —— 广播拿它判断「这一拍要不要发」
        runtime.hp = monster.hp;
        runtime.maxHp = monster.maxHp;
        this.stepMonster(runtime, monster, config, players, now, key, geometry);
      }
    }

    // 没人看的分域：**冻结**，不删（#857）。删掉运行时 = 下次进图按出生点重建，
    // buff 计时、击退游标、索敌目标全部作废 —— 反复进出图就成了免费回血回 buff。
    // 冻结够久（`FREEZE_RECYCLE_MS`）才回收：那时图里换了一批人，旧状态已经没有意义。
    for (const key of [...this.runtimes.keys()]) {
      if (viewedKeys.has(key)) continue;
      const since = this.frozenAt.get(key);
      if (since === undefined) {
        this.frozenAt.set(key, now);
        continue;
      }
      if (now - since < FREEZE_RECYCLE_MS) continue;
      this.runtimes.delete(key);
      this.frozenAt.delete(key);
      // 没人看的时候攒下的击杀事件没人需要（与冻结回收同一笔账）
      this.pendingKills.delete(key);
    }
  }

  /**
   * 推进一只怪（#853 起是一个显式状态机：`idle` / `chase` / `return`）
   *
   * 每一拍只走其中一条路：
   * 击退 → 施法硬直 → 回家 → 目标校验 → 脱战判定 → 索敌 → 出手/追击 → 待机游走
   */
  private stepMonster(
    runtime: MonsterRuntime,
    monster: WorldMonster,
    config: { aggressive: boolean; detectRange: number; moveSpeed: number },
    players: Array<{ accountId: string; x: number; y: number; hp: number; at: number }>,
    now: number,
    mapKey: string,
    geometry: WalkGeometry | null,
  ): void {
    // 周期状态（#826 第三批）：灼烧这类 DoT 按 `tick_ms` 结算，**与控制无关** ——
    // 被定住的目标照样在烧。放在最前面：击退 / 硬直 / 回家 / 被控那几条早退都不会漏掉它。
    this.applyStatusTicks(runtime, monster, now);

    // 击退优先于一切（#670）：期间只按击退方向位移，目标 / 技能 / 硬直都往后放 ——
    // 被推着的怪继续放技能会看起来像「飘着打人」，而且落点会与施法者的预期错开。
    //
    // 位移按「已推游标 → min(窗口尾, 本次 tick)」补齐（#826 第二批）：tick 粒度可能比
    // 击退时长粗（测试把 tick 拉到 1s，击退窗口只有 200ms）—— 原实现按整个 tick 算步长，
    // tick 落在窗口内会一次推出数倍于配置的距离，落在窗口外又一步不推，位移量全看运气。
    // 游标保证：无论 tick 几时落，窗口走完后总位移恒等于配置的击退距离，不重复不遗漏。
    if (runtime.pushedUntil < runtime.pushEndAt) {
      const upto = Math.min(runtime.pushEndAt, now);
      const advanceMs = upto - runtime.pushedUntil;
      if (advanceMs > 0) {
        const step = (runtime.pushSpeed * advanceMs) / 1000;
        // 击退也走碰撞（#854 / docs/27 E4）：被墙挡住就**原地不动**，不滑行 ——
        // 滑行会让「被推开」看起来像「自己绕开了」，而且推的方向是施法者决定的，
        // 怪没有资格替那一下选一条路。窗口照旧推进（这一下作废，不在墙前反复试）
        this.pushPoint(runtime, runtime.pushDirX * step, runtime.pushDirY * step, geometry);
        runtime.movingNow = true;
        runtime.pushedUntil = upto;
        if (runtime.pushedUntil >= runtime.pushEndAt) return; // 击退走完，本拍到此为止
      }
      if (now < runtime.pushEndAt) return; // 还在窗口内：不追不出手
    }

    // 控制（#826 第三批）：眩晕 = 既不能动也不能出手（用户口径：眩晕与麻痹都禁一切，
    // 只是来源与图标不同）；定身只禁移动；沉默只禁出手。
    // 放在击退之后（推是别人的动作，被推的位移该走完）、硬直与索敌之前 ——
    // 被控的怪不该在这几拍里「顺带」换个目标、或者自己溜达回家。
    const control = this.controlOf(runtime, now);
    if (control.stunned) {
      runtime.movingNow = false;
      return;
    }

    // 施法硬直：动作没播完之前既不移动也不出手（与客户端动作锁同一语义）。
    // 放在目标校验之前 —— 硬直期间不该因为目标丢失而中断这次释放的收尾。
    if (now < runtime.castEndAt) {
      runtime.movingNow = false;
      return;
    }

    // 回家（#853 E3）：脱战之后只朝出生点直线走，**不索敌、不接受新威胁**。
    // 放在目标校验之前 —— 这一段本来就没有目标可言，走完就结束这一拍
    if (runtime.state === "return") {
      // 定身期间不回家：否则被定住的怪会一边「不能动」一边飘回出生点
      if (control.rooted) {
        runtime.movingNow = false;
        return;
      }
      this.returnHome(runtime, monster, config, now, geometry);
      return;
    }

    // 目标校验：上报超时 / 换图 / 死亡都算丢失，**记恨也一并清掉**（#858）——
    // 「玩家跑开就永久记恨」等于被动怪锁死第一个打它的人，别人再也拉不走
    if (runtime.target) {
      const position = this.presence.positionOf(runtime.target);
      const fresh = !!position && position.hp > 0 && now - position.at <= this.posStaleMs();
      if (!fresh) {
        // 结束追击要能解释「为什么」：这四种成因在页面上是完全不同的故事。
        // 在场表按超时删条目（#855 之后它是唯一副本），所以「没有位置」有两种可能：
        // 人真离线了，还是只是这一阵没上报 —— 用在线存档区分，别把掉线的人说成超时
        const reason = position
          ? position.hp <= 0
            ? "目标倒下"
            : position.zoneId !== runtime.zoneId || position.mapId !== runtime.mapId
              ? "目标换图"
              : "位置上报超时"
          : this.roles.online(runtime.target)
            ? "位置上报超时"
            : "目标离线";
        this.endChase(runtime, runtime.target, reason, now, position);
      }
    }

    // 脱战（#853 E3）：目标还在，但已经被拉出牵引半径 —— 放弃并回家。
    // 判据放在出手之前：600px 外的目标连远程技能都不该摸到。
    if (runtime.target) {
      const target = this.presence.positionOf(runtime.target);
      if (target) {
        const leash = Math.hypot(target.x - runtime.x, target.y - runtime.y);
        if (leash > this.ai.leashRange) {
          this.endChase(runtime, runtime.target, `超出牵引范围（${this.ai.leashRange}px）`, now, target);
        }
      }
    }
    // 目标获取：主动怪发现检测范围内最近玩家；被动怪只认记恨的那个人
    if (!runtime.target) {
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const player of players) {
        if (!config.aggressive && runtime.provoked !== player.accountId) continue;
        // 出手连着失败过的人不再选（#856）：计数按「这只怪 + 这个人」存，
        // 别的怪爱追他是别人的事
        if ((runtime.failCounts.get(player.accountId) ?? 0) >= FAIL_LIMIT) continue;
        const distance = Math.hypot(player.x - runtime.x, player.y - runtime.y);
        if (distance <= config.detectRange && distance < bestDistance) {
          best = player.accountId;
          bestDistance = distance;
        }
      }
      if (best) {
        runtime.target = best;
        runtime.state = "chase";
        // 待机游走计时归零：追赶期间不再按停留点乱晃
        runtime.idleMoveEndAt = 0;
        runtime.detourTicks = 0;
        this.emitLog({
          type: "chase",
          at: now,
          phase: "start",
          zoneId: runtime.zoneId,
          mapId: runtime.mapId,
          instanceId: monster.instanceId,
          monsterKey: runtime.monsterKey,
          x: runtime.x,
          y: runtime.y,
          accountId: best,
          // 「主动怪看见人」与「被动怪挨打之后记恨」是两种不同的因果，日志里要分开
          reason: runtime.provoked === best ? "被打之后记恨" : "进入检测范围",
          distance: Math.round(bestDistance),
        });
      }
    }

    if (runtime.target) {
      const position = this.presence.positionOf(runtime.target);
      if (!position) return;
      const distance = Math.hypot(position.x - runtime.x, position.y - runtime.y);
      // 技能优先（#372）：进入战斗才有意义 —— 没有敌人时给自己上 buff 没有价值。
      // 沉默（#826 第三批）连技能带 buff 一起禁：`silence` 的字面含义就是「放不出技能」，
      // 只禁伤害型会让「沉默」在怪物身上变成只影响一半的半个状态
      if (!control.silenced && this.tryCast(runtime, monster, distance, now, mapKey)) return;
      // 技能尝试里可能已经把目标作废了（结算不出来 → `forgetTarget`）：这一拍的追击与普攻
      // 都跟着作废，否则会拿一个 null 目标去结算（`attack` 的入参是 string）
      const chasing = runtime.target;
      if (!chasing) return;
      if (distance <= this.ai.attackRange) {
        // 站定出手：按普攻间隔结算一次
        runtime.movingNow = false;
        if (now >= runtime.nextAttackAt) {
          runtime.nextAttackAt = now + this.ai.attackInterval;
          const hit = this.attack(monster, chasing);
          if (hit) {
            // 打得动：这一个目标的失败账本清零
            runtime.failCounts.delete(chasing);
            this.pushHit(mapKey, hit);
            // 普攻命中：一行「谁被打了多少」（技能命中走 cast，别在这里重复记两条）
            this.emitLog({
              type: "hit",
              at: now,
              zoneId: runtime.zoneId,
              mapId: runtime.mapId,
              instanceId: monster.instanceId,
              monsterKey: runtime.monsterKey,
              x: runtime.x,
              y: runtime.y,
              accountId: chasing,
              damage: hit.d,
              hp: hit.hp,
              maxHp: hit.m,
            });
          } else {
            this.forgetTarget(runtime, chasing, now, this.presence.positionOf(chasing));
          }
        }
        return;
      }
      // 追击：直线趋近 + 碰撞滑行（#854，不做寻路）。定身（#826 第三批）原地不动，
      // 但**照常站着打**——定身只禁移动，禁出手的是眩晕与沉默
      if (control.rooted) {
        runtime.movingNow = false;
        return;
      }
      this.stepToward(runtime, position.x, position.y, config.moveSpeed, geometry, now);
      return;
    }

    // 没目标：待机游走（停留点 + 活动半径，与客户端 stayIdle / wanderStep 同口径）
    if (now >= runtime.nextIdleMoveAt && runtime.idleMoveEndAt <= now) {
      runtime.nextIdleMoveAt = now + randomBetween(this.ai.idleMoveInterval);
      runtime.idleMoveEndAt = now + randomBetween(this.ai.idleMoveDuration);
      const offsetX = runtime.x - runtime.anchorX;
      const offsetY = runtime.y - runtime.anchorY;
      const fromAnchor = Math.hypot(offsetX, offsetY);
      if (fromAnchor > this.ai.wanderRadius) {
        // 离停留点超过活动半径：往回走
        runtime.idleMoveDirectionX = -offsetX / fromAnchor;
        runtime.idleMoveDirectionY = -offsetY / fromAnchor;
      } else {
        const angle = Math.random() * Math.PI * 2;
        runtime.idleMoveDirectionX = Math.cos(angle);
        runtime.idleMoveDirectionY = Math.sin(angle);
      }
      // 新的游走方向 = 新的一次机会：上一轮卡住的账本清零
      runtime.stuckFrames = 0;
      runtime.stuckTurns = 0;
      runtime.detourTicks = 0;
    }
    if (runtime.idleMoveEndAt > now && !control.rooted) {
      const speed = config.moveSpeed * this.ai.idleMoveSpeedScale;
      this.stepAlong(runtime, runtime.idleMoveDirectionX, runtime.idleMoveDirectionY, (speed * this.tickMs()) / 1000, geometry, now);
    } else {
      // 定身期间待机游走同样不推进（但计时照旧流逝：解除控制后重新掷一次方向，
      // 而不是把「被定住的这 3 秒」补成一次突然的长距离位移）
      runtime.movingNow = false;
    }
  }

  /**
   * 回家（#853 E3）
   *
   * 到达判定用 `HOME_ARRIVE_PX`；超时（`returnTimeoutMs`，默认 20 秒）还没到就**吸附**到出生点 ——
   * 被地形挡住、或者出生点本身就落在碰撞盒里（运营画刷怪区时没对齐）都会让直线回家永远走不到，
   * 不吸附的话这只怪会永久卡在半路，既不打人也不回巢。
   */
  private returnHome(
    runtime: MonsterRuntime,
    monster: WorldMonster,
    config: { moveSpeed: number },
    now: number,
    geometry: WalkGeometry | null,
  ): void {
    if (runtime.returningSince > 0 && now - runtime.returningSince > this.ai.returnTimeoutMs) {
      runtime.x = monster.x;
      runtime.y = monster.y;
      this.arriveHome(runtime, monster, now);
      return;
    }
    if (Math.hypot(monster.x - runtime.x, monster.y - runtime.y) <= HOME_ARRIVE_PX) {
      this.arriveHome(runtime, monster, now);
      return;
    }
    this.stepToward(runtime, monster.x, monster.y, config.moveSpeed * this.ai.returnSpeedRate, geometry, now);
  }

  /** 到家：回到待机（停留点重新锚在出生点，游走计时重掷） */
  private arriveHome(runtime: MonsterRuntime, monster: WorldMonster, now: number): void {
    runtime.state = "idle";
    runtime.returningSince = 0;
    runtime.anchorX = monster.x;
    runtime.anchorY = monster.y;
    runtime.idleMoveEndAt = 0;
    runtime.nextIdleMoveAt = now + randomBetween(this.ai.idleMoveInterval);
    runtime.movingNow = false;
    runtime.stuckFrames = 0;
    runtime.stuckTurns = 0;
    runtime.detourTicks = 0;
  }

  //#endregion

  //#region 移动与碰撞（#854 / docs/27 E4）

  /**
   * 朝一个点走一步（追击 / 回家共用）
   *
   * 到点了就只把移动标记放下 —— 距离为 0 时除以它会得到 NaN，那是能让整只怪从图上消失的写法。
   */
  private stepToward(
    runtime: MonsterRuntime,
    targetX: number,
    targetY: number,
    speed: number,
    geometry: WalkGeometry | null,
    now: number,
  ): void {
    const offsetX = targetX - runtime.x;
    const offsetY = targetY - runtime.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance <= 0.01) {
      runtime.movingNow = false;
      return;
    }
    // 一步不跨过目标点（否则会在目标两侧来回跳）
    const step = Math.min(distance, Math.max(0, (speed * this.tickMs()) / 1000));
    this.stepAlong(runtime, offsetX / distance, offsetY / distance, step, geometry, now);
  }

  /**
   * 沿一个单位方向走 `step` 像素，并做卡住判定
   *
   * 卡住判定的口径是**实际位移**（不是「想走的距离」）：贴着墙走的时候想走的距离永远正常，
   * 实际位移才是 0。连续 `STUCK_FRAMES` 帧一步都没动 → 换切线 ±60° 试 `DETOUR_TICKS` 帧，
   * 两次都不行就停在这里待机（`docs/27` E4：不许抽搐，也不许原地空转烧 CPU）。
   * 「没动」的门槛是浮点误差级（0.01px），不是 1px —— 见下面那行注释。
   */
  private stepAlong(
    runtime: MonsterRuntime,
    dirX: number,
    dirY: number,
    step: number,
    geometry: WalkGeometry | null,
    now: number,
  ): void {
    // 卡住后正在走切线：方向换成切线方向，帧数走完自动放掉
    const detouring = runtime.detourTicks > 0;
    const useX = detouring ? runtime.detourDirX : dirX;
    const useY = detouring ? runtime.detourDirY : dirY;
    if (detouring) runtime.detourTicks -= 1;

    const moved = this.slideMove(runtime, useX * step, useY * step, geometry);
    // 「动了」的绝对下限只能是浮点误差级（0.01px），**不能拿 1px 当门槛**：
    // 出厂 `monster_presentation.move_speed` 是个位数（2px/s 的怪每帧只走 0.1px），
    // 1px 的绝对门槛会把所有慢速怪都判成「卡住」—— 它们既不报 moving（客户端不播走路），
    // 还会在 3 帧后开始无意义地拐弯。真正被墙挡住的怪 `slideMove` 返回的是 0。
    if (moved >= 0.01) {
      runtime.movingNow = true;
      runtime.stuckFrames = 0;
      if (!detouring) runtime.stuckTurns = 0;
      return;
    }
    runtime.movingNow = false;
    // 切线还没走完就先不计数：换方向之后的头几帧本来就可能是原地打转
    if (detouring) return;
    runtime.stuckFrames += 1;
    if (runtime.stuckFrames < STUCK_FRAMES) return;
    runtime.stuckFrames = 0;
    if (runtime.stuckTurns >= STUCK_TURNS) {
      // 两条切线都不通：停在这里待机，等下一轮 idle 计时换个方向
      runtime.idleMoveEndAt = 0;
      runtime.nextIdleMoveAt = now + randomBetween(this.ai.idleMoveInterval);
      runtime.stuckTurns = 0;
      return;
    }
    // 换切线：第一次 +60°，第二次 −60°（左右各试一次，只往一边拐会一直贴着同一面墙）
    runtime.stuckTurns += 1;
    const signed = runtime.stuckTurns % 2 === 1 ? DETOUR_ANGLE : -DETOUR_ANGLE;
    const cos = Math.cos(signed);
    const sin = Math.sin(signed);
    runtime.detourDirX = dirX * cos - dirY * sin;
    runtime.detourDirY = dirX * sin + dirY * cos;
    runtime.detourTicks = DETOUR_TICKS;
  }

  /**
   * 一次带碰撞的位移（#854）
   *
   * @returns 实际位移（像素）
   *
   * 三档退让：整步走得通就走；撞墙则拆成两个分量各试一次（走通的那个照走 = **滑行**，
   * 撞墙保留平行分量）；都不通就原地不动，交给卡住判定换切线。
   *
   * 为什么是滑行而不是「撞了就停」：撞停会让怪卡在墙角抽搐，滑行看起来像「贴着墙追」——
   * CPU 最省、观感最不难看的做法（docs/27 E4）。**不做 A\***：一张图十几个矩形，
   * 直线 + 滑行已经够用。
   *
   * 最后一律钳进图内（`clampToMap`）：墙画在图外，被击退出图之后世界坐标里没有「图外」，
   * 客户端也不会渲染 —— 不钳就是永久消失。
   */
  private slideMove(runtime: MonsterRuntime, dx: number, dy: number, geometry: WalkGeometry | null): number {
    if (geometry === null) {
      // 没有几何（导入工具没跑）：不判碰撞也不钳边界，退回「直接改坐标」的老行为
      runtime.x += dx;
      runtime.y += dy;
      return Math.hypot(dx, dy);
    }
    const fromX = runtime.x;
    const fromY = runtime.y;
    if (!this.blockedIn(runtime.x + dx, runtime.y + dy, geometry)) {
      runtime.x += dx;
      runtime.y += dy;
    } else {
      // 先试位移更大的那个分量（它是「主方向」），再试另一个
      const order: Array<[number, number]> = Math.abs(dx) >= Math.abs(dy)
        ? [[dx, 0], [0, dy]]
        : [[0, dy], [dx, 0]];
      let slid = false;
      for (const [stepX, stepY] of order) {
        if (stepX === 0 && stepY === 0) continue;
        if (this.blockedIn(runtime.x + stepX, runtime.y + stepY, geometry)) continue;
        runtime.x += stepX;
        runtime.y += stepY;
        slid = true;
        break;
      }
      if (!slid) return 0;
    }
    this.clampToMap(runtime, geometry);
    // 钳完还在盒里（外墙就画在图边）→ 这一小步等于撞进墙，整步作废。
    // 单帧位移只有 0.1~6px，退回原地不会让「贴墙走」变成抽搐
    if (this.blockedIn(runtime.x, runtime.y, geometry)) {
      runtime.x = fromX;
      runtime.y = fromY;
      return 0;
    }
    return Math.hypot(runtime.x - fromX, runtime.y - fromY);
  }

  /**
   * 击退位移（#854）：被挡就**原地不动**，不做滑行
   *
   * 「被挡」包括「被地图边界挡住」：先钳再判 —— 外墙通常就画在图边（`cx = 0, w = 128`），
   * 钳到 `x = 0` 的落点正好在墙里，直接落上去等于被撞进墙。钳完还在盒里就整次作废。
   */
  private pushPoint(runtime: MonsterRuntime, dx: number, dy: number, geometry: WalkGeometry | null): void {
    if (geometry === null) {
      runtime.x += dx;
      runtime.y += dy;
      return;
    }
    const targetX = Math.min(geometry.width, Math.max(0, runtime.x + dx));
    const targetY = Math.min(0, Math.max(-geometry.height, runtime.y + dy));
    if (this.blockedIn(targetX, targetY, geometry)) return;
    runtime.x = targetX;
    runtime.y = targetY;
  }

  /** 这个点在不在某个碰撞矩形里（`map_collisions` 的矩形：中心 + 宽高） */
  private blockedIn(x: number, y: number, geometry: WalkGeometry): boolean {
    for (const box of geometry.boxes) {
      if (Math.abs(x - box.cx) <= box.w / 2 && Math.abs(y - box.cy) <= box.h / 2) return true;
    }
    return false;
  }

  /** 钳进图内：`x ∈ [0, width]`、`y ∈ [-height, 0]`（左上角原点、y 轴向上） */
  private clampToMap(runtime: MonsterRuntime, geometry: WalkGeometry): void {
    runtime.x = Math.min(geometry.width, Math.max(0, runtime.x));
    runtime.y = Math.min(0, Math.max(-geometry.height, runtime.y));
  }

  /** 一张图的可行走几何（5 秒 TTL；读库失败按「不判碰撞」处理，不中断 AI） */
  private geometryOf(mapId: string): WalkGeometry | null {
    const now = Date.now();
    const cached = this.geometryCache.get(mapId);
    if (cached && now - cached.at < GEOMETRY_CACHE_TTL_MS) return cached.geo;
    let geo: WalkGeometry | null = null;
    try {
      geo = this.maps.walkGeometryOf(mapId);
    } catch (error) {
      this.logger.warn(`读取地图 ${mapId} 的可行走几何失败（本轮不判碰撞）：${error instanceof Error ? error.message : String(error)}`);
    }
    this.geometryCache.set(mapId, { at: now, geo });
    return geo;
  }

  //#endregion

  //#endregion

  //#region 技能释放（#372）

  /**
   * 尝试放一个技能：按缓存里的顺序取第一个可用的
   *
   * 顺序在缓存构建时就排好了（状态型优先 + priority 升序 + id 稳定），这里只做四道判断：
   * 冷却、距离（仅伤害型）、状态是否已在身上、技能是否仍然有效（缓存里已经没有它了就跳过）。
   * 全都不满足返回 false，调用方回落到普攻。
   */
  private tryCast(runtime: MonsterRuntime, monster: WorldMonster, distance: number, now: number, mapKey: string): boolean {
    const plans = this.skillPlans.get(monster.monsterKey);
    if (!plans || plans.length === 0) return false;
    for (const plan of plans) {
      if (now < (runtime.skillReadyAt.get(plan.skillId) ?? 0)) continue;
      // 伤害型要够得着；状态型不看距离（追击路上也能给自己上 buff）
      if (plan.category === "0" && distance > Math.max(plan.distance, this.ai.attackRange)) continue;
      // 状态型：这个状态还在身上就不重复放。过期那一条顺手剔掉 —— 不剔的话
      // `has()` 会一直为真，怪物就再也不给自己补 buff 了（到期行没人读时不会自己消失）
      if (plan.category === "2") {
        const existing = runtime.statuses.get(plan.statusId);
        if (existing && existing.expiresAt > now) continue;
        if (existing) runtime.statuses.delete(plan.statusId);
      }
      if (this.castSkill(runtime, monster, plan, now, mapKey)) return true;
      // 释放失败只可能是「目标刚倒下了」（见 castSkill）：目标已经丢掉，这一拍不会再放
      // 任何需要目标的技能，直接回落到「没有目标」的分支
      if (!runtime.target) return false;
    }
    return false;
  }

  /**
   * 释放一次技能
   *
   * 伤害型：按倍率算一次伤害，命中事件照旧走 `hits`（客户端只演数字）；
   * 状态型：给自己挂状态（同状态重复获得 = 刷新到期时间，不叠层），不发命中事件。
   * 两种都发 `casts`（客户端据此播动作 + 特效）。
   *
   * **伤害型先结算再落账**（#670）：结算不出来（目标已经倒下 / 不在线）就整次释放作废 ——
   * 冷却不消耗、硬直不进入、`casts` 不发。原来的顺序是先记冷却与硬直、再把 casts 塞进队列，
   * 命中与否都发：目标已经倒在地上，客户端还在播「怪物对着尸体放技能」，两边都停不下来。
   *
   * @returns 是否真的放出来了（false = 这次尝试作废，调用方不该当它放过了）
   */
  private castSkill(runtime: MonsterRuntime, monster: WorldMonster, plan: CastPlan, now: number, mapKey: string): boolean {
    let hit: RealtimeMonsterHit | null = null;
    /** 这一发打的是谁（状态要挂到他身上，所以先取出来 —— attack 之后 runtime.target 可能被清） */
    const victim = runtime.target;
    if (plan.category !== "2") {
      if (!victim) return false;
      hit = this.attack(monster, victim, plan.rate, plan.baseType);
      if (!hit) {
        this.forgetTarget(runtime, victim, now, this.presence.positionOf(victim));
        return false;
      }
    }

    runtime.movingNow = false;
    runtime.skillReadyAt.set(plan.skillId, now + plan.cooldown * 1000);
    // 硬直：配置值优先；0 回落到普攻动作时长（服务端不知道客户端动画有多长）
    runtime.castEndAt = now + (plan.castLockMs > 0 ? plan.castLockMs : this.ai.attackActionTime);
    // 普攻与施法共用同一个出手窗口：技能放完不会立刻接一记普攻
    runtime.nextAttackAt = Math.max(runtime.nextAttackAt, now + this.ai.attackInterval);

    const cast: RealtimeMonsterCast = { i: monster.instanceId, s: plan.skillId };
    if (plan.category === "2") {
      // 自己上 buff：走统一的挂状态入口（叠层 / 刷新到期 / tickedAt 三件事只写一份）
      this.applyStatusToMonster(monster.instanceId, plan.statusId);
      cast.st = plan.statusId;
    } else if (hit && victim && plan.statusId) {
      // 伤害型技能顺带挂状态（#826 第三批）：眩晕 / 麻痹 / 灼烧是「怪打人」这一侧的效果，
      // 落在**被打的玩家**身上（角色状态有落库 + 每秒结算，怪物侧只有进程内记账）。
      // 挂不上（配置里没这个状态 / 持续时间 0）就只当这一发是纯伤害 —— 配置错误由
      // 管理端的状态页看得见，不该让 AI 每 tick 刷一条日志。
      const pushed = this.roles.applyStatusToOnlineRole(victim, plan.statusId, plan.skillId);
      if (pushed) {
        cast.st = plan.statusId;
        // 整份快照推给本人：不推的话他要等到下一次出手被 `stunned` 拒了才知道自己被控
        this.onStatuses?.(victim, pushed);
      }
    }
    const list = this.pendingCasts.get(mapKey) ?? [];
    list.push(cast);
    this.pendingCasts.set(mapKey, list);
    if (hit) this.pushHit(mapKey, hit);
    // 技能释放入日志（#745）：带技能名与这一下的伤害 —— 页面「怪物放了什么、打掉多少血」
    this.emitLog({
      type: "cast",
      at: now,
      zoneId: runtime.zoneId,
      mapId: runtime.mapId,
      instanceId: monster.instanceId,
      monsterKey: runtime.monsterKey,
      x: runtime.x,
      y: runtime.y,
      accountId: runtime.target ?? "",
      skillId: plan.skillId,
      skillLabel: plan.label,
      damage: hit?.d ?? 0,
      hp: hit?.hp ?? 0,
      maxHp: hit?.m ?? 0,
    });
    this.logger.debug(
      `怪物 ${monster.instanceId}(${monster.monsterKey}) 释放技能 ${plan.skillId}（${plan.category === "2" ? `状态 ${plan.statusId}` : `伤害倍率 ${plan.rate}`}）`,
    );
    return true;
  }

  //#endregion

  //#region 伤害

  /**
   * 结算一次出手（普攻或伤害型技能）
   *
   * 伤害 = round(怪物「该项攻击」区间随机值 × 攻击倍率 × 技能倍率 − 玩家「该项防御」区间随机值 × 防御倍率)，
   * 下限 0，再过一道格挡（#822）。怪物侧攻击倍率来自它自己的状态（#372）；玩家侧防御倍率与格挡
   * 来自 `role_status`（护体神盾 30% 格挡减半、金刚护体防御 ×1.5）—— 两边同一套 `combat` 口径。
   *
   * **物法分离（#823 / docs/22 A6）**：`baseType` 决定读怪物的哪一项攻击（`physical_attack` /
   * `magic_attack` / `taoist_attack`）与玩家的哪一项防御（`physicalDefense` / `magicDefense` /
   * `taoistDefense`）。普攻没有技能系数 → 恒物理。映射表在 `game-enums`，与玩家打怪那份同一张。
   *
   * @returns null = 这一下打不出去（玩家已经倒下 / 不在线，或怪物缺数值行）。
   *          调用方**必须**把它当成「目标作废」处理（见 `forgetTarget`）—— 只当成本次落空会让
   *          记恨一直挂着，怪继续对尸体出手（#670）。
   */
  private attack(monster: WorldMonster, accountId: string, rate = 1, baseType: string = "physicalAttack"): RealtimeMonsterHit | null {
    const role = this.roles.online(accountId);
    if (!role) return null;
    const stats = this.monsterConfigs.findByKey(monster.monsterKey);
    if (!stats) return null;
    // RoleDto 要摊平（装备/成长线在 data 里），否则玩家的防御只剩等级那一档
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data));
    // 玩家身上的状态（#822）：防御倍率乘在防御项上，格挡在算完之后掷一次
    const modifiers = this.roles.statusModifiersOf(accountId);
    const attack = rollRange(monsterAttackRange(stats, baseType)) * this.attackMultiplierOf(monster.instanceId);
    const defenseKey = DEFENSE_BY_ATTACK[baseType] ?? "physicalDefense";
    const defenseRange = summary ? (summary[defenseKey as keyof typeof summary] as [number, number]) : null;
    const defense = Math.round((defenseRange ? rollRange(defenseRange) : 0) * modifiers.defenseMultiplier);
    // 格挡的随机数在这里掷（`resolveIncomingDamage` 是纯函数，e2e 才敢按固定 roll 断言）
    const resolved = resolveIncomingDamage(Math.max(0, Math.round(attack * rate - defense)), modifiers, Math.random());
    const damage = resolved.damage;
    const applied = this.roles.applyMonsterHit(accountId, damage);
    if (!applied) return null;
    // 权威血量回填到在场表（#855）：AI 与互见帧都只读那一份 —— 不写的话，
    // 打到 0 血之后还要等客户端下一帧上报，中间几拍会继续对着尸体出手（#670 复发）
    this.presence.markHp(accountId, applied.hp);
    return {
      i: monster.instanceId,
      a: accountId,
      d: damage,
      hp: applied.hp,
      m: applied.maxHp,
      ...(resolved.blocked ? { bl: true } : {}),
    };
  }

  private pushHit(mapKey: string, hit: RealtimeMonsterHit): void {
    const list = this.pendingHits.get(mapKey) ?? [];
    list.push(hit);
    this.pendingHits.set(mapKey, list);
  }

  /**
   * 丢一个「已经打不了」的目标（#670 的根因；#856 收窄到这一只怪）
   *
   * `RolesService.applyMonsterHit` 在**玩家已经倒下**或**不在线**时返回 null，而 AI 原来只把
   * 它当「这一下落空」：记恨不清、下一拍继续放技能，客户端于是看见一只怪对着尸体连放技能
   * （服务端返回 null，AI 不知道）。
   *
   * 旧实现把「全图所有盯着他的怪」一起清了，还顺手删掉位置缓存 —— 于是一个玩家的单点结算
   * 失败会让**整张图的怪同时掉头**（玩家看到的是集体脱战）。现在只清**这只怪**这一条目标，
   * 并在它自己身上记一次失败；别的怪各自在真的打不动时才发现。
   *
   * 位置不再需要「删缓存」：在场表里血量会被 `markHp` 同步成权威值（0），`aiTargetsOn`
   * 直接把尸体过滤掉，不会又被选回来（#855）。
   */
  private forgetTarget(
    runtime: MonsterRuntime,
    accountId: string,
    now: number,
    position: { x: number; y: number } | null,
  ): void {
    const fails = (runtime.failCounts.get(accountId) ?? 0) + 1;
    runtime.failCounts.set(accountId, fails);
    if (fails >= FAIL_LIMIT && runtime.provoked === accountId) {
      // 连着几次都结算不出来 = 这个人现在真打不了：连记恨一起放下，
      // 否则被动怪会一直盯着一个打不动的目标（#858 的另一半）
      runtime.provoked = null;
    }
    this.endChase(runtime, accountId, "目标倒下或不在线（出手结算不出来）", now, position);
  }

  /**
   * 结束一次追击（#853 / #858 的唯一收口）
   *
   * 三件事必须一起做，缺一条就复发：
   * - 清目标（不然下一拍继续对着他已经打不了一帧）；
   * - 清记恨（#858：`provoked` 原来只写不清，被动怪永久锁死第一个打它的人）；
   * - 转「回家」（#853：只清目标的话，怪会停在玩家把它拉到的位置继续游走，
   *   下一个人过来看到的是一只离出生点半张图的怪）。
   */
  private endChase(
    runtime: MonsterRuntime,
    accountId: string,
    reason: string,
    now: number,
    position: { x: number; y: number } | null,
  ): void {
    this.logChaseEnd(runtime, accountId, reason, now, position);
    runtime.target = null;
    runtime.provoked = null;
    runtime.state = "return";
    runtime.returningSince = now;
    runtime.detourTicks = 0;
    runtime.stuckFrames = 0;
    runtime.stuckTurns = 0;
  }

  //#endregion

  //#region 日志出口（#745：实时地图监控）

  /**
   * 记一次「结束追击」
   *
   * 结束时的距离按**最后已知位置**算（目标可能已经下线，位置缓存为空 → 0）：
   * 「0」在读日志时明确表示「不知道他跑多远了」，不是「贴在一起」。
   */
  private logChaseEnd(
    runtime: MonsterRuntime,
    accountId: string,
    reason: string,
    now: number,
    position: { x: number; y: number } | null,
  ): void {
    this.emitLog({
      type: "chase",
      at: now,
      phase: "end",
      zoneId: runtime.zoneId,
      mapId: runtime.mapId,
      instanceId: runtime.instanceId,
      monsterKey: runtime.monsterKey,
      x: runtime.x,
      y: runtime.y,
      accountId,
      reason,
      distance: position ? Math.round(Math.hypot(position.x - runtime.x, position.y - runtime.y)) : 0,
    });
  }

  /** 把事件交给接线方（没接线 = 没人听；监听方抛错绝不能打断 AI tick） */
  private emitLog(event: MonsterAiLogEvent): void {
    if (!this.onLog) return;
    try {
      this.onLog(event);
    } catch (error) {
      this.logger.warn(`监控日志写入失败（${event.type}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  //#endregion

  //#region 广播：只发有变化的怪 + 攒下的命中与技能释放

  private broadcast(): void {
    if (this.onBroadcast === null && this.pendingHits.size === 0 && this.pendingCasts.size === 0 && this.pendingKills.size === 0) return;
    for (const [key, runtimes] of this.runtimes) {
      // key 是房号（`<zone>:<map>:<slot>`）：帧里仍然只带 `mapId`（客户端只认图），
      // 分线之后要区分「哪条线的怪」得加字段 —— 那是第④刀与协议一起改的事
      const mapId = splitRoomKey(key).mapId;
      const hits = this.pendingHits.get(key) ?? [];
      this.pendingHits.delete(key);
      const casts = this.pendingCasts.get(key) ?? [];
      this.pendingCasts.delete(key);
      const kills = this.pendingKills.get(key) ?? [];
      this.pendingKills.delete(key);
      const monsters: RealtimeMonsterAiEntry[] = [];
      for (const [instanceId, runtime] of runtimes) {
        const moved = Math.abs(runtime.x - runtime.sentX) > 0.01 || Math.abs(runtime.y - runtime.sentY) > 0.01;
        const turn = runtime.movingNow !== runtime.sentMoving;
        // 血量也是「有变化」（#670）：站着不动的怪被别人打了一下，也该让所有人看见血条掉
        const hurt = runtime.hp !== runtime.sentHp;
        if (!moved && !turn && !hurt) continue;
        monsters.push({
          i: instanceId,
          // #768 坐标整数化：广播出整数像素（模拟内部仍是浮点，只省线上字节）
          x: Math.round(runtime.x),
          y: Math.round(runtime.y),
          mv: runtime.movingNow,
          hp: runtime.hp,
          m: runtime.maxHp,
        });
        runtime.sentX = runtime.x;
        runtime.sentY = runtime.y;
        runtime.sentMoving = runtime.movingNow;
        runtime.sentHp = runtime.hp;
      }
      if (monsters.length === 0 && hits.length === 0 && casts.length === 0 && kills.length === 0) continue;
      this.onBroadcast?.(key, { mapId, monsters, hits, casts, kills });
    }
  }

  //#endregion

  //#region 配置缓存（#372 技能 / #655 怪物表现与 AI 参数：都读库，1 秒 TTL）

  /**
   * 加载配置快照（TTL 内直接返回）：技能 / 状态 / 挂载 + 怪物表现 + AI 参数
   *
   * 五张表都不大（技能 15 / 挂载若干 / 表现 220 行 / 参数 1 行），但 AI 每 tick 每只怪
   * 都要用它们 —— 1 秒 TTL 让「管理端改完最多 1 秒生效」，同时把查询成本压到可忽略。
   *
   * 技能顺序在构建时完成：**状态型整体先于伤害型**（buff 先上），同类型按 priority 升序，
   * 再按技能 id 兜底 —— 保证「同一只怪两轮 tick 里放技能的次序」是确定的。
   */
  private refreshSkillCache(now: number): void {
    if (now - this.skillCacheLoadedAt < SKILL_CACHE_TTL_MS) return;
    this.skillCacheLoadedAt = now;

    const presentation = new Map<string, MonsterAiConfig>();
    for (const row of this.presentationRepo.listAll()) {
      presentation.set(row.id, {
        aggressive: Number(row.aggressive) === 1,
        detectRange: Number(row.detect_range) || 0,
        moveSpeed: Number(row.move_speed) || 0,
      });
    }
    this.presentationByKey = presentation;
    this.ai = this.readAiParams();

    const skills = new Map<string, SkillRow>();
    for (const row of this.skillsRepo.listAll()) skills.set(row.id, row);
    const statuses = new Map<string, StatusRow>();
    for (const row of this.statusesRepo.listAll()) statuses.set(row.id, row);
    this.statusRows = statuses;

    const plans = new Map<string, CastPlan[]>();
    for (const mount of this.monsterSkillsRepo.listAll()) {
      const skill = skills.get(mount.skill_id);
      // 被删掉的技能（挂载行还在）在这里自然跳过：管理端删技能前会拒删被引用的，
      // 但两个进程之间仍有极小的窗口（删技能与挂载替换并发），跳过比抛错安全
      if (!skill || skill.owner !== "monster") continue;
      const plan = buildCastPlan(skill, mount.priority, mount.cooldown, statuses.get(skill.status_id));
      if (!plan) continue;
      // 法/道攻打 0 = 运营还没给这只怪配该项数值（#823 拍板口径）：伤害会恒 0，
      // 放出来只会让玩家看到「怪放了个法术、我一点血没掉」。跳过并 warn 一次，
      // 该怪回落到普攻；等运营把数值配上去，下一次缓存重建就自动恢复。
      if (plan.category === "0" && !hasAttackFor(this.monsterConfigs.findByKey(mount.monster_key), plan.baseType)) {
        const ticket = `${mount.monster_key}:${plan.skillId}`;
        if (!this.warnedNoAttack.has(ticket)) {
          this.warnedNoAttack.add(ticket);
          this.logger.warn(
            `怪物 ${mount.monster_key} 的技能 ${plan.skillId}（${plan.label}）按 ${plan.baseType} 结算，但该项攻击配成 0 —— 已跳过该技能（回落到普攻）`,
          );
        }
        continue;
      }
      const list = plans.get(mount.monster_key) ?? [];
      list.push(plan);
      plans.set(mount.monster_key, list);
    }
    for (const list of plans.values()) {
      list.sort((a, b) => (a.category === "2" ? 0 : 1) - (b.category === "2" ? 0 : 1) || a.priority - b.priority || a.skillId.localeCompare(b.skillId));
    }
    this.skillPlans = plans;
  }

  /**
   * 读 `runtime_params.monster_ai` 这一列（JSON）
   *
   * 缺列 / 坏 JSON / 缺键都退回 `FALLBACK_AI` 并 warn 一次：这一组值直接乘在
   * 「怪物每秒走多远、多久打一下」上，取 0 会让战斗彻底失衡。
   */
  private readAiParams(): MonsterAiParams {
    const raw = this.runtimeParamsRepo.get()?.monster_ai;
    const parsed = parseJsonObject(raw);
    const next: MonsterAiParams = {
      attackInterval: positiveOr(parsed?.attackInterval, FALLBACK_AI.attackInterval),
      attackRange: positiveOr(parsed?.attackRange, FALLBACK_AI.attackRange),
      attackActionTime: positiveOr(parsed?.attackActionTime, FALLBACK_AI.attackActionTime),
      pushDuration: positiveOr(parsed?.pushDuration, FALLBACK_AI.pushDuration),
      idleMoveInterval: rangeOr(parsed?.idleMoveInterval, FALLBACK_AI.idleMoveInterval),
      idleMoveDuration: rangeOr(parsed?.idleMoveDuration, FALLBACK_AI.idleMoveDuration),
      idleMoveSpeedScale: positiveOr(parsed?.idleMoveSpeedScale, FALLBACK_AI.idleMoveSpeedScale),
      wanderRadius: positiveOr(parsed?.wanderRadius, FALLBACK_AI.wanderRadius),
      leashRange: positiveOr(parsed?.leashRange, FALLBACK_AI.leashRange),
      returnSpeedRate: positiveOr(parsed?.returnSpeedRate, FALLBACK_AI.returnSpeedRate),
      returnTimeoutMs: positiveOr(parsed?.returnTimeoutMs, FALLBACK_AI.returnTimeoutMs),
    };
    // 判据是「这一列里没有这个键」，不是「算出来的值等于兜底值」—— 出厂值本来就等于兜底
    // （攻击间隔 2000 / 攻击距离 60 / 漫游速度倍率 0.5），拿值相等当判据会让每次启动都喊缺参数，
    // 喊上几遍之后这一行 warn 就没人看了。
    const fallbackFields = (Object.keys(FALLBACK_AI) as Array<keyof MonsterAiParams>).filter(
      (key) => parsed === null || parsed[key] === undefined,
    );
    if (fallbackFields.length > 0 && !this.aiFallbackWarned) {
      this.aiFallbackWarned = true;
      this.logger.warn(
        `runtime_params.monster_ai 缺这些参数，已用最小可用值兜底：${fallbackFields.join(", ")}` +
          "（跑 make config-import 恢复出厂值）",
      );
    }
    return next;
  }

  //#endregion

  //#region 运行时与配置

  /** 取（或按出生点初始化）一只怪的 AI 运行时 */
  private runtimeOf(monster: WorldMonster): MonsterRuntime {
    const key = roomKey(monster.zoneId, monster.mapId, monster.slot);
    let map = this.runtimes.get(key);
    if (!map) {
      map = new Map<string, MonsterRuntime>();
      this.runtimes.set(key, map);
    }
    const existed = map.get(monster.instanceId);
    if (existed) return existed;
    const runtime: MonsterRuntime = {
      zoneId: monster.zoneId,
      mapId: monster.mapId,
      instanceId: monster.instanceId,
      monsterKey: monster.monsterKey,
      x: monster.x,
      y: monster.y,
      target: null,
      provoked: null,
      state: "idle",
      returningSince: 0,
      failCounts: new Map<string, number>(),
      stuckFrames: 0,
      stuckTurns: 0,
      detourTicks: 0,
      detourDirX: 0,
      detourDirY: 0,
      nextAttackAt: 0,
      anchorX: monster.x,
      anchorY: monster.y,
      idleMoveEndAt: 0,
      idleMoveDirectionX: 0,
      idleMoveDirectionY: 0,
      nextIdleMoveAt: Date.now() + randomBetween(this.ai.idleMoveInterval),
      sentX: monster.x,
      sentY: monster.y,
      sentMoving: false,
      movingNow: false,
      skillReadyAt: new Map<string, number>(),
      statuses: new Map<string, MonsterStatusEffect>(),
      castEndAt: 0,
      pushEndAt: 0,
      pushStartAt: 0,
      pushedUntil: 0,
      pushDirX: 0,
      pushDirY: 0,
      pushSpeed: 0,
      hp: monster.hp,
      maxHp: monster.maxHp,
      sentHp: -1,
    };
    map.set(monster.instanceId, runtime);
    return runtime;
  }

  private tickMs(): number {
    return Math.max(20, Number(this.config.get<number>("monsterAiTickMs") ?? 100));
  }

  private broadcastMs(): number {
    // #768 提频：默认 10Hz（与客户端上报节拍对齐），配置可覆写，下限 50ms 不变
    return Math.max(50, Number(this.config.get<number>("monsterAiBroadcastMs") ?? 100));
  }

  private posStaleMs(): number {
    return Math.max(500, Number(this.config.get<number>("monsterAiPosStaleMs") ?? 3000));
  }

  //#endregion
}

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MonsterPresentationRepository } from "../../database/repositories/monster-presentation.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MonsterSkillRepository } from "../../database/repositories/monster-skill.repository";
import { SkillRepository } from "../../database/repositories/skill.repository";
import { StatusRepository } from "../../database/repositories/status.repository";
import { SkillRow, StatusRow } from "../../database/rows";
import { parseCoefficientsJson, parseCombatJson } from "../../common/config-json";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { resolveIncomingDamage } from "../combat/status-combat";
import { RolesService } from "../roles/roles.service";
import { WorldService, worldKey, type WorldMonster } from "../world/world.service";
import type { RealtimeDropEntry, RealtimeMonsterAiEntry, RealtimeMonsterCast, RealtimeMonsterHit, RealtimeMonsterKill } from "./realtime.protocol";

/**
 * 怪物 AI 参数（`runtime_params.monster_ai` 列，管理端「运行时参数」页可改）
 *
 * 这一组值决定「怪出手多快、走多快、游走多远」—— 它们是**运营数据**，出厂值在
 * `server/data/config-sync.sql` 里，代码不存第二份。
 */
interface MonsterAiParams {
  attackInterval: number;
  attackRange: number;
  /** 施法硬直兜底（毫秒）：技能没配 castLockMs 时用它 */
  attackActionTime: number;
  /** 击退时长（毫秒，技能只配距离时用它换算击退速度；#670 从客户端 monsterAI.pushDuration 搬来） */
  pushDuration: number;
  idleMoveInterval: [number, number];
  idleMoveDuration: [number, number];
  idleMoveSpeedScale: number;
  wanderRadius: number;
}

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
};

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
  /** 自己身上的状态（statusId → 到期时刻，毫秒；#372 服务端生效，不叠层只刷新） */
  statuses: Map<string, number>;
  /** 施法硬直到期时刻（毫秒）：期间既不移动也不出手（#372） */
  castEndAt: number;
  /** 击退结束时刻（毫秒；#670 技能击退，期间只按击退方向位移） */
  pushEndAt: number;
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

/** 一个玩家的位置上报（AI 的目标检测输入；移动预测仍在客户端，服务端不做位置的权威） */
interface PlayerPosition {
  zoneId: number;
  mapId: string;
  x: number;
  y: number;
  hp: number;
  updatedAt: number;
}

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
 *   玩家离开检测范围即丢失目标（记恨不清，回来继续被追 —— 与客户端语义一致）；
 *   **出手结算不出来（玩家已经倒下 / 不在线）即当作目标作废**（#670）：清记恨、清位置缓存，
 *   并且这次出手整次不发 —— 包括技能（见 `forgetTarget`）；
 * - 移动：待机游走（停留点 + 随机方向 + 活动半径）与追击（直线趋近，不做寻路），
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
 * - **位置不落盘**：坐标的持久真相是出生点（世界服务的既有边界），重启后怪物回出生点
 *   重新游走 —— 几秒钟的表现层状态，不值得为它加一张表；
 * - 玩家位置不权威：客户端节流上报（`pos` 帧），服务端只把它当 AI 输入；
 *   超时没上报的玩家视作离场，怪物丢失目标；
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

  /** `zone:mapId` → 该图各怪的 AI 运行时（与世界服务的分域键同构；没人看的图整份清掉） */
  private readonly runtimes = new Map<string, Map<string, MonsterRuntime>>();
  /** 账号 → 最近一次位置上报 */
  private readonly positions = new Map<string, PlayerPosition>();
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
        zoneId: number,
        mapId: string,
        data: {
          mapId: string;
          monsters: RealtimeMonsterAiEntry[];
          hits: RealtimeMonsterHit[];
          casts: RealtimeMonsterCast[];
          kills: RealtimeMonsterKill[];
        },
      ) => void)
    | null = null;

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

  //#region 输入（通道侧调用）

  /**
   * 记录一次玩家位置上报（不校验图是否加载：上报先到、worldJoin 后到是正常时序）
   */
  updatePosition(accountId: string, zoneId: number, mapId: string, x: number, y: number, hp: number): void {
    this.positions.set(accountId, { zoneId, mapId, x, y, hp, updatedAt: Date.now() });
  }

  /**
   * 被动怪的记恨（结算侧在玩家打伤怪后调用）：之后这只怪在检测范围内会追击这个玩家
   */
  provoke(instanceId: string, accountId: string): void {
    const monster = this.world.find(instanceId);
    if (!monster) return;
    const runtime = this.runtimeOf(monster);
    runtime.provoked = accountId;
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
    const from = this.positions.get(fromAccountId);
    if (!from) return;
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
    runtime.pushEndAt = Date.now() + duration;
    // 击退打断手上的动作：硬直清零，落点后重新开始（下一次出手仍受普攻间隔约束）
    runtime.castEndAt = 0;
    runtime.movingNow = true;
  }

  /**
   * 怪物被击杀：AI 运行时作废（重生回出生点后按新的一轮游走重新开始，身上的状态一并清掉）；
   * 带击杀事件（#689，结算侧在奖励结算完后调用）时攒进待广播队列，
   * 同图观看者的下一拍 monster-ai 帧会带上 —— 死亡清场与掉落铺场的跨端演出全靠它。
   */
  onMonsterKilled(
    instanceId: string,
    kill?: { zoneId: number; mapId: string; accountId: string; x: number; y: number; drops: RealtimeDropEntry[] },
  ): void {
    const now = Date.now();
    for (const map of this.runtimes.values()) {
      const runtime = map.get(instanceId);
      // 它正在追人的话，这一死就是那次追击的结局（日志里否则会留下一条没有结束的追击）
      if (runtime?.target) this.logChaseEnd(runtime, runtime.target, "怪物被击杀", now, this.positions.get(runtime.target) ?? null);
      map.delete(instanceId);
    }
    if (!kill) return;
    const key = worldKey(kill.zoneId, kill.mapId);
    const list = this.pendingKills.get(key) ?? [];
    list.push({ instanceId, accountId: kill.accountId, x: kill.x, y: kill.y, drops: kill.drops });
    this.pendingKills.set(key, list);
  }

  /** 连接断开 / 被踢：位置上报作废（该玩家的目标下轮 tick 自然丢失） */
  dropAccount(accountId: string): void {
    this.positions.delete(accountId);
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
    const now = Date.now();
    let multiplier = 1;
    for (const [statusId, expiresAt] of runtime.statuses) {
      if (expiresAt <= now) {
        runtime.statuses.delete(statusId);
        continue;
      }
      const row = this.statusRows.get(statusId);
      if (!row) continue;
      const value = parseCombatJson(row.combat)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) multiplier *= value;
    }
    return multiplier;
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
    const viewed = this.world.viewedMaps();
    const viewedKeys = new Set<string>();

    for (const { zoneId, mapId, monsters } of viewed) {
      const key = worldKey(zoneId, mapId);
      viewedKeys.add(key);
      let runtimes = this.runtimes.get(key);
      if (!runtimes) {
        runtimes = new Map<string, MonsterRuntime>();
        this.runtimes.set(key, runtimes);
      }
      // 这张图上「位置新鲜且活着」的玩家（AI 的目标候选）
      const players: Array<[string, PlayerPosition]> = [];
      for (const [accountId, position] of this.positions) {
        if (position.zoneId !== zoneId || position.mapId !== mapId) continue;
        if (now - position.updatedAt > this.posStaleMs() || position.hp <= 0) continue;
        players.push([accountId, position]);
      }

      for (const monster of monsters.values()) {
        if (!monster.alive) {
          runtimes.delete(monster.instanceId);
          continue;
        }
        const config = this.presentationByKey.get(monster.monsterKey);
        if (!config) continue;
        const runtime = this.runtimeOf(monster);
        // 血量抄一份到运行时（#670）：世界层是权威，AI 只读 —— 广播拿它判断「这一拍要不要发」
        runtime.hp = monster.hp;
        runtime.maxHp = monster.maxHp;
        this.stepMonster(runtime, monster, config, players, now, key);
      }
    }

    // 没人看的分域：AI 运行时整份清掉（重进图时按出生点重建；身上的状态也一并作废）；
    // 攒着没发出去的击杀事件随分域一起作废（没有观看者 = 没有人需要这场演出）
    for (const key of [...this.runtimes.keys()]) {
      if (!viewedKeys.has(key)) {
        this.runtimes.delete(key);
        this.pendingKills.delete(key);
      }
    }
  }

  /** 推进一只怪：先校验/获取目标，再按「有目标技能或普攻 / 没目标待机游走」走一步 */
  private stepMonster(
    runtime: MonsterRuntime,
    monster: WorldMonster,
    config: { aggressive: boolean; detectRange: number; moveSpeed: number },
    players: Array<[string, PlayerPosition]>,
    now: number,
    mapKey: string,
  ): void {
    // 击退优先于一切（#670）：期间只按击退方向位移，目标 / 技能 / 硬直都往后放 ——
    // 被推着的怪继续放技能会看起来像「飘着打人」，而且落点会与施法者的预期错开
    if (now < runtime.pushEndAt) {
      const step = (runtime.pushSpeed * this.tickMs()) / 1000;
      runtime.x += runtime.pushDirX * step;
      runtime.y += runtime.pushDirY * step;
      runtime.movingNow = true;
      return;
    }

    // 施法硬直：动作没播完之前既不移动也不出手（与客户端动作锁同一语义）。
    // 放在目标校验之前 —— 硬直期间不该因为目标丢失而中断这次释放的收尾。
    if (now < runtime.castEndAt) {
      runtime.movingNow = false;
      return;
    }

    // 目标校验：上报超时 / 换图 / 死亡都算丢失（记恨不清，与客户端旧语义一致）
    if (runtime.target) {
      const position = this.positions.get(runtime.target);
      const fresh = position && position.hp > 0 && Date.now() - position.updatedAt <= this.posStaleMs();
      if (!fresh) {
        // 结束追击要能解释「为什么」：这四种成因在页面上是完全不同的故事
        const reason = !position
          ? "目标离线"
          : position.hp <= 0
            ? "目标倒下"
            : position.zoneId !== runtime.zoneId || position.mapId !== runtime.mapId
              ? "目标换图"
              : "位置上报超时";
        this.logChaseEnd(runtime, runtime.target, reason, now, position ?? null);
        runtime.target = null;
      }
    }
    // 目标获取：主动怪发现检测范围内最近玩家；被动怪只认记恨的那个人
    if (!runtime.target) {
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const [accountId, position] of players) {
        if (!config.aggressive && runtime.provoked !== accountId) continue;
        const distance = Math.hypot(position.x - runtime.x, position.y - runtime.y);
        if (distance <= config.detectRange && distance < bestDistance) {
          best = accountId;
          bestDistance = distance;
        }
      }
      if (best) {
        runtime.target = best;
        // 进入追击：停留点定在当前位置，待机游走计时归零（与客户端 followAnchor 同语义）
        runtime.anchorX = runtime.x;
        runtime.anchorY = runtime.y;
        runtime.idleMoveEndAt = 0;
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
      const position = this.positions.get(runtime.target);
      if (!position) return;
      const distance = Math.hypot(position.x - runtime.x, position.y - runtime.y);
      // 技能优先（#372）：进入战斗才有意义 —— 没有敌人时给自己上 buff 没有价值
      if (this.tryCast(runtime, monster, distance, now, mapKey)) return;
      if (distance <= this.ai.attackRange) {
        // 站定出手：按普攻间隔结算一次
        runtime.movingNow = false;
        if (now >= runtime.nextAttackAt) {
          runtime.nextAttackAt = now + this.ai.attackInterval;
          const hit = this.attack(monster, runtime.target);
          if (hit) {
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
              accountId: runtime.target,
              damage: hit.damage,
              hp: hit.hp,
              maxHp: hit.maxHp,
            });
          } else this.forgetTarget(runtime.target);
        }
        return;
      }
      // 追击：直线趋近（不做寻路，与客户端旧口径一致）
      const step = Math.min(distance, (config.moveSpeed * this.tickMs()) / 1000);
      runtime.x += ((position.x - runtime.x) / distance) * step;
      runtime.y += ((position.y - runtime.y) / distance) * step;
      runtime.movingNow = true;
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
    }
    if (runtime.idleMoveEndAt > now) {
      const speed = config.moveSpeed * this.ai.idleMoveSpeedScale;
      runtime.x += runtime.idleMoveDirectionX * ((speed * this.tickMs()) / 1000);
      runtime.y += runtime.idleMoveDirectionY * ((speed * this.tickMs()) / 1000);
      runtime.movingNow = true;
    } else {
      runtime.movingNow = false;
    }
  }

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
      if (plan.category === "2" && runtime.statuses.has(plan.statusId) && (runtime.statuses.get(plan.statusId) ?? 0) > now) continue;
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
    if (plan.category !== "2") {
      if (!runtime.target) return false;
      hit = this.attack(monster, runtime.target, plan.rate);
      if (!hit) {
        this.forgetTarget(runtime.target);
        return false;
      }
    }

    runtime.movingNow = false;
    runtime.skillReadyAt.set(plan.skillId, now + plan.cooldown * 1000);
    // 硬直：配置值优先；0 回落到普攻动作时长（服务端不知道客户端动画有多长）
    runtime.castEndAt = now + (plan.castLockMs > 0 ? plan.castLockMs : this.ai.attackActionTime);
    // 普攻与施法共用同一个出手窗口：技能放完不会立刻接一记普攻
    runtime.nextAttackAt = Math.max(runtime.nextAttackAt, now + this.ai.attackInterval);

    const cast: RealtimeMonsterCast = { instanceId: monster.instanceId, skillId: plan.skillId };
    if (plan.category === "2") {
      runtime.statuses.set(plan.statusId, now + plan.statusDuration * 1000);
      cast.statusId = plan.statusId;
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
      damage: hit?.damage ?? 0,
      hp: hit?.hp ?? 0,
      maxHp: hit?.maxHp ?? 0,
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
   * 伤害 = round(怪物物攻区间随机值 × 攻击倍率 × 技能倍率 − 玩家物防区间随机值 × 防御倍率)，下限 0，
   * 再过一道格挡（#822）。怪物侧攻击倍率来自它自己的状态（#372）；玩家侧防御倍率与格挡
   * 来自 `role_status`（护体神盾 30% 格挡减半、金刚护体防御 ×1.5）—— 两边同一套 `combat` 口径。
   *
   * @returns null = 这一下打不出去（玩家已经倒下 / 不在线，或怪物缺数值行）。
   *          调用方**必须**把它当成「目标作废」处理（见 `forgetTarget`）—— 只当成本次落空会让
   *          记恨一直挂着，怪继续对尸体出手（#670）。
   */
  private attack(monster: WorldMonster, accountId: string, rate = 1): RealtimeMonsterHit | null {
    const role = this.roles.online(accountId);
    if (!role) return null;
    const stats = this.monsterConfigs.findByKey(monster.monsterKey);
    if (!stats) return null;
    // RoleDto 要摊平（装备/成长线在 data 里），否则玩家的防御只剩等级那一档
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data));
    // 玩家身上的状态（#822）：防御倍率乘在防御项上，格挡在算完之后掷一次
    const modifiers = this.roles.statusModifiersOf(accountId);
    const attack = rollRange([Number(stats.physical_attack_min) || 0, Number(stats.physical_attack_max) || 0]) * this.attackMultiplierOf(monster.instanceId);
    const defense = Math.round((summary ? rollRange(summary.physicalDefense) : 0) * modifiers.defenseMultiplier);
    // 格挡的随机数在这里掷（`resolveIncomingDamage` 是纯函数，e2e 才敢按固定 roll 断言）
    const resolved = resolveIncomingDamage(Math.max(0, Math.round(attack * rate - defense)), modifiers, Math.random());
    const damage = resolved.damage;
    const applied = this.roles.applyMonsterHit(accountId, damage);
    if (!applied) return null;
    // 位置缓存里的血量同步（下轮目标校验用它，不再多打一次库）
    const position = this.positions.get(accountId);
    if (position) position.hp = applied.hp;
    return {
      instanceId: monster.instanceId,
      accountId,
      damage,
      hp: applied.hp,
      maxHp: applied.maxHp,
      ...(resolved.blocked ? { blocked: true } : {}),
    };
  }

  private pushHit(mapKey: string, hit: RealtimeMonsterHit): void {
    const list = this.pendingHits.get(mapKey) ?? [];
    list.push(hit);
    this.pendingHits.set(mapKey, list);
  }

  /**
   * 丢掉一个已经打不了的目标（#670 的根因就在这里）
   *
   * `RolesService.applyMonsterHit` 在**玩家已经倒下**或**不在线**时返回 null，而 AI 原来只把
   * 它当「这一下落空」：记恨不清、下一拍继续放技能，客户端于是看见一只怪对着尸体连放技能
   * （服务端返回 null，AI 不知道）。
   *
   * 两件事一起做，缺一条都还会复发：
   * - 清掉所有怪身上指向他的目标（同一具尸体常被几只怪同时盯着，一处发现就全图清）；
   * - 删掉位置缓存。目标检测读的是 `positions` 里的 hp，而「我已死亡」这条信息不会经上报
   *   反向传播（客户端死后照旧上报位置）—— 不删的话下一轮 tick 又把这具尸体选成目标。
   *   删掉是安全的：活着的玩家 250ms 内会重新上报一条（客户端 `pos` 帧），死人不该再被选。
   */
  private forgetTarget(accountId: string): void {
    this.positions.delete(accountId);
    const now = Date.now();
    for (const runtimes of this.runtimes.values()) {
      for (const runtime of runtimes.values()) {
        if (runtime.target !== accountId) continue;
        // 每个被清掉的目标都是一次「结束追击」，日志里要能对上它当初那次「开始」（#745）
        this.logChaseEnd(runtime, accountId, "目标倒下或不在线（出手结算不出来）", now, null);
        runtime.target = null;
      }
    }
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
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
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
          instanceId,
          x: Math.round(runtime.x * 100) / 100,
          y: Math.round(runtime.y * 100) / 100,
          moving: runtime.movingNow,
          hp: runtime.hp,
          maxHp: runtime.maxHp,
        });
        runtime.sentX = runtime.x;
        runtime.sentY = runtime.y;
        runtime.sentMoving = runtime.movingNow;
        runtime.sentHp = runtime.hp;
      }
      if (monsters.length === 0 && hits.length === 0 && casts.length === 0 && kills.length === 0) continue;
      this.onBroadcast?.(zoneId, mapId, { mapId, monsters, hits, casts, kills });
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
    const key = worldKey(monster.zoneId, monster.mapId);
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
      statuses: new Map<string, number>(),
      castEndAt: 0,
      pushEndAt: 0,
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
    return Math.max(50, Number(this.config.get<number>("monsterAiBroadcastMs") ?? 200));
  }

  private posStaleMs(): number {
    return Math.max(500, Number(this.config.get<number>("monsterAiPosStaleMs") ?? 3000));
  }

  //#endregion
}

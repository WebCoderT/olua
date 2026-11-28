import { Injectable, Logger } from "@nestjs/common";
import { CastRangeParams } from "../../common/constants/runtime-params";
import { skillOf } from "../../common/runtime-config-cache";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { RolesService } from "../roles/roles.service";

/**
 * 出手判定链的六道闸（#813 / docs/37 A1~A3）
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * `settleNew` 原来只有「技能存在 → 目标存在 → 同区 → 目标活着 → 角色在线 → 已学习 →
 * 有系数 → 扣血」这几步：**冷却、耗蓝、距离、跨图、施法者存活、出手频率全都没有**。
 * 也就是说一份改了包的客户端可以无限施法、隔整张图打怪、尸体继续输出、单连接万次/秒。
 * 六道闸就是把这些「客户端本来会自己守、但服务端不能相信它守了」的规则搬到服务端。
 *
 * 顺序固定（A1）：`存活 → 跨图 → 距离 → 冷却 → 耗蓝 → 频率 → 结算`。
 * 依据是「越便宜、越不可能通过的先判」，且所有**会改状态**的动作（扣蓝、记冷却、扣令牌）
 * 都在最后一步统一提交 —— 前面任何一道失败都不需要回滚。
 *
 * **六道全部落地**。第三道距离闸当时按 #811 挂起（位置源是客户端自报的样本，与客户端
 * 自己的预测差一两拍，硬接会把站在攻击边缘的正常出手判成超距）；#811 收口后由 #1030 补上：
 * 判据与客户端 `canAttackTarget` **同一式** —— 把两边的碰撞盒换成边缘间距再比
 * `skills.distance`，并给 `cast_range.jitterPx` 的抖动余量。具体见下面第三道。
 *
 * ===========================================================================
 * 两个数值口径（都与客户端同源，不另立一份）
 * ===========================================================================
 * - **冷却**：`skills.cooldown`（秒）÷ `data.speedRate[skills.action]`。
 *   客户端 `SkillManager.getEffectiveCooldown` 就是这个式子（speedRate = 每秒循环数），
 *   基础剑术 `1.0s ÷ 4 = 250ms`。**不能直接用 cooldown**：那会把 4 刀/秒的攻速按 1 刀/秒判，
 *   正常玩家每次出手都被拒。
 * - **令牌桶**：容量 3、补充速率 = 上面那个有效冷却的倒数（基础攻速 = 4/秒）。
 *   A2 原文写的是「每秒补 1」，那等于全服 DPS 砍到 1/4（2026-11-08 拍板改为按攻速折算）：
 *   桶的职责是挡「比合法攻速更快」的连发，不是限速本身。
 *
 * ===========================================================================
 * 位置与死亡的来源
 * ===========================================================================
 * - 跨图读存档 `data.mapAt`（服务端写，`worldJoin` 放行时才写）—— 权威；
 * - 存活读存档 `data.hp`（`applyMonsterHit` 写的）—— 权威；
 * - 距离读 `presence.positionOf`（客户端上报 + #811 的服务端校验）与怪物 AI 的仲裁后坐标。
 *   两者都有「时刻」，过期 / 缺省一律按**位置未知**放行（与拾取距离闸同一条纪律）。
 *
 * ===========================================================================
 * 状态的生命周期
 * ===========================================================================
 * 冷却与令牌桶都是**进程内内存态**：重启丢一次（玩家多放一次技能）可接受，与掉落那套
 * 「重启清场」同取向。断线清掉（不占内存），**换图不重置**（A2：否则换图刷桶）。
 */

/**
 * 六道闸的拒绝原因（A3：settle 帧的 `rejected` 取值，不新增帧类型）
 *
 * `stunned`（#826 第三批）是「控制状态中不能出手」—— 与 docs/22 §2.1 第 6 条同名。
 * 客户端对未知 `rejected` 只 warn 不崩，所以新增取值不需要改帧结构。
 */
export type CastRejectReason = "dead" | "cross_map" | "range" | "cooldown" | "mp" | "rate" | "stunned";

/** 判定结果：放行（带权威冷却结束时刻），或带原因的拒绝 */
export type CastGuardVerdict =
  | {
      ok: true;
      /**
       * 放行的这一发记下的**冷却结束时刻**（服务端毫秒轴，#1137 批次 2）
       *
       * 客户端用它起冷却倒计时（ServerClock 换算到本地轴）—— 冷却显示全由服务端值驱动，
       * 本地不再 `Date.now()` 起钟（本地钟与 lastCastAt 漂移正是 #1133 蓝量弹回的推手）。
       * 冷却配 0 的技能不带（没有冷却就没有这个字段）。
       */
      cooldownUntilMs?: number;
    }
  | {
      ok: false;
      rejected: CastRejectReason;
      message: string;
      /** 冷却闸专用：还要等多少毫秒（客户端可用来转圈，不至于一排红字） */
      remainMs?: number;
      /** 耗蓝闸专用：这一发需要多少法力 */
      need?: number;
      /** 耗蓝闸专用：当前法力 */
      have?: number;
    };

/** 一次出手要判的输入（全部来自服务端自己的对象，不信任客户端传参） */
export interface CastGuardInput {
  accountId: string;
  /** 技能配置行（`skillOf` 的结果；调用方已确认真实存在） */
  skill: Record<string, unknown>;
  skillId: string;
  /** 角色存档（`RoleDto.data`）：hp / mp / mapAt / speedRate 都在里面 */
  roleData: Record<string, unknown>;
  /**
   * 目标实例的当前坐标与所在地图（世界服务持有）
   *
   * **缺省 = 自身施法**（#822：护体神盾 / 金刚护体这类 `category = "2"` 的 buff）：
   * 没有目标就没有「跨图打」和「隔图打」这回事，跨图与距离两道直接跳过，
   * 存活 / 冷却 / 耗蓝 / 频率四道照走（buff 同样能被改包连放）。
   *
   * `halfWidth` / `halfHeight` 是目标碰撞盒的半宽半高（#1030，距离闸用）：
   * 由调用方从 `monster_presentation.content_width/height` 取（客户端 `addMonsterCollider`
   * 就是拿这两个值当 `BoxCollider2D.size`）。**缺省 = 尺寸未知，距离闸放行**。
   */
  target?: { mapId: string; x: number; y: number; halfWidth?: number; halfHeight?: number };
  /**
   * 施法者当前坐标与那一帧的时刻（#1030，距离闸用，来自 `presence.positionOf`）
   *
   * 缺省 / `at` 过期按**位置未知**放行：刚进图的前几百毫秒、或上报被挡住的老客户端，
   * 拿不到位置就拒人，等于让正常玩家「点了没反应」。宁可不判，不可误判。
   */
  caster?: { x: number; y: number; at: number };
}

/** 令牌桶容量（A2）：只用来吸收网络抖动，不是「每秒能放几次」 */
const CAST_BUCKET_CAPACITY = 3;

/**
 * 补充速率的防御性上限（次/秒）
 *
 * 运营把某个技能冷却调到 0 时「1/冷却」会变成无穷大 —— 那会让令牌桶彻底失效。
 * 20 次/秒已经远高于任何合法攻速（当前最快的 0.25s 一刀 = 4 次/秒），
 * 到这个量级只可能是配置手滑。
 */
const CAST_TOKENS_MAX_PER_SEC = 20;

/**
 * 角色碰撞盒（#1030，距离闸用）
 *
 * 与客户端 `client/assets/configs/role.ts` 的 `roleBody` **必须同值**：
 * `colliderSize = 40 × 40`、`colliderOffset = (0, 20)`（#1339：贴地的 40×40，原 40×70 罩全身）——
 * 节点的原点在脚下，所以判距离时角色的盒心是 `(x, y + 20)`。
 *
 * 客户端换碰撞盒而这里没跟 → 边缘玩家的正常出手会被判成超距（`enforce` 档）；
 * 反过来这里比客户端宽 → 只是少拦一点，不会误伤。**往宽的一侧偏是安全的**。
 */
const ROLE_HALF_WIDTH = 20;
const ROLE_HALF_HEIGHT = 20;
const ROLE_BOX_OFFSET_Y = 20;

/**
 * 施法者位置的有效期（毫秒）
 *
 * `pos` 帧是 10Hz（#768 提频），正常情况下最新一条不会超过 100ms。取 2 秒是给
 * 「卡了一下 / 刚过图 / 网络抖」留余量：超过 2 秒还没新帧，这个人要么已经掉线，
 * 要么客户端根本不报位置 —— 两种情况都不该由距离闸来判。
 */
const CAST_POS_STALE_MS = 2_000;

/**
 * 读 `runtime_params.cast_range` 这一列
 *
 * 缺列 / 坏 JSON / 缺键一律退回 `FALLBACK`（**档位 `off`**）：读不出来时最安全的事情是
 * 「什么都别拦」—— 反过来（缺配置就当 `enforce`）会让配置事故变成「全服打不出技能」。
 * 出厂值 `log` 在 `config-sync.sql`，与这里的兜底**刻意不同**：一个是运营口径，一个是进程兜底。
 */
const FALLBACK_CAST_RANGE: CastRangeParams = { mode: "off", jitterPx: 24 };

function parseCastRange(raw: string | undefined): CastRangeParams {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const mode = parsed.mode;
  const jitter = Number(parsed.jitterPx);
  return {
    // 认不出的档位按 `log`：拼错不该让全服突然打不出技能（也不该静默变成「不校验」）
    mode: mode === "off" || mode === "enforce" || mode === "log" ? mode : "log",
    jitterPx: Number.isFinite(jitter) && jitter >= 0 ? jitter : FALLBACK_CAST_RANGE.jitterPx,
  };
}

@Injectable()
export class CastGuardService {
  private readonly logger = new Logger(CastGuardService.name);

  /** `账号:技能id` → 上次被接受的出手时刻（毫秒） */
  private readonly lastCastAt = new Map<string, number>();
  /** 账号 → 上次**任意**技能被接受的出手时刻（毫秒；#1001 的「战斗中」判据读它） */
  private readonly lastAcceptedAt = new Map<string, number>();
  /** 账号 → 令牌桶（容量 3；补充速率随所施技能的攻速走） */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** 距离闸流水（`log` 档观察期靠它出数：每 60 秒汇总一行 warn） */
  private readonly rangeCounters = { judged: 0, rejected: 0 };
  /** 上次汇总输出的时刻 */
  private lastRangeSummaryAt = 0;

  constructor(
    private readonly roles: RolesService,
    private readonly runtimeParams: RuntimeParamsRepository,
  ) {}

  /** 当前生效的距离闸参数（**每次现读库**，与位移校验同一取向：改完下一次出手就生效） */
  castRangeParams(): CastRangeParams {
    return parseCastRange(this.runtimeParams.get()?.cast_range);
  }

  /** 距离闸计数快照（排查脚本 / e2e 的诊断出口；不是业务接口） */
  castRangeStats(): { judged: number; rejected: number } {
    return { ...this.rangeCounters };
  }

  /**
   * 判一次出手能不能打出去（不改世界状态，只改判定链自己的三样东西：冷却、令牌、法力）
   *
   * 放行时副作用已经提交（冷却记上、令牌扣掉、法力扣掉）；拒绝时**什么都没动**。
   */
  guard(input: CastGuardInput): CastGuardVerdict {
    const now = Date.now();

    // —— 一、施法者存活（存档里的 hp 是服务端写的，权威）——
    const hp = Math.floor(Number(input.roleData.hp) || 0);
    if (hp <= 0) {
      return { ok: false, rejected: "dead", message: "角色已死亡，不能出手（先复活）" };
    }

    // —— 一·五、控制：眩晕 / 麻痹 / 沉默期间不能出手（#826 第三批）——
    // 放在存活之后、跨图之前：它比后面几道都便宜（一次 role_status 读），而且「人还在、
    // 但被打得动不了」是这个状态最直接的语义。**移动闸是另一处独立判定**（pos 帧那条路），
    // 两处各判一次是有意的：一条帧只走一条路，谁也不会替对方判。
    const control = this.roles.controlOf(input.accountId);
    if (control.silenced) {
      return {
        ok: false,
        rejected: "stunned",
        message: control.stunned ? "你正处于眩晕 / 麻痹状态，无法出手" : "你被沉默，无法出手",
      };
    }

    // —— 二、跨图：目标必须在自己**服务端记下的位置**那张图上 ——
    // `mapAt` 是 worldJoin 放行时写进去的（#606）；没有这个键（老档 / 刚建号）时不拦，
    // 与进图门槛的纪律一致（那一刻“他在哪”还没有服务端的答案，拦下来只会误伤）。
    const mapAt = typeof input.roleData.mapAt === "string" ? input.roleData.mapAt : "";
    if (input.target && mapAt && mapAt !== input.target.mapId) {
      return {
        ok: false,
        rejected: "cross_map",
        message: `目标在 ${input.target.mapId}，你在 ${mapAt}（服务端只认自己放行过的图）`,
      };
    }

    // —— 三、距离（#1030）：与客户端 canAttackTarget 同一式 ——
    // 判据是**碰撞盒边缘间距**而不是中心距：客户端 `BattleMath.canAttackTarget` 取两个
    // `BoxCollider2D.worldAABB`，算「水平前沿的间隙」与「垂直间隙」，再比 `skills.distance`。
    // 服务端只有中心点，所以自己把两边的盒补齐：
    //   施法者盒心 (x, y+35)、半宽 20、半高 35（roleBody）；目标盒心 (x, y)、半宽高取呈现表。
    // 为什么不能用一个固定容差代替：怪物半宽 11.5~590px（`monster_presentation` 实测），
    // 固定 200px 会把大怪的正常近战判成超距，固定 600px 又等于允许站 600px 外打小怪。
    const rangeReject = this.rangeVerdict(input);
    if (rangeReject) return rangeReject;

    // —— 四、冷却（配置冷却 ÷ 动作速度倍率，与客户端 getEffectiveCooldown 同式）——
    const cooldownMs = this.cooldownMsOf(input.skill, input.roleData);
    if (cooldownMs > 0) {
      const key = `${input.accountId}:${input.skillId}`;
      const last = this.lastCastAt.get(key);
      if (last !== undefined && now - last < cooldownMs) {
        const remainMs = Math.ceil(cooldownMs - (now - last));
        return {
          ok: false,
          rejected: "cooldown",
          message: `${input.skillId} 冷却中，还需 ${remainMs}ms`,
          remainMs,
        };
      }
    }

    // —— 五、耗蓝：先只读判「够不够」，真正扣在最后统一提交 ——
    const mpCost = Math.max(0, Math.floor(Number(input.skill.mpCost) || 0));
    if (mpCost > 0) {
      const vitals = this.roles.vitalsOf(input.accountId);
      if (!vitals) {
        return { ok: false, rejected: "mp", message: "读不到在线角色的法力，无法施法" };
      }
      if (vitals.mp < mpCost) {
        return {
          ok: false,
          rejected: "mp",
          message: `法力不足：需要 ${mpCost}，当前 ${vitals.mp}`,
          need: mpCost,
          have: vitals.mp,
        };
      }
    }

    // —— 六、频率（令牌桶；补充速率 = 该技能的有效攻速）——
    const tokensPerSecond = cooldownMs > 0 ? 1000 / cooldownMs : CAST_TOKENS_MAX_PER_SEC;
    const bucket = this.takeBucket(input.accountId, now, tokensPerSecond);
    if (bucket.tokens < 1) {
      return {
        ok: false,
        rejected: "rate",
        message: "出手太快（超出任何合法攻速的连发被丢弃）",
      };
    }

    // —— 全部通过：统一提交副作用 ——
    if (mpCost > 0 && !this.roles.spendCastMp(input.accountId, mpCost)) {
      // 极端竞态（两个帧同时到、蓝只够一次）：这一发按蓝不足拒，冷却与令牌不记
      return { ok: false, rejected: "mp", message: `法力不足：需要 ${mpCost}`, need: mpCost };
    }
    bucket.tokens -= 1;
    // 「刚打完一发」的既成事实（#1001 的 deny_transfer_in_combat 判据读它）——
    // 记冷技能与不计冷却的技能都要记，放在冷却分支之前
    this.lastAcceptedAt.set(input.accountId, now);
    if (cooldownMs > 0) {
      this.lastCastAt.set(`${input.accountId}:${input.skillId}`, now);
      // 权威冷却结束时刻随放行帧带回（#1137 批次 2）：客户端的冷却显示以它为唯一起点
      return { ok: true, cooldownUntilMs: now + cooldownMs };
    }
    return { ok: true };
  }

  /**
   * 这个账号上一次**被接受**的出手是什么时候（毫秒；没打过返回 null）
   *
   * 「被接受」是关键：蓝不够 / 冷却中 / 目标已死那些被拒的帧不更新它 ——
   * 改包狂发 `cast` 不能把「战斗中」这个状态续上。
   */
  lastAcceptedOf(accountId: string): number | null {
    return this.lastAcceptedAt.get(accountId) ?? null;
  }

  /**
   * 这个账号当前仍在冷却中的技能 → 剩余毫秒（#1137 批次 2，roleUpdate 快照用）
   *
   * 客户端的冷却显示全由服务端值驱动：settle-ok 帧只覆盖「刚放的那一发」，
   * 进图 / 重连后的存量冷却就靠这张表随 roleUpdate 帧下发（**只在仍有冷却时带**，
   * 空表不带 —— 免得每帧多塞一个恒空对象）。
   *
   * 口径与冷却闸同一把尺（`cooldownMsOf`：配置冷却 ÷ speedRate），所以客户端拿到的
   * remainMs 与下一发会不会被拒必然一致 —— 它不存在「本地算出来已就绪、服务端还在转」的空间。
   */
  cooldownSnapshotOf(accountId: string, roleData: Record<string, unknown>): Record<string, number> {
    const now = Date.now();
    const prefix = `${accountId}:`;
    const snapshot: Record<string, number> = {};
    for (const [key, last] of this.lastCastAt) {
      if (!key.startsWith(prefix)) continue;
      const skill = skillOf(key.slice(prefix.length));
      if (!skill) continue;
      const cooldownMs = this.cooldownMsOf(skill, roleData);
      if (cooldownMs <= 0) continue;
      const remainMs = Math.ceil(cooldownMs - (now - last));
      if (remainMs > 0) snapshot[key.slice(prefix.length)] = remainMs;
    }
    return snapshot;
  }

  /** 连接断开：清掉本账号的冷却与令牌桶（内存不陪断线玩家涨；换图**不**清，见文件头） */
  dropAccount(accountId: string): void {
    this.buckets.delete(accountId);
    this.lastAcceptedAt.delete(accountId);
    const prefix = `${accountId}:`;
    for (const key of [...this.lastCastAt.keys()]) {
      if (key.startsWith(prefix)) this.lastCastAt.delete(key);
    }
  }

  //#region 内部

  /**
   * 第三道：距离（#1030）
   *
   * 返回 `null` = 放行（含「不该判」的所有情况），返回 verdict = 拒绝。
   *
   * 什么时候**不判**（每一条都是「宁可漏判，不可误判」）：
   * - 档位 `off`；
   * - `skills.distance <= 0`（不限距离，现有 1004 / 1010 / 1011 都是 0）；
   * - 自身 / 范围技能没有目标（调用方不传 target）；
   * - 施法者位置缺省或过期（`CAST_POS_STALE_MS`）；
   * - 目标碰撞盒尺寸未知（呈现表缺行）；
   * - 目标不在同一张图（那是第二道跨图闸的活，这里不重复判）。
   *
   * `log` 档：照判照记，最后返回 `null`（观察期不改行为）。
   */
  private rangeVerdict(input: CastGuardInput): CastGuardVerdict | null {
    // 先做两件不花钱的排除（自身 buff / 区域技能没有目标；不限距离的技能没有可判的东西），
    // 再读库取档位 —— 这两类出手占多数，没必要为它们每次 SELECT 一行
    if (!input.target) return null;
    const allow = Number(input.skill.distance);
    if (!Number.isFinite(allow) || allow <= 0) return null;

    const cfg = this.castRangeParams();
    if (cfg.mode === "off") return null;

    const caster = input.caster;
    if (!caster) return null;
    const now = Date.now();
    if (now - caster.at > CAST_POS_STALE_MS) return null;
    // 跨图是第二道闸的活：这里只判「同一张图上隔多远」。施法者在哪张图由存档 `mapAt` 给
    // （上面第二道已经用它判过跨图），没有这个键就不判
    const mapAt = typeof input.roleData.mapAt === "string" ? input.roleData.mapAt : "";
    if (mapAt && input.target.mapId !== mapAt) return null;

    const halfWidth = Number(input.target.halfWidth);
    const halfHeight = Number(input.target.halfHeight);
    if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight) || halfWidth <= 0 || halfHeight <= 0) return null;

    // 边缘间距：先算盒心差，再各减两边的半宽/半高，负数按 0（重叠）
    const gapX = Math.abs(caster.x - input.target.x) - (ROLE_HALF_WIDTH + halfWidth);
    const gapY = Math.abs(caster.y + ROLE_BOX_OFFSET_Y - input.target.y) - (ROLE_HALF_HEIGHT + halfHeight);
    const gap = Math.hypot(Math.max(0, gapX), Math.max(0, gapY));

    this.rangeCounters.judged += 1;
    const limit = Math.max(1, allow) + cfg.jitterPx;
    if (gap <= limit) return null;

    this.rangeCounters.rejected += 1;
    this.summarizeRange(cfg);
    if (cfg.mode === "log") return null; // 观察期只记账，不改行为
    return {
      ok: false,
      rejected: "range",
      // 文案里把「射程」与「余量」分开写：只给一个合计数时，玩家会把 34px 当成技能射程
      message: `目标距离 ${Math.round(gap)}px，超出技能 ${input.skillId} 的射程（${Math.round(Math.max(1, allow))}px + ${cfg.jitterPx}px 余量）—— 走近再打`,
    };
  }

  /** 60 秒汇总一行（只在**有超距**时说话；`log` 档的观察期就靠这一行） */
  private summarizeRange(cfg: CastRangeParams): void {
    const now = Date.now();
    if (now - this.lastRangeSummaryAt < 60000) return;
    this.lastRangeSummaryAt = now;
    const ratio = this.rangeCounters.judged > 0 ? (this.rangeCounters.rejected / this.rangeCounters.judged) * 100 : 0;
    this.logger.warn(
      `出手距离闸（${cfg.mode}）近 60 秒：判定 ${this.rangeCounters.judged} 次 / 超距 ${this.rangeCounters.rejected} 次` +
        `（占比 ${ratio.toFixed(2)}%，余量 ${cfg.jitterPx}px）`,
    );
  }

  /**
   * 这个技能的实际冷却（毫秒）= `cooldown × 1000 ÷ speedRate[action]`
   *
   * speedRate 是「每秒循环数」（客户端 `EffectManager.actionDuration` 用 `1 / rate` 算
   * 动作时长，同一口径）。缺这个键 / 值 <= 0 时按 1 处理，与客户端 `(rate > 0 ? rate : 1)` 一致。
   */
  private cooldownMsOf(skill: Record<string, unknown>, roleData: Record<string, unknown>): number {
    const seconds = Number(skill.cooldown);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    const action = typeof skill.action === "string" ? skill.action : "";
    const rates = roleData.speedRate;
    const raw = action && rates && typeof rates === "object"
      ? Number((rates as Record<string, unknown>)[action])
      : 1;
    const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
    return (seconds * 1000) / rate;
  }

  /**
   * 取这个账号的令牌桶并按时间补令牌（懒补充：不跑定时器，出手时才结算）
   *
   * 补充速率每次现算（随所施技能的攻速）：`tokens += (now - at) / 1000 × perSecond`。
   * 这样玩家在「4 刀/秒」与「1/60 秒的增益技能」之间切换时，桶始终按当前合法攻速补充，
   * 不会因为上一次放的是慢技能就长期欠账。
   */
  private takeBucket(accountId: string, now: number, tokensPerSecond: number): { tokens: number; at: number } {
    const existed = this.buckets.get(accountId);
    if (!existed) {
      const fresh = { tokens: CAST_BUCKET_CAPACITY, at: now };
      this.buckets.set(accountId, fresh);
      return fresh;
    }
    const rate = Math.min(CAST_TOKENS_MAX_PER_SEC, Math.max(0, tokensPerSecond));
    const gained = ((now - existed.at) / 1000) * rate;
    existed.tokens = Math.min(CAST_BUCKET_CAPACITY, existed.tokens + Math.max(0, gained));
    existed.at = now;
    return existed;
  }

  //#endregion
}

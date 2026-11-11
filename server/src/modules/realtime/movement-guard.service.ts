import { Injectable, Logger } from "@nestjs/common";
import { MovementGuardParams } from "../../common/constants/runtime-params";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MapGeometryService } from "./map-geometry.service";

/** 拒绝原因（`posCorrect` 帧的 `reason` 取值；客户端据此选提示文案） */
export type MovementRejectReason = "speed" | "wall";

/** 一帧位移的裁决结果 */
export interface MovementVerdict {
  /** 这帧坐标能不能进在场表 */
  accept: boolean;
  /** 拒绝原因（`accept = true` 时为 null） */
  reason: MovementRejectReason | null;
  /** 是不是 `enforce` 档（调用方据此决定要不要回 `posCorrect`） */
  enforce: boolean;
}

/** 一次裁决的输入 */
export interface MovementInput {
  /** 上次**被接受**的坐标（服务端权威位置） */
  from: { x: number; y: number };
  /** 本帧上报的坐标 */
  to: { x: number; y: number };
  /** 与上次被接受的时间差（毫秒；按**实际间隔**算，掉帧不该被误判） */
  dtMs: number;
  /** 地图 id（穿墙校验按图取几何） */
  mapId: string;
  /**
   * 这一次位移的**免检额度**（像素，#811）
   *
   * 服务端自己造成的位移必须自己认账：击退 / 拉人（#826）由服务端发起，客户端照位移
   * 表现之后再上报，从服务端的视角看就是「一帧跳了 80px」。不给额度的话，`enforce` 档
   * 会把每个被击退的玩家都拉回原地 —— 表现为「被怪推了一下，人又弹回去」。
   */
  credit: number;
}

/**
 * 位移校验（#811 前两道：速度 + 穿墙）
 *
 * ===========================================================================
 * 为什么要它
 * ===========================================================================
 * `PlayerPresenceService` 的位置是**客户端自报**的（4Hz），#596 只留了一道「荒谬级」
 * 阈值（1000px/s）与「连续 2 帧异常即信任」的宽容分支 —— 结果是**两次上报（约 250ms）
 * 就能把一个人挪到任何地方**，而怪物 AI 与互见广播都读这份坐标。这个服务把那道闸
 * 换成「按实际间隔算的可信距离 + 真的不穿墙」。
 *
 * ===========================================================================
 * 三档（`runtime_params.movement.mode`，改库即热切）
 * ===========================================================================
 * - `off`：完全不判，行为与 #811 之前一模一样（唯一用途是回滚）；
 * - `log`：**出厂**。照判、照接受，只记流水与计数 —— 上线先跑一周，看超速占比与
 *   穿墙抽样有没有误判。之所以「照接受」而不是「悄悄拒绝」：观察期的目的是量误伤率，
 *   若这一档就开始拒帧，玩家看到的是「我在走别人看我停着」，等于用线上体验换数据；
 * - `enforce`：拒绝该帧（不进在场表、不动基线）+ 立刻回一帧 `posCorrect` 把客户端
 *   拉回权威位置。**单帧即回**（2026-11-12 拍板）：不回的话客户端以为自己在那、
 *   继续往那边走，服务端一直拒 → 越走越远、无限不同步。
 *
 * ===========================================================================
 * 数值口径
 * ===========================================================================
 * `上限 = maxSpeed × tolerance × Δt + jitterPx + credit`
 * - **Δt 用实际间隔**（上次被接受 → 这次），所以掉帧 200ms 出来的大步长不会被误判；
 *   上限截到 5 秒（再长的间隔按 5 秒算，掉线重连的第一帧不该按真实间隔放开）；
 * - 服务端**没有**角色移速属性（移速只在客户端刚体与怪物 `move_speed` 里），所以
 *   `maxSpeed` 是一把全局尺子（出厂 400px/s，约实测跑步的 3 倍），不是「角色移速 × 1.5」；
 * - 穿墙校验用**原始碰撞盒**（不外扩 `clearance`）：闸门只挡真的穿过去的，宽松一侧
 *   永远留给误判。
 *
 * 静默的边界：`MapGeometryService.geometryOf` 读不到几何时**不判穿墙**（几何是加固手段，
 * 不能因为它挂了就让人走不动路），只判速度。
 */
@Injectable()
export class MovementGuardService {
  private readonly logger = new Logger(MovementGuardService.name);

  /** 流水计数（`log` 档观察期靠它出数：每 60 秒汇总一行 warn） */
  private readonly counters = { total: 0, speed: 0, wall: 0, corrected: 0 };
  /** 上次汇总输出的时刻 */
  private lastSummaryAt = 0;

  constructor(
    private readonly runtimeParams: RuntimeParamsRepository,
    private readonly geometry: MapGeometryService,
  ) {}

  /**
   * 当前生效参数（**每次现读库**）
   *
   * 不做缓存的原因就是「配置表热切」这条拍板：一张单行表的 `SELECT` 是纳秒级，
   * 而 `pos` 帧是 4Hz × 在线人数 —— 每秒几十到几百次读取对 SQLite 完全不算事，
   * 换来的「改完下一帧就按新值判」比省这点 IO 值钱。
   */
  params(): MovementGuardParams {
    const parsed = parseMovement(this.runtimeParams.get()?.movement);
    return {
      mode: parsed.mode,
      maxSpeed: parsed.maxSpeed,
      tolerance: parsed.tolerance,
      jitterPx: parsed.jitterPx,
      wallCheck: parsed.wallCheck,
      correctIntervalMs: parsed.correctIntervalMs,
    };
  }

  /** 判一帧位移 */
  judge(input: MovementInput): MovementVerdict {
    const cfg = this.params();
    if (cfg.mode === "off") return { accept: true, reason: null, enforce: false };
    this.counters.total += 1;
    // 上限截到 5 秒：`pos` 帧超时（3 秒）就会被当离场，理论上到不了这里；
    // 真到了（进程刚起 / 重连首帧）也不能按真实间隔放开 —— 那是给「挂机一小时后瞬移」开后门
    const dtSeconds = Math.min(5, Math.max(0, input.dtMs) / 1000);
    const limit = cfg.maxSpeed * cfg.tolerance * dtSeconds + cfg.jitterPx + Math.max(0, input.credit);
    const dist = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
    let reason: MovementRejectReason | null = null;
    if (dist > limit) {
      reason = "speed";
    } else if (cfg.wallCheck && this.geometry.crossesWall(input.mapId, input.from, input.to)) {
      reason = "wall";
    }
    if (reason === null) return { accept: true, reason: null, enforce: cfg.mode === "enforce" };
    if (reason === "speed") this.counters.speed += 1;
    else this.counters.wall += 1;
    this.summarize(cfg);
    // `log` 档照接受（观察期不改行为），`enforce` 档才真的拒
    return { accept: cfg.mode === "log", reason, enforce: cfg.mode === "enforce" };
  }

  /** 记一次已发出的 `posCorrect`（只用于汇总输出） */
  noteCorrected(): void {
    this.counters.corrected += 1;
  }

  /** 当前计数快照（排查脚本 / e2e 的诊断出口；不是业务接口） */
  stats(): { total: number; speed: number; wall: number; corrected: number } {
    return { ...this.counters };
  }

  /**
   * 60 秒汇总一行（只在**有拒绝**时说话）
   *
   * 观察期要的就是这一行：`超速 / 穿墙 / 已拉回` 三个数配总帧数，直接能算出误伤率。
   * 不节流的话一个作弊客户端 4Hz 就能把日志冲干净。
   */
  private summarize(cfg: MovementGuardParams): void {
    const now = Date.now();
    if (now - this.lastSummaryAt < 60000) return;
    this.lastSummaryAt = now;
    const ratio = this.counters.total > 0 ? ((this.counters.speed + this.counters.wall) / this.counters.total) * 100 : 0;
    this.logger.warn(
      `位移校验（${cfg.mode}）近 60 秒：总 ${this.counters.total} 帧 / 超速 ${this.counters.speed} / 穿墙 ${this.counters.wall} / 已拉回 ${this.counters.corrected}` +
        `（异常占比 ${ratio.toFixed(2)}%，上限 ${cfg.maxSpeed}px/s × ${cfg.tolerance}）`,
    );
  }
}

/**
 * 读 `runtime_params.movement` 这一列
 *
 * 缺列 / 坏 JSON / 缺键一律退回 `FALLBACK`（**档位 `off`**）：读不出来时最安全的事情是
 * 「什么都别拦」—— 反过来（缺配置就当 `enforce`）会让配置事故变成「全服玩家互相拉回」。
 * 出厂值 `log` 在 `config-sync.sql`，与这里的兜底**刻意不同**：一个是运营口径，一个是进程兜底。
 */
const FALLBACK: MovementGuardParams = {
  mode: "off",
  maxSpeed: 400,
  tolerance: 1.35,
  jitterPx: 24,
  wallCheck: true,
  correctIntervalMs: 500,
};

function parseMovement(raw: string | undefined): MovementGuardParams {
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
  return {
    // 认不出的档位按 `log`：拼错不该让全服的人突然被拉回（也不该静默变成「不校验」）
    mode: mode === "off" || mode === "enforce" || mode === "log" ? mode : "log",
    maxSpeed: positiveOr(parsed.maxSpeed, FALLBACK.maxSpeed),
    tolerance: positiveOr(parsed.tolerance, FALLBACK.tolerance),
    jitterPx: nonNegativeOr(parsed.jitterPx, FALLBACK.jitterPx),
    wallCheck: typeof parsed.wallCheck === "boolean" ? parsed.wallCheck : FALLBACK.wallCheck,
    correctIntervalMs: nonNegativeOr(parsed.correctIntervalMs, FALLBACK.correctIntervalMs),
  };
}

/** 正值兜底（0 / 负数 / NaN 一律当没配） */
function positiveOr(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/** 非负兜底（0 合法，只有负数 / NaN 才回落） */
function nonNegativeOr(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

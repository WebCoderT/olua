import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ReloadMode,
  WorldReloadRequestRepository,
} from "../../database/repositories/world-reload-request.repository";
import { roomKey } from "../../common/utils/room-key.util";
import { WorldService } from "./world.service";

/** 执行失败的重试上限（超过就标 failed，不让 `pending` 卡住整张表的轮询） */
export const RELOAD_MAX_ATTEMPTS = 3;

/** 已完结行的保留期：7 天（够运营回看「上周改区域之后重载过几次」，又不至于把表撑大） */
export const RELOAD_HISTORY_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * 单图热重载的执行器（#809 / docs/20 §2.7，收 #669）
 *
 * ===========================================================================
 * 为什么是「读表 + 轮询」而不是「管理端直接调服务」
 * ===========================================================================
 * 管理端接口在**存档进程**（3100），世界内存活在**实时进程**（3101）—— 两个进程只共享
 * SQLite。轮询表天然是「谁在跑谁执行」：实时进程没起来时请求就躺在库里，起来之后第一轮
 * 就处理掉（验收里「存档进程重启：pending 行留在库里」靠的就是这一点）。
 *
 * ===========================================================================
 * 排队还是立刻执行
 * ===========================================================================
 * - `mode=reload`（连 AI 一起重载）：**立刻**执行。它本来就是「这张图的怪物全换掉」的
 *   重活，等的空窗没有意义（等到了也得整份重播）；
 * - `mode=respawn`（只重播刷怪区）：房里有人就**排队等空窗**，最多等到 `force_at`
 *   （出厂 5 分钟，见 `DEFAULT_FORCE_AFTER_MS`）。
 *
 * 为什么允许「强制重刷」而不是永远等空窗：运营配完区域要立刻验证，等 10 分钟无人是不
 * 现实的。代价是那一间房里的人会看到怪整体刷新一次 —— 这是**可接受且有提示**的表现，
 * 比「配了看不见效果」好（客户端收到 `world.reload{ forced:true }` 会飘字）。
 *
 * ===========================================================================
 * 失败处理
 * ===========================================================================
 * 执行抛异常时本轮不标状态，下一轮再试；**连续 3 次**（`RELOAD_MAX_ATTEMPTS`）失败才标
 * `failed` 并记 error。不重试的话一次偶发的库锁就把请求吞了（运营以为点了，其实没动）；
 * 无限重试的话一条坏请求会让「这张图的怪物一直少一半」永远自愈不了。
 */
@Injectable()
export class RoomReloadService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RoomReloadService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 请求 id → 已经失败的次数（只在内存里：进程重启后从 0 重数，比落库一列中间态简单） */
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly requests: WorldReloadRequestRepository,
    private readonly world: WorldService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.poll(), this.pollMs()).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 跑一轮（e2e 也可以直接调它，不必等定时器） */
  poll(): void {
    const now = Date.now();
    for (const request of this.requests.listPending()) {
      const roomId = roomKey(request.zone_id, request.map_id, request.slot);
      const mode = request.mode === "reload" ? "reload" : "respawn";
      const forced = now >= request.force_at;
      const watched = [...this.world.viewersOf(roomId)].length > 0;
      // 排队：有人看、只重播刷怪区、还没到强制时刻 —— 什么都不做，下一轮再看
      if (watched && mode === "respawn" && !forced) continue;
      this.execute(request.id, roomId, mode, forced, watched);
    }
    this.trimHistory(now);
  }

  private execute(id: number, roomId: string, mode: ReloadMode, forced: boolean, watched: boolean): void {
    try {
      const result = this.world.reloadRoom(roomId, forced, mode);
      this.attempts.delete(id);
      this.requests.markDone(
        id,
        JSON.stringify({ removed: result.removed, seeded: result.seeded, forced, watched }),
        Date.now(),
      );
    } catch (error) {
      const failed = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, failed);
      const message = error instanceof Error ? error.message : String(error);
      if (failed < RELOAD_MAX_ATTEMPTS) {
        this.logger.warn(`房间 ${roomId} 重载失败（第 ${failed}/${RELOAD_MAX_ATTEMPTS} 次，下轮重试）：${message}`);
        return;
      }
      this.attempts.delete(id);
      this.requests.markFailed(id, message, Date.now());
      this.logger.error(`房间 ${roomId} 重载连续 ${RELOAD_MAX_ATTEMPTS} 次失败，已标记 failed：${message}`);
    }
  }

  /** 顺手清掉太旧的已完结行（每轮都跑，代价是一条 DELETE） */
  private trimHistory(now: number): void {
    const removed = this.requests.trimFinished(now - RELOAD_HISTORY_KEEP_MS);
    if (removed > 0) this.logger.debug(`重载请求历史清理：删掉 ${removed} 条 7 天前的记录`);
  }

  private pollMs(): number {
    // 跟世界 tick 同一个旋钮：e2e 把 WORLD_TICK_MS 调小之后，重载也会跟着变快 ——
    // 否则「改完区域等一秒就生效」在测试里要等 5 秒，每个用例都得多睡一段
    return this.config.get<number>("worldTickMs") ?? 1000;
  }
}

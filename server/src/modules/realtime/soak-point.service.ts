import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { AccountRepository } from "../../database/repositories/account.repository";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { RolesService } from "../roles/roles.service";

/**
 * 泡点活动（#722：在线角色按服务端节拍发经验）
 *
 * ===========================================================================
 * 它是什么
 * ===========================================================================
 * #550 下线的那个「泡点」（原 AutoUpgrade 是纯本地加经验的死组件）按当时写明的
 * 方向复活：**经验只由服务端发** —— 本服务每秒醒一次，攒够一拍就给所有在线角色
 * 入账 `soakExpPerTick` 点经验。入账走 `RolesService.applySoakExp`，与击杀经验
 * 共用同一条升级链路（role_levels 判定 / 循环升级 / 权威属性重算），客户端从
 * 既有的 roleUpdate 轮询帧看到经验与等级变化 —— **没有任何本地加经验路径**。
 *
 * ===========================================================================
 * 参数（管理端「成长参数」页即改即生效，每拍现查库）
 * ===========================================================================
 * - `soakExpPerTick`：每拍经验，**0 = 活动关闭**（出厂默认，不改变既有部署的经济节奏）；
 * - `soakTickSeconds`：拍间隔（秒）。计时器固定每秒醒一次、按拍计数，改间隔
 *   不用重启定时器 —— 下一拍就按新间隔走。
 *
 * ===========================================================================
 * 为什么住在实时模块
 * ===========================================================================
 * 泡点要「整个游戏只发一份」：拆进程形态（`main.realtime.ts`）里只有实时进程装载
 * `RealtimeModule`，tick 天然单份；放 RolesModule 就得在两个进程里各跑一份
 * （RolesModule 两边都装），经验翻倍。单进程形态（本地开发 / 全部 e2e）下
 * `realtime: true` 默认装载，照常工作。
 *
 * 「在线」的真相是 `accounts.online_role_id`（#547 心跳清算兜着：断线 / 崩溃的
 * 标记过期即清），不依赖 WS 在场表 —— 实时通道抖动不该影响泡点发经验。
 */
@Injectable()
export class SoakPointService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SoakPointService.name);

  /** 心跳节拍（毫秒）：固定每秒醒一次，攒拍计数到 `soakTickSeconds` 才真正发放 */
  private static readonly BEAT_MS = 1000;
  /** 距上次发放攒了多少拍 */
  private elapsed = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly growth: GrowthRepository,
    private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SoakPointService.BEAT_MS).unref();
    this.logger.log(`泡点活动已启动（出厂关闭，管理端「成长参数」页 soakExpPerTick > 0 即开启）`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 一秒一醒：读当前参数（每拍现查库，管理端改完即生效），攒够一拍就整批发放 */
  private tick(): void {
    const rate = this.scalarValue("soakExpPerTick", 0, 1_000_000);
    if (rate <= 0) {
      // 活动关闭：计数清零 —— 重新开启时从整拍开始，不会把关闭期间的拍数补发出去
      this.elapsed = 0;
      return;
    }
    const seconds = Math.max(1, this.scalarValue("soakTickSeconds", 10, 3600));
    this.elapsed += 1;
    if (this.elapsed < seconds) return;
    this.elapsed = 0;
    const online = this.accounts.listOnline();
    for (const account of online) {
      // 逐个入账：applySoakExp 内部做归属 / 满级短路，null（不在线了 / 满级）安静跳过。
      // 一个账号写库失败不该断掉整批 —— applyKillExp 的异常路径由全局过滤器与
      // 事务边界兜着，这里不被单点拖垮是关键（发经验是尽力而为的节拍活）
      try {
        this.roles.applySoakExp(account.id, rate);
      } catch (error) {
        this.logger.warn(`泡点入账失败（账号 ${account.id}）：${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * 读一个标量参数（每拍现查库）：行不在 / 值非法按 `fallback` 处理
   *
   * 行不在只在「存量库还没跑过 #722 的补种」时出现（ensure 段会 INSERT OR IGNORE），
   * 防御性回落而已；soakExpPerTick 回落 0 的语义正好是「活动关闭」，宁可不发不错发。
   */
  private scalarValue(key: "soakExpPerTick" | "soakTickSeconds", fallback: number, max: number): number {
    const value = Number(this.growth.findScalar(key)?.value);
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(Math.floor(value), max);
  }
}

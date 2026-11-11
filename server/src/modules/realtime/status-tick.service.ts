import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { RolesService } from "../roles/roles.service";

/**
 * 周期状态结算（#826 第三批：灼烧这类 DoT / HoT）
 *
 * ===========================================================================
 * 它是什么
 * ===========================================================================
 * 每秒醒一次，问 `RolesService.applyStatusTicks()`「有哪些状态的这一拍该结算了」，
 * 由它扣血 / 回蓝并落库。**血量变化不推 revision**（`updateDataKeepRevision`），
 * 但会推进 `updated_at` —— 实时通道的 `roleUpdate` 轮询比较的是
 * `revision:updated_at`，所以本人一秒内就能看到血条下降，不需要新协议帧。
 *
 * 别人眼里的血条走 presence 在场表：客户端下一次 `pos` 帧带上新的 hp，
 * 广播时按变化发（`sentHp`）。周期伤害不值得为它单开一条广播 —— 那会让
 * 「每秒一次的全服广播」变成每个状态各一条。
 *
 * ===========================================================================
 * 为什么住在实时模块（与 SoakPointService 同一理由）
 * ===========================================================================
 * 结算要「整个游戏只跑一份」：拆进程形态（`main.realtime.ts`）里只有实时进程装载
 * `RealtimeModule`；放 RolesModule 就得在两个进程里各跑一份，周期伤害翻倍。
 *
 * 承伤者只认在线角色（`accounts.online_role_id`）：离线的人没有每秒一拍的时间源，
 * 若按挂上的时刻补，会在他不在的时候被烧死 —— 那不是玩法，是数据事故。
 *
 * ===========================================================================
 * 出错怎么办
 * ===========================================================================
 * **一个人失败不影响这一拍的其他所有人**：`applyStatusTicks` 内部逐条 try 化了写库，
 * 这里再兜一层 —— 一秒后还有下一拍，漏掉一拍比整轮断掉轻得多。
 */
@Injectable()
export class StatusTickService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StatusTickService.name);

  /** 心跳节拍（毫秒）：与泡点同一把尺子 */
  private static readonly BEAT_MS = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly roles: RolesService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), StatusTickService.BEAT_MS).unref();
    this.logger.log("周期状态结算已启动（statuses.tick_ms > 0 的状态每秒按拍结算）");
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      const applied = this.roles.applyStatusTicks();
      if (applied.length > 0) {
        const digits = applied.map((entry) => `${entry.roleId.slice(0, 6)}:${entry.hp}`).join(" ");
        this.logger.debug(`周期状态结算 ${applied.length} 人 —— ${digits}`);
      }
    } catch (error) {
      // 扫描本身炸了（库被锁 / 表结构不对）：喊出来，下一拍继续试
      this.logger.warn(`周期状态结算失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

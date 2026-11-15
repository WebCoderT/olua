import { Injectable } from "@nestjs/common";
import { CastGuardService } from "./cast-guard.service";

/**
 * 「最近出过手」算战斗中的窗口（毫秒）
 *
 * #1001 的 `deny_transfer_in_combat` 有两半判据：**有存活目标** / **最近 N 秒出过手**。
 * 服务端没有「当前目标」这份登记簿（目标只出现在每一次 `cast` 帧里，结算完就丢），
 * 所以只能落地后半句 —— 而且它更抗改包：改包能把 targetId 编成任意值，改不掉
 * 「刚才真的打出去过一发」这个既成事实。
 *
 * 10 秒 = 当前最慢技能（8s 冷却）的冷却 + 一点余量：一发刚打完就想跑，跑不掉；
 * 打完站着不动超过 10 秒，正常玩家眼里「已经脱战了」，这时候还拦就是在卡人。
 */
export const COMBAT_TRANSFER_BLOCK_MS = 10_000;

/**
 * 传送代价的进程内状态（#1001 / docs/20 §2.6）
 *
 * ===========================================================================
 * 为什么单独一个服务
 * ===========================================================================
 * 冷却按**角色**记（换号不该继承上一个号的冷却），而 `RoleDto` 是「每次操作现读 + 写回」
 * 的存档形态 —— 把「上次传送时刻」塞进存档等于为了几十秒的冷却多一次写库 + 一个迁移字段，
 * 还要处理「两个进程各写一次」的乐观锁冲突。它就是个会话级的节奏器，跟 `CastGuardService`
 * 的冷却表同一性质：**进程内、重启清零、不跨进程共享**。
 *
 * 重启清零是可接受的：进程重启已经把人全踢下线了，谁也不会在重连后立刻发现自己
 * 「冷却还在」。而 `cast` 的冷却表是同一取向（见那个类顶部的说明）。
 *
 * ===========================================================================
 * 什么时候记
 * ===========================================================================
 * **只有真的换了图才记**（`worldJoin` 落地、`mapAt` 从 A 改成 B 的那一刻）。
 * 登录 / 断线重连 / 换线 / 被拒的那次都不记 —— 否则「上线一次就吃一次冷却」，
 * 而玩家什么也没做。
 */
@Injectable()
export class TransferGuardService {
  /**
   * `roleId` → 上次真的传送到另一张图的时刻（毫秒）
   *
   * 用角色 id 而不是账号 id：同一账号换角色后，新角色不该继承上一个角色的冷却。
   * 条目**不主动清理** —— 键的数量上界是「这个进程里出现过的角色数」，一条 40 字节，
   * 与 `CastGuardService.lastCastAt` 同一个量级；靠 TTL 清理反而会引入「刚好清掉又刚好
   * 到点」的判据抖动。
   */
  private readonly lastTransferAt = new Map<string, number>();

  constructor(private readonly castGuard: CastGuardService) {}

  /**
   * 冷却还剩多少毫秒（`0` = 可以走）
   *
   * @param cooldownMs 目标图配的 `transfer_cooldown_ms`（0 = 无冷却）
   */
  remainMsOf(roleId: string, cooldownMs: number, now = Date.now()): number {
    if (cooldownMs <= 0) return 0;
    const last = this.lastTransferAt.get(roleId);
    if (last === undefined) return 0;
    const elapsed = now - last;
    if (elapsed >= cooldownMs) return 0;
    return Math.ceil(cooldownMs - elapsed);
  }

  /** 记一次传送（只该在「真的换了图、已经落地」之后调） */
  record(roleId: string, now = Date.now()): void {
    this.lastTransferAt.set(roleId, now);
  }

  /**
   * 这个账号现在算不算「战斗中」（`deny_transfer_in_combat` 的判据）
   *
   * 委托给出手判定链：它记着每一次**被接受**的出手（被拒的次数不算 —— 蓝不够、
   * 冷却中那些不是「打出去了」）。
   */
  inCombatOf(accountId: string, now = Date.now()): boolean {
    const last = this.castGuard.lastAcceptedOf(accountId);
    if (last === null) return false;
    return now - last < COMBAT_TRANSFER_BLOCK_MS;
  }
}

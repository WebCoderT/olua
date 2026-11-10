/**
 * 使用类道具的服务端冷却（#847 / #848）
 *
 * ## 为什么需要它
 *
 * 药品与货币道具原来都没有服务端冷却：客户端点得再快服务端也照做，改包就能
 * 「1 秒嗑 20 瓶药」「999 个货币道具瞬间变现」。乐观锁（revision）挡不住这个 ——
 * 每次都按回执更新 revision 再发一次，服务端看不出异常。
 *
 * ## 为什么放在内存里
 *
 * - `drugs.cooldown` / 货币道具的间隔都是**秒级**，重启丢掉的代价只是「重登后能立刻用一次」，
 *   没有任何数据后果；
 * - 落库要加一张运行表 + 每个道具一行写放大，换来的是「跨进程一致」—— 但用药与用道具
 *   只走 HTTP（`RolesModule` 只由 API 进程对外提供接口，实时进程只处理 WS 帧），
 *   两个进程各记一份也不会被绕过。
 * - 所以：内存 Map，进程内一份，`unref` 语义无关（纯数据，不需要定时器）。
 *
 * ## 键的粒度
 *
 * `角色 + 道具 id`：不同的药互不影响（战斗中先红后蓝是常态），同一瓶药按它自己的
 * `cooldown` 算间隔。
 *
 * ## 与「先占位再写库」的配合
 *
 * `take()` 在**写库之前**占位（否则两个并发请求都能通过检查），写库失败时调用方
 * `release()` 把占位退掉 —— 失败不该让玩家白等一个冷却。
 */
export class UseCooldown {
  /** key → 解锁时刻（毫秒时间戳） */
  private readonly until = new Map<string, number>();

  /**
   * 尝试占用一次冷却
   *
   * @param key `角色 + 道具` 组成的键（见文件头）
   * @param cooldownMs 本次冷却时长（≤ 0 = 不设冷却，直接放行且不登记）
   * @param now 当前时刻（测试可注入）
   * @returns 剩余毫秒：0 = 已占用（可以用），> 0 = 还在冷却里（这个值就是「还要等多久」）
   */
  take(key: string, cooldownMs: number, now: number = Date.now()): number {
    const blockedUntil = this.until.get(key) ?? 0;
    const remaining = blockedUntil - now;
    if (remaining > 0) return remaining;
    if (cooldownMs > 0) {
      this.until.set(key, now + cooldownMs);
      this.sweep(now);
    }
    return 0;
  }

  /** 退掉占位（写库失败时调）：下一次可以立刻再试，不让失败也吃冷却 */
  release(key: string): void {
    this.until.delete(key);
  }

  /**
   * 清掉已经过期的键
   *
   * Map 会随「玩过的角色数 × 用过的药品种数」增长，虽然每条只是一个数字，
   * 但服务跑几个月不重启就是慢性泄漏。顺手在同一处清理，比再起一个定时器省事；
   * 阈值只是避免每次 `take` 都全表扫。
   */
  private sweep(now: number): void {
    if (this.until.size < 1024) return;
    for (const [key, blockedUntil] of this.until) {
      if (blockedUntil <= now) this.until.delete(key);
    }
  }
}

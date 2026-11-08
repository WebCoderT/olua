import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { statusOf } from "../../common/runtime-config-cache";
import { NO_STATUS_MODIFIERS, RoleStatusModifiers } from "../combat/status-combat";
import { RoleStatusRepository } from "../../database/repositories/role-status.repository";
import { RoleStatusRow } from "../../database/rows";

/**
 * 角色身上生效中的状态（#822 / docs/22 A4）
 *
 * ===========================================================================
 * 为什么要有这一层
 * ===========================================================================
 * 在此之前「放 buff」是**客户端的事**：`skills/warrior.ts` 的 `skill_1010` 本地
 * `StatusManager.apply()` 就完事了，服务端完全不知道 —— 后果有两头：
 *
 * - 结算不认 `category`：`1010 护体神盾`（category=2，配了 `damageCoefficients`）
 *   被当伤害技能结算，「护体神盾」变成 300% 核弹；
 * - 受击不认状态：`MonsterAiService.attack` 按裸属性算，护体神盾的 30% 格挡、
 *   金刚护体的防御 ×1.5 永远只在客户端动画里。
 *
 * 这一层把「谁此刻挂着什么、还剩多久」搬成服务端权威（表 `role_status`），
 * 结算与受击都从这里读数值；数值口径在 `modules/combat/status-combat`（纯函数）。
 *
 * ===========================================================================
 * 生命周期（docs/22 §5 已定）
 * ===========================================================================
 * - **重复获得**：刷新到期（本轮 `stacks` 恒为 1 —— 层数封顶 `max_stacks` 与周期效果
 *   一起做，重开条件见 docs/22 §2.3 的落地顺序）；
 * - **到期**：读取前惰性清理（判据绝不吃旧行），另有 5 秒一次的全表清扫兜住没人读的行；
 * - **死亡**：清空（复活不带旧 buff）—— 由 `RolesService.applyMonsterHit` 在血量归零时调；
 * - **下线**：清空（离线不保留 buff）；
 * - **换图**：保留（换图不是死亡）。
 *
 * 为什么落库而不是像怪物那样放进程内 Map：怪物状态是「这一轮表现」，丢了无所谓；
 * 角色状态会改结算，重启后凭空消失等于「登录即被白打一刀」，而且死亡清在存档进程、
 * 结算读在实时进程 —— 跨进程只能靠库。
 */
@Injectable()
export class RoleStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoleStatusService.name);

  /** 全表清扫间隔：到期判定本身是惰性的，这个只负责把「再没人读过」的行删掉 */
  private static readonly SWEEP_MS = 5_000;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly repo: RoleStatusRepository) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.sweep(), RoleStatusService.SWEEP_MS);
    // unref：这个定时器不该拖住进程退出（e2e 起停很频繁）
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * 施加（或刷新）一个状态
   *
   * @returns 生效后的状态；`null` = 配置里没有这个状态（或 duration ≤ 0，配错了）
   *          —— 调用方据此拒绝，**不要**静默当成「已放但没效果」：那会让运营以为
   *          改了 statusId 就生效，实际什么都没发生。
   */
  apply(roleId: string, statusId: string, options?: { skillId?: string; now?: number }): RoleStatusRow | null {
    const config = statusOf(statusId);
    if (!config) return null;
    const durationMs = Math.round(Number(config.duration) * 1000);
    if (!(durationMs > 0)) return null;

    const now = options?.now ?? Date.now();
    const skillId = options?.skillId ?? "";
    const existing = this.repo.listByRole(roleId).find((row) => row.status_id === statusId);
    // 重复获得：刷新到期，层数本轮恒为 1（叠加规则随 max_stacks 一起做，见类注释）
    const stacks = existing ? Math.max(1, Number(existing.stacks) || 1) : 1;
    const row: RoleStatusRow = { role_id: roleId, status_id: statusId, stacks, expire_at: now + durationMs, source_skill: skillId };
    this.repo.upsert(row);
    return row;
  }

  /**
   * 这个角色此刻全部生效中的状态（客户端图标栏的权威来源）
   *
   * 先删过期行再读：`expire_at <= now` 的行在判据里一天都不该出现 —— 惰性清理放在
   * 这里而不是每个读取方各删一次，是因为「读到旧行」的后果比「多一次 DELETE」重得多。
   */
  snapshotOf(roleId: string, now = Date.now()): Array<{ id: string; stacks: number; remainingMs: number }> {
    this.repo.deleteExpiredOfRole(roleId, now);
    return this.repo
      .listByRole(roleId)
      .filter((row) => statusOf(row.status_id) !== null)
      .map((row) => ({
        id: row.status_id,
        stacks: Math.max(1, Number(row.stacks) || 1),
        remainingMs: Math.max(0, Number(row.expire_at) - now),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 汇总成结算用的数值修正（口径见类注释）
   *
   * 没有状态时返回中性值（格挡 0 / 系数 1 / 倍率 1）—— 与 `NO_STATUS_MODIFIERS` 一致，
   * 这样「接上状态层」对没 buff 的玩家是零行为变化。
   */
  modifiersOf(roleId: string, now = Date.now()): RoleStatusModifiers {
    const modifiers: RoleStatusModifiers = { ...NO_STATUS_MODIFIERS };
    for (const entry of this.snapshotOf(roleId, now)) {
      const combat = statusOf(entry.id)?.combatValue;
      if (!combat) continue;
      if (typeof combat.blockChance === "number" && Number.isFinite(combat.blockChance)) {
        modifiers.blockChance = Math.max(modifiers.blockChance, combat.blockChance);
      }
      if (typeof combat.blockFactor === "number" && Number.isFinite(combat.blockFactor)) {
        modifiers.blockFactor = Math.min(modifiers.blockFactor, combat.blockFactor);
      }
      if (typeof combat.defenseMultiplier === "number" && Number.isFinite(combat.defenseMultiplier) && combat.defenseMultiplier > 0) {
        modifiers.defenseMultiplier *= combat.defenseMultiplier;
      }
      if (typeof combat.attackMultiplier === "number" && Number.isFinite(combat.attackMultiplier) && combat.attackMultiplier > 0) {
        modifiers.attackMultiplier *= combat.attackMultiplier;
      }
    }
    return modifiers;
  }

  /** 清空一个角色的全部状态（死亡 / 下线；换图不清） */
  clearOfRole(roleId: string): void {
    const { changes } = this.repo.deleteByRole(roleId);
    if (changes > 0) this.logger.debug(`角色 ${roleId} 的状态已清空（${changes} 条）`);
  }

  /** 全表清扫过期行（定时器调用；两个进程各自扫也不会互相踩 —— 只删已过期的） */
  sweep(now = Date.now()): void {
    this.repo.deleteExpired(now);
  }
}

import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RolePositionRow } from "../rows";

/**
 * 角色位置快照数据访问（#862/#863 的距离校验）
 *
 * 两条纪律：
 * - **唯一写入方是实时进程**（`PlayerPresenceService` 节流落库）；存档进程只读，
 *   越权写会让「服务端认为你在哪」变成客户端说啥就是啥；
 * - 仓储只写 SQL，**判断留给调用方**（新鲜度窗口 / 距离阈值都在
 *   `common/constants/quest.ts` 与 `QuestService` 里）—— 与刷怪区 / 点位仓储同一取向。
 */
@Injectable()
export class RolePositionRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 写一次最新坐标（同角色覆盖；`updated_at` 是新鲜度的唯一依据） */
  upsert(row: RolePositionRow): void {
    this.db.run(
      `INSERT INTO role_positions (role_id, map_id, x, y, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(role_id) DO UPDATE SET
         map_id = excluded.map_id,
         x = excluded.x,
         y = excluded.y,
         updated_at = excluded.updated_at`,
      [row.role_id, row.map_id, row.x, row.y, row.updated_at],
    );
  }

  /** 一个角色的最新坐标；没有行返回 null（= 还没进过图 / 已下线清掉） */
  findByRole(roleId: string): RolePositionRow | null {
    return this.db.get<RolePositionRow>("SELECT * FROM role_positions WHERE role_id = ?", [roleId]) ?? null;
  }

  /** 角色下线 / 被踢：删掉这一行（留着只会让下一次交互读到一张过期的位置） */
  remove(roleId: string): void {
    this.db.run("DELETE FROM role_positions WHERE role_id = ?", [roleId]);
  }

  /** 角色删除时清理（与其它角色附属表的 `removeAllOfRole` 同形） */
  removeAllOfRole(roleId: string): void {
    this.remove(roleId);
  }

  /**
   * 删掉某个区所有角色的位置行（#961 合并区）
   *
   * **必须在搬角色之前调**：这张表没有 `zone_id`，只能反查 `roles.zone_id` ——
   * 角色一旦搬去目标区，就再也认不出哪些行是源区留下的了（会变成一堆指向
   * 「现在属于别的区」的角色的过期坐标，让合并后的距离校验按旧图判断）。
   */
  removeByZoneRoles(zoneId: number): number {
    const rows = this.db.all<{ role_id: string }>("SELECT id AS role_id FROM roles WHERE zone_id = ?", [zoneId]);
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => "?").join(",");
    this.db.run(`DELETE FROM role_positions WHERE role_id IN (${placeholders})`, rows.map((row) => row.role_id));
    return rows.length;
  }
}

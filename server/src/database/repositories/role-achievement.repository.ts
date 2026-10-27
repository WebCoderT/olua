import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RoleAchievementRow } from "../rows";

/**
 * 成就进度数据访问（#401）
 *
 * 写到这里的只有**累计型**条件（kill / quest）；状态型（level / combat / collect）
 * 不落进度，每次查询按角色当前状态现算 —— 这一层不认识条件类型，只认「计数」。
 *
 * 双进程共享（同 quest_progress）：realtime 进程的击杀结算直写，HTTP 进程读同一张表。
 */
@Injectable()
export class RoleAchievementRepository {
  constructor(private readonly db: DatabaseService) {}

  findByKey(roleId: string, achievementId: string): RoleAchievementRow | undefined {
    return this.db.get<RoleAchievementRow>(
      "SELECT * FROM role_achievements WHERE role_id = ? AND achievement_id = ?",
      [roleId, achievementId],
    );
  }

  /** 某角色的全部成就记录（GET /achievements/me 全量下发） */
  listByRole(roleId: string): RoleAchievementRow[] {
    return this.db.all<RoleAchievementRow>(
      "SELECT * FROM role_achievements WHERE role_id = ? ORDER BY achievement_id ASC",
      [roleId],
    );
  }

  /**
   * 累计型条件 +1（没有行时插一行）
   *
   * 只在「尚未达成」时被调用（由 service 判断），所以这里不用管达成后不再累加 ——
   * 一旦达成，`achieved_at` 就非空，service 不会再对它有下一次 +1。
   */
  bump(roleId: string, achievementId: string): RoleAchievementRow | undefined {
    return this.db.get<RoleAchievementRow>(
      `INSERT INTO role_achievements (role_id, achievement_id, progress, achieved_at, claimed_at, updated_at)
       VALUES (?, ?, 1, NULL, NULL, ?)
       ON CONFLICT(role_id, achievement_id) DO UPDATE SET
         progress = progress + 1,
         updated_at = excluded.updated_at
       RETURNING *`,
      [roleId, achievementId, Date.now()],
    );
  }

  /** 达成（`achieved_at` 只写一次：已经有了就不再盖，保住「第一次达成的时刻」） */
  markAchieved(roleId: string, achievementId: string): void {
    this.db.run(
      `UPDATE role_achievements SET achieved_at = ?, updated_at = ?
       WHERE role_id = ? AND achievement_id = ? AND achieved_at IS NULL`,
      [Date.now(), Date.now(), roleId, achievementId],
    );
  }

  /** 领奖（调用方先确认 `achieved_at` 非空且 `claimed_at` 为空） */
  markClaimed(roleId: string, achievementId: string): void {
    this.db.run(
      "UPDATE role_achievements SET claimed_at = ?, updated_at = ? WHERE role_id = ? AND achievement_id = ?",
      [Date.now(), Date.now(), roleId, achievementId],
    );
  }

  /** 某成就有多少角色记录（管理端删除守卫） */
  countByAchievement(achievementId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM role_achievements WHERE achievement_id = ?", [
      achievementId,
    ]);
  }

  /** 某角色的全部记录（角色删除时外键级联；这里给测试与清理留显式入口） */
  removeAllOfRole(roleId: string): void {
    this.db.run("DELETE FROM role_achievements WHERE role_id = ?", [roleId]);
  }
}

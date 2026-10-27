import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { QuestProgressRow } from "../rows";

/**
 * 任务进度数据访问（#396）
 *
 * 双进程共享（同 monsters 读库模式）：realtime 进程的击杀结算直写进度
 * （`onMonsterKilled` → bumpProgress），HTTP 进程的接取 / 交付读写同一张表。
 * 状态机与删行语义见 `QuestProgressRow` 注释。
 */
@Injectable()
export class QuestProgressRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 接取（重复接取由调用方先查状态，这里不吞异常） */
  insert(row: QuestProgressRow): void {
    this.db.run(
      `INSERT INTO quest_progress
         (role_id, quest_id, status, progress, claimed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.role_id, row.quest_id, row.status, row.progress, row.claimed_at, row.created_at, row.updated_at],
    );
  }

  findByKey(roleId: string, questId: string): QuestProgressRow | undefined {
    return this.db.get<QuestProgressRow>(
      "SELECT * FROM quest_progress WHERE role_id = ? AND quest_id = ?",
      [roleId, questId],
    );
  }

  /** 某角色的全部进度行（GET /quests/me 全量下发） */
  listByRole(roleId: string): QuestProgressRow[] {
    return this.db.all<QuestProgressRow>(
      "SELECT * FROM quest_progress WHERE role_id = ? ORDER BY quest_id ASC",
      [roleId],
    );
  }

  /** 某角色指定状态的进度行（接取门控查「前置是否已领」用） */
  listByStatus(roleId: string, status: string): QuestProgressRow[] {
    return this.db.all<QuestProgressRow>(
      "SELECT * FROM quest_progress WHERE role_id = ? AND status = ?",
      [roleId, status],
    );
  }

  /** 击杀 / 对话推进度（+1 并判断是否到 ready）；没有进行中的行返回 null（调用方忽略） */
  bumpProgress(roleId: string, questId: string, count: number): { status: string; progress: number } | null {
    return (
      this.db.get<{ status: string; progress: number }>(
        `UPDATE quest_progress
         SET progress = progress + 1,
             status = CASE WHEN progress + 1 >= ? THEN 'ready' ELSE status END,
             updated_at = ?
         WHERE role_id = ? AND quest_id = ? AND status = 'accepted'
         RETURNING status, progress`,
        [count, Date.now(), roleId, questId],
      ) ?? null
    );
  }

  /** 标记可交付（collect 任务交付前的兜底不使用；预留给未来多目标） */
  markReady(roleId: string, questId: string): void {
    this.db.run(
      "UPDATE quest_progress SET status = 'ready', updated_at = ? WHERE role_id = ? AND quest_id = ? AND status = 'accepted'",
      [Date.now(), roleId, questId],
    );
  }

  /** 领奖（main 保留 claimed 行作链门控） */
  markClaimed(roleId: string, questId: string): void {
    this.db.run(
      "UPDATE quest_progress SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE role_id = ? AND quest_id = ?",
      [Date.now(), Date.now(), roleId, questId],
    );
  }

  /** 领奖（daily 删行 → 可重接、进度清零） */
  remove(roleId: string, questId: string): void {
    this.db.run("DELETE FROM quest_progress WHERE role_id = ? AND quest_id = ?", [roleId, questId]);
  }

  /** 某任务被多少角色引用（管理端删除守卫） */
  countByQuest(questId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM quest_progress WHERE quest_id = ?", [questId]);
  }

  /** 某角色的全部进度（角色删除时级联由外键处理，这里给管理端清理留显式入口） */
  removeAllOfRole(roleId: string): void {
    this.db.run("DELETE FROM quest_progress WHERE role_id = ?", [roleId]);
  }
}

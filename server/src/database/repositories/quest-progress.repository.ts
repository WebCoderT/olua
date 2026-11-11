import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { QuestProgressRow } from "../rows";

/**
 * 任务进度数据访问（#396 / #815）
 *
 * 双进程共享（同 monsters 读库模式）：realtime 进程的击杀结算直写进度
 * （`onMonsterKilled` → bumpProgress），HTTP 进程的接取 / 交付读写同一张表。
 * 状态机、`reset_day` 日切口径、以及「daily 也保留 claimed 行」的理由见 `QuestProgressRow` 注释。
 */
@Injectable()
export class QuestProgressRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 接取（重复接取由调用方先查状态，这里不吞异常） */
  insert(row: QuestProgressRow): void {
    this.db.run(
      `INSERT INTO quest_progress
         (role_id, quest_id, status, progress, claimed_at, reset_day, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.role_id,
        row.quest_id,
        row.status,
        row.progress,
        row.claimed_at,
        row.reset_day,
        row.created_at,
        row.updated_at,
      ],
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

  /** 领奖（daily 与 main 同一处理：#815 起都不删行，「今天领过没有」由 reset_day 判定） */
  markClaimed(roleId: string, questId: string): void {
    this.db.run(
      "UPDATE quest_progress SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE role_id = ? AND quest_id = ?",
      [Date.now(), Date.now(), roleId, questId],
    );
  }

  /**
   * 跨轮重新接取（#815 日常 / #864 周常）：覆盖重置成新一轮的 accepted
   *
   * 不复用 `insert` —— 行还在（主键冲突），只能原地改。`claimed_at` 一并清掉：
   * 它记的是「上一轮哪一刻领的」，留到这一轮会让人误读成「本轮领过」。
   * `day` 是**本轮起点天号**：日常传今天、周常传本周周一，与 `reset_day` 同口径。
   */
  resetForNewDay(roleId: string, questId: string, day: number): void {
    this.db.run(
      `UPDATE quest_progress
       SET status = 'accepted', progress = 0, claimed_at = NULL, reset_day = ?, updated_at = ?
       WHERE role_id = ? AND quest_id = ?`,
      [day, Date.now(), roleId, questId],
    );
  }

  /**
   * 放弃（#865）：删掉这一行 = 回到「没接过」
   *
   * 只删非 claimed 行（调用方先判）：claimed 行是「这一轮领过」的证据，删了就把
   * 日常 / 周常变回可刷（#815 的洞）。
   */
  remove(roleId: string, questId: string): void {
    this.db.run("DELETE FROM quest_progress WHERE role_id = ? AND quest_id = ?", [roleId, questId]);
  }

  /**
   * 某任务被多少角色引用（管理端删除守卫）
   *
   * `excludeStatus` 给日常用：daily 的 claimed 行是「今天领过」的记账，不是「卡在这个任务上」，
   * 拿它拦下架会让日常永远删不掉（每天都有行）。main 不传 —— claimed 行是链门控，删了就断链。
   */
  countByQuest(questId: string, excludeStatus?: string): number {
    if (excludeStatus) {
      return this.db.count("SELECT COUNT(1) AS total FROM quest_progress WHERE quest_id = ? AND status <> ?", [
        questId,
        excludeStatus,
      ]);
    }
    return this.db.count("SELECT COUNT(1) AS total FROM quest_progress WHERE quest_id = ?", [questId]);
  }

  /** 某角色的全部进度（角色删除时级联由外键处理，这里给管理端清理留显式入口） */
  removeAllOfRole(roleId: string): void {
    this.db.run("DELETE FROM quest_progress WHERE role_id = ?", [roleId]);
  }
}

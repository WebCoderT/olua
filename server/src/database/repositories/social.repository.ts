import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { FRIEND_STATUS } from "../../common/constants/social";
import { RoleEnemyWithRoleRow, RoleFriendRow, RoleFriendWithRoleRow } from "../rows";

/**
 * 好友与敌人数据访问（#389）
 *
 * ## 好友是**镜像两行**，不是一行 + 双向查
 * A 加 B 时同时写 `(A,B)` 与 `(B,A)`，`status` 保持一致（pending → accepted）。
 * 这样「我的好友」「谁在等我」「我加了谁」都是**一次主键前缀查询**；
 * 换成一行的写法要在每个查询里 `WHERE role_id = ? OR friend_id = ?` 再自己判方向，
 * 四处查询就有四处可能写反。
 *
 * 代价是「同意」要更新两行 —— 所以它必须在 `transaction()` 里做：只改一边
 * 会出现「我这边显示好友、他那边还挂着待处理」。
 *
 * ## 敌人是**单向一行**
 * 我标我的，对方既不知道也不受影响（没有通知，也不需要事务）。
 *
 * 列表都要展示对方的角色名与等级：查询里 join `roles`（索引列上的冗余），不落第二份快照。
 */
@Injectable()
export class SocialRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 事务（与 guild / zone 仓储同款：事务开在仓储里，业务层只声明「这几步要么全成要么全不成」）
   *
   * 好友这条线上必须原子的是三处：发申请（写两行）、同意（两行同时 accepted）、
   * 删好友（两行同时消失）。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  //#region 好友

  /** 已互为好友的列表（按成为好友的时间倒序：新加的在上面） */
  friends(roleId: string): RoleFriendWithRoleRow[] {
    return this.db.all<RoleFriendWithRoleRow>(
      `SELECT f.*, r.name AS friend_name, r.level AS friend_level, r.occupation AS friend_occupation
         FROM role_friends f
         JOIN roles r ON r.id = f.friend_id
        WHERE f.role_id = ? AND f.status = ?
        ORDER BY f.updated_at DESC`,
      [roleId, FRIEND_STATUS.ACCEPTED],
    );
  }

  /** 别人加我、我还没处理的（`requested_by` 不是我 = 他在等我） */
  incomingRequests(roleId: string): RoleFriendWithRoleRow[] {
    return this.db.all<RoleFriendWithRoleRow>(
      `SELECT f.*, r.name AS friend_name, r.level AS friend_level, r.occupation AS friend_occupation
         FROM role_friends f
         JOIN roles r ON r.id = f.friend_id
        WHERE f.role_id = ? AND f.status = ? AND f.requested_by <> ?
        ORDER BY f.created_at ASC`,
      [roleId, FRIEND_STATUS.PENDING, roleId],
    );
  }

  /** 我加别人、还在等对方处理的 */
  outgoingRequests(roleId: string): RoleFriendWithRoleRow[] {
    return this.db.all<RoleFriendWithRoleRow>(
      `SELECT f.*, r.name AS friend_name, r.level AS friend_level, r.occupation AS friend_occupation
         FROM role_friends f
         JOIN roles r ON r.id = f.friend_id
        WHERE f.role_id = ? AND f.status = ? AND f.requested_by = ?
        ORDER BY f.created_at ASC`,
      [roleId, FRIEND_STATUS.PENDING, roleId],
    );
  }

  /** 某一对关系（无论方向：传谁都一样，因为镜像两行的内容同构） */
  findFriend(roleId: string, friendId: string): RoleFriendRow | undefined {
    return this.db.get<RoleFriendRow>("SELECT * FROM role_friends WHERE role_id = ? AND friend_id = ?", [
      roleId,
      friendId,
    ]);
  }

  /** 好友数量（上限判定用；只数 accepted） */
  countFriends(roleId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM role_friends WHERE role_id = ? AND status = ?", [
      roleId,
      FRIEND_STATUS.ACCEPTED,
    ]);
  }

  /**
   * 写一对 pending（镜像两行，`requested_by` 记为发起人）
   *
   * 用 `ON CONFLICT DO UPDATE` 而不是纯 INSERT：极端情况下两边同时发起，
   * 后到的那次不该 500 —— 覆盖成「最新一次请求」语义最简单（谁先处理都能成）。
   */
  upsertRequest(roleId: string, friendId: string, requestedBy: string, now: number): void {
    const sql = `INSERT INTO role_friends (role_id, friend_id, status, requested_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(role_id, friend_id) DO UPDATE SET
                   status = excluded.status,
                   requested_by = excluded.requested_by,
                   updated_at = excluded.updated_at`;
    this.db.run(sql, [roleId, friendId, FRIEND_STATUS.PENDING, requestedBy, now, now]);
    this.db.run(sql, [friendId, roleId, FRIEND_STATUS.PENDING, requestedBy, now, now]);
  }

  /** 同意：两行一起置 accepted（调用方负责包事务） */
  acceptPair(roleId: string, friendId: string, now: number): void {
    const sql = "UPDATE role_friends SET status = ?, updated_at = ? WHERE role_id = ? AND friend_id = ?";
    this.db.run(sql, [FRIEND_STATUS.ACCEPTED, now, roleId, friendId]);
    this.db.run(sql, [FRIEND_STATUS.ACCEPTED, now, friendId, roleId]);
  }

  /** 删除一对（拒绝 = 删自己这一对的两行；删好友同理 —— 双向消失） */
  removePair(roleId: string, friendId: string): void {
    const sql = "DELETE FROM role_friends WHERE role_id = ? AND friend_id = ?";
    this.db.run(sql, [roleId, friendId]);
    this.db.run(sql, [friendId, roleId]);
  }

  /** 角色被删 / 注销时清掉它参与的每一对（另一侧随之消失，不会留下悬空 id） */
  removeAllOfRole(roleId: string): void {
    this.db.run("DELETE FROM role_friends WHERE role_id = ? OR friend_id = ?", [roleId, roleId]);
  }

  //#endregion

  //#region 敌人

  /** 我标的敌人（新标的在前） */
  enemies(roleId: string): RoleEnemyWithRoleRow[] {
    return this.db.all<RoleEnemyWithRoleRow>(
      `SELECT e.*, r.name AS enemy_name, r.level AS enemy_level, r.occupation AS enemy_occupation
         FROM role_enemies e
         JOIN roles r ON r.id = e.enemy_id
        WHERE e.role_id = ?
        ORDER BY e.created_at DESC`,
      [roleId],
    );
  }

  findEnemy(roleId: string, enemyId: string) {
    return this.db.get<{ role_id: string; enemy_id: string; created_at: number }>(
      "SELECT * FROM role_enemies WHERE role_id = ? AND enemy_id = ?",
      [roleId, enemyId],
    );
  }

  insertEnemy(roleId: string, enemyId: string, now: number): void {
    this.db.run("INSERT INTO role_enemies (role_id, enemy_id, created_at) VALUES (?, ?, ?)", [roleId, enemyId, now]);
  }

  removeEnemy(roleId: string, enemyId: string): void {
    this.db.run("DELETE FROM role_enemies WHERE role_id = ? AND enemy_id = ?", [roleId, enemyId]);
  }

  /** 角色被删时清掉「他标的」与「别人标他的」 */
  removeAllEnemiesOfRole(roleId: string): void {
    this.db.run("DELETE FROM role_enemies WHERE role_id = ? OR enemy_id = ?", [roleId, roleId]);
  }

  //#endregion
}


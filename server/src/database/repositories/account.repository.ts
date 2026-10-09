import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { AccountRow, AccountWithCountRow } from "../rows";

/** 账号数据访问（账号表只被 auth / admin 两个模块用到，SQL 集中在这里） */
@Injectable()
export class AccountRepository {
  constructor(private readonly db: DatabaseService) {}

  findById(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
  }

  findByUsername(username: string): AccountRow | undefined {
    return this.db.get<AccountRow>("SELECT * FROM accounts WHERE username = ?", [username]);
  }

  insert(row: AccountRow): void {
    this.db.run(
      `INSERT INTO accounts (id, username, password, status, online_role_id, token_version, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.username,
        row.password,
        row.status,
        row.online_role_id,
        row.token_version,
        row.created_at,
        row.updated_at,
        row.last_login_at,
      ],
    );
  }

  /** 局部更新（只更新传入的字段；不存在返回 false） */
  updateById(id: string, patch: Partial<Omit<AccountRow, "id" | "created_at">>): boolean {
    const fields: string[] = [];
    const params: SqlParam[] = [];
    const assign = (column: string, value: SqlParam) => {
      fields.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.username !== undefined) assign("username", patch.username);
    if (patch.password !== undefined) assign("password", patch.password);
    if (patch.status !== undefined) assign("status", patch.status);
    if (patch.online_role_id !== undefined) assign("online_role_id", patch.online_role_id);
    if (patch.token_version !== undefined) assign("token_version", patch.token_version);
    if (patch.last_login_at !== undefined) assign("last_login_at", patch.last_login_at);
    if (fields.length === 0) return this.findById(id) !== undefined;
    assign("updated_at", patch.updated_at ?? Date.now());
    params.push(id);
    return this.db.execute(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, params).changes > 0;
  }

  /**
   * 改口令 + 作废已签发令牌（一次写完）
   *
   * 两件事必须一起落：分成两条语句就可能出现「密码改了但版本号没加」的半截状态，
   * 那样玩家用旧密码登不上、旧令牌却还有效 —— 最糟的一种组合。
   * 自增写在 SQL 里：并发下「读出来加一再写回」会丢自增。
   */
  updatePasswordAndBumpVersion(id: string, password: string): void {
    this.db.run("UPDATE accounts SET password = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?", [
      password,
      Date.now(),
      id,
    ]);
  }

  /** 删除账号（角色由外键级联删除） */
  deleteById(id: string): boolean {
    return this.db.execute("DELETE FROM accounts WHERE id = ?", [id]).changes > 0;
  }

  /** 清空当前在线角色（角色被删时调用；只在正好指向该角色时清） */
  clearOnlineRole(accountId: string, roleId: string): void {
    this.db.run("UPDATE accounts SET online_role_id = NULL, updated_at = ? WHERE id = ? AND online_role_id = ?", [
      Date.now(),
      accountId,
      roleId,
    ]);
  }

  /** 分页检索（keyword 匹配用户名） */
  list(options: { page: number; size: number; keyword?: string; status?: string }): AccountWithCountRow[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      where.push("a.username LIKE ?");
      params.push(`%${options.keyword}%`);
    }
    if (options.status) {
      where.push("a.status = ?");
      params.push(options.status);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.all<AccountWithCountRow>(
      `SELECT a.*, (SELECT COUNT(1) FROM roles r WHERE r.account_id = a.id) AS role_count
       FROM accounts a ${clause}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索的总数 */
  count(options: { keyword?: string; status?: string }): number {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      where.push("username LIKE ?");
      params.push(`%${options.keyword}%`);
    }
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.count(`SELECT COUNT(1) AS total FROM accounts ${clause}`, params);
  }

  /** 统计总数（概览用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM accounts");
  }

  /** 统计某时间点之后注册的数量（概览用） */
  countCreatedAfter(timestamp: number): number {
    return this.db.count("SELECT COUNT(1) AS total FROM accounts WHERE created_at >= ?", [timestamp]);
  }

  /** 当前有在线角色的账号数（概览用） */
  countOnline(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM accounts WHERE online_role_id IS NOT NULL");
  }
}

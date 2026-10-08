import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { RoleRow, RoleWithAccountRow } from "../rows";

/** 角色数据访问 */
@Injectable()
export class RoleRepository {
  constructor(private readonly db: DatabaseService) {}

  findById(id: string): RoleRow | undefined {
    return this.db.get<RoleRow>("SELECT * FROM roles WHERE id = ?", [id]);
  }

  findByAccount(accountId: string): RoleRow[] {
    return this.db.all<RoleRow>("SELECT * FROM roles WHERE account_id = ? ORDER BY created_at ASC", [accountId]);
  }

  /** 同一账号下是否已有同名角色（excludeId 用于「改自己的名字不算重复」） */
  findByAccountAndName(accountId: string, name: string, excludeId?: string): RoleRow | undefined {
    if (excludeId) return this.db.get<RoleRow>("SELECT * FROM roles WHERE account_id = ? AND name = ? AND id <> ?", [accountId, name, excludeId]);
    return this.db.get<RoleRow>("SELECT * FROM roles WHERE account_id = ? AND name = ?", [accountId, name]);
  }

  countByAccount(accountId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM roles WHERE account_id = ?", [accountId]);
  }

  insert(row: RoleRow): void {
    this.db.run(
      `INSERT INTO roles (id, account_id, name, occupation, sex, level, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.account_id, row.name, row.occupation, row.sex, row.level, row.data, row.created_at, row.updated_at],
    );
  }

  /** 全量覆盖（进度保存：data 与索引字段一起换） */
  replace(row: RoleRow): boolean {
    return (
      this.db.execute(
        `UPDATE roles SET name = ?, occupation = ?, sex = ?, level = ?, data = ?, updated_at = ? WHERE id = ?`,
        [row.name, row.occupation, row.sex, row.level, row.data, row.updated_at, row.id],
      ).changes > 0
    );
  }

  /** 局部更新（管理端只改某几个字段时用） */
  updateById(id: string, patch: { name?: string; occupation?: string; sex?: string; level?: number; data?: string; updated_at?: number }): boolean {
    const fields: string[] = [];
    const params: SqlParam[] = [];
    if (patch.name !== undefined) {
      fields.push("name = ?");
      params.push(patch.name);
    }
    if (patch.occupation !== undefined) {
      fields.push("occupation = ?");
      params.push(patch.occupation);
    }
    if (patch.sex !== undefined) {
      fields.push("sex = ?");
      params.push(patch.sex);
    }
    if (patch.level !== undefined) {
      fields.push("level = ?");
      params.push(patch.level);
    }
    if (patch.data !== undefined) {
      fields.push("data = ?");
      params.push(patch.data);
    }
    if (fields.length === 0) return this.findById(id) !== undefined;
    fields.push("updated_at = ?");
    params.push(patch.updated_at ?? Date.now());
    params.push(id);
    return this.db.execute(`UPDATE roles SET ${fields.join(", ")} WHERE id = ?`, params).changes > 0;
  }

  deleteById(id: string): boolean {
    return this.db.execute("DELETE FROM roles WHERE id = ?", [id]).changes > 0;
  }

  /** 删除某账号的全部角色 */
  deleteByAccount(accountId: string): number {
    return this.db.execute("DELETE FROM roles WHERE account_id = ?", [accountId]).changes;
  }

  /** 管理端分页检索（keyword 匹配角色名或角色 id；accountId 限定账号） */
  list(options: { page: number; size: number; keyword?: string; accountId?: string }): RoleWithAccountRow[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      where.push("(r.name LIKE ? OR r.id LIKE ?)");
      params.push(`%${options.keyword}%`, `%${options.keyword}%`);
    }
    if (options.accountId) {
      where.push("r.account_id = ?");
      params.push(options.accountId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.all<RoleWithAccountRow>(
      `SELECT r.*, a.username AS account_name, a.online_role_id AS account_online_role_id
       FROM roles r LEFT JOIN accounts a ON a.id = r.account_id
       ${clause}
       ORDER BY r.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  count(options: { keyword?: string; accountId?: string }): number {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      where.push("(name LIKE ? OR id LIKE ?)");
      params.push(`%${options.keyword}%`, `%${options.keyword}%`);
    }
    if (options.accountId) {
      where.push("account_id = ?");
      params.push(options.accountId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.count(`SELECT COUNT(1) AS total FROM roles ${clause}`, params);
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM roles");
  }
}

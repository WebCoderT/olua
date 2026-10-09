import { Injectable } from "@nestjs/common";
import { AdminRole, AdminRoleValue } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { DatabaseService } from "../database.service";
import { AdminRow } from "../rows";

/** 管理员列表查询条件 */
export interface AdminListOptions {
  page: number;
  size: number;
  /** 模糊匹配管理员账号名 */
  keyword?: string;
  role?: string;
}

/** 管理员数据访问（与玩家账号分表：两种身份不共用一张表，避免权限混用） */
@Injectable()
export class AdminRepository {
  constructor(private readonly db: DatabaseService) {}

  findById(id: string): AdminRow | undefined {
    return this.db.get<AdminRow>("SELECT * FROM admins WHERE id = ?", [id]);
  }

  findByUsername(username: string): AdminRow | undefined {
    return this.db.get<AdminRow>("SELECT * FROM admins WHERE username = ?", [username]);
  }

  /** 分页列表（按创建时间升序） */
  list(options: AdminListOptions): AdminRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.keyword) {
      where.push("username LIKE ?");
      params.push(`%${options.keyword}%`);
    }
    if (options.role) {
      where.push("role = ?");
      params.push(options.role);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(options.size, (options.page - 1) * options.size);
    return this.db.all<AdminRow>(`SELECT * FROM admins ${clause} ORDER BY created_at ASC LIMIT ? OFFSET ?`, params);
  }

  /** 统计（与 list 用同一套条件） */
  count(options: { keyword?: string; role?: string } = {}): number {
    const where: string[] = [];
    const params: string[] = [];
    if (options.keyword) {
      where.push("username LIKE ?");
      params.push(`%${options.keyword}%`);
    }
    if (options.role) {
      where.push("role = ?");
      params.push(options.role);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.count(`SELECT COUNT(1) AS total FROM admins ${clause}`, params);
  }

  insert(row: AdminRow): void {
    this.db.run(
      `INSERT INTO admins (id, username, password, status, role, token_version, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.username,
        row.password,
        row.status,
        row.role,
        row.token_version,
        row.created_at,
        row.updated_at,
        row.last_login_at,
      ],
    );
  }

  updateById(
    id: string,
    patch: {
      status?: string;
      role?: AdminRoleValue;
      password?: string;
      token_version?: number;
      last_login_at?: number;
      updated_at?: number;
    },
  ): boolean {
    const fields: string[] = [];
    const params: (string | number)[] = [];
    if (patch.status !== undefined) {
      fields.push("status = ?");
      params.push(patch.status);
    }
    if (patch.role !== undefined) {
      fields.push("role = ?");
      params.push(patch.role);
    }
    if (patch.password !== undefined) {
      fields.push("password = ?");
      params.push(patch.password);
    }
    if (patch.token_version !== undefined) {
      fields.push("token_version = ?");
      params.push(patch.token_version);
    }
    if (patch.last_login_at !== undefined) {
      fields.push("last_login_at = ?");
      params.push(patch.last_login_at);
    }
    if (fields.length === 0) return this.findById(id) !== undefined;
    fields.push("updated_at = ?");
    params.push(patch.updated_at ?? Date.now());
    params.push(id);
    return this.db.execute(`UPDATE admins SET ${fields.join(", ")} WHERE id = ?`, params).changes > 0;
  }

  /**
   * 改口令 + 作废已签发令牌（一次写完，避免出现「密码改了但版本号没加」的半截状态）
   *
   * 自增写在 SQL 里：并发下「读出来加一再写回」会丢自增。
   */
  updatePasswordAndBumpVersion(id: string, password: string): void {
    this.db.run("UPDATE admins SET password = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?", [
      password,
      Date.now(),
      id,
    ]);
  }

  deleteById(id: string): boolean {
    return this.db.execute("DELETE FROM admins WHERE id = ?", [id]).changes > 0;
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM admins");
  }

  /** 某个角色的人数（保护最后一个超级管理员用） */
  countByRole(role: AdminRoleValue): number {
    return this.db.count("SELECT COUNT(1) AS total FROM admins WHERE role = ?", [role]);
  }

  /** 除某人之外，还有几个启用的超级管理员 */
  countActiveSuperAdminsExcept(id: string): number {
    return this.db.count(`SELECT COUNT(1) AS total FROM admins WHERE role = ? AND status = ? AND id <> ?`, [
      AdminRole.SUPER,
      ENTITY_STATUS.ACTIVE,
      id,
    ]);
  }
}

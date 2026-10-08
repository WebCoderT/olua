import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { RoleRow, RoleWithAccountRow } from "../rows";

/**
 * 角色筛选条件（管理端列表 / 批量操作共用）
 *
 * `online` 的语义与列表里的「在线」徽章完全一致：**该角色是所属账号当前选中的那个**
 * （账号表的 online_role_id），不是「玩家此刻真的在游戏里」—— 后者需要心跳，本阶段不做。
 */
export interface RoleFilter {
  keyword?: string;
  accountId?: string;
  /** true 只看在线角色；false 只看离线角色；不传不筛 */
  online?: boolean;
  occupation?: string;
  sex?: string;
  minLevel?: number;
  maxLevel?: number;
}

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

  /** 按 id 批量取（批量删除要先知道它们属于哪些账号，好清理在线标记） */
  findManyByIds(ids: string[]): RoleRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.all<RoleRow>(`SELECT * FROM roles WHERE id IN (${placeholders})`, ids);
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
      `INSERT INTO roles (id, account_id, name, occupation, sex, level, data, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.account_id, row.name, row.occupation, row.sex, row.level, row.data, row.revision, row.created_at, row.updated_at],
    );
  }

  /**
   * 全量覆盖（玩家保存进度：data 与索引字段一起换，并推进修订号）
   *
   * 修订号用 `revision + 1` 而不是「读出来加一再写回」：并发下后者会丢计数。
   */
  replace(row: RoleRow): boolean {
    return (
      this.db.execute(
        `UPDATE roles SET name = ?, occupation = ?, sex = ?, level = ?, data = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        [row.name, row.occupation, row.sex, row.level, row.data, row.updated_at, row.id],
      ).changes > 0
    );
  }

  /** 局部更新（管理端只改某几个字段时用；同样推进修订号） */
  updateById(
    id: string,
    patch: { name?: string; occupation?: string; sex?: string; level?: number; data?: string; updated_at?: number },
  ): boolean {
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
    fields.push("revision = revision + 1");
    fields.push("updated_at = ?");
    params.push(patch.updated_at ?? Date.now());
    params.push(id);
    return this.db.execute(`UPDATE roles SET ${fields.join(", ")} WHERE id = ?`, params).changes > 0;
  }

  deleteById(id: string): boolean {
    return this.db.execute("DELETE FROM roles WHERE id = ?", [id]).changes > 0;
  }

  /** 按 id 批量删除，返回真正删掉的条数（传进来的 id 可能已被别处删掉） */
  deleteByIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.execute(`DELETE FROM roles WHERE id IN (${placeholders})`, ids).changes;
  }

  /** 删除某账号的全部角色 */
  deleteByAccount(accountId: string): number {
    return this.db.execute("DELETE FROM roles WHERE account_id = ?", [accountId]).changes;
  }

  /** 管理端分页检索（条件见 RoleFilter；一次 join 拿全账号名与账号的在线角色，避免 N+1） */
  list(options: RoleFilter & { page: number; size: number }): RoleWithAccountRow[] {
    const { clause, params } = this.buildWhere(options);
    return this.db.all<RoleWithAccountRow>(
      `SELECT r.*, a.username AS account_name, a.online_role_id AS account_online_role_id
       FROM roles r LEFT JOIN accounts a ON a.id = r.account_id
       ${clause}
       ORDER BY r.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 条数（与 list 同一套条件，别各写一份） */
  count(options: RoleFilter): number {
    const { clause, params } = this.buildWhere(options);
    return this.db.count(
      `SELECT COUNT(1) AS total FROM roles r LEFT JOIN accounts a ON a.id = r.account_id ${clause}`,
      params,
    );
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM roles");
  }

  /** 拼 where（list 与 count 共用；`online` 靠 join 出来的账号在线角色判定） */
  private buildWhere(options: RoleFilter): { clause: string; params: SqlParam[] } {
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
    if (options.occupation) {
      where.push("r.occupation = ?");
      params.push(options.occupation);
    }
    if (options.sex) {
      where.push("r.sex = ?");
      params.push(options.sex);
    }
    if (options.minLevel !== undefined) {
      where.push("r.level >= ?");
      params.push(options.minLevel);
    }
    if (options.maxLevel !== undefined) {
      where.push("r.level <= ?");
      params.push(options.maxLevel);
    }
    if (options.online !== undefined) {
      where.push(options.online ? "a.online_role_id = r.id" : "(a.online_role_id IS NULL OR a.online_role_id <> r.id)");
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

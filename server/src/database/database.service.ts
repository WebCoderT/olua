import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdminRole } from "../common/constants/permission";

/** 可绑定的参数值（node:sqlite 支持的类型） */
export type SqlParam = string | number | bigint | null | Uint8Array;

/**
 * SQLite 连接（Node 22 内置 `node:sqlite`，**零原生依赖**）
 *
 * 只做「连接 + 建表 + 薄封装」，SQL 一律写在各 Repository 里（便于全文检索某张表的用法）。
 * 数据文件路径来自配置（DB_PATH），`:memory:` 表示内存库（e2e 测试用）。
 */
@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: DatabaseSync;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>("dbPath") ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL 提升并发读性能；外键打开后删账号会级联删角色
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.logger.log(`SQLite 就绪：${path}`);
  }

  /** 建表（IF NOT EXISTS，可重复执行；新增字段时在此加 ALTER 并做存在性判断） */
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE,
        password       TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'active',
        online_role_id TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );

      CREATE TABLE IF NOT EXISTS roles (
        id         TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        occupation TEXT NOT NULL DEFAULT '',
        sex        TEXT NOT NULL DEFAULT '',
        level      INTEGER NOT NULL DEFAULT 1,
        data       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_roles_account ON roles(account_id);

      CREATE TABLE IF NOT EXISTS admins (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        role          TEXT NOT NULL DEFAULT '${AdminRole.ADMIN}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );
    `);

    // 存量库补列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
    this.ensureColumn("admins", "role", `TEXT NOT NULL DEFAULT '${AdminRole.ADMIN}'`);
    this.ensureSuperAdmin();
  }

  /**
   * 存量库兜底：老库没有 role 列，补列后所有管理员都成了「管理员」——
   * 那样**没人有 admin:manage**，等于后台再也管不了管理员。
   * 所以库里有管理员却一个超管都没有时，把最早创建的那位提为超管（一次性）。
   * 新库不受影响：第一个注册的管理员本来就是超管（见 AdminAuthService.register）。
   */
  private ensureSuperAdmin(): void {
    if (this.count("SELECT COUNT(1) AS total FROM admins WHERE role = ?", [AdminRole.SUPER]) > 0) return;
    const oldest = this.get<{ id: string }>("SELECT id FROM admins ORDER BY created_at ASC LIMIT 1");
    if (!oldest) return;
    this.run("UPDATE admins SET role = ? WHERE id = ?", [AdminRole.SUPER, oldest.id]);
    this.logger.log(`存量库没有超级管理员，已把最早创建的管理员提升为超级管理员（${oldest.id}）`);
  }

  /** 给已有表补一列（列已存在则不动；SQLite 的 ADD COLUMN 带 NOT NULL 必须有默认值） */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    this.logger.log(`表 ${table} 补列：${column}`);
  }

  /** 执行写语句（无返回） */
  run(sql: string, params: SqlParam[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  /** 执行写语句并返回影响行数（用于判断是否存在） */
  execute(sql: string, params: SqlParam[] = []): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /** 取一行（无结果返回 undefined） */
  get<T>(sql: string, params: SqlParam[] = []): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    // node:sqlite 返回 null 原型对象，转成普通对象免得下游（如 JSON 序列化、展开）踩坑
    return row ? ({ ...row } as unknown as T) : undefined;
  }

  /** 取多行 */
  all<T>(sql: string, params: SqlParam[] = []): T[] {
    return (this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]).map((row) => ({ ...row }) as unknown as T);
  }

  /** 取单个数值（COUNT 之类） */
  count(sql: string, params: SqlParam[] = []): number {
    const row = this.get<Record<string, number>>(sql, params);
    if (!row) return 0;
    const value = Object.values(row)[0];
    return Number(value ?? 0);
  }

  /** 事务（回调内抛异常会整体回滚） */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

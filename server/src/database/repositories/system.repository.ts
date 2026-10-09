import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";

/** 系统信息用的数据访问（只读；SQL 与其他仓储一样收在 database/repositories 下） */
@Injectable()
export class SystemRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 各用户表的行数
   *
   * 表名**动态枚举 `sqlite_master`** 而不是写死一张清单：以后加表，这一页不用跟着改
   * （写死的清单必然在某次加表后变成「少了一行而且没人发现」）。
   */
  listTableCounts(): { table: string; rows: number }[] {
    const tables = this.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
    );
    return tables.map((row) => ({
      table: row.name,
      // 表名来自 sqlite_master（不是请求参数），仍用双引号包住 —— 标识符的引用规则与字符串值不同，
      // 双引号是 SQLite 的标识符引法，能兜住名字里带空格/关键字的表
      rows: this.db.count(`SELECT COUNT(1) AS total FROM "${row.name}"`),
    }));
  }
}

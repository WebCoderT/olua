import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MonsterSkillRow } from "../rows";

/**
 * 怪物技能挂载数据访问（#372）
 *
 * 与其它配置表的最大差别：**这张表是可增删的**（怪物技能天然会加，不像角色技能清单固定）。
 * 管理端按「一只怪一份清单」整份替换（`replaceForMonster`），没有的行就是「不放了」——
 * 单个增删的接口会把「删除中间的某条」拆成一串调用，反而更容易写出半份清单。
 *
 * 服务端 AI 的读取走 `listAll()`（表很小：一两只怪 × 两三条技能），
 * 由 `MonsterAiService` 做 1 秒 TTL 缓存 —— 管理端改动在实时进程里最多 1 秒生效，
 * 不需要跨进程通知（两个进程共享 SQLite）。
 */
@Injectable()
export class MonsterSkillRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过：运营改过的优先级 / 冷却不会被配置更新覆盖回去） */
  seedRow(row: MonsterSkillRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO monster_skills (monster_key, skill_id, priority, cooldown, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.monster_key, row.skill_id, row.priority, row.cooldown, row.updated_at],
    );
  }

  /** 某只怪的完整清单（按优先级 + 技能 id 排，AI 按这个顺序尝试） */
  listByMonster(monsterKey: string): MonsterSkillRow[] {
    return this.db.all<MonsterSkillRow>(
      "SELECT * FROM monster_skills WHERE monster_key = ? ORDER BY priority ASC, skill_id ASC",
      [monsterKey],
    );
  }

  /** 全量清单（服务端 AI 的缓存来源；表很小，一次读全比按怪轮询省事） */
  listAll(): MonsterSkillRow[] {
    return this.db.all<MonsterSkillRow>("SELECT * FROM monster_skills ORDER BY monster_key ASC, priority ASC, skill_id ASC");
  }

  count(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM monster_skills");
  }

  /** 某个技能被几只怪挂着（删技能前查引用：被引用中的技能拒绝删除） */
  countBySkill(skillId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM monster_skills WHERE skill_id = ?", [skillId]);
  }

  /**
   * 整份替换某只怪的清单（先删后插，放在一个事务里：中途失败不会留下半份）
   *
   * 空数组 = 这只怪不再放任何技能（保留一条都不剩，AI 自然回退到普攻）。
   */
  replaceForMonster(monsterKey: string, rows: MonsterSkillRow[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM monster_skills WHERE monster_key = ?", [monsterKey]);
      for (const row of rows) {
        this.db.run(
          `INSERT INTO monster_skills (monster_key, skill_id, priority, cooldown, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [monsterKey, row.skill_id, row.priority, row.cooldown, row.updated_at],
        );
      }
    });
  }
}

import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import {
  GuildApplicationRow,
  GuildApplicationWithRoleRow,
  GuildListRow,
  GuildMemberRow,
  GuildMemberWithRoleRow,
  GuildRow,
} from "../rows";

/**
 * 帮会数据访问（#388）
 *
 * 三张表各管一件事：
 * - `guilds`：帮会本身（名字 / 公告 / 帮主 / 占位的等级与资金）
 * - `guild_members`：谁在哪个帮会、什么职位 —— `role_id` 唯一索引保证「一个人只能在一个帮会」
 * - `guild_applications`：入帮申请（同一人对同一帮会只有一行，重复申请覆盖留言）
 *
 * 成员 / 申请列表都要展示**角色名与等级**，所以查询里 join `roles` —— 那是索引列上的冗余，
 * 不落第二份快照（角色改名 / 升级后列表立刻是新的，不需要同步）。
 */
@Injectable()
export class GuildRepository {
  constructor(private readonly db: DatabaseService) {}

  //#region 帮会

  /** 帮会列表：按人数降序（人多的在前），同人数按创建时间升序（老帮会在前） */
  list(): GuildListRow[] {
    return this.db.all<GuildListRow>(
      `SELECT g.*,
              (SELECT COUNT(1) FROM guild_members m WHERE m.guild_id = g.id) AS member_count,
              COALESCE((SELECT r.name FROM roles r WHERE r.id = g.leader_id), '') AS leader_name
         FROM guilds g
        ORDER BY member_count DESC, g.created_at ASC`,
    );
  }

  findById(id: string): GuildRow | undefined {
    return this.db.get<GuildRow>("SELECT * FROM guilds WHERE id = ?", [id]);
  }

  findByName(name: string): GuildRow | undefined {
    return this.db.get<GuildRow>("SELECT * FROM guilds WHERE name = ?", [name]);
  }

  /** 列表行形态的单条（管理端详情 / 创建后回显都用它，形状与列表一致） */
  findListRow(id: string): GuildListRow | undefined {
    return this.db.get<GuildListRow>(
      `SELECT g.*,
              (SELECT COUNT(1) FROM guild_members m WHERE m.guild_id = g.id) AS member_count,
              COALESCE((SELECT r.name FROM roles r WHERE r.id = g.leader_id), '') AS leader_name
         FROM guilds g
        WHERE g.id = ?`,
      [id],
    );
  }

  insert(row: GuildRow): void {
    this.db.run(
      `INSERT INTO guilds (id, name, notice, leader_id, level, funds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.notice, row.leader_id, row.level, row.funds, row.created_at, row.updated_at],
    );
  }

  updateNotice(id: string, notice: string, now: number): void {
    this.db.run("UPDATE guilds SET notice = ?, updated_at = ? WHERE id = ?", [notice, now, id]);
  }

  updateName(id: string, name: string, now: number): void {
    this.db.run("UPDATE guilds SET name = ?, updated_at = ? WHERE id = ?", [name, now, id]);
  }

  updateLeader(id: string, leaderId: string, now: number): void {
    this.db.run("UPDATE guilds SET leader_id = ?, updated_at = ? WHERE id = ?", [leaderId, now, id]);
  }

  /** 解散（成员与申请靠外键 ON DELETE CASCADE 一起清掉，不需要手工删两张表） */
  remove(id: string): void {
    this.db.run("DELETE FROM guilds WHERE id = ?", [id]);
  }

  count(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM guilds");
  }

  /**
   * 事务（与 zone 仓储同款：事务开在仓储里，业务层只声明「这几步要么全成要么全不成」）
   *
   * 帮会里必须原子的是两处：建帮（帮会行 + 帮主成员行）、转让（两行职位 + leader_id）。
   * 少了事务就会留下「有帮会没有帮主」或「帮主显示是他、权限却还是我」这种半成品状态。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  //#endregion

  //#region 成员

  /** 某个角色所在的行（未加入任何帮会返回 undefined；唯一索引保证最多一行） */
  membershipOf(roleId: string): GuildMemberRow | undefined {
    return this.db.get<GuildMemberRow>("SELECT * FROM guild_members WHERE role_id = ?", [roleId]);
  }

  /** 某个角色所在的帮会（未加入返回 undefined） */
  guildOfRole(roleId: string): GuildRow | undefined {
    return this.db.get<GuildRow>(
      "SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id = g.id WHERE m.role_id = ?",
      [roleId],
    );
  }

  /** 成员列表：帮主 → 副帮主 → 成员，同职位按入帮时间升序 */
  members(guildId: string): GuildMemberWithRoleRow[] {
    return this.db.all<GuildMemberWithRoleRow>(
      `SELECT m.*, r.name AS role_name, r.level AS role_level, r.occupation AS role_occupation
         FROM guild_members m
         JOIN roles r ON r.id = m.role_id
        WHERE m.guild_id = ?
        ORDER BY CASE m.rank WHEN 'leader' THEN 0 WHEN 'vice' THEN 1 ELSE 2 END ASC, m.joined_at ASC`,
      [guildId],
    );
  }

  countMembers(guildId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM guild_members WHERE guild_id = ?", [guildId]);
  }

  insertMember(guildId: string, roleId: string, rank: string, now: number): void {
    this.db.run("INSERT INTO guild_members (guild_id, role_id, rank, joined_at) VALUES (?, ?, ?, ?)", [
      guildId,
      roleId,
      rank,
      now,
    ]);
  }

  updateRank(guildId: string, roleId: string, rank: string): void {
    this.db.run("UPDATE guild_members SET rank = ? WHERE guild_id = ? AND role_id = ?", [rank, guildId, roleId]);
  }

  removeMember(guildId: string, roleId: string): void {
    this.db.run("DELETE FROM guild_members WHERE guild_id = ? AND role_id = ?", [guildId, roleId]);
  }

  //#endregion

  //#region 申请

  /** 待审批列表：按申请时间升序（先来的先处理） */
  applications(guildId: string): GuildApplicationWithRoleRow[] {
    return this.db.all<GuildApplicationWithRoleRow>(
      `SELECT a.*, r.name AS role_name, r.level AS role_level
         FROM guild_applications a
         JOIN roles r ON r.id = a.role_id
        WHERE a.guild_id = ?
        ORDER BY a.created_at ASC`,
      [guildId],
    );
  }

  findApplication(guildId: string, roleId: string): GuildApplicationRow | undefined {
    return this.db.get<GuildApplicationRow>("SELECT * FROM guild_applications WHERE guild_id = ? AND role_id = ?", [
      guildId,
      roleId,
    ]);
  }

  /** 写一条申请（已存在则覆盖留言与时间；「重复申请」不该堆出两条，只会更新） */
  upsertApplication(guildId: string, roleId: string, message: string, now: number): void {
    this.db.run(
      `INSERT INTO guild_applications (guild_id, role_id, message, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, role_id) DO UPDATE SET message = excluded.message, created_at = excluded.created_at`,
      [guildId, roleId, message, now],
    );
  }

  removeApplication(guildId: string, roleId: string): void {
    this.db.run("DELETE FROM guild_applications WHERE guild_id = ? AND role_id = ?", [guildId, roleId]);
  }

  /** 角色退帮 / 被踢 / 解散时，把它挂在别的帮会下的申请一并清掉（避免「幽灵申请」） */
  removeApplicationsOfRole(roleId: string): void {
    this.db.run("DELETE FROM guild_applications WHERE role_id = ?", [roleId]);
  }

  //#endregion
}

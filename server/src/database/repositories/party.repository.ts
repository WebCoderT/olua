import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { PartyMemberRow, PartyMemberWithRoleRow, PartyRow } from "../rows";

/**
 * 队伍数据访问（#399）
 *
 * ## 为什么落库而不是纯内存
 * 纯内存（像聊天的限频账、拾取的掉落账）在实时进程重启时会**一次性清空所有人的队伍** ——
 * 部署一次、崩一次，玩家就得重新组队。队伍是「弱持久」的东西：重连回来还在同一个队
 * 才符合预期。落库还顺带拿到「一个角色只能在一个队里」这条约束（`party_members.role_id`
 * 唯一索引），并发加入时不用先查再写。
 *
 * ## 队长的唯一写者
 * `parties.leader_role_id`。成员表不存 `is_leader`：两个写者在转让时必然漂一次，
 * 而漂的表现是「两个人都能踢人」。
 *
 * ## 整表读的两个入口
 * 实时进程启动时把两张表整份读进内存（`allParties` / `allMemberships`），之后
 * 读写都走内存 + 写穿（见 PartyService）。队伍表规模 = 在线玩家数 / 队伍人数，很小。
 */
@Injectable()
export class PartyRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 我的队伍（不在队伍里返回 undefined；一次 JOIN 拿全，省得业务层查两次） */
  findPartyOf(roleId: string): PartyRow | undefined {
    return this.db.get<PartyRow>(
      `SELECT p.* FROM parties p
         JOIN party_members m ON m.party_id = p.id
        WHERE m.role_id = ?
        LIMIT 1`,
      [roleId],
    );
  }

  /**
   * 队伍成员（带角色当前的名字与等级）
   *
   * 排序固定「先来的在前 + roleId 兜底」：与 `joined_at` 顺序一致的两条记录在极端情况下
   * （同一毫秒入队）不会每次返回不同顺序 —— 队长退出时的「自动移交给最早加入的成员」
   * 依赖这个顺序，顺序不稳就会移交给人不同的人。
   */
  membersOf(partyId: string): PartyMemberWithRoleRow[] {
    return this.db.all<PartyMemberWithRoleRow>(
      `SELECT m.*, r.name AS role_name, r.level AS level
         FROM party_members m
         LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.party_id = ?
        ORDER BY m.joined_at ASC, m.role_id ASC`,
      [partyId],
    );
  }

  countMembers(partyId: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM party_members WHERE party_id = ?", [partyId]);
  }

  /** 队伍里有没有这个角色（踢人 / 转让的目标校验） */
  findMember(partyId: string, roleId: string): PartyMemberRow | undefined {
    return this.db.get<PartyMemberRow>("SELECT * FROM party_members WHERE party_id = ? AND role_id = ? LIMIT 1", [
      partyId,
      roleId,
    ]);
  }

  insertParty(row: PartyRow): void {
    this.db.run("INSERT INTO parties (id, leader_role_id, created_at) VALUES (?, ?, ?)", [
      row.id,
      row.leader_role_id,
      row.created_at,
    ]);
  }

  insertMember(row: PartyMemberRow): void {
    this.db.run("INSERT INTO party_members (party_id, role_id, joined_at) VALUES (?, ?, ?)", [
      row.party_id,
      row.role_id,
      row.joined_at,
    ]);
  }

  removeMember(roleId: string): void {
    this.db.run("DELETE FROM party_members WHERE role_id = ?", [roleId]);
  }

  /** 换队长（成员不变；队长只有这一个写者） */
  setLeader(partyId: string, roleId: string): void {
    this.db.run("UPDATE parties SET leader_role_id = ? WHERE id = ?", [roleId, partyId]);
  }

  /** 解散：先删成员再删本体（外键 CASCADE 也会删，但显式写出来读代码的人不用去查 schema） */
  deleteParty(partyId: string): void {
    this.db.run("DELETE FROM party_members WHERE party_id = ?", [partyId]);
    this.db.run("DELETE FROM parties WHERE id = ?", [partyId]);
  }

  //#region 整表读（PartyService 启动时灌内存快照）

  allParties(): PartyRow[] {
    return this.db.all<PartyRow>("SELECT * FROM parties");
  }

  allMemberships(): PartyMemberRow[] {
    return this.db.all<PartyMemberRow>("SELECT * FROM party_members ORDER BY joined_at ASC, role_id ASC");
  }

  //#endregion
}

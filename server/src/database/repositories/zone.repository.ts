import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { WorldMetaRow, ZoneRow } from "../rows";

/**
 * 区服与世界代际的数据访问（#295 阶段二：多开区 / 合并区）
 *
 * zones 是运营数据（管理员开区 / 合并），账号注册时引用；world_meta 是世界服务的
 * 跨进程「配置失效」信号（epoch 变了 = 库里的世界被改写过了，内存里的旧状态作废）。
 * 两者都只有服务端写，不需要乐观锁列。
 */
@Injectable()
export class ZoneRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 全部区服（含已合并的，管理端列表用；按 id 升序 = 开区顺序） */
  listAll(): ZoneRow[] {
    return this.db.all<ZoneRow>("SELECT * FROM zones ORDER BY id ASC");
  }

  /** 还活着的区服（未合并；玩家注册下拉框只列这些） */
  listLive(): ZoneRow[] {
    return this.db.all<ZoneRow>("SELECT * FROM zones WHERE merged_into IS NULL ORDER BY id ASC");
  }

  findById(id: number): ZoneRow | undefined {
    return this.db.get<ZoneRow>("SELECT * FROM zones WHERE id = ?", [id]);
  }

  /** 查一个活区（未合并；注册校验与合并目标校验都用它） */
  findLiveById(id: number): ZoneRow | undefined {
    return this.db.get<ZoneRow>("SELECT * FROM zones WHERE id = ? AND merged_into IS NULL", [id]);
  }

  findByName(name: string): ZoneRow | undefined {
    return this.db.get<ZoneRow>("SELECT * FROM zones WHERE name = ?", [name]);
  }

  /** 开新区（名字唯一性由 UNIQUE 约束兜底，调用方先查重给友好报错） */
  create(name: string, now: number): number {
    return this.db.insertReturningId(
      "INSERT INTO zones (name, merged_into, created_at, updated_at) VALUES (?, NULL, ?, ?)",
      [name, now, now],
    );
  }

  /** 合并区标记（from 区打上 merged_into；调用方负责在同一事务里搬账号与世界状态） */
  markMerged(fromId: number, toId: number, now: number): void {
    this.db.run("UPDATE zones SET merged_into = ?, updated_at = ? WHERE id = ?", [toId, now, fromId]);
  }

  /** 某个区名下的账号数（合并前给管理端确认用） */
  countAccounts(zoneId: number): number {
    return this.db.count("SELECT COUNT(1) AS total FROM accounts WHERE zone_id = ?", [zoneId]);
  }

  /**
   * 事务透传（回调内抛异常整体回滚）
   *
   * 合并区要在**一个事务**里搬账号 + 重排世界发牌 + 打标记 + 升代际，涉及的 SQL 分属
   * 三四个仓储 —— 编排留在 ZoneService，但「开事务」这件事只能由数据层做
   * （业务模块不许直接摸 DatabaseService，见 audit-server-boundaries）。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  //#region 世界代际（跨进程配置失效信号）

  /** 当前代际（表恒有一行，id=1，migrate 时 seed） */
  getEpoch(): number {
    const row = this.db.get<WorldMetaRow>("SELECT * FROM world_meta WHERE id = 1");
    return Number(row?.epoch ?? 0);
  }

  /** 代际 +1（合并区成功后调用；单行表原地加，并发由调用方的事务/时序保证） */
  bumpEpoch(): void {
    this.db.run("UPDATE world_meta SET epoch = epoch + 1 WHERE id = 1");
  }

  //#endregion
}

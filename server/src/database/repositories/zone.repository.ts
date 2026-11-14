import { Injectable } from "@nestjs/common";
import { DatabaseService, type SqlParam } from "../database.service";
import { ZoneRow, ZoneWorldMetaRow } from "../rows";

/**
 * 区服与世界代际的数据访问（#295 阶段二：多开区 / 合并区）
 *
 * zones 是运营数据（管理员开区 / 合并 / 状态），账号注册时引用；`zone_world_meta` 是世界
 * 服务的跨进程「配置失效」信号（#961 起按区：某个区的代际变了 = 那个区的库内世界被改写
 * 过了，内存里的旧状态作废）。两者都只有服务端写，不需要乐观锁列。
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
    return this.db.all<ZoneRow>("SELECT * FROM zones WHERE merged_into IS NULL ORDER BY sort ASC, id ASC");
  }

  /**
   * 登录页 / 注册下拉的可选区（#960）
   *
   * 与 `listLive` 同一条 SQL，但**语义不同**：这里要的是「能选的有哪些」——
   * 含 `closed` 区（管理端要能进去查历史），只是排序听运营的（`sort` 升序，同值按 id）。
   * 之所以让 `listLive` 也按 `sort`：玩家注册时看到的顺序应该和后台排的一致，
   * 否则「运营把新区顶上去」只对管理员生效。
   */
  listSelectable(): ZoneRow[] {
    return this.listLive();
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
  create(
    name: string,
    now: number,
    options: { openedAt?: number; sort?: number; recommended?: boolean; note?: string | null } = {},
  ): number {
    return this.db.insertReturningId(
      "INSERT INTO zones (name, status, sort, opened_at, recommended, note, merged_into, created_at, updated_at)" +
        " VALUES (?, 'open', ?, ?, ?, ?, NULL, ?, ?)",
      [
        name,
        options.sort ?? 0,
        options.openedAt ?? now,
        options.recommended ? 1 : 0,
        options.note ?? null,
        now,
        now,
      ],
    );
  }

  /**
   * 改运营字段（#961）
   *
   * **名字不在其中**：改名会让已经发出去的公告、客服话术、玩家口口相传的区名全部对不上，
   * 收益（少开一个区）远小于代价。同理 `merged_into` 也不在这里改（合并是专门的事务）。
   */
  updateSettings(
    id: number,
    patch: { sort?: number; recommended?: boolean; note?: string | null; openedAt?: number },
    now: number,
  ): void {
    const sets: string[] = [];
    const args: SqlParam[] = [];
    if (patch.sort !== undefined) {
      sets.push("sort = ?");
      args.push(patch.sort);
    }
    if (patch.recommended !== undefined) {
      sets.push("recommended = ?");
      args.push(patch.recommended ? 1 : 0);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      args.push(patch.note);
    }
    if (patch.openedAt !== undefined) {
      sets.push("opened_at = ?");
      args.push(patch.openedAt);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    args.push(now, id);
    this.db.run(`UPDATE zones SET ${sets.join(", ")} WHERE id = ?`, args);
  }

  /** 改状态（状态机由 ZoneService 判；这里只落库 —— 仓储不认识「维护中能不能关闭」这种规则） */
  setStatus(id: number, status: string, now: number): void {
    this.db.run("UPDATE zones SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
  }

  /**
   * 区状态全表（#961：实时进程的维护巡检、玩家侧的开放闸门都读它）
   *
   * 区数是个位数，全表读比维护缓存简单得多；调用方按秒级轮询也不心疼。
   */
  listStates(): Array<{ id: number; name: string; status: string; merged_into: number | null }> {
    return this.db.all<{ id: number; name: string; status: string; merged_into: number | null }>(
      "SELECT id, name, status, merged_into FROM zones ORDER BY id ASC",
    );
  }

  /** 单个区的状态（不存在返回 undefined） */
  stateOf(id: number): { id: number; name: string; status: string; merged_into: number | null } | undefined {
    return this.db.get<{ id: number; name: string; status: string; merged_into: number | null }>(
      "SELECT id, name, status, merged_into FROM zones WHERE id = ?",
      [id],
    );
  }

  /** 合并区标记（from 区打上 merged_into；调用方负责在同一事务里搬账号与世界状态） */
  markMerged(fromId: number, toId: number, now: number): void {
    this.db.run("UPDATE zones SET merged_into = ?, status = 'closed', updated_at = ? WHERE id = ?", [toId, now, fromId]);
  }

  /**
   * 本区账号数（#961 聚合 / 合并前确认）
   *
   * 「本区账号」= 在这个区**有角色**的账号。账号本身不属于区（#957），所以只能用
   * `EXISTS` 反查；`active_zone_id` 不能用 —— 那只是「上次在哪个区看角色」。
   */
  countAccounts(zoneId: number): number {
    return this.db.count(
      "SELECT COUNT(1) AS total FROM accounts a WHERE EXISTS (SELECT 1 FROM roles r WHERE r.account_id = a.id AND r.zone_id = ?)",
      [zoneId],
    );
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

  /**
   * 区级代际全表（#961）
   *
   * 世界 tick 每拍读它，与内存里那份 Map 比：**只有变化的那几个区**的房间作废。
   * 区数个位数，全表读的代价远小于「一次合并惊动全服」的代价。
   */
  listEpochs(): ZoneWorldMetaRow[] {
    return this.db.all<ZoneWorldMetaRow>("SELECT * FROM zone_world_meta");
  }

  /**
   * 只 bump 指定区（合并区用：作废参与合并的那两个区的内存世界）
   *
   * `NULL → 0 → 1` 两个方向都算「变了」：没有行的区（新开的区）读作 0，
   * 一旦被 bump 就会写成 1，第一次合并就能正常触发重载。
   */
  bumpEpochs(zoneIds: number[]): void {
    for (const zoneId of zoneIds) {
      this.db.run(
        "INSERT INTO zone_world_meta (zone_id, epoch) VALUES (?, 1)" +
          " ON CONFLICT(zone_id) DO UPDATE SET epoch = epoch + 1",
        [zoneId],
      );
    }
  }

  //#endregion
}

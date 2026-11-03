import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapCollisionRow } from "../rows";

/**
 * 碰撞盒数据访问（#676：碰撞区域从 TMX 搬到后台）
 *
 * ## 这张表为什么比 `map_spawn_areas` 还薄
 *
 * 碰撞盒没有名字、没有种类、没有归属对象 —— 它就是一个「这块地方过不去」的矩形。
 * 所以仓储只有最朴素的增删改查，**连唯一索引都没有**：两个位置尺寸完全一样的碰撞盒
 * 在语义上是冗余的，但不是错的（删掉一个不影响另一个），拿它当约束只会在画布上
 * 「画两次同一个框」时莫名其妙地 409。
 *
 * ## 校验不在这一层
 *
 * 矩形合法性（宽高下限）与「整块在图外」的展示结论都在 `map.service`：仓储只写 SQL。
 * 这样 e2e 能直接对着服务端的文案断言，也避免「仓储里抛业务异常」这种分层混乱。
 */
@Injectable()
export class MapCollisionRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 按行 id 取一条（改 / 删前确认存在，且必须属于路径里那张图） */
  findById(id: number): MapCollisionRow | null {
    return this.db.get<MapCollisionRow>("SELECT * FROM map_collisions WHERE id = ?", [id]) ?? null;
  }

  /** 插入一行，返回带 id 的完整行（接口要回显，别让客户端再猜一次 id） */
  insert(row: Omit<MapCollisionRow, "id">): MapCollisionRow {
    const id = this.db.insertReturningId(
      `INSERT INTO map_collisions (map_id, cx, cy, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.map_id, row.cx, row.cy, row.w, row.h, row.updated_at],
    );
    const created = this.findById(id);
    if (!created) throw new Error(`碰撞盒刚插入却读不回来（id=${id}），库状态异常`);
    return created;
  }

  /** 整行覆盖（管理端表单是整份提交，不做分字段更新） */
  update(row: MapCollisionRow): void {
    this.db.run(
      `UPDATE map_collisions SET cx = ?, cy = ?, w = ?, h = ?, updated_at = ? WHERE id = ?`,
      [row.cx, row.cy, row.w, row.h, row.updated_at, row.id],
    );
  }

  /** 删一行，返回是否真的删掉了（0 = 本来就不存在） */
  remove(id: number): boolean {
    return this.db.execute("DELETE FROM map_collisions WHERE id = ?", [id]).changes > 0;
  }

  /** 一张图的全部碰撞盒（按 id 升序 = 建盒顺序，画布叠放稳定、重画不闪） */
  listByMap(mapId: string): MapCollisionRow[] {
    return this.db.all<MapCollisionRow>("SELECT * FROM map_collisions WHERE map_id = ? ORDER BY id ASC", [mapId]);
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM map_collisions");
  }

  /**
   * 每张图的碰撞盒行数（管理端地图列表用一次 GROUP BY）
   *
   * 列表要显示「这张图有几个碰撞盒」，11 张图逐图 `listByMap` 就是 11 次查询 —— 聚合成一次。
   */
  countByMap(): Array<{ map_id: string; total: number }> {
    return this.db.all<{ map_id: string; total: number }>(
      "SELECT map_id, COUNT(1) AS total FROM map_collisions GROUP BY map_id",
    );
  }

  /**
   * 这张图是否已经有碰撞盒行
   *
   * 迁移脚本用它做幂等判据（**不看唯一键，看「这张图有没有搬过」**）：
   * 碰撞盒没有天然唯一键，`INSERT OR IGNORE` 会每次重跑都插一份重复的；
   * 而「图里已经有盒子」就意味着搬过了 —— 运营之后手动删掉几个也不该被重跑灌回来。
   * 代价是「运营把一张图的所有碰撞盒删光后重跑迁移」，那些盒子会回来：这是可接受的，
   * 因为它们和 TMX 里的原始数据一致，而 TMX 那组数据马上就会被删掉。
   */
  hasAny(mapId: string): boolean {
    return this.countByMap().some((row) => row.map_id === mapId && row.total > 0);
  }
}

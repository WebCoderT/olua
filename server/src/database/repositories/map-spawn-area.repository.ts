import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapSpawnAreaRow } from "../rows";

/**
 * 刷怪区数据访问（#295 阶段一：刷怪区配置归服务端 / #667 改成后台绘制）
 *
 * #667 之前，行只能来自「库为空时的 seed」或导入工具的整表替换 —— 后台上不了手。
 * 现在**管理端是唯一写入方**：地图管理页拖框建区、改、删（`map.service` 的三个方法），
 * 导入工具 `tools/import-map-resources.cjs` 已经不碰这张表了（审计守点盯着这一条）。
 *
 * 仍然没有「随便插一行」的语义：写入必须过 service 的四道校验（图存在 / 怪物 key 存在 /
 * 同图名字唯一 / 矩形在图内）。仓储只负责 SQL，判断留给上面 —— 这样 e2e 能直接测校验文案。
 */
@Injectable()
export class MapSpawnAreaRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（同图同名已存在则跳过） */
  seedRow(row: Omit<MapSpawnAreaRow, "id">): void {
    this.db.run(
      `INSERT OR IGNORE INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.map_id, row.name, row.monster_key, row.min, row.max, row.cx, row.cy, row.w, row.h, row.updated_at],
    );
  }

  /** 按行 id 取一条（改 / 删前确认存在，且必须属于路径里那张图） */
  findById(id: number): MapSpawnAreaRow | null {
    return this.db.get<MapSpawnAreaRow>("SELECT * FROM map_spawn_areas WHERE id = ?", [id]) ?? null;
  }

  /** 同图同名查重（改的时候要排除自己那一行） */
  findByName(mapId: string, name: string): MapSpawnAreaRow | null {
    return (
      this.db.get<MapSpawnAreaRow>("SELECT * FROM map_spawn_areas WHERE map_id = ? AND name = ?", [mapId, name]) ?? null
    );
  }

  /** 插入一行，返回带 id 的完整行（接口要回显，别让客户端再猜一次 id） */
  insert(row: Omit<MapSpawnAreaRow, "id">): MapSpawnAreaRow {
    const id = this.db.insertReturningId(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.map_id, row.name, row.monster_key, row.min, row.max, row.cx, row.cy, row.w, row.h, row.updated_at],
    );
    const created = this.findById(id);
    if (!created) throw new Error(`刷怪区刚插入却读不回来（id=${id}），库状态异常`);
    return created;
  }

  /** 整行覆盖（管理端表单是整份提交，不做分字段更新 —— 两人同改时不会互相截半） */
  update(row: MapSpawnAreaRow): void {
    this.db.run(
      `UPDATE map_spawn_areas
          SET name = ?, monster_key = ?, min = ?, max = ?, cx = ?, cy = ?, w = ?, h = ?, updated_at = ?
        WHERE id = ?`,
      [row.name, row.monster_key, row.min, row.max, row.cx, row.cy, row.w, row.h, row.updated_at, row.id],
    );
  }

  /** 删一行，返回是否真的删掉了（0 = 本来就不存在） */
  remove(id: number): boolean {
    return this.db.execute("DELETE FROM map_spawn_areas WHERE id = ?", [id]).changes > 0;
  }

  /** 一张图的全部刷怪区（按 id 升序 = 建区顺序，播种发牌可复现） */
  listByMap(mapId: string): MapSpawnAreaRow[] {
    return this.db.all<MapSpawnAreaRow>("SELECT * FROM map_spawn_areas WHERE map_id = ? ORDER BY id ASC", [mapId]);
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM map_spawn_areas");
  }

  /**
   * 每张图的刷怪区行数（管理端地图列表用一次 GROUP BY）
   *
   * 列表要显示「这张图服务端整理出了几个刷怪区」，11 张图逐图 `listByMap` 就是 11 次查询；
   * 聚合成一次，且不改变任何写入语义。
   */
  countByMap(): Array<{ map_id: string; total: number }> {
    return this.db.all<{ map_id: string; total: number }>(
      "SELECT map_id, COUNT(1) AS total FROM map_spawn_areas GROUP BY map_id",
    );
  }
}

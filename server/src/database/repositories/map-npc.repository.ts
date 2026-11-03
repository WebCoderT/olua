import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapNpcRow } from "../rows";

/**
 * NPC 点位数据访问（#672：点位从 TMX 搬到后台）
 *
 * 一行 = 「某个 NPC 站在某张图的某个点上」。**管理端是唯一写入方**（地图页点放 / 拖动 / 删），
 * 出厂值由 `server/scripts/migrate-map-points.cjs` 从 `maps.content` 里现成的 TMX 对象组灌一次
 * （灌完就跟 TMX 没关系了，工具重跑也不会再动这张表）。
 *
 * 与刷怪区仓储同一条纪律：仓储只写 SQL，**判断留给 service**（图存在 / NPC 存在 / 同图不重复 /
 * 点位在图内）。这样 e2e 能直接对着校验文案断言，也不会有人绕过接口塞一行进去。
 */
@Injectable()
export class MapNpcRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 按行 id 取一条（改 / 删前确认存在，且必须属于路径里那张图） */
  findById(id: number): MapNpcRow | null {
    return this.db.get<MapNpcRow>("SELECT * FROM map_npcs WHERE id = ?", [id]) ?? null;
  }

  /** 同图同 NPC 查重（改的时候要排除自己那一行） */
  findByNpc(mapId: string, npcId: string): MapNpcRow | null {
    return this.db.get<MapNpcRow>("SELECT * FROM map_npcs WHERE map_id = ? AND npc_id = ?", [mapId, npcId]) ?? null;
  }

  /** 插入一行，返回带 id 的完整行（接口要回显，别让客户端再猜一次 id） */
  insert(row: Omit<MapNpcRow, "id">): MapNpcRow {
    const id = this.db.insertReturningId(
      "INSERT INTO map_npcs (map_id, npc_id, cx, cy, updated_at) VALUES (?, ?, ?, ?, ?)",
      [row.map_id, row.npc_id, row.cx, row.cy, row.updated_at],
    );
    const created = this.findById(id);
    if (!created) throw new Error(`NPC 点位刚插入却读不回来（id=${id}），库状态异常`);
    return created;
  }

  /** 整行覆盖（表单整份提交：换 NPC 与挪位置是同一次动作，分字段更新会留下半新半旧） */
  update(row: MapNpcRow): void {
    this.db.run("UPDATE map_npcs SET npc_id = ?, cx = ?, cy = ?, updated_at = ? WHERE id = ?", [
      row.npc_id,
      row.cx,
      row.cy,
      row.updated_at,
      row.id,
    ]);
  }

  /** 删一行，返回是否真的删掉了（0 = 本来就不存在） */
  remove(id: number): boolean {
    return this.db.execute("DELETE FROM map_npcs WHERE id = ?", [id]).changes > 0;
  }

  /** 一张图的全部点位（按 id 升序 = 放置顺序，管理端列表与客户端建节点的顺序都可复现） */
  listByMap(mapId: string): MapNpcRow[] {
    return this.db.all<MapNpcRow>("SELECT * FROM map_npcs WHERE map_id = ? ORDER BY id ASC", [mapId]);
  }

  /** 每张图的点位数（列表页一次 GROUP BY，别 11 张图逐图查） */
  countByMap(): Array<{ map_id: string; total: number }> {
    return this.db.all<{ map_id: string; total: number }>(
      "SELECT map_id, COUNT(1) AS total FROM map_npcs GROUP BY map_id",
    );
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM map_npcs");
  }
}

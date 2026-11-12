import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapRuleRow } from "../rows";

/**
 * 地图级玩法规则（`map_rules` 表；#809 / docs/20 §2.2）
 *
 * **一行不存在 = 全默认**：读的一律 `getOrDefault()`，不靠 seed 补行。这是这张表与
 * 其它配置表最大的区别 —— 绝大多数图只用默认值，给每张图插一行等于让「运营调过这张图」
 * 与「没调过」在库里长得一样。
 *
 * 写入口只有管理端（`PATCH /admin/maps/:id/rules`）。倍率只在服务端结算时乘，
 * 不进客户端快照 —— 否则「客户端算的经验」和「服务端给的经验」迟早不一致。
 */
@Injectable()
export class MapRuleRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 取一行（没有就返回 null，调用方用 `DEFAULT_MAP_RULES` 兜底） */
  find(mapId: string): MapRuleRow | null {
    return this.db.get<MapRuleRow>("SELECT * FROM map_rules WHERE map_id = ?", [mapId]) ?? null;
  }

  /** 全部行（管理端列表 / 排查「哪些图调过」用；没调过的图不在里面） */
  list(): MapRuleRow[] {
    return this.db.all<MapRuleRow>("SELECT * FROM map_rules ORDER BY map_id ASC");
  }

  /**
   * 覆盖式写入一行（整份覆盖；`updated_by` / `updated_at` 由调用方给）
   *
   * 用 `INSERT ... ON CONFLICT DO UPDATE` 而不是「先查后插」：管理端可能同时开两个页签
   * 改同一张图，先查后插的窗口里会写出两行（主键冲突）或丢掉一次修改。
   */
  save(row: MapRuleRow): void {
    this.db.run(
      `INSERT INTO map_rules (
        map_id, exp_rate, drop_rate, money_rate, allow_pk, allow_auto_battle, allow_recall, allow_drop,
        max_players_per_room, max_channels, transfer_cost_money, transfer_cooldown_ms, deny_transfer_in_combat,
        respawn_ms_override, simulate_when_empty, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(map_id) DO UPDATE SET
        exp_rate = excluded.exp_rate,
        drop_rate = excluded.drop_rate,
        money_rate = excluded.money_rate,
        allow_pk = excluded.allow_pk,
        allow_auto_battle = excluded.allow_auto_battle,
        allow_recall = excluded.allow_recall,
        allow_drop = excluded.allow_drop,
        max_players_per_room = excluded.max_players_per_room,
        max_channels = excluded.max_channels,
        transfer_cost_money = excluded.transfer_cost_money,
        transfer_cooldown_ms = excluded.transfer_cooldown_ms,
        deny_transfer_in_combat = excluded.deny_transfer_in_combat,
        respawn_ms_override = excluded.respawn_ms_override,
        simulate_when_empty = excluded.simulate_when_empty,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`,
      [
        row.map_id,
        row.exp_rate,
        row.drop_rate,
        row.money_rate,
        row.allow_pk,
        row.allow_auto_battle,
        row.allow_recall,
        row.allow_drop,
        row.max_players_per_room,
        row.max_channels,
        row.transfer_cost_money,
        row.transfer_cooldown_ms,
        row.deny_transfer_in_combat,
        row.respawn_ms_override,
        row.simulate_when_empty,
        row.updated_by,
        row.updated_at,
      ],
    );
  }
}

/** 地图规则的业务形状（读的一方只认它，不认 snake_case 列名） */
export interface MapRules {
  expRate: number;
  dropRate: number;
  moneyRate: number;
  allowPk: boolean;
  allowAutoBattle: boolean;
  allowRecall: boolean;
  allowDrop: boolean;
  maxPlayersPerRoom: number;
  maxChannels: number;
  transferCostMoney: number;
  transferCooldownMs: number;
  denyTransferInCombat: boolean;
  respawnMsOverride: number | null;
  simulateWhenEmpty: boolean;
}

/**
 * 出厂默认规则（`map_rules` 一行都没有时的取值口径）
 *
 * 数值必须与 `CREATE TABLE` 的 DEFAULT 逐个对齐 —— 两处不一致的后果是「管理端看到 30、
 * 服务端按 40 判」这种查一整天的问题。改这里之前先改 DDL。
 */
export const DEFAULT_MAP_RULES: MapRules = Object.freeze({
  expRate: 1,
  dropRate: 1,
  moneyRate: 1,
  allowPk: false,
  allowAutoBattle: true,
  allowRecall: true,
  allowDrop: true,
  maxPlayersPerRoom: 30,
  maxChannels: 1,
  transferCostMoney: 0,
  transferCooldownMs: 0,
  denyTransferInCombat: false,
  respawnMsOverride: null,
  simulateWhenEmpty: false,
});

/** 行 → 业务形状（行不存在时给出厂默认） */
export function mapRulesOf(row: MapRuleRow | null): MapRules {
  if (!row) return DEFAULT_MAP_RULES;
  return {
    expRate: row.exp_rate,
    dropRate: row.drop_rate,
    moneyRate: row.money_rate,
    allowPk: row.allow_pk === 1,
    allowAutoBattle: row.allow_auto_battle === 1,
    allowRecall: row.allow_recall === 1,
    allowDrop: row.allow_drop === 1,
    maxPlayersPerRoom: row.max_players_per_room,
    maxChannels: row.max_channels,
    transferCostMoney: row.transfer_cost_money,
    transferCooldownMs: row.transfer_cooldown_ms,
    denyTransferInCombat: row.deny_transfer_in_combat === 1,
    respawnMsOverride: row.respawn_ms_override,
    simulateWhenEmpty: row.simulate_when_empty === 1,
  };
}

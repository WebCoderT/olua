import type { WorldMonsterRow } from "../../database/rows";

/**
 * 服务端持有的一只怪物实例（权威状态；内存形态，落盘见 WorldMonsterRow）
 *
 * 从 `world.service.ts` 抽出来（#809）：Room 抽象之后它同时被 `RoomManager`（实例表）、
 * `WorldService`（重生 / 密度 / 落盘）和 `MonsterAiService`（AI 运行时按 instanceId 挂钩）
 * 引用，留在 world.service 里会形成「world.service ← room ← world.service」的循环。
 */
export interface WorldMonster {
  /** 实例 id（服务端发牌，`m<mapId>_z<zoneId>_c<slot>_<n>`，跨重启稳定不重号） */
  instanceId: string;
  mapId: string;
  /** 归属区（#295 阶段二：同一张图各区各有一份独立世界） */
  zoneId: number;
  /**
   * 归属线（#809：公共线 `"0"`，分线 `"1"..`，副本 `"i<seq>"`）
   *
   * 与 `zoneId` / `mapId` 一起决定「这间房」；单看 zone+map 在分线之后是不够的。
   */
  slot: string;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 monsters 表） */
  monsterKey: string;
  /** 归属刷怪区（#852：密度补种按它统计「这一区现在几只」；老档可空） */
  areaId: number | null;
  /** 出生点（世界坐标；重生的落点也是它） */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 死亡时刻（毫秒）；存活为 null */
  killedAt: number | null;
  /** 预定重生时刻（毫秒）；存活为 null */
  respawnAt: number | null;
  /**
   * 最后一次被攻击的时刻（毫秒；只在内存里，不落库）
   *
   * 只有一个消费方：密度裁剪（#852）要「删最久没被攻击的」，且**正在被打的不删**。
   * 不落库是因为它只在本次进程的生命周期内有意义 —— 重启后所有人都已经脱战了。
   */
  lastDamagedAt: number | null;
  /** 内存里改过还没落盘（tick 按节流批量写库） */
  dirty: boolean;
}

/** 快照里的一只怪（world 帧的 monsters 列表项，见 realtime.protocol.ts） */
export interface WorldMonsterSnapshot {
  instanceId: string;
  monsterKey: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  /**
   * 出生点（世界坐标）。**这不是「他现在在哪」** —— 世界层不持有走动，怪的位置只有怪物 AI
   * 运行时知道；通道把快照发出去之前会按运行时坐标覆盖它（#670，见 RealtimeService）。
   */
  x: number;
  y: number;
  respawnInMs?: number;
}

/** 内存实例 → 数据库行（写入形态） */
export function toWorldMonsterRow(monster: WorldMonster): WorldMonsterRow {
  return {
    instance_id: monster.instanceId,
    map_id: monster.mapId,
    zone_id: monster.zoneId,
    slot: monster.slot,
    monster_key: monster.monsterKey,
    area_id: monster.areaId,
    x: monster.x,
    y: monster.y,
    hp: monster.hp,
    max_hp: monster.maxHp,
    alive: monster.alive ? 1 : 0,
    killed_at: monster.killedAt,
    respawn_at: monster.respawnAt,
    updated_at: Date.now(),
  };
}

/** 数据库行 → 内存实例（恢复形态；从库里加载出来的不标脏 —— 没改过不用写回去） */
export function fromWorldMonsterRow(row: WorldMonsterRow): WorldMonster {
  return {
    instanceId: row.instance_id,
    mapId: row.map_id,
    zoneId: row.zone_id,
    slot: row.slot ?? "0",
    monsterKey: row.monster_key,
    areaId: row.area_id ?? null,
    x: row.x,
    y: row.y,
    hp: row.hp,
    maxHp: row.max_hp,
    alive: row.alive === 1,
    killedAt: row.killed_at,
    respawnAt: row.respawn_at,
    lastDamagedAt: null,
    dirty: false,
  };
}

/** 实例 → 快照（world 帧的下发形态；死亡中的怪带重生倒计时） */
export function worldMonsterSnapshotOf(monster: WorldMonster): WorldMonsterSnapshot {
  const now = Date.now();
  return {
    instanceId: monster.instanceId,
    monsterKey: monster.monsterKey,
    hp: monster.hp,
    maxHp: monster.maxHp,
    alive: monster.alive,
    x: monster.x,
    y: monster.y,
    ...(monster.alive || monster.respawnAt === null ? {} : { respawnInMs: Math.max(0, monster.respawnAt - now) }),
  };
}

/**
 * 到期重生的补处理（tick 与「房间重新加载」共用这一条口径）
 *
 * 重生 = 满血、回出生点、清掉死亡时间戳。返回本轮重生了几只（调用方据此决定要不要广播）。
 * 「卸载的房间不跑 tick、重载时一次性补上」靠的就是它接受任意 `now`：错过多个周期也不会
 * 连环重生，只补一次。
 */
export function processRespawns(monsters: Map<string, WorldMonster>, now: number): number {
  let revived = 0;
  for (const monster of monsters.values()) {
    if (monster.alive || monster.respawnAt === null || monster.respawnAt > now) continue;
    monster.alive = true;
    monster.hp = monster.maxHp;
    monster.killedAt = null;
    monster.respawnAt = null;
    monster.dirty = true;
    revived += 1;
  }
  return revived;
}

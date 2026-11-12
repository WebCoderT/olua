import type { WorldMonster } from "../world-monster";

/**
 * 一个 Room = 「一份跑起来的世界」（#809）
 *
 * 改造前这些字段是 `WorldService` 里五个平行的 `Map<"zone:map", …>`（怪物表 / 观看者 /
 * 无人时刻 / 发牌序号 / 裁剪宽限期）。它们**本来就应该是一份东西** —— 拆成五个 Map 的
 * 直接后果是：任何一处新增字段都要记得在「加载 / 卸载 / 代际作废 / 重载」四个地方同步
 * 增删，漏一个就是「内存里有这间房、序号却从 1 重来」这类脏状态。收进一个对象之后
 * 生命周期只有一个入口（`RoomManager.ensure` / `destroy`）。
 *
 * **slot 三种形态**见 `common/utils/room-key.util`：`"0"` 公共线 / `"1"..` 分线 /
 * `"i<seq>"` 副本。第③刀只产出 `"0"`，但字段与键一次到位。
 */
export interface Room {
  /** `<zoneId>:<mapId>:<slot>`（`room-key.util` 是唯一生成处） */
  roomId: string;
  zoneId: number;
  mapId: string;
  slot: string;
  /** 实例表（权威状态本体；内存形态，落盘见 WorldMonsterRow） */
  monsters: Map<string, WorldMonster>;
  /** 正在看这间房的账号（广播与空闲回收的唯一依据） */
  viewers: Set<string>;
  /** 变成无人观看的时刻（毫秒）；有人看时为 null */
  emptySince: number | null;
  /** 发牌序号（instanceId 的 `_n` 段；加载时从库里最大值续起，重启不重号） */
  seq: number;
  /**
   * 密度裁剪的宽限期截止时刻（毫秒）
   *
   * 合并区会把源区实例整批改牌搬进目标区（24 只 > 目标 12 只）。那是**一次搬迁**，
   * 不是「配置改小了」—— 立刻按密度裁掉一半等于把源区那份世界状态扔掉。宽限期内只补不裁。
   */
  trimGraceUntil: number;
  /** 容量（`map_rules.max_players_per_room`，0 = 不限）；第③刀只记录，不据此拒人 */
  capacity: number;
}

/** 这间房现在有没有人看（空闲回收与「无人冻结」的判据） */
export function roomIsEmpty(room: Room): boolean {
  return room.viewers.size === 0;
}

/**
 * 这间房是否已满（容量 0 = 不限）
 *
 * **第③刀不据此拒人** —— 分线还没做，满了也没有第二条线可去，按它拒人就是把玩家
 * 挡在门外。真正拒人属于第④刀（`mapEnterResult{ reason:"full" }`）。
 */
export function roomIsFull(room: Room): boolean {
  return room.capacity > 0 && room.viewers.size >= room.capacity;
}

/** 房间的观感摘要（日志与监控用；别拿去当业务字段） */
export function roomLabelOf(room: Room): string {
  return `地图 ${room.mapId} / 区 ${room.zoneId} / 线 ${room.slot}（${room.viewers.size} 人看，${room.monsters.size} 只实例）`;
}

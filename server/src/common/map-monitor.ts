/**
 * 实时地图监控的数据形状（#665）—— **写者（实时进程）与读者（管理端接口）共用这一份**
 *
 * ## 为什么单独一个文件
 *
 * 监控的数据流要跨两个进程：实时进程每秒把「这张图现在长什么样」写进 `map_monitor_state`
 * 的 JSON 列，存档进程的 `/admin/maps/:id/monitor` 再把它读出来。两个进程**只有 SQLite**
 * 这一条路（见 monster-ai.service 顶部那段），也就是说这些字段是**跨进程的契约**：
 * 写侧少一个字段、读侧多一个字段，编译不会报错，页面上只会「少了一列」。
 *
 * 所以形状放在基础层（`common/`，谁都能引，不构成模块间的边），两边在同一个类型上编译。
 *
 * ## 坐标口径
 *
 * 全部是**世界坐标**（原点 = 地图左上角、y 轴向上，与 `map_spawn_areas` / `world_monsters`
 * 同一套）。画到地图上要 `y = -worldY`（见管理端 `MapMonitor` 组件与 #566 的口径说明）。
 */

/** 掉落物在监控里的一条（位置 = 怪物死亡点 —— 客户端在它周围铺开，服务端不逐件记坐标） */
export interface MapMonitorDrop {
  goodId: string;
  /** 显示名（服务端从物品表现取；取不到为空串，界面退回 goodId） */
  label: string;
  count: number;
  /** 落点（世界坐标）= 击杀点 */
  x: number;
  y: number;
}

/** 一只怪在快照里的样子 */
export interface MapMonitorMonster {
  instanceId: string;
  monsterKey: string;
  /** 显示名（monsters 表的 label） */
  label: string;
  /** 当前坐标（世界坐标）：活着的怪是 AI 模拟位置，死了的怪是死亡点 */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 死亡中的怪：距重生还剩多少毫秒（存活时为 null） */
  respawnInMs: number | null;
  /** 死亡中的怪：预定重生时刻（毫秒时间戳；存活时为 null） */
  respawnAt: number | null;
}

/** 一个玩家在快照里的样子（来自 pos 帧，只读展示；超时未上报的已被在场表剔除） */
export interface MapMonitorPlayer {
  accountId: string;
  /** 账号名（在场表里那份缓存；取不到就给 accountId） */
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moving: boolean;
}

/** 一张图（一个区）此刻的样子 */
export interface MapMonitorSnapshot {
  monsters: MapMonitorMonster[];
  players: MapMonitorPlayer[];
  /** 采样时刻（毫秒）；管理端据此判断「数据是不是停了」 */
  sampledAt: number;
}

/** 文字流里的一次击杀 */
export interface MapMonitorKillEvent {
  kind: "kill";
  /** 事件时刻（毫秒） */
  at: number;
  instanceId: string;
  monsterKey: string;
  /** 怪物显示名 */
  label: string;
  /** 怪物死亡点（世界坐标） */
  x: number;
  y: number;
  /** 击杀者角色名（取不到为空串） */
  killer: string;
  drops: MapMonitorDrop[];
  /** 这只怪预定什么时候刷新（毫秒时间戳）—— 「下次预计什么时候刷」的直接答案 */
  respawnAt: number;
}

/** 文字流里的一次刷新 */
export interface MapMonitorRespawnEvent {
  kind: "respawn";
  at: number;
  instanceId: string;
  monsterKey: string;
  label: string;
  x: number;
  y: number;
}

export type MapMonitorEvent = MapMonitorKillEvent | MapMonitorRespawnEvent;

/**
 * 解析快照 JSON
 *
 * 坏数据（半截 JSON / 结构不对）返回 `null` —— 调用方据此显示「快照不可读」，
 * 而不是抛 500：一张图的镜像坏了，不该让整个监控接口挂掉。
 */
export function parseMonitorSnapshot(text: string | null | undefined): MapMonitorSnapshot | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<MapMonitorSnapshot>;
    if (!Array.isArray(value.monsters) || !Array.isArray(value.players)) return null;
    return {
      monsters: value.monsters,
      players: value.players,
      sampledAt: Number(value.sampledAt ?? 0),
    };
  } catch {
    return null;
  }
}

/** 解析事件 JSON（形状不对返回 `null`，由调用方跳过这一行） */
export function parseMonitorEvent(text: string): MapMonitorEvent | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { kind?: unknown };
    if (value.kind !== "kill" && value.kind !== "respawn") return null;
    return parsed as MapMonitorEvent;
  } catch {
    return null;
  }
}

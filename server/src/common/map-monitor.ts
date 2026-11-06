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

/**
 * 一次「玩家打怪」的伤害（#745：从「谁死了」细到「这一下掉了多少血」）
 *
 * 一行 = 一个 castId 的结算结果。伤害是服务端算的（`CombatSettlementService.settleNew`），
 * 所以这里的数字与客户端飘字、与怪物血条**必然同一个来源** —— 不需要二次对账。
 *
 * `hpBefore` 由 `hpAfter + amount` 反推（世界服务只回结果血量），两者相减恒等于 `amount`：
 * 页面上「200 → 137（-63）」这三个数永远自洽，不会出现「掉了 63 但差值是 62」。
 */
export interface MapMonitorDamageEvent {
  kind: "damage";
  at: number;
  instanceId: string;
  monsterKey: string;
  label: string;
  /** 怪被打时所在的位置（世界坐标） */
  x: number;
  y: number;
  /** 出手者角色名（取不到为空串） */
  attacker: string;
  /** 技能 id / 名称（普攻就是 "1000" 基础剑术） */
  skillId: string;
  skillLabel: string;
  /** 这一下掉了多少血（= hpBefore - hpAfter，恒等） */
  amount: number;
  hpBefore: number;
  hpAfter: number;
  maxHp: number;
  /** 这一下打死了（与随后的 kill 事件同时出现，前者是「过程」后者是「结果」） */
  killed: boolean;
  /** 这一下把怪推开了多远（技能配了 push_distance 才有；0 = 没推） */
  pushDistance: number;
}

/**
 * 怪物开始 / 结束追击
 *
 * 两端都要有：只看「开始」不知道它是不是一直在追一只已经跑远的目标；只看「结束」不知道
 * 它为什么停下。`reason` 是服务端算出来的**唯一解释**（页面上直接显示这几个字）。
 */
export interface MapMonitorChaseEvent {
  kind: "chase";
  at: number;
  instanceId: string;
  monsterKey: string;
  label: string;
  /** 追到 / 放弃的那一刻它站在哪（世界坐标） */
  x: number;
  y: number;
  /** 被追的角色名（取不到为空串） */
  target: string;
  /** 被追的账号（页面据此「只看这个人的日志」） */
  targetAccountId: string;
  phase: "start" | "end";
  /** start：进入视野 / 记恨；end：走出检测范围 / 目标倒下 / 目标离线 / 目标换图 / 怪被击杀 */
  reason: string;
  /** 这一刻双方的距离（像素，取整） */
  distance: number;
}

/** 怪物放了一次技能（状态型没有目标也没有伤害） */
export interface MapMonitorMonsterCastEvent {
  kind: "cast";
  at: number;
  instanceId: string;
  monsterKey: string;
  label: string;
  x: number;
  y: number;
  skillId: string;
  skillLabel: string;
  /** 目标角色名；状态型技能（给自己上 buff）为空串 */
  target: string;
  targetAccountId: string;
  /** 这一下对玩家造成的伤害（状态型为 0） */
  damage: number;
  /** 挨打之后玩家的血量与上限（状态型为 0） */
  hpBefore: number;
  hpAfter: number;
  maxHp: number;
  /** 这一下把玩家打倒 */
  killed: boolean;
}

/** 怪物打中了一次玩家（普攻；技能命中走 cast） */
export interface MapMonitorMonsterHitEvent {
  kind: "hit";
  at: number;
  instanceId: string;
  monsterKey: string;
  label: string;
  x: number;
  y: number;
  /** 被打的角色名 */
  target: string;
  targetAccountId: string;
  damage: number;
  hpBefore: number;
  hpAfter: number;
  maxHp: number;
  /** 这一下把玩家打倒 */
  killed: boolean;
}

export type MapMonitorEvent =
  | MapMonitorKillEvent
  | MapMonitorRespawnEvent
  | MapMonitorDamageEvent
  | MapMonitorChaseEvent
  | MapMonitorMonsterCastEvent
  | MapMonitorMonsterHitEvent;

/** 全部事件类型（解析时按它白名单校验；页面按同一份清单做筛选项） */
export const MAP_MONITOR_EVENT_KINDS = ["kill", "respawn", "damage", "chase", "cast", "hit"] as const;

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
    // 白名单而不是「有 kind 就收」：库里存过一版后来废掉的 kind 时，读侧只会跳过它
    if (typeof value.kind !== "string" || !(MAP_MONITOR_EVENT_KINDS as readonly string[]).includes(value.kind)) return null;
    return parsed as MapMonitorEvent;
  } catch {
    return null;
  }
}

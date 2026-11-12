/**
 * 房间键（#809 Room 抽象）：`<zoneId>:<mapId>:<slot>` 与实例 id 的唯一口径
 *
 * ===========================================================================
 * 为什么要有这个文件
 * ===========================================================================
 * 「谁在哪张图」在世界层、在场表、怪物 AI、监控、聊天里各有一份内存索引，改造前
 * 每一处都自己拼 `` `${zoneId}:${mapId}` ``（`player-presence` 甚至自己写了一份
 * `worldKey()`）。第④刀要做分线 / 副本时，那种散着拼的写法要一处一处找出来改，
 * 漏一处就是「分线的人看到公共线的怪」这类静默错位。
 *
 * 所以键的**解析与生成**只此一份（纯函数、无依赖），两边（服务端各处 + e2e）都调它。
 *
 * ===========================================================================
 * slot 的三种形态
 * ===========================================================================
 * - `"0"`      公共线（`PUBLIC_SLOT`）—— **第③刀只实现这一档**
 * - `"1".."N"` 分线（第④刀）
 * - `"i<seq>"` 副本（第④刀；`i` 是 instance 的首字母，与分线的纯数字区分开）
 *
 * 老键 `zone:mapId`（两段）等价于 `zone:mapId:0` —— `splitRoomKey()` 容忍两段，
 * 这样**存量日志与老 e2e 断言**不用改；新代码一律走 `roomKey()` 生成三段。
 */

/** 公共线（出厂唯一的线；`map_rules.max_channels = 1` 时永远只有它） */
export const PUBLIC_SLOT = "0";

/** 房间的三段键（解析结果；`roomId` 是原串，省得调用方再拼一次） */
export interface RoomRef {
  roomId: string;
  zoneId: number;
  mapId: string;
  slot: string;
}

/** 段分隔符：区号是数字、地图 id 是数字或 slug（都不含冒号），slot 是数字或 `i<seq>` */
const SEP = ":";

/** 拼房间键：`roomKey(1, "3") === "1:3:0"` */
export function roomKey(zoneId: number, mapId: string, slot: string = PUBLIC_SLOT): string {
  return `${zoneId}${SEP}${mapId}${SEP}${slot}`;
}

/**
 * 拆房间键。**容忍两段**（老键 `1:3` → `slot = "0"`）：
 * 库里 / 旧日志里都还是两段形态，强制三段会让读旧数据的地方直接炸。
 *
 * 段数不对（空串 / 超过三段）不抛异常 —— 这些值是内存键，抛出去只会让 tick 整轮挂掉；
 * 交不出合法结果时按「区 0 + 公共线」兜底，由调用方的存在性检查（图在不在库里）去拒。
 */
export function splitRoomKey(roomId: string): RoomRef {
  const parts = roomId.split(SEP);
  const zoneId = Number(parts[0]);
  const mapId = parts[1] ?? "";
  const slot = parts[2] ?? PUBLIC_SLOT;
  return {
    roomId: parts.length >= 3 ? roomId : roomKey(Number.isFinite(zoneId) ? zoneId : 0, mapId, slot),
    zoneId: Number.isFinite(zoneId) ? zoneId : 0,
    mapId,
    slot: slot === "" ? PUBLIC_SLOT : slot,
  };
}

/** 是不是副本房（`slot` 以 `i` 开头） */
export function isInstanceSlot(slot: string): boolean {
  return slot.startsWith("i");
}

/**
 * 分线号（公共线 0、`"2"` → 2）；**副本返回 -1**
 *
 * 客户端小地图要显示「· 2 线」、容量统计要按线算，两处都读它 —— 副本不该显示成
 * 「-1 线」也不该混进分线容量，所以用负数明确区分而不是 `Number("i7") = NaN`。
 */
export function channelOfSlot(slot: string): number {
  if (isInstanceSlot(slot)) return -1;
  const channel = Number(slot);
  return Number.isInteger(channel) && channel >= 0 ? channel : 0;
}

/**
 * 实例 id：`m<mapId>_z<zoneId>_c<slot>_<seq>`（副本是 `m<mapId>_z<zoneId>_i<seq>_<n>`）
 *
 * 与改造前 `m<mapId>_z<zoneId>_<seq>` 的区别只有 slot 段 —— 带上它，分线 / 副本的
 * 实例才能在同一张表里共存（`instance_id` 仍是主键，靠这段区分房间）。
 * 老格式的行不做迁移期外的改写，`parseInstanceSeq()` 取尾段数字，两种都认。
 */
export function instanceIdOf(mapId: string, zoneId: number, slot: string, seq: number): string {
  const tag = isInstanceSlot(slot) ? slot : `c${slot}`;
  return `m${mapId}_z${zoneId}_${tag}_${seq}`;
}

/**
 * 从实例 id 解析发牌序号（`m3_z1_c0_12` → 12；老格式 `m3_z1_12` → 12）
 *
 * 解析不出按 0：调用方拿它续号，0 等于「从 1 开始」—— 比抛异常好（一条脏行不该让
 * 整张图的实例加载失败）。真正防撞号的是「同 id 覆盖写」这条 upsert 语义。
 */
export function parseInstanceSeq(instanceId: string): number {
  const at = instanceId.lastIndexOf("_");
  if (at < 0) return 0;
  const seq = Number(instanceId.slice(at + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * 老两段键（`zone:mapId`）—— **只给读旧数据 / 旧日志的地方用**
 *
 * 世界层改造后内部一律用 `roomKey()`；这个函数留着是为了「合并区搬账号」这类
 * 仍在按区扫全表的旧代码路径，以及日志里比对历史。
 */
export function legacyWorldKey(zoneId: number, mapId: string): string {
  return `${zoneId}${SEP}${mapId}`;
}

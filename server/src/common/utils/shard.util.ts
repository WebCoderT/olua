/**
 * 实时进程分片（#770）：`zoneId → 分片号` 的唯一口径
 *
 * ===========================================================================
 * 为什么分片键是「区」而不是「地图」
 * ===========================================================================
 * 按地图拆会让**同区不同图的人落在两个进程**，于是世界频道、帮会频道、全服公告、
 * 稀有掉落公告全部要跨进程广播 —— 那需要一条总线，而这套东西（SQLite + 无 MQ）
 * 里没有总线。按区拆没有这个问题：区本来就是完整隔离边界（#957~#963 之后角色带区、
 * 社交同区、榜单同区、管理端按区），跨区本来就不能互见。代价是单区上限受单进程限制
 * （重开条件见 docs/28 §8）。
 *
 * ===========================================================================
 * 为什么取模而不是配置列
 * ===========================================================================
 * `zones.shard` 那种配置列能让运营把热门区单独放一片，代价是「改配置要不要踢线上连接」
 * 这个新问题 —— 而现在连「分片数」都还只有 2。取模零配置、零状态：分片数改了，
 * 所有区的连接会在下一次重连时落到新片上，存档一行不动。真到了需要手工摆布的时候
 * 再加列（那时才有真实证据说「哪个区需要单独一片」）。
 *
 * ===========================================================================
 * 调用点
 * ===========================================================================
 * - `RealtimeService`：取票时算「该去哪个片」、握手时判「这个片收不收这个区的票」
 * - `main.realtime.ts`：启动时打印自己的分片与负责的区
 * - `e2e-realtime-shard`：验算与断言（**不要自己写一遍 `% N`**，否则改了规则测试还在自证）
 * - `docker-compose.yml` / `deploy/nginx-game.conf`：`REALTIME_SHARD_INDEX` 与路径段要与之对齐
 */

/** 路径里的分片段（`/api/realtime/s2` 的 `s2`） */
export function shardSegment(index: number): string {
  return `s${index}`;
}

/**
 * 分片数：非法值一律退回 1
 *
 * 配歪了（0 / 负数 / `"abc"`）宁可「当成没开分片」也不能让进程起不来 ——
 * 分片是**扩容手段**，配置错了退化成单进程是最不伤人的失败方式。
 */
export function shardCountOf(raw: unknown): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * 分片号：`zoneId % count`
 *
 * 用**位置式的正模**而不是 `%`：JS 的 `%` 对负数返回负值（`-1 % 2 === -1`），
 * 而 `zoneId` 是从库里来的整数，理论上不会是负的 —— 但这条路是**准入闸门**，
 * 一个负分片号会让「这个区归谁」变成没人认领，连接直接全拒。算得稳比算得快重要。
 */
export function shardOf(zoneId: number, count: number): number {
  const n = shardCountOf(count);
  if (!Number.isFinite(zoneId)) return 0;
  return ((Math.trunc(zoneId) % n) + n) % n;
}

/** 本进程该不该管这个区（`index` 越界时只认 0，见 `shardCountOf` 的同一条理由） */
export function ownsZone(zoneId: number, count: number, index: number): boolean {
  const shards = shardCountOf(count);
  const mine = Number.isInteger(index) && index >= 0 && index < shards ? index : 0;
  return shardOf(zoneId, shards) === mine;
}

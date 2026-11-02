/**
 * 掉落物的**运行时手感参数**（#603 起本文件只剩这一项）
 *
 * 掉落表本身不在客户端：具名表与兜底表的唯一书写处是服务端
 * `server/src/shared/drop-seed.ts`，每只怪的独立表在 `monster-drop-seed.ts`；
 * 启动时 seed 进 `drop_tables` / `monster_drops`，运营在管理端「掉落配置」改。
 * 抽取也只在服务端做（`combat-settlement.service`），客户端拿到的是一次结算的**结果**
 * （settle 帧的 `reward.drops`），本地没有任何抽奖代码。
 *
 * 这里留下的是「掉落物在地上怎么被捡起来、怎么摆」—— 纯表现，与掉落表无关。
 * 想调手感（捡得更远、提示更密、掉落物更散）只改这里，不必碰 DropManager / DropScatter。
 */
export const dropRuntime = {
  /** 自动拾取半径：角色脚底与掉落物距离小于该值即拾取；取值 = 图标半宽 20 + 脚部容差 20 */
  autoPickupRadius: 40,
  /** 背包已满的提示/重试间隔（毫秒）：避免自动拾取时每帧刷屏 */
  fullTipInterval: 1500,
  /** 多件掉落物的最小中心间距（像素）：同心环散落，保证图标互不重叠；取值 = 图标 40 + 12 留白 */
  scatterMinDistance: 52,
  /**
   * 服务端拾取应答的等待上限（毫秒，#325）：pick 帧发出去到 picked 帧回来之间
   * 该掉落物不再重复请求；超过仍无应答（帧丢失 / 断线）视为本轮失败，允许重新拾取
   */
  pickReplyTimeout: 5000,
};

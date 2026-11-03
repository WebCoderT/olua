/**
 * 掉落物的**运行时手感参数**（#603 起本文件只剩这一项；#605 起数值改为运营可配）
 *
 * 掉落表本身不在客户端：具名表与兜底表的唯一书写处是服务端
 * `server/data/config-sync.sql`（`drop_tables` 具名表 + `monster_drops` 每怪独立表，都在同一次导出里）；
 * 启动时 seed 进 `drop_tables` / `monster_drops`，运营在管理端「掉落配置」改。
 * 抽取也只在服务端做（`combat-settlement.service`），客户端拿到的是一次结算的**结果**
 * （settle 帧的 `reward.drops`），本地没有任何抽奖代码。
 *
 * 这里留下的是「掉落物在地上怎么被捡起来、怎么摆」—— 纯表现，与掉落表无关。
 * **数值不在这里写死**（#605）：出厂值只是快照没到时的兜底，进游戏后由
 * `GET /game-config` 的 `runtimeParams.drop` 段覆写（管理端「运行时参数」页可改），
 * 于是「捡得更远一点」不用再发一次客户端包。
 */
export interface DropRuntimeParams {
  /** 自动拾取半径（像素）：角色脚底与掉落物距离小于该值即拾取 */
  autoPickupRadius: number;
  /** 背包已满的提示 / 重试间隔（毫秒）：避免自动拾取时每帧刷屏 */
  fullTipInterval: number;
  /** 多件掉落物的最小中心间距（像素）：同心环散落，保证图标互不重叠 */
  scatterMinDistance: number;
  /**
   * 服务端拾取应答的等待上限（毫秒，#325）：pick 帧发出去到 picked 帧回来之间
   * 该掉落物不再重复请求；超过仍无应答（帧丢失 / 断线）视为本轮失败，允许重新拾取
   */
  pickReplyTimeout: number;
}

/**
 * 生效中的手感参数（**对象引用恒定**，只改字段）
 *
 * 消费方（DropManager / DropScatter）在模块加载时就拿到了这个对象的引用，
 * 所以覆写必须是「原地改字段」而不是「换一个新对象」—— 换对象等于把改动写给空气。
 */
export const dropRuntime: DropRuntimeParams = {
  // 取值 = 图标半宽 20 + 脚部容差 20
  autoPickupRadius: 40,
  fullTipInterval: 1500,
  // 取值 = 图标 40 + 12 留白
  scatterMinDistance: 52,
  pickReplyTimeout: 5000,
};

/**
 * 覆写手感参数（#605；快照 `runtimeParams.drop` 段到达时调一次）
 *
 * 逐键覆写、只认已知键：服务端将来删掉某个参数，旧客户端里的残值也不会留在生效路径上；
 * 非有限数字（服务端漏字段 / 坏数据）保持当前值，不把半径覆写成 0 或 NaN。
 */
export function applyDropRuntime(params: Partial<DropRuntimeParams> | undefined): void {
  if (!params) return;
  (Object.keys(dropRuntime) as Array<keyof DropRuntimeParams>).forEach((key) => {
    const value = Number(params[key]);
    if (Number.isFinite(value) && value >= 0) dropRuntime[key] = value;
  });
}

/**
 * 掉落物的**运行时手感参数**（#603 起本文件只剩这一项；#605 起数值改为运营可配）
 *
 * 掉落表本身不在客户端：具名表与兜底表的唯一书写处是服务端
 * `server/data/config-sync.sql`（`drop_tables` 具名表 + `monster_drops` 每怪独立表，都在同一次导出里）；
 * 启动时 seed 进 `drop_tables` / `monster_drops`，运营在管理端「掉落配置」改。
 * 抽取也只在服务端做（`combat-settlement.service`），客户端拿到的是一次结算的**结果**
 * （settle 帧的 `reward.drops`），本地没有任何抽奖代码。
 *
 * 这里留下的是「掉落物在地上怎么被捡起来」—— 纯表现，与掉落表无关。
 * **落点不再由客户端算**（#804）：散落（同心环 + 避让）搬到服务端 `DropService.spawn`，
 * 客户端只把帧里的 x/y 摆上去，所以 `ui/utils/drop/DropScatter.ts` 已删除。
 * **数值不在这里写死**（#605 / #724）：唯一来源是 `GET /game-config` 的 `runtimeParams.drop` 段
 * （管理端「运行时参数」页可改），初始 0 = 快照没到（进游戏前契约已保证快照到达）——
 * 于是「捡得更远一点」不用再发一次客户端包，客户端也没有第二份出厂值可漂移。
 */
export interface DropRuntimeParams {
  /** 自动拾取半径（像素）：角色脚底与掉落物距离小于该值即拾取 */
  autoPickupRadius: number;
  /** 背包已满的提示 / 重试间隔（毫秒）：避免自动拾取时每帧刷屏 */
  fullTipInterval: number;
  /**
   * 全屏自动拾取（#1380，快照覆写；默认 false = 现状只捡 autoPickupRadius 内）
   *
   * 开启后自动拾取半径放宽到 `FULL_SCREEN_PICKUP_RADIUS`（屏幕内掉落全部自动入包），
   * 服务端拾取距离闸同步放宽（drop.service 的 FULL_SCREEN_PICK_RANGE 同值）——
   * **两端口径必须一致**，进游戏时提示一次「全屏自动拾取已开启」。
   */
  fullScreenPickup: boolean;
  /**
   * 多件掉落物的最小中心间距（像素）
   *
   * **服务端用，客户端不读**（#804）：散落坐标改由服务端算（`DropService.spawn` 的同心环
   * + 避让），客户端只把服务端给的 x/y 摆上去。这一项留在类型里是为了与快照 `runtimeParams.drop`
   * 段**同形**（少一个键就成了一份「看起来像、其实缺字段」的镜像，将来有人按它写新代码会踩空）。
   */
  scatterMinDistance: number;
  /**
   * 服务端拾取应答的等待上限（毫秒，#325）：pick 帧发出去到 picked 帧回来之间
   * 该掉落物不再重复请求；超过仍无应答（帧丢失 / 断线）视为本轮失败，允许重新拾取
   */
  pickReplyTimeout: number;
}

/**
 * 全屏自动拾取半径（像素，#1380）：`dropRuntime.fullScreenPickup` 开启时的拾取半径。
 * 1920×1080 设计分辨率可视半径 ≈1101px（半对角），1200 留余量；
 * 服务端同值常量 FULL_SCREEN_PICK_RANGE（drop.service），两端口径必须一致。
 */
export const FULL_SCREEN_PICKUP_RADIUS = 1_200;

/**
 * 生效中的手感参数（**对象引用恒定**，只改字段）
 *
 * 消费方（DropManager）在模块加载时就拿到了这个对象的引用，
 * 所以覆写必须是「原地改字段」而不是「换一个新对象」—— 换对象等于把改动写给空气。
 *
 * **初始数值全 0 / 布尔 false = 快照没到**（#724 无本地兜底）：唯一来源是快照 `runtimeParams.drop` 段，
 * 契约保证进游戏前必到；0 半径/超时只在加载期存在，进游戏后就是服务端给的值。
 */
export const dropRuntime: DropRuntimeParams = {
  autoPickupRadius: 0,
  fullTipInterval: 0,
  fullScreenPickup: false,
  scatterMinDistance: 0,
  pickReplyTimeout: 0,
};

/**
 * 覆写手感参数（#605；快照 `runtimeParams.drop` 段到达时调一次）
 *
 * 按字段类型分派覆写（#1380）：数字键只认有限非负数（服务端漏字段 / 坏数据保持当前值，
 * 不把半径覆写成 0 或 NaN）；布尔键只认 boolean——旧的 `Number()` 一把转会把 true 变成 1
 * 写进布尔字段，覆写等于失效。
 */
export function applyDropRuntime(params: Partial<DropRuntimeParams> | undefined): void {
  if (!params) return;
  // 数字键：只认有限非负数（服务端漏字段 / 坏数据保持当前值，不把半径覆写成 0 或 NaN）
  const numberKeys = ["autoPickupRadius", "fullTipInterval", "scatterMinDistance", "pickReplyTimeout"] as const;
  numberKeys.forEach((key) => {
    const value = Number(params[key]);
    if (Number.isFinite(value) && value >= 0) dropRuntime[key] = value;
  });
  // 布尔键（#1380）：只认 boolean——旧的 `Number()` 一把转会把 true 变成 1 写进布尔字段，覆写等于失效
  if (typeof params.fullScreenPickup === "boolean") dropRuntime.fullScreenPickup = params.fullScreenPickup;
}

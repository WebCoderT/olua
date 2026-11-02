/**
 * 商城出厂定价（#603 第八域：唯一书写处）
 *
 * 以前这份数据写在客户端 `configs/mall.ts` 的 `mallPrice` 常量里，服务端经生成器抄一份
 * 灌进 `mall_settings` 单行表 —— 「改一个默认价要改客户端」，归属是反的。本域把它翻过来：
 *
 * - 统一价 = `MALL_DEFAULT_PRICE`（本文件），`MallPricingService` 启动时 `INSERT OR IGNORE`
 *   进 `mall_settings`（运营改过的行不会被盖回去）；
 * - 特殊价是**运营数据**，不进种子也不进生成物：它在 `mall_prices` 表里动态增删，
 *   出厂就是空表（「不在表里的商品走统一价」）。
 *
 * 客户端一个价格都不存：进游戏由 `GET /game-config` 快照的 `mallSettings` / `mallPrices`
 * 两段下发，`configs/mall.getMallPrice` 只做「特殊价优先、否则统一价」的取价。
 */
export const MALL_DEFAULT_PRICE = 1;

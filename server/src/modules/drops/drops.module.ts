import { Module } from "@nestjs/common";
import { GameConfigModule } from "../game-config/game-config.module";
import { AdminDropsController } from "./admin-drops.controller";
import { DropsService } from "./drops.service";

/**
 * 掉落模块（#803 流水 / #805 监控与反查）
 *
 * **必须挂在 AppModule 的公共 imports 里**（不在 `options.realtime` 分支内）：这些接口
 * 是管理端在**存档进程**（3100）读的，而写入方在实时进程 —— 拆进程形态下两边都要有
 * `DatabaseModule`（`@Global`）里的仓储。
 *
 * ## 为什么 import GameConfigModule
 *
 * 「单图上限占用水位」要读运行时参数 `drop.maxGroundPerMap`（#805）。**不复刻那份读取逻辑**：
 * 夹逼、坏值回落、缺键用出厂值这些细节 `RuntimeParamsService` 里已经做对过一次，这里再抄
 * 一遍就会在两个地方分别漂。社交域（帮会门槛）也是这么借的。
 *
 * ## 权限点
 *
 * 读走 `drop:read`（**给了只读观察员**，与 `event:read` 的区别见 `permission.ts` 的注释）。
 * 将来的写操作（按图清空地面）另开一个写权限点，不借用这个读权限。
 */
@Module({
  imports: [GameConfigModule],
  controllers: [AdminDropsController],
  providers: [DropsService],
  exports: [DropsService],
})
export class DropsModule {}

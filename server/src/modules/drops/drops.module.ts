import { Module } from "@nestjs/common";
import { AdminDropsController } from "./admin-drops.controller";
import { DropsService } from "./drops.service";

/**
 * 掉落流水模块（#803）
 *
 * **必须挂在 AppModule 的公共 imports 里**（不在 `options.realtime` 分支内）：这两个接口
 * 是管理端在**存档进程**（3100）读的，而写入方在实时进程 —— 拆进程形态下两边都要有
 * `DatabaseModule`（`@Global`）里的 `DropRecordRepository`。
 *
 * ## 为什么权限点复用 `event:read`
 *
 * 这张表记的是「谁在哪捡走了什么」，与「玩家行为流水」（`event_logs`）同属**查人**的数据，
 * 所以同样**不给只读观察员**（观察员的定位是看业务数据）。这一刀只有读接口，没有自己的
 * 写操作 —— 等 #805 加「按图清空地面」时再单列一个写权限点，那时才需要新的名字。
 */
@Module({
  controllers: [AdminDropsController],
  providers: [DropsService],
  exports: [DropsService],
})
export class DropsModule {}

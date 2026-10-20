import { Module } from "@nestjs/common";

import { WorldService } from "./world.service";

/**
 * 世界模块（#35：服务端持有的地图实例 / 怪物状态 / tick 循环）
 *
 * 这是服务端第一次出现**常驻状态 + 定时循环**（此前是「请求来了干活、干完没事」）。
 * 数据层（WorldMonsterRepository）在全局 DatabaseModule 里，这里只装配世界服务本体；
 * 广播的出口（`onWorldChanged`）由 RealtimeModule 接线 —— 世界层不知道连接的存在。
 */
@Module({
  providers: [WorldService],
  exports: [WorldService],
})
export class WorldModule {}

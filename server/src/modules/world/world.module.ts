import { Module } from "@nestjs/common";

import { WorldService } from "./world.service";
import { RoomManager } from "./room/room.manager";
import { RoomReloadService } from "./room-reload.service";

/**
 * 世界模块（#35：服务端持有的地图实例 / 怪物状态 / tick 循环；#809 起按房间组织）
 *
 * 这是服务端第一次出现**常驻状态 + 定时循环**（此前是「请求来了干活、干完没事」）。
 * 数据层（WorldMonsterRepository / MapRuleRepository / WorldReloadRequestRepository …）
 * 在全局 DatabaseModule 里，这里只装配世界服务本体。
 *
 * 三个 provider 的分工见各自文件头：
 * - `RoomManager` —— 「有哪些房间、每间几只」（状态容器 + 播种 + 卸载）；
 * - `WorldService` —— 「时间」（重生 / 密度 / 落盘 / 代际）；
 * - `RoomReloadService` —— 「重载请求」（读 `world_reload_requests`，排队或强制执行）。
 *
 * 广播的出口（`onWorldChanged` / `onRoomReloaded`）由 RealtimeModule 接线 ——
 * 世界层不知道连接的存在。
 */
@Module({
  providers: [RoomManager, WorldService, RoomReloadService],
  exports: [WorldService, RoomManager],
})
export class WorldModule {}

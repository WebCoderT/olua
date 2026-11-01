import { Module } from "@nestjs/common";
import { AdminMapController } from "./map.controller";
import { MapService } from "./map.service";

/**
 * 地图模块（#571：管理端只读观测）
 *
 * 只读，没有 seed、没有写入口：数据源是生成快照（`shared/map-*.generated.ts`）与
 * 两张已有库表（`map_spawn_areas` / `world_monsters`），仓储由全局 DatabaseModule 提供。
 * 之所以单独成模块而不是塞进 game-config：这一块**不改任何配置**，混进去会让人以为
 * 地图也是「可编辑的运营配置」（它不是 —— 真相在客户端 TMX）。
 */
@Module({
  controllers: [AdminMapController],
  providers: [MapService],
  exports: [MapService],
})
export class MapModule {}

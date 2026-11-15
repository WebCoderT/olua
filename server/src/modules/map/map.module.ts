import { Module } from "@nestjs/common";
import { AdminMapController } from "./map.controller";
import { AdminMapInstanceController } from "./map-instance.controller";
import { MapService } from "./map.service";

/**
 * 地图模块（#571 观测台 / #573 玩法配置归服务端）
 *
 * 与 game-config 分开的原因不是「只读」了，而是**能改的东西不一样**：
 * game-config 那些模块改的是客户端配置的镜像（称号 / 装备 / 技能…），
 * 这里改的是地图的玩法配置（名称 / 类型 / 进入条件），而地图的**资源本体**根本不在服务端
 * （TMX 在客户端资源包里）。混进 game-config 会让人以为「地图也能像装备那样整套替换」。
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 `MapService.onModuleInit`（按资源清单补行，
 * `INSERT OR IGNORE` 幂等，api 与 realtime 两个进程各跑一次也无副作用）。
 * 副本接口单独一个控制器（`AdminMapInstanceController`）：地图配置是全区共用，
 * 而副本是分区的（同一个 slot 在不同区是两场），区口径相反，混在一个类里迟早漏 `X-Zone-Id`。
 *
 * `exports: MapService` 是给 `ClientConfigService`（配置快照）用的 —— 客户端拿到快照后
 * 在 `changeOnMap` 里自己判进入条件（服务端不拦连接，原因见 `MapService` 顶部）。
 */
@Module({
  controllers: [AdminMapController, AdminMapInstanceController],
  providers: [MapService],
  exports: [MapService],
})
export class MapModule {}

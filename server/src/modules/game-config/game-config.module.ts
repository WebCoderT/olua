import { Module } from "@nestjs/common";
import { AdminSoulController } from "./admin-soul.controller";
import { AdminTitleController } from "./admin-title.controller";
import { GameConfigService } from "./game-config.service";

/**
 * 养成配置（称号 / 战魂）管理
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 GameConfigService.onModuleInit（INSERT OR IGNORE
 * 幂等，realtime 进程同模块初始化时重复执行也无副作用）。
 */
@Module({
  controllers: [AdminTitleController, AdminSoulController],
  providers: [GameConfigService],
})
export class GameConfigModule {}

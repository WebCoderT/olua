import { Module } from "@nestjs/common";
import { AdminDrugController } from "./admin-drug.controller";
import { AdminEquipmentController } from "./admin-equipment.controller";
import { AdminGrowthScalarController, AdminGrowthSegmentController, AdminLevelExpController } from "./admin-growth.controller";
import { AdminItemController } from "./admin-item.controller";
import { AdminMonsterController } from "./admin-monster.controller";
import { AdminNpcController } from "./admin-npc.controller";
import { AdminRankController } from "./admin-rank.controller";
import { AdminSoulController } from "./admin-soul.controller";
import { AdminTitleController } from "./admin-title.controller";
import { GameConfigService } from "./game-config.service";
import { GrowthConfigService } from "./growth-config.service";

/**
 * 养成配置（称号 / 战魂 / 军衔 / 装备基础件 / 药品 / 物品材料 / 怪物 / NPC / 成长曲线）管理
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 GameConfigService / GrowthConfigService 的
 * onModuleInit（INSERT OR IGNORE 幂等，realtime 进程同模块初始化时重复执行也无副作用）。
 */
@Module({
  controllers: [AdminTitleController, AdminSoulController, AdminRankController, AdminEquipmentController, AdminDrugController, AdminItemController, AdminMonsterController, AdminNpcController, AdminLevelExpController, AdminGrowthSegmentController, AdminGrowthScalarController],
  providers: [GameConfigService, GrowthConfigService],
})
export class GameConfigModule {}

import { Module } from "@nestjs/common";
import { AdminDropController } from "./admin-drop.controller";
import { ClientConfigController } from "./client-config.controller";
import { ClientConfigService } from "./client-config.service";
import { AdminDrugController } from "./admin-drug.controller";
import { AdminEquipmentController } from "./admin-equipment.controller";
import { AdminFashionController } from "./admin-fashion.controller";
import { AdminGrowthScalarController, AdminGrowthSegmentController, AdminLevelExpController } from "./admin-growth.controller";
import { AdminItemController } from "./admin-item.controller";
import { AdminMallController } from "./admin-mall.controller";
import { AdminMonsterController } from "./admin-monster.controller";
import { AdminNpcController } from "./admin-npc.controller";
import { AdminQuestController } from "./admin-quest.controller";
import { AdminRankController } from "./admin-rank.controller";
import { AdminSkillController } from "./admin-skill.controller";
import { AdminStatusController } from "./admin-status.controller";
import { AdminSoulController } from "./admin-soul.controller";
import { AdminTitleController } from "./admin-title.controller";
import { GameConfigService } from "./game-config.service";
import { DropConfigService } from "./drop-config.service";
import { GrowthConfigService } from "./growth-config.service";
import { MallPricingService } from "./mall-pricing.service";

/**
 * 养成配置（称号 / 战魂 / 军衔 / 装备基础件 / 药品 / 物品材料 / 怪物 / NPC / 商城定价 / 时装 /
 * 成长曲线 / 技能 / 状态）管理
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 GameConfigService / GrowthConfigService /
 * MallPricingService 的 onModuleInit（INSERT OR IGNORE 幂等，realtime 进程同模块初始化时
 * 重复执行也无副作用）。
 */
@Module({
  controllers: [AdminTitleController, AdminSoulController, AdminRankController, AdminSkillController, AdminStatusController, AdminEquipmentController, AdminDrugController, AdminItemController, AdminMonsterController, AdminNpcController, AdminQuestController, AdminMallController, AdminFashionController, AdminDropController, AdminLevelExpController, AdminGrowthSegmentController, AdminGrowthScalarController, ClientConfigController],
  providers: [GameConfigService, DropConfigService, GrowthConfigService, MallPricingService, ClientConfigService],
  // 商城购买收权（#304）：存档域（roles）读这里的成交价
  exports: [MallPricingService],
})
export class GameConfigModule {}

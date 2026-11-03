import { Module } from "@nestjs/common";
import { MapModule } from "../map/map.module";
import { UiEffectModule } from "../ui-effect/ui-effect.module";
import { AdminAchievementController } from "./admin-achievement.controller";
import { AdminGameDataController } from "./admin-game-data.controller";
import { AdminDropController } from "./admin-drop.controller";
import { ClientConfigController } from "./client-config.controller";
import { ClientConfigService } from "./client-config.service";
import { AdminDrugController } from "./admin-drug.controller";
import { AdminEquipmentController, AdminEquipmentVariantController } from "./admin-equipment.controller";
import { AdminEquipmentRulesController } from "./admin-equipment-rules.controller";
import { AdminEquipAlignController } from "./admin-equip-align.controller";
import { AdminEquipInAlignController } from "./admin-equip-in-align.controller";
import { AdminFashionController } from "./admin-fashion.controller";
import { AdminGrowthScalarController, AdminRoleLevelController } from "./admin-growth.controller";
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
import { EquipAlignService } from "./equip-align.service";
import { EquipInAlignService } from "./equip-in-align.service";
import { GameConfigService } from "./game-config.service";
import { DropConfigService } from "./drop-config.service";
import { GrowthConfigService } from "./growth-config.service";
import { MallPricingService } from "./mall-pricing.service";
import { RuntimeConfigService } from "./runtime-config.service";
import { RuntimeParamsService } from "./runtime-params.service";
import { AdminRuntimeParamsController } from "./admin-runtime-params.controller";
import { AdminCombatWeightsController } from "./admin-combat-weights.controller";
import { CombatWeightsService } from "./combat-weights.service";
import { AdminGuideController } from "./admin-guide.controller";
import { GuideSettingsService } from "./guide-settings.service";

/**
 * 养成配置（称号 / 战魂 / 军衔 / 装备基础件 / 药品 / 物品材料 / 怪物 / NPC / 商城定价 / 时装 /
 * 成长曲线 / 技能 / 状态）管理
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 GameConfigService / GrowthConfigService /
 * MallPricingService 的 onModuleInit（INSERT OR IGNORE 幂等，realtime 进程同模块初始化时
 * 重复执行也无副作用）。
 */
@Module({
  // 地图玩法配置（#573）：配置快照要下发它（客户端据此判进入条件）
  // 特效（#594 升级特效 / #634 掉落光效）：配置快照要下发它（客户端特效按服务端参数演）
  imports: [MapModule, UiEffectModule],
  controllers: [AdminAchievementController, AdminTitleController, AdminSoulController, AdminRankController, AdminSkillController, AdminStatusController, AdminEquipmentController, AdminEquipmentVariantController, AdminEquipmentRulesController, AdminEquipAlignController, AdminEquipInAlignController, AdminDrugController, AdminItemController, AdminMonsterController, AdminNpcController, AdminQuestController, AdminMallController, AdminFashionController, AdminDropController, AdminRoleLevelController, AdminGrowthScalarController, ClientConfigController, AdminRuntimeParamsController, AdminCombatWeightsController, AdminGuideController, AdminGameDataController],
  providers: [GameConfigService, EquipAlignService, EquipInAlignService, DropConfigService, GrowthConfigService, MallPricingService, ClientConfigService, RuntimeConfigService, RuntimeParamsService, CombatWeightsService, GuideSettingsService],
  // 商城购买收权（#304）：存档域（roles）读这里的成交价
  // 运行时参数（#605）：社交域（social）的帮会规则门槛要读同一份配置
  // 战斗力权重（#605）：不需要对外导出 —— 服务端结算经 `shared/runtime-overrides` 的覆盖层读，
  // 不跨模块注入（`role-attributes` 是纯函数，拿不到 Nest 的 provider）
  exports: [MallPricingService, RuntimeParamsService],
})
export class GameConfigModule {}

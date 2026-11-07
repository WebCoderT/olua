import { Module } from "@nestjs/common";
import { MapModule } from "../map/map.module";
import { UiEffectModule } from "../ui-effect/ui-effect.module";
import { AudioSettingModule } from "../audio-setting/audio-setting.module";
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
import { AdminGrowthScalarController, AdminLevelCurveController } from "./admin-growth.controller";
import { AdminItemController } from "./admin-item.controller";
import { AdminMoneyItemController } from "./admin-money-item.controller";
import { AdminLevelScrollController } from "./admin-level-scroll.controller";
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
import { AdminEquipmentBorderController } from "./admin-equipment-border.controller";
import { AdminEquipmentBackgroundController } from "./admin-equipment-background.controller";
import { GuideSettingsService } from "./guide-settings.service";
import { EquipmentAppearanceService } from "./equipment-appearance.service";

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
  // 音效（#683）：配置快照要下发它（客户端按 key 播 / 不播）—— 只借它的 service，不借控制器
  imports: [MapModule, UiEffectModule, AudioSettingModule],
  controllers: [AdminAchievementController, AdminTitleController, AdminSoulController, AdminRankController, AdminSkillController, AdminStatusController, AdminEquipmentController, AdminEquipmentVariantController, AdminEquipmentRulesController, AdminEquipAlignController, AdminEquipInAlignController, AdminDrugController, AdminItemController, AdminMoneyItemController, AdminLevelScrollController, AdminMonsterController, AdminNpcController, AdminQuestController, AdminMallController, AdminFashionController, AdminDropController, AdminLevelCurveController, AdminGrowthScalarController, ClientConfigController, AdminRuntimeParamsController, AdminCombatWeightsController, AdminGuideController, AdminEquipmentBorderController, AdminEquipmentBackgroundController, AdminGameDataController],
  providers: [GameConfigService, EquipmentAppearanceService, EquipAlignService, EquipInAlignService, DropConfigService, GrowthConfigService, MallPricingService, ClientConfigService, RuntimeConfigService, RuntimeParamsService, CombatWeightsService, GuideSettingsService],
  // 商城购买收权（#304）：存档域（roles）读这里的成交价
  // 运行时参数（#605）：社交域（social）的帮会规则门槛要读同一份配置
  // 战斗力权重（#605）：不需要对外导出 —— 服务端结算经 `shared/runtime-overrides` 的覆盖层读，
  // 不跨模块注入（`role-attributes` 是纯函数，拿不到 Nest 的 provider）
  // RuntimeConfigService（#732）：实时进程要定时 refreshAll —— 管理端写操作后的进程内重装
  // 跨不过进程边界，实时进程不重装就会按旧配置现算战斗力（与操作应答各执一份值，客户端抖动）
  exports: [MallPricingService, RuntimeParamsService, RuntimeConfigService],
})
export class GameConfigModule {}

import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { AchievementController } from "./achievement.controller";
import { AchievementService } from "./achievement.service";

/**
 * 成就（#401，epic #394）
 *
 * 与任务模块同一装配口径：需要 `RolesModule` 导出的 `RolesService`（查等级 / 战力 /
 * 背包持有量，领奖也走它的单次落库发奖入口）；仓储由全局 `DatabaseModule` 提供，
 * 事件总线由 `GameEventsModule` 提供（两者都不在这里重复注册）。
 */
@Module({
  imports: [RolesModule],
  controllers: [AchievementController],
  providers: [AchievementService],
  exports: [AchievementService],
})
export class AchievementModule {}

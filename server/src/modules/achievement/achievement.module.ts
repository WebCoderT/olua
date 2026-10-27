import { Module } from "@nestjs/common";
import { GameMailModule } from "../game-mail/game-mail.module";
import { RolesModule } from "../roles/roles.module";
import { AchievementController } from "./achievement.controller";
import { AchievementService } from "./achievement.service";

/**
 * 成就（#401，epic #394）
 *
 * 与任务模块同一装配口径：需要 `RolesModule` 导出的 `RolesService`（查等级 / 战力 /
 * 背包持有量，领奖也走它的单次落库发奖入口）；仓储由全局 `DatabaseModule` 提供，
 * 事件总线由 `GameEventsModule` 提供（两者都不在这里重复注册）。
 *
 * `GameMailModule`（#429）只为一件事：领奖时背包满，把整份奖励转成邮件 ——
 * 服务端内部的降级，客户端不需要多一步操作。
 */
@Module({
  imports: [RolesModule, GameMailModule],
  controllers: [AchievementController],
  providers: [AchievementService],
  exports: [AchievementService],
})
export class AchievementModule {}

import { Module } from "@nestjs/common";
import { GameConfigModule } from "../game-config/game-config.module";
import { GameMailModule } from "../game-mail/game-mail.module";
import { RolesModule } from "../roles/roles.module";
import { AdminGuildController } from "./admin-guild.controller";
import { AdminReportController } from "./admin-report.controller";
import { GuildController } from "./guild.controller";
import { GuildService } from "./guild.service";
import { ReportService } from "./report.service";
import { SocialController } from "./social.controller";
import { SocialService } from "./social.service";

/**
 * 社交（#388 帮会；#389 好友与关系；#398 屏蔽与举报）
 *
 * 需要 RolesModule 导出的 `RolesService`：所有社交动作都落在**账号的在线角色**上，
 * 而「哪个角色在线」只有存档域知道（`accounts.online_role_id`）。
 * 需要 GameMailModule 导出的 `GameMailService`：好友申请要给对方留一条社交消息（#436）。
 * 需要 GameConfigModule 导出的 `RuntimeParamsService`：帮会名 / 公告 / 留言的长度门槛
 * 是运行时参数（#605，管理端可改），建帮与改公告按当前配置判。
 * 仓储由全局 DatabaseModule 提供，这里不重复注册。
 */
@Module({
  imports: [RolesModule, GameMailModule, GameConfigModule],
  controllers: [GuildController, AdminGuildController, SocialController, AdminReportController],
  providers: [GuildService, SocialService, ReportService],
})
export class SocialModule {}

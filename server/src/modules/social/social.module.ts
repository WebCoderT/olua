import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { AdminGuildController } from "./admin-guild.controller";
import { GuildController } from "./guild.controller";
import { GuildService } from "./guild.service";
import { SocialController } from "./social.controller";
import { SocialService } from "./social.service";

/**
 * 社交（#388 帮会；#389 好友与关系）
 *
 * 需要 RolesModule 导出的 `RolesService`：所有社交动作都落在**账号的在线角色**上，
 * 而「哪个角色在线」只有存档域知道（`accounts.online_role_id`）。
 * 仓储由全局 DatabaseModule 提供，这里不重复注册。
 */
@Module({
  imports: [RolesModule],
  controllers: [GuildController, AdminGuildController, SocialController],
  providers: [GuildService, SocialService],
})
export class SocialModule {}

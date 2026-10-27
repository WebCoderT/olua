import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { GameMailController } from "./game-mail.controller";
import { GameMailService } from "./game-mail.service";

/**
 * 游戏内邮件（#429）
 *
 * exports 是为了让成就模块在「背包满」时能直接把奖励转成一封邮件 ——
 * 那是**服务端内部的降级**，不该让客户端多一步操作。
 *
 * 别和 `MailModule` 搞混：那个是外发 SMTP 投递队列（发到玩家注册邮箱）。
 */
@Module({
  imports: [RolesModule],
  controllers: [GameMailController],
  providers: [GameMailService],
  exports: [GameMailService],
})
export class GameMailModule {}

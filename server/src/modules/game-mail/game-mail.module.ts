import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { GameMailController } from "./game-mail.controller";
import { GameMailEventsService } from "./game-mail-events.service";
import { GameMailService } from "./game-mail.service";

/**
 * 游戏内邮件 / 消息中心（#429、频道化 #436）
 *
 * exports 是为了让其他模块能把「一条消息」写进玩家的收件箱：
 * - 成就模块：领奖时背包满 → 整份奖励转邮件（`channel: reward`）
 * - 社交模块：好友申请 → 一条社交消息（`channel: social`）
 * - 战斗频道：本模块自己订阅 `monster:killed`（`channel: combat`）
 *
 * 别和 `MailModule` 搞混：那个是外发 SMTP 投递队列（发到玩家注册邮箱）。
 */
@Module({
  imports: [RolesModule],
  controllers: [GameMailController],
  providers: [GameMailService, GameMailEventsService],
  exports: [GameMailService],
})
export class GameMailModule {}

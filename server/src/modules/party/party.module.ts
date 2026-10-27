import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { PartyService } from "./party.service";

/**
 * 队伍（#399）
 *
 * 与社交 / 任务同一种形态：**没有控制器** —— 队伍的全部交互走实时通道的 `party` 帧
 * （邀请必须即时送达，而 HTTP 在存档进程、推不到别人的 WS 连接）。
 *
 * 装在 `AppModule` 的**无条件分支**里：两个进程都要能读队伍（实时进程要分经验 / 发帧，
 * 存档进程将来排查与管理端也要看），只有实时进程会写。
 * 仓储由全局 `DatabaseModule` 提供（`PartyRepository` 在那里注册），这里不重复。
 */
@Module({
  imports: [RolesModule],
  providers: [PartyService],
  exports: [PartyService],
})
export class PartyModule {}

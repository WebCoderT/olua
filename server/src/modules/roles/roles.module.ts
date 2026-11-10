import { Module } from "@nestjs/common";
import { GameConfigModule } from "../game-config/game-config.module";
import { EventLogModule } from "../event-log/event-log.module";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";
import { RoleStatusService } from "./role-status.service";

/** 客户端角色模块 */
@Module({
  // 商城购买收权（#304）：购买要读成交价（game-config 的定价服务）
  // 行为流水（#886）：拾取 / 获得 / 消耗在写入口记一条
  imports: [GameConfigModule, EventLogModule],
  controllers: [RolesController],
  // 角色状态（#822）：结算与受击都要读它，存活周期比一次出手长（落库）
  providers: [RolesService, RoleStatusService],
  exports: [RolesService, RoleStatusService],
})
export class RolesModule {}

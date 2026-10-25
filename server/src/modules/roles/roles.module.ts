import { Module } from "@nestjs/common";
import { GameConfigModule } from "../game-config/game-config.module";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";

/** 客户端角色模块 */
@Module({
  // 商城购买收权（#304）：购买要读成交价（game-config 的定价服务）
  imports: [GameConfigModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}

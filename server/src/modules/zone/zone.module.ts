import { Module } from "@nestjs/common";
import { ZoneController } from "./zone.controller";
import { ZoneService } from "./zone.service";

/**
 * 区服模块（#295 阶段二：多开区 / 合并区）
 *
 * ZoneService 同时服务玩家侧（注册选区的活区列表）与管理端（开区 / 合并区，
 * 管理端控制器在 modules/admin/admin-zone.controller.ts）—— 一份合并逻辑，别处不复制。
 */
@Module({
  controllers: [ZoneController],
  providers: [ZoneService],
  exports: [ZoneService],
})
export class ZoneModule {}

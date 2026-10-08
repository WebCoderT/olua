import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

/** 系统模块（健康检查） */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}

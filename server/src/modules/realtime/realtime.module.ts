import { Module } from "@nestjs/common";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";

/**
 * 实时模块（服务端侧的 WebSocket 通道）
 *
 * 不引 `DatabaseModule`：它不碰库 —— 身份由 HTTP 那侧（AuthGuard）给过来，
 * 连接状态只活在内存里。等通道上开始跑业务（#34）再看要不要落库。
 */
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
})
export class RealtimeModule {}

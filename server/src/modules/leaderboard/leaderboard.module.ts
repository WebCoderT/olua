import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { LeaderboardController } from "./leaderboard.controller";
import { LeaderboardService } from "./leaderboard.service";

/**
 * 排行榜（#400）
 *
 * 只读模块：榜单是 `roles` 的派生数据，不经手任何写路径（击杀计数由 `RolesService` 负责）。
 * 无条件下装载 —— 单进程形态与拆进程形态都要有 HTTP 接口；真实的重算成本只在
 * 「第一次有人看榜」之后才发生（见 `LeaderboardService` 里定时器的注释）。
 */
@Module({
  imports: [DatabaseModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}

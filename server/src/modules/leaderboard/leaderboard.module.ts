import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { RolesModule } from "../roles/roles.module";
import { LeaderboardController } from "./leaderboard.controller";
import { LeaderboardService } from "./leaderboard.service";

/**
 * 排行榜（#400）
 *
 * 只读模块：榜单是 `roles` 的派生数据，不经手任何写路径（击杀计数由 `RolesService` 负责）。
 * 依赖 RolesModule 只为一件事：**这个账号现在是哪个区**（`RolesService.zoneOf`：
 * 进图后是在线角色的区，还没选角色时是账号的当前浏览区，见 #959）。
 * 不自己再写一份读法 —— 两处口径迟早会分叉。
 *
 * 无条件下装载 —— 单进程形态与拆进程形态都要有 HTTP 接口；真实的重算成本只在
 * 「第一次有人看榜」之后才发生（见 `LeaderboardService` 里定时器的注释）。
 */
@Module({
  imports: [DatabaseModule, RolesModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}

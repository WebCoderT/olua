import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { AdminAnnouncementController } from "./admin-announcement.controller";
import { AnnouncementController } from "./announcement.controller";
import { AnnouncementService } from "./announcement.service";

/**
 * 公告模块
 *
 * 一个模块里两个控制器，对应两条完全不同的访问路径：
 * - `AnnouncementController`：公共（登录页）/ 玩家侧读（游戏内公告板）
 * - `AdminAnnouncementController`：管理端，运营写
 *
 * 放在同一个模块里是因为它们共用同一份仓储与「什么算生效」的判据 ——
 * 拆成两个模块会让那段判据要么重复、要么需要跨模块导出。
 *
 * 依赖 `RolesModule` 只为了一件事（#963）：玩家侧的「全服 + 本区」要知道这个账号在哪个区，
 * 而「区怎么算」的口径（在线角色优先）只能有一份 —— 见 `RolesService.zoneOf`。
 */
@Module({
  // AnnouncementRepository 由全局 DatabaseModule 提供（全部仓储统一装配，模块内不再本地注册）
  imports: [RolesModule],
  controllers: [AnnouncementController, AdminAnnouncementController],
  providers: [AnnouncementService],
})
export class AnnouncementModule {}

import { Module } from "@nestjs/common";
import { AdminAnnouncementController } from "./admin-announcement.controller";
import { AnnouncementController } from "./announcement.controller";
import { AnnouncementService } from "./announcement.service";

/**
 * 公告模块
 *
 * 一个模块里两个控制器，对应两条完全不同的访问路径：
 * - `AnnouncementController`：公共，玩家侧读（登录页也要能显示）
 * - `AdminAnnouncementController`：管理端，运营写
 *
 * 放在同一个模块里是因为它们共用同一份仓储与「什么算生效」的判据 ——
 * 拆成两个模块会让那段判据要么重复、要么需要跨模块导出。
 */
@Module({
  // AnnouncementRepository 由全局 DatabaseModule 提供（全部仓储统一装配，模块内不再本地注册）
  controllers: [AnnouncementController, AdminAnnouncementController],
  providers: [AnnouncementService],
})
export class AnnouncementModule {}

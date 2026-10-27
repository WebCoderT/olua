import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { QuestController } from "./quest.controller";
import { QuestService } from "./quest.service";

/**
 * 任务（#396，epic #394）
 *
 * 需要 RolesModule 导出的 `RolesService`：接取 / 交付都落在**账号的在线角色**上，
 * 交付发奖（扣材料 + 发奖励 + 升级）也走存档域的**单次落库**方法。
 * 仓储由全局 DatabaseModule 提供，这里不重复注册（审计盯着这条装配口径）。
 */
@Module({
  imports: [RolesModule],
  controllers: [QuestController],
  providers: [QuestService],
  exports: [QuestService],
})
export class QuestModule {}

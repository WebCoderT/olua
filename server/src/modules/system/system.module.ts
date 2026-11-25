import { Module } from "@nestjs/common";
import { AdminSystemController } from "./admin-system.controller";
import { BackupSchedulerService } from "./backup-scheduler.service";
import { BackupService } from "./backup.service";
import { ConfigSnapshotService } from "./config-snapshot.service";
import { SystemService } from "./system.service";

/**
 * 系统信息模块
 *
 * 只有管理端一个只读接口（`GET /admin/system`）—— 运维自查用，不参与任何业务流程。
 * 配置快照的导出 / 导入（#1266）也挂在这里：导出是只读备份，导入继承 `make config-import`
 * 的同一份脚本与安全语义 —— 与自动备份同理，「界面上的操作」与「命令行的操作」必须是同一份实现。
 * 依赖 DatabaseModule 拿只读的行数统计（表名从 `sqlite_master` 动态枚举）。
 *
 * 自动备份的两个服务也挂在这里（而不是另起一个 BackupModule）：备份本身就是
 * 运维自查的一部分 —— `make db-backup` 手工跑出来的东西，与这里自动跑出来的，
 * 必须是同一份脚本、同一个目录、同一套保留策略。
 */
@Module({
  // SystemRepository 由全局 DatabaseModule 提供（全部仓储统一装配，模块内不再本地注册）
  controllers: [AdminSystemController],
  providers: [SystemService, BackupService, BackupSchedulerService, ConfigSnapshotService],
})
export class SystemModule {}

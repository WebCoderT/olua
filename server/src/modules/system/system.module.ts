import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { SystemRepository } from "../../database/repositories/system.repository";
import { AdminSystemController } from "./admin-system.controller";
import { SystemService } from "./system.service";

/**
 * 系统信息模块
 *
 * 只有管理端一个只读接口（`GET /admin/system`）—— 运维自查用，不参与任何业务流程。
 * 依赖 DatabaseModule 拿只读的行数统计（表名从 `sqlite_master` 动态枚举）。
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminSystemController],
  providers: [SystemService, SystemRepository],
})
export class SystemModule {}

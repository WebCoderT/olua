import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { AccountRepository } from "./repositories/account.repository";
import { AdminRepository } from "./repositories/admin.repository";
import { AuditRepository } from "./repositories/audit.repository";
import { RoleRepository } from "./repositories/role.repository";

/**
 * 数据层（全局模块）
 *
 * 各业务模块直接用注入的 Repository，不必逐层 import 本模块；
 * SQL 全部收在 repositories/ 下，换库时只需改这一层。
 */
@Global()
@Module({
  providers: [DatabaseService, AccountRepository, RoleRepository, AdminRepository, AuditRepository],
  exports: [DatabaseService, AccountRepository, RoleRepository, AdminRepository, AuditRepository],
})
export class DatabaseModule {}

import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { AccountRepository } from "./repositories/account.repository";
import { AdminRepository } from "./repositories/admin.repository";
import { AnnouncementRepository } from "./repositories/announcement.repository";
import { AuditRepository } from "./repositories/audit.repository";
import { MailRepository } from "./repositories/mail.repository";
import { RoleRepository } from "./repositories/role.repository";
import { SoulRepository } from "./repositories/soul.repository";
import { SystemRepository } from "./repositories/system.repository";
import { GrowthRepository } from "./repositories/growth.repository";
import { RankRepository } from "./repositories/rank.repository";
import { TitleRepository } from "./repositories/title.repository";
import { WorldMonsterRepository } from "./repositories/world-monster.repository";

/**
 * 数据层（全局模块）
 *
 * 全部仓储（8 个）都在这里 provide + export：业务模块直接注入 Repository，不必逐层 import
 * 本模块，也**不许在各模块里再本地注册仓储类**（与全局单例同名会造出第二个实例 —— 审计脚本
 * `tools/audit-server-boundaries.cjs` 盯着这条装配口径）。SQL 全部收在 repositories/ 下，
 * 换库时只需改这一层。
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    AccountRepository,
    RoleRepository,
    AdminRepository,
    AuditRepository,
    AnnouncementRepository,
    MailRepository,
    SystemRepository,
    WorldMonsterRepository,
    TitleRepository,
    RankRepository,
    GrowthRepository,
    SoulRepository,
  ],
  exports: [
    DatabaseService,
    AccountRepository,
    RoleRepository,
    AdminRepository,
    AuditRepository,
    AnnouncementRepository,
    MailRepository,
    SystemRepository,
    WorldMonsterRepository,
    TitleRepository,
    RankRepository,
    GrowthRepository,
    SoulRepository,
  ],
})
export class DatabaseModule {}

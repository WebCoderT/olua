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
import { EquipmentRepository } from "./repositories/equipment.repository";
import { DrugRepository } from "./repositories/drug.repository";
import { ItemRepository } from "./repositories/item.repository";
import { MallRepository } from "./repositories/mall.repository";
import { MonsterRepository } from "./repositories/monster.repository";
import { NpcRepository } from "./repositories/npc.repository";
import { FashionRepository } from "./repositories/fashion.repository";
import { DropTableRepository } from "./repositories/drop-table.repository";
import { MonsterDropRepository } from "./repositories/monster-drop.repository";
import { TitleRepository } from "./repositories/title.repository";
import { WorldMonsterRepository } from "./repositories/world-monster.repository";
import { MapSpawnAreaRepository } from "./repositories/map-spawn-area.repository";
import { ZoneRepository } from "./repositories/zone.repository";
import { SkillRepository } from "./repositories/skill.repository";
import { StatusRepository } from "./repositories/status.repository";
import { MonsterSkillRepository } from "./repositories/monster-skill.repository";
import { GuildRepository } from "./repositories/guild.repository";
import { SocialRepository } from "./repositories/social.repository";
import { QuestRepository } from "./repositories/quest.repository";
import { QuestProgressRepository } from "./repositories/quest-progress.repository";
import { ReportRepository } from "./repositories/report.repository";
import { PartyRepository } from "./repositories/party.repository";
import { AchievementRepository } from "./repositories/achievement.repository";
import { RoleAchievementRepository } from "./repositories/role-achievement.repository";
import { RoleMailRepository } from "./repositories/role-mail.repository";

/**
 * 数据层（全局模块）
 *
 * 全部仓储都在这里 provide + export：业务模块直接注入 Repository，不必逐层 import
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
    MapSpawnAreaRepository,
    ZoneRepository,
    TitleRepository,
    RankRepository,
    EquipmentRepository,
    DrugRepository,
    ItemRepository,
    MonsterRepository,
    MallRepository,
    NpcRepository,
    FashionRepository,
    DropTableRepository,
    MonsterDropRepository,
    GrowthRepository,
    SoulRepository,
    SkillRepository,
    StatusRepository,
    MonsterSkillRepository,
    GuildRepository,
    SocialRepository,
    QuestRepository,
    QuestProgressRepository,
    ReportRepository,
    PartyRepository,
    AchievementRepository,
    RoleAchievementRepository,
    RoleMailRepository,
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
    MapSpawnAreaRepository,
    ZoneRepository,
    TitleRepository,
    RankRepository,
    EquipmentRepository,
    DrugRepository,
    ItemRepository,
    MonsterRepository,
    MallRepository,
    NpcRepository,
    FashionRepository,
    DropTableRepository,
    MonsterDropRepository,
    GrowthRepository,
    SoulRepository,
    SkillRepository,
    StatusRepository,
    MonsterSkillRepository,
    GuildRepository,
    SocialRepository,
    QuestRepository,
    QuestProgressRepository,
    ReportRepository,
    PartyRepository,
    AchievementRepository,
    RoleAchievementRepository,
    RoleMailRepository,
  ],
})
export class DatabaseModule {}

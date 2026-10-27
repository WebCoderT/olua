import { AccountDto } from "../modules/auth/dto/account.dto";
import { AuthTokenDto } from "../modules/auth/dto/auth-token.dto";
import { AdminLoginDto, AdminRegisterDto } from "../modules/admin/dto/admin-auth.dto";
import { AdminDto, AdminTokenDto, AdminUpdateDto } from "../modules/admin/dto/admin.dto";
import { AdminPatchRoleDto, RoleBagCellDto } from "../modules/admin/dto/patch-role.dto";
import { BatchDeleteResultDto, BatchDeleteRolesDto } from "../modules/admin/dto/batch-role.dto";
import { BatchStatusResultDto, BatchUpdateAccountStatusDto } from "../modules/admin/dto/batch-account.dto";
import { ChangeAdminPasswordDto, ResetAccountPasswordDto, ResetAdminPasswordDto, ResetPasswordResultDto } from "../modules/admin/dto/password.dto";
import { AccountQueryDto, AdminQueryDto, RoleQueryDto, StatsRecentQueryDto, StatsTrendQueryDto, UpdateAccountStatusDto } from "../modules/admin/dto/query.dto";
import {
  AdminAccountDetailDto,
  AdminStatsDto,
  StatsBreakdownDto,
  StatsBreakdownItemDto,
  StatsRecentItemDto,
  StatsTrendDto,
  StatsTrendPointDto,
} from "../modules/admin/dto/stats.dto";
import { AccountPageDto, AdminPageDto, AdminRolePageDto } from "../modules/admin/dto/page-result.dto";
import { AuditActionListDto, AuditExportDto, AuditLogDto, AuditLogPageDto, AuditQueryDto } from "../modules/audit/dto/audit.dto";
import { ApiEnvelopeDto, PageMetaDto, PageQueryDto } from "../common/dto/api-envelope.dto";
import { HealthDto } from "../modules/health/dto/health.dto";
import { CreateRoleDto, SaveRoleDto } from "../modules/roles/dto/create-role.dto";
import { LeaderboardEntryDto, LeaderboardPageDto, LeaderboardQueryDto, LeaderboardSelfDto } from "../modules/leaderboard/dto/leaderboard.dto";
import { AdminRoleDetailDto, AdminRoleDto, GrowthUpgradeResultDto, RoleDerivedAttributesDto, RoleDerivedDto, RoleReportedAttributesDto, RoleDto, RoleSummaryDto } from "../modules/roles/dto/role.dto";
import { GrowthUpgradeDto } from "../modules/roles/dto/growth-upgrade.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "../modules/roles/dto/mall-purchase.dto";
import { SellEntryDto, SellGoodsDto, SellGoodsResultDto, SellLineDto } from "../modules/roles/dto/sell-goods.dto";
import { DrugUseDto, DrugUseResultDto } from "../modules/roles/dto/drug-use.dto";
import {
  SystemConfigItemDto,
  SystemDatabaseDto,
  SystemInfoDto,
  SystemRuntimeDto,
  SystemTableCountDto,
} from "../modules/system/dto/system.dto";
import {
  ActiveAnnouncementDto,
  AnnouncementDto,
  AnnouncementPageDto,
  AnnouncementQueryDto,
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from "../modules/announcement/dto/announcement.dto";
import {
  ConfigAttributeRangeDto,
  ConfigAttributesDto,
  TitleDto,
  TitlePageDto,
  TitleQueryDto,
  UpdateTitleDto,
  UpgradeOrderDto,
} from "../modules/game-config/dto/title.dto";
import { SoulDto, SoulPageDto, SoulQueryDto, UpdateSoulDto } from "../modules/game-config/dto/soul.dto";
import { RankDto, RankPageDto, RankQueryDto, UpdateRankDto } from "../modules/game-config/dto/rank.dto";
import { EquipmentDto, EquipmentPageDto, EquipmentQueryDto, UpdateEquipmentDto } from "../modules/game-config/dto/equipment.dto";
import { DrugDto, DrugPageDto, DrugQueryDto, UpdateDrugDto } from "../modules/game-config/dto/drug.dto";
import { ItemDto, ItemPageDto, ItemQueryDto, UpdateItemDto } from "../modules/game-config/dto/item.dto";
import { MonsterDto, MonsterPageDto, MonsterQueryDto, UpdateMonsterDto } from "../modules/game-config/dto/monster.dto";
import { NpcDto, NpcPageDto, NpcQueryDto, UpdateNpcDto } from "../modules/game-config/dto/npc.dto";
import { CreateSkillDto, DamageCoefficientDto, SkillDto, SkillPageDto, SkillQueryDto, UpdateSkillDto } from "../modules/game-config/dto/skill.dto";
import { MonsterSkillDto, MonsterSkillItemDto, MonsterSkillListDto, ReplaceMonsterSkillsDto } from "../modules/game-config/dto/monster-skill.dto";
import { StatusCombatDto, StatusDto, StatusPageDto, StatusQueryDto, UpdateStatusDto } from "../modules/game-config/dto/status.dto";
import { CreateQuestDto, QuestDto, QuestObjectiveDto, QuestPageDto, QuestQueryDto, QuestRewardItemDto, QuestRewardsDto, UpdateQuestDto } from "../modules/game-config/dto/quest.dto";
import { MyQuestsDto, NpcTalkDto, NpcTalkResultDto, QuestIdDto, QuestRewardResultDto, QuestStateDto, QuestSubmitResultDto } from "../modules/quest/dto/quest-state.dto";
import { MallPriceItemDto, MallPricePageDto, MallPriceQueryDto, MallPriceRemoveDto, MallSettingsDto, PutMallPriceDto, UpdateMallSettingsDto } from "../modules/game-config/dto/mall.dto";
import { FashionDto, FashionPageDto, FashionQueryDto, UpdateFashionDto } from "../modules/game-config/dto/fashion.dto";
import { CreateDropTableDto, DropEntryDto, DropTableDto, DropTableListDto, MonsterDropDto, MonsterDropPageDto, MonsterDropQueryDto, UpdateDropTableDto, UpdateMonsterDropDto } from "../modules/game-config/dto/drop.dto";
import { GameConfigSnapshotDto } from "../modules/game-config/dto/client-config.dto";
import {
  GrowthScalarDto,
  GrowthScalarPageDto,
  GrowthScalarQueryDto,
  GrowthSegmentDto,
  GrowthSegmentPageDto,
  GrowthSegmentQueryDto,
  LevelExpDto,
  LevelExpPageDto,
  LevelExpQueryDto,
  UpdateGrowthScalarDto,
  UpdateGrowthSegmentDto,
  UpdateLevelExpDto,
} from "../modules/game-config/dto/growth.dto";
import { LoginDto, RegisterDto } from "../modules/auth/dto/register.dto";
import { RealtimeTicketDto } from "../modules/realtime/dto/realtime.dto";
import { ZoneDto, AdminZoneDto, CreateZoneDto, MergeZoneDto } from "../modules/zone/dto/zone.dto";
import {
  AdminGuildDetailDto,
  AdminGuildDto,
  AdminUpdateGuildDto,
  ApplyGuildDto,
  CreateGuildDto,
  GuildApplicationDto,
  GuildMemberDto,
  GuildSummaryDto,
  MyGuildDto,
  ReviewGuildApplicationDto,
  TransferGuildDto,
  UpdateGuildNoticeDto,
} from "../modules/social/dto/guild.dto";
import { CreateReportDto, MySocialDto, SocialEntryDto, SocialTargetDto } from "../modules/social/dto/social.dto";
import { ReportDto, ReportPageDto, ReportQueryDto } from "../modules/social/dto/report.dto";
import {
  MailJobDto,
  MailJobPageDto,
  MailQueryDto,
  MailTemplateDto,
  SendMailDto,
  SendMailResultDto,
} from "../modules/mail/dto/mail.dto";

/**
 * Swagger 文档要注册的模型清单
 *
 * `@ApiDataResponse(XxxDto)` 生成的 schema 是 `$ref`，被引用的模型必须在文档里存在，
 * 所以统一在这里登记进 `extraModels`（新增响应 DTO 时**补到这里**，否则 Swagger 上会缺 schema）。
 */
export const SWAGGER_MODELS = [
  ApiEnvelopeDto,
  PageMetaDto,
  PageQueryDto,
  // 客户端
  RegisterDto,
  LoginDto,
  AccountDto,
  AuthTokenDto,
  CreateRoleDto,
  SaveRoleDto,
  GrowthUpgradeDto,
  MallPurchaseDto,
  DrugUseDto,
  RoleSummaryDto,
  RoleDto,
  GrowthUpgradeResultDto,
  MallPurchaseResultDto,
  SellGoodsDto,
  SellEntryDto,
  SellLineDto,
  SellGoodsResultDto,
  DrugUseResultDto,
  RealtimeTicketDto,
  // 区服（#295 阶段二）
  ZoneDto,
  AdminZoneDto,
  CreateZoneDto,
  MergeZoneDto,
  // 管理端
  AdminRegisterDto,
  AdminLoginDto,
  AdminDto,
  AdminTokenDto,
  AdminAccountDetailDto,
  AdminStatsDto,
  // 运营看板
  StatsTrendDto,
  StatsTrendPointDto,
  StatsBreakdownDto,
  StatsBreakdownItemDto,
  StatsRecentItemDto,
  StatsTrendQueryDto,
  StatsRecentQueryDto,
  AccountPageDto,
  AdminPageDto,
  AdminRolePageDto,
  AdminRoleDto,
  AdminRoleDetailDto,
  RoleDerivedDto,
  RoleDerivedAttributesDto,
  RoleReportedAttributesDto,
  AdminPatchRoleDto,
  RoleBagCellDto,
  BatchDeleteRolesDto,
  BatchDeleteResultDto,
  BatchUpdateAccountStatusDto,
  BatchStatusResultDto,
  AdminUpdateDto,
  // 口令管理
  ResetAccountPasswordDto,
  ResetAdminPasswordDto,
  ChangeAdminPasswordDto,
  ResetPasswordResultDto,
  // 操作日志
  AuditLogDto,
  AuditLogPageDto,
  AuditActionListDto,
  AuditExportDto,
  AuditQueryDto,
  AccountQueryDto,
  RoleQueryDto,
  AdminQueryDto,
  UpdateAccountStatusDto,
  // 系统
  HealthDto,
  SystemInfoDto,
  SystemRuntimeDto,
  SystemDatabaseDto,
  SystemTableCountDto,
  SystemConfigItemDto,
  // 公告
  ActiveAnnouncementDto,
  AnnouncementDto,
  AnnouncementPageDto,
  AnnouncementQueryDto,
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
  // 邮件
  MailJobDto,
  MailJobPageDto,
  MailQueryDto,
  MailTemplateDto,
  SendMailDto,
  SendMailResultDto,
  // 养成配置（称号 / 战魂）
  TitleDto,
  TitlePageDto,
  TitleQueryDto,
  UpdateTitleDto,
  UpgradeOrderDto,
  SoulDto,
  SoulPageDto,
  SoulQueryDto,
  UpdateSoulDto,
  ConfigAttributesDto,
  ConfigAttributeRangeDto,
  // 养成配置（成长曲线 #256）
  LevelExpDto,
  LevelExpPageDto,
  LevelExpQueryDto,
  UpdateLevelExpDto,
  GrowthSegmentDto,
  GrowthSegmentPageDto,
  GrowthSegmentQueryDto,
  UpdateGrowthSegmentDto,
  GrowthScalarDto,
  GrowthScalarPageDto,
  GrowthScalarQueryDto,
  UpdateGrowthScalarDto,
  // 养成配置（军衔 #250）
  RankDto,
  RankPageDto,
  RankQueryDto,
  UpdateRankDto,
  // 养成配置（装备基础件 #252）
  EquipmentDto,
  EquipmentPageDto,
  EquipmentQueryDto,
  UpdateEquipmentDto,
  // 养成配置（药品 #253）
  DrugDto,
  DrugPageDto,
  DrugQueryDto,
  UpdateDrugDto,
  // 养成配置（物品与材料 #255）
  ItemDto,
  ItemPageDto,
  ItemQueryDto,
  UpdateItemDto,
  // 养成配置（怪物 #258）
  MonsterDto,
  MonsterPageDto,
  MonsterQueryDto,
  UpdateMonsterDto,
  // 养成配置（NPC #258）
  NpcDto,
  NpcPageDto,
  NpcQueryDto,
  UpdateNpcDto,
  // 养成配置（技能与状态 #367）
  SkillDto,
  DamageCoefficientDto,
  SkillPageDto,
  SkillQueryDto,
  UpdateSkillDto,
  CreateSkillDto,
  MonsterSkillDto,
  MonsterSkillItemDto,
  MonsterSkillListDto,
  ReplaceMonsterSkillsDto,
  StatusDto,
  StatusCombatDto,
  StatusPageDto,
  StatusQueryDto,
  UpdateStatusDto,
  // 任务配置（#396）
  QuestDto,
  QuestObjectiveDto,
  QuestRewardsDto,
  QuestRewardItemDto,
  QuestPageDto,
  QuestQueryDto,
  UpdateQuestDto,
  CreateQuestDto,
  // 任务（#396 玩家侧）
  MyQuestsDto,
  QuestStateDto,
  QuestSubmitResultDto,
  QuestRewardResultDto,
  NpcTalkResultDto,
  QuestIdDto,
  NpcTalkDto,
  // 商城定价（#251）
  MallSettingsDto,
  MallPriceItemDto,
  MallPricePageDto,
  MallPriceQueryDto,
  UpdateMallSettingsDto,
  PutMallPriceDto,
  MallPriceRemoveDto,
  FashionDto,
  FashionPageDto,
  FashionQueryDto,
  UpdateFashionDto,
  CreateDropTableDto,
  DropEntryDto,
  DropTableDto,
  DropTableListDto,
  MonsterDropDto,
  MonsterDropPageDto,
  MonsterDropQueryDto,
  GameConfigSnapshotDto,
  UpdateDropTableDto,
  UpdateMonsterDropDto,
  // 帮会（#388）
  GuildSummaryDto,
  GuildMemberDto,
  GuildApplicationDto,
  MyGuildDto,
  AdminGuildDto,
  AdminGuildDetailDto,
  CreateGuildDto,
  ApplyGuildDto,
  ReviewGuildApplicationDto,
  UpdateGuildNoticeDto,
  TransferGuildDto,
  AdminUpdateGuildDto,
  // 社交（#389：好友与敌人；#398：屏蔽与举报）
  SocialEntryDto,
  MySocialDto,
  SocialTargetDto,
  CreateReportDto,
  ReportDto,
  ReportPageDto,
  ReportQueryDto,
  // 排行榜（#400）
  LeaderboardEntryDto,
  LeaderboardPageDto,
  LeaderboardSelfDto,
  LeaderboardQueryDto,
];

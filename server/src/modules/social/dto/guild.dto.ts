import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from "class-validator";
import { GuildApplicationWithRoleRow, GuildListRow, GuildMemberWithRoleRow, GuildRow } from "../../../database/rows";
import {
  GUILD_APPLICATION_MESSAGE_MAX,
  GUILD_NAME_MAX,
  GUILD_NAME_MIN,
  GUILD_NOTICE_MAX,
  GUILD_RANK_LABELS,
} from "../../../common/constants/social";

/** 帮会列表一行（浏览用：不含成员名单，人多的帮会名单能到几十条，列表里不需要） */
export class GuildSummaryDto {
  @ApiProperty({ description: "帮会 id", example: "g_1760000000000_ab12" })
  id: string;

  @ApiProperty({ description: "帮会名", example: "听雨阁" })
  name: string;

  @ApiProperty({ description: "帮会公告（列表里也带，便于一行看全）", example: "每周三晚八点集合" })
  notice: string;

  @ApiProperty({ description: "帮会等级（当前恒为 1：等级业务未做，先占位）", example: 1 })
  level: number;

  @ApiProperty({ description: "当前成员数", example: 12 })
  memberCount: number;

  @ApiProperty({ description: "帮主角色名", example: "甲一" })
  leaderName: string;

  @ApiProperty({ description: "创建时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  static from(row: GuildListRow): GuildSummaryDto {
    const dto = new GuildSummaryDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.notice = row.notice;
    dto.level = row.level;
    dto.memberCount = row.member_count;
    dto.leaderName = row.leader_name;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/** 帮会成员一行（名字与等级取 `roles` 的索引列，角色改名/升级后自动是新的） */
export class GuildMemberDto {
  @ApiProperty({ description: "角色 id", example: "role_a1" })
  roleId: string;

  @ApiProperty({ description: "角色名", example: "甲一" })
  name: string;

  @ApiProperty({ description: "角色等级", example: 12 })
  level: number;

  @ApiProperty({ description: "职业（客户端按这张表显示职业图标）", example: "1" })
  occupation: string;

  @ApiProperty({ description: "职位：leader 帮主 / vice 副帮主 / member 成员", example: "member" })
  rank: string;

  @ApiProperty({ description: "职位中文名（服务端给，客户端不另写一套）", example: "成员" })
  rankLabel: string;

  @ApiProperty({ description: "入帮时间（毫秒）", example: 1760000000000 })
  joinedAt: number;

  static from(row: GuildMemberWithRoleRow): GuildMemberDto {
    const dto = new GuildMemberDto();
    dto.roleId = row.role_id;
    dto.name = row.role_name;
    dto.level = row.role_level;
    dto.occupation = row.role_occupation;
    dto.rank = row.rank;
    dto.rankLabel = GUILD_RANK_LABELS[row.rank] ?? row.rank;
    dto.joinedAt = row.joined_at;
    return dto;
  }
}

/** 入帮申请一行 */
export class GuildApplicationDto {
  @ApiProperty({ description: "申请人角色 id", example: "role_b2" })
  roleId: string;

  @ApiProperty({ description: "申请人角色名", example: "乙二" })
  name: string;

  @ApiProperty({ description: "申请人等级", example: 9 })
  level: number;

  @ApiProperty({ description: "申请留言", example: "带我一个" })
  message: string;

  @ApiProperty({ description: "申请时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  static from(row: GuildApplicationWithRoleRow): GuildApplicationDto {
    const dto = new GuildApplicationDto();
    dto.roleId = row.role_id;
    dto.name = row.role_name;
    dto.level = row.role_level;
    dto.message = row.message;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/**
 * 我的帮会（`GET /guilds/me`）
 *
 * 带三个「能不能」：`canReview` / `canManage` / `canDisband` —— 由服务端按职位算好，
 * 客户端只负责显隐按钮。**职位规则只写在服务端一处**，客户端不要自己再判一遍 rank，
 * 否则改规则时必然漏一处（典型症状：界面给了按钮，点了报 50105）。
 */
export class MyGuildDto {
  @ApiProperty({ description: "帮会 id", example: "g_1760000000000_ab12" })
  id: string;

  @ApiProperty({ description: "帮会名", example: "听雨阁" })
  name: string;

  @ApiProperty({ description: "帮会公告", example: "每周三晚八点集合" })
  notice: string;

  @ApiProperty({ description: "帮会等级（当前恒为 1）", example: 1 })
  level: number;

  @ApiProperty({ description: "帮主角色 id", example: "role_a1" })
  leaderId: string;

  @ApiProperty({ description: "帮主角色名", example: "甲一" })
  leaderName: string;

  @ApiProperty({ description: "当前成员数", example: 12 })
  memberCount: number;

  @ApiProperty({ description: "人数上限（配置驱动，默认 50）", example: 50 })
  memberLimit: number;

  @ApiProperty({ description: "我的角色 id", example: "role_b2" })
  myRoleId: string;

  @ApiProperty({ description: "我的职位：leader / vice / member", example: "member" })
  myRank: string;

  @ApiProperty({ description: "我的职位中文名", example: "成员" })
  myRankLabel: string;

  @ApiProperty({ description: "我能不能审批入帮申请（帮主 / 副帮主）", example: false })
  canReview: boolean;

  @ApiProperty({ description: "我能不能改公告 / 踢人（帮主 / 副帮主）", example: false })
  canManage: boolean;

  @ApiProperty({ description: "我能不能解散（仅帮主）", example: false })
  canDisband: boolean;

  @ApiProperty({ description: "成员列表（帮主 → 副帮主 → 成员，同职位按入帮时间）", type: [GuildMemberDto] })
  members: GuildMemberDto[];

  @ApiProperty({
    description: "待审批申请（**只有干部才拿得到**，普通成员是空数组 —— 非干部不该看到谁在申请）",
    type: [GuildApplicationDto],
  })
  applicants: GuildApplicationDto[];
}

/** 管理端帮会一行（在列表行基础上补帮主 id 与更新时间，便于运营定位） */
export class AdminGuildDto extends GuildSummaryDto {
  @ApiProperty({ description: "帮主角色 id", example: "role_a1" })
  leaderId: string;

  @ApiProperty({ description: "最近更新时间（毫秒）", example: 1760000000000 })
  updatedAt: number;

  static fromAdmin(row: GuildListRow): AdminGuildDto {
    const dto = new AdminGuildDto();
    Object.assign(dto, GuildSummaryDto.from(row));
    dto.leaderId = row.leader_id;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 管理端帮会详情（列表行 + 完整成员名单；申请不含 —— 运营要看的是组织关系，不是待办） */
export class AdminGuildDetailDto extends AdminGuildDto {
  @ApiProperty({ description: "成员名单", type: [GuildMemberDto] })
  members: GuildMemberDto[];

  static fromDetail(row: GuildListRow, members: GuildMemberWithRoleRow[]): AdminGuildDetailDto {
    const dto = new AdminGuildDetailDto();
    Object.assign(dto, AdminGuildDto.fromAdmin(row));
    dto.members = members.map((item) => GuildMemberDto.from(item));
    return dto;
  }
}

/** 创建帮会入参 */
export class CreateGuildDto {
  @ApiProperty({ description: `帮会名（${GUILD_NAME_MIN}~${GUILD_NAME_MAX} 字，全局唯一）`, example: "听雨阁" })
  @IsString({ message: "帮会名必须是字符串" })
  @Length(GUILD_NAME_MIN, GUILD_NAME_MAX, { message: `帮会名需为 ${GUILD_NAME_MIN}~${GUILD_NAME_MAX} 字` })
  name: string;

  @ApiProperty({ description: `公告（可选，0~${GUILD_NOTICE_MAX} 字）`, required: false, example: "新帮会，欢迎加入" })
  @IsOptional()
  @IsString({ message: "公告必须是字符串" })
  @MaxLength(GUILD_NOTICE_MAX, { message: `公告最多 ${GUILD_NOTICE_MAX} 字` })
  notice?: string;
}

/** 申请加入入参 */
export class ApplyGuildDto {
  @ApiProperty({
    description: `留言（可选，0~${GUILD_APPLICATION_MESSAGE_MAX} 字）；重复申请会**覆盖**上一条留言`,
    required: false,
    example: "每天在线，求收留",
  })
  @IsOptional()
  @IsString({ message: "留言必须是字符串" })
  @MaxLength(GUILD_APPLICATION_MESSAGE_MAX, { message: `留言最多 ${GUILD_APPLICATION_MESSAGE_MAX} 字` })
  message?: string;
}

/** 审批入参 */
export class ReviewGuildApplicationDto {
  @ApiProperty({ description: "true 通过 / false 拒绝（拒绝直接删掉申请，不留记录）", example: true })
  @IsBoolean({ message: "approve 必须是布尔值" })
  approve: boolean;
}

/** 改公告入参（空字符串 = 清空公告） */
export class UpdateGuildNoticeDto {
  @ApiProperty({ description: `公告（0~${GUILD_NOTICE_MAX} 字；空字符串表示清空）`, example: "本帮不收 20 级以下" })
  @IsString({ message: "公告必须是字符串" })
  @MaxLength(GUILD_NOTICE_MAX, { message: `公告最多 ${GUILD_NOTICE_MAX} 字` })
  notice: string;
}

/** 转让帮主入参 */
export class TransferGuildDto {
  @ApiProperty({ description: "新帮主的角色 id（必须是本帮成员，且不是自己）", example: "role_b2" })
  @IsString({ message: "roleId 必须是字符串" })
  @Length(1, 64, { message: "roleId 不合法" })
  roleId: string;
}

/** 管理端改帮会入参（名字与公告都可改；名字仍要全局唯一） */
export class AdminUpdateGuildDto {
  @ApiProperty({
    description: `帮会名（${GUILD_NAME_MIN}~${GUILD_NAME_MAX} 字，全局唯一）`,
    required: false,
    example: "听雨阁",
  })
  @IsOptional()
  @IsString({ message: "帮会名必须是字符串" })
  @Length(GUILD_NAME_MIN, GUILD_NAME_MAX, { message: `帮会名需为 ${GUILD_NAME_MIN}~${GUILD_NAME_MAX} 字` })
  name?: string;

  @ApiProperty({ description: `公告（0~${GUILD_NOTICE_MAX} 字）`, required: false, example: "公告已重置" })
  @IsOptional()
  @IsString({ message: "公告必须是字符串" })
  @MaxLength(GUILD_NOTICE_MAX, { message: `公告最多 ${GUILD_NOTICE_MAX} 字` })
  notice?: string;
}

/** 内部：组装 MyGuildDto 的原始件（服务层拿到帮会行 + 成员 + 申请 + 我的职位后一次拼好） */
export interface MyGuildParts {
  guild: GuildRow;
  memberCount: number;
  memberLimit: number;
  myRoleId: string;
  myRank: string;
  members: GuildMemberWithRoleRow[];
  applicants: GuildApplicationWithRoleRow[];
}

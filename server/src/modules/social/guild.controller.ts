import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { GUILD_APPLICATION_MESSAGE_MAX, GUILD_MEMBER_LIMIT_DEFAULT } from "../../common/constants/social";
import {
  ApplyGuildDto,
  CreateGuildDto,
  GuildSummaryDto,
  MyGuildDto,
  ReviewGuildApplicationDto,
  TransferGuildDto,
  UpdateGuildNoticeDto,
} from "./dto/guild.dto";
import { GuildService } from "./guild.service";

/**
 * 客户端 · 帮会（#388）
 *
 * 全部以**令牌里的账号**为准，落到该账号的在线角色上；请求体里出现角色 id 的地方
 * （转让 / 踢人 / 审批）都只是**目标**，服务端会校验那个角色确实在本帮里。
 *
 * 写接口统一返回最新的「我的帮会」（`MyGuildDto`）—— 客户端不必再拉一次 `/guilds/me`，
 * 也不会出现「操作成功了但界面还是旧的」。
 */
@Controller("guilds")
export class GuildController {
  constructor(private readonly guildService: GuildService) {}

  @Get()
  @ApiPlayerDoc({
    operationId: "guild.list",
    summary: "帮会列表",
    description: "全部帮会，按人数降序（同人数按创建时间升序）。列表带人数与帮主名，不含成员名单。",
  })
  @ApiDataResponse(GuildSummaryDto, { isArray: true, description: "帮会列表" })
  list(): GuildSummaryDto[] {
    return this.guildService.list();
  }

  @Get("me")
  @ApiPlayerDoc({
    operationId: "guild.mine",
    summary: "我的帮会",
    description:
      "当前在线角色所在的帮会（成员名单 + 待审批申请 + 我可用的操作）。不在任何帮会时 data 为 null。\n\n" +
      "`canReview` / `canManage` / `canDisband` 由服务端按职位算好 —— 客户端只显隐按钮，**不要自己再判 rank**。",
  })
  @ApiDataResponse(MyGuildDto, { description: "我的帮会，可能为 null", nullable: true })
  mine(@CurrentUser() user: AuthenticatedUser): MyGuildDto | null {
    return this.guildService.mine(user.id);
  }

  @Post()
  @ApiPlayerDoc({
    operationId: "guild.create",
    summary: "创建帮会",
    description:
      `建帮人自动成为帮主，**免费**；帮会名 2~12 字且全局唯一。` +
      `已在帮会里会返回 50103（一个人只能在一个帮会）。`,
  })
  @ApiDataResponse(MyGuildDto, { status: HttpStatus.CREATED, description: "刚创建的帮会（含我的职位 = 帮主）" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateGuildDto): MyGuildDto {
    return this.guildService.create(user.id, dto);
  }

  @Post(":id/applications")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.apply",
    summary: "申请加入帮会",
    description:
      `留言 0~${GUILD_APPLICATION_MESSAGE_MAX} 字。**重复申请只覆盖留言**，不会堆出两条。\n\n` +
      "失败：50103 已在别的帮会 / 50101 帮会不存在 / 50107 人满了。",
  })
  @ApiParam({ name: "id", description: "帮会 id" })
  @ApiVoidResponse("申请已提交（等待帮主或副帮主审批）")
  apply(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: ApplyGuildDto): void {
    this.guildService.apply(user.id, id, dto.message ?? "");
  }

  @Post("me/applications/:roleId/review")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.review",
    summary: "审批入帮申请",
    description: "帮主 / 副帮主可用。拒绝时直接删掉申请（不留记录）。通过时再查一次「对方是否已入别的帮、帮会是否已满」。",
  })
  @ApiParam({ name: "roleId", description: "申请人角色 id" })
  @ApiDataResponse(MyGuildDto, { description: "处理后的我的帮会" })
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param("roleId") roleId: string,
    @Body() dto: ReviewGuildApplicationDto,
  ): MyGuildDto {
    return this.guildService.review(user.id, roleId, dto.approve);
  }

  @Post("me/members/:roleId/kick")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.kick",
    summary: "踢出成员",
    description: "帮主 / 副帮主可用。副帮主不能踢另一位副帮主；帮主不可被踢；不能踢自己。",
  })
  @ApiParam({ name: "roleId", description: "被踢成员的角色 id" })
  @ApiDataResponse(MyGuildDto, { description: "处理后的我的帮会" })
  kick(@CurrentUser() user: AuthenticatedUser, @Param("roleId") roleId: string): MyGuildDto {
    return this.guildService.kick(user.id, roleId);
  }

  @Post("me/transfer")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.transfer",
    summary: "转让帮主",
    description: "仅帮主可用。双方职位互换（我变普通成员，他变帮主），`guilds.leader_id` 同一事务内改。",
  })
  @ApiDataResponse(MyGuildDto, { description: "转让后的我的帮会（我已是普通成员）" })
  transfer(@CurrentUser() user: AuthenticatedUser, @Body() dto: TransferGuildDto): MyGuildDto {
    return this.guildService.transfer(user.id, dto.roleId);
  }

  @Post("me/notice")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.notice",
    summary: "修改帮会公告",
    description: "帮主 / 副帮主可用；空字符串表示清空公告。",
  })
  @ApiDataResponse(MyGuildDto, { description: "修改后的我的帮会" })
  notice(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateGuildNoticeDto): MyGuildDto {
    return this.guildService.updateNotice(user.id, dto.notice);
  }

  @Post("me/leave")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "guild.leave",
    summary: "退出帮会",
    description: "帮主不能直接退出（50106）：先把帮主转让给别人，或者解散帮会。",
  })
  @ApiVoidResponse("已退出帮会")
  leave(@CurrentUser() user: AuthenticatedUser): void {
    this.guildService.leave(user.id);
  }

  @Delete("me")
  @ApiPlayerDoc({
    operationId: "guild.disband",
    summary: "解散帮会",
    description: `仅帮主可用；成员与待审批申请一并清除，**不可恢复**。帮会人数上限见服务端配置（默认 ${GUILD_MEMBER_LIMIT_DEFAULT}）。`,
  })
  @ApiVoidResponse("帮会已解散")
  disband(@CurrentUser() user: AuthenticatedUser): void {
    this.guildService.disband(user.id);
  }
}

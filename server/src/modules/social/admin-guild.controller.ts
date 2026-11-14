import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { Permission } from "../../common/constants/permission";
import { AdminGuildDetailDto, AdminGuildDto, AdminUpdateGuildDto } from "./dto/guild.dto";
import { GuildService } from "./guild.service";

/**
 * 管理端 · 帮会（#388）
 *
 * 运营要看的是**组织关系**：谁在哪个帮、多少人、谁建的。玩家侧的申请待办不在这里 ——
 * 那是帮主的事，管理员只在违规时改公告 / 改名 / 强制解散。
 *
 * **单区上下文（#960）**：帮会带区（`guilds.zone_id`），列表与写操作都只在本区里干活，
 * 别区的帮会 id 一律 404 —— 否则「A 区列表里点了个链接、把 B 区的帮会解散了」是能成功的。
 *
 * 解散是**连删成员表**的重操作（一群人瞬间没有帮会），与删账号同量级：单列 `guild:write`。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/guilds")
export class AdminGuildController {
  constructor(private readonly guildService: GuildService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminGuild.list",
    summary: "帮会列表",
    description: "当前区的全部帮会（含人数与帮主名），按人数降序。",
    permissions: [Permission.GUILD_READ],
  })
  @ApiDataResponse(AdminGuildDto, { description: "帮会列表", isArray: true })
  list(@ZoneContext() zoneId: number): AdminGuildDto[] {
    return this.guildService.adminList(zoneId);
  }

  @Get(":id")
  @ApiAdminDoc({
    operationId: "adminGuild.detail",
    summary: "帮会详情",
    description: "帮会信息 + 完整成员名单（帮主 → 副帮主 → 成员）。别区的帮会 id 返回 404。",
    permissions: [Permission.GUILD_READ],
  })
  @ApiParam({ name: "id", description: "帮会 id" })
  @ApiDataResponse(AdminGuildDetailDto, { description: "帮会详情" })
  detail(@Param("id") id: string, @ZoneContext() zoneId: number): AdminGuildDetailDto {
    return this.guildService.adminDetail(zoneId, id);
  }

  @Patch(":id")
  @AuditTarget("guild")
  @ApiAdminDoc({
    operationId: "adminGuild.update",
    summary: "修改帮会（名字 / 公告）",
    description:
      "两个字段都可选，只传要改的。改名字仍要求**全局唯一**（50102）—— 同名帮会分处两区会让搜索、" +
      "举报、客服沟通全部指不准。别区的帮会 id 返回 404。",
    permissions: [Permission.GUILD_WRITE],
  })
  @ApiParam({ name: "id", description: "帮会 id" })
  @ApiDataResponse(AdminGuildDetailDto, { description: "修改后的帮会详情" })
  update(@Param("id") id: string, @Body() dto: AdminUpdateGuildDto, @ZoneContext() zoneId: number): AdminGuildDetailDto {
    return this.guildService.adminUpdate(zoneId, id, dto);
  }

  @Delete(":id")
  @AuditTarget("guild")
  @ApiAdminDoc({
    operationId: "adminGuild.remove",
    summary: "强制解散帮会",
    description:
      "成员与待审批申请一并清除，**不可恢复**。用于违规帮会名 / 组织性刷资源等运营处置。别区的帮会 id 返回 404。",
    permissions: [Permission.GUILD_WRITE],
  })
  @ApiParam({ name: "id", description: "帮会 id" })
  @ApiVoidResponse("帮会已解散")
  remove(@Param("id") id: string, @ZoneContext() zoneId: number): void {
    this.guildService.adminRemove(zoneId, id);
  }
}

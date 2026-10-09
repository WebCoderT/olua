import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AccountDto } from "../auth/dto/account.dto";
import { AdminService } from "./admin.service";
import { BatchDeleteResultDto } from "./dto/batch-role.dto";
import { ResetAccountPasswordDto, ResetPasswordResultDto } from "./dto/password.dto";
import { AccountQueryDto, UpdateAccountStatusDto } from "./dto/query.dto";
import { AdminAccountDetailDto, AdminStatsDto } from "./dto/stats.dto";
import { AccountPageDto } from "./dto/page-result.dto";

/**
 * 管理端 · 账号管理（检索 / 封禁 / 删除 / 概览）
 *
 * 每个接口都标了所需权限点（`@ApiAdminDoc({ permissions })`），
 * 实际校验在 common/guards/permission.guard：只读观察员调写接口会拿到 403 / 30006。
 */
@ApiAudience("admin")
@Controller("admin")
export class AdminAccountsController {
  constructor(private readonly adminService: AdminService) {}

  @Get("stats")
  @ApiAdminDoc({ operationId: "adminAccount.stats", summary: "概览统计", permissions: [Permission.STATS_READ] })
  @ApiDataResponse(AdminStatsDto, { description: "统计数据" })
  stats(): AdminStatsDto {
    return this.adminService.stats();
  }

  @Get("accounts")
  @ApiAdminDoc({
    operationId: "adminAccount.list",
    summary: "账号列表",
    description: "keyword 模糊匹配账号名；status 可按状态筛选。",
    permissions: [Permission.ACCOUNT_READ],
  })
  @ApiQueryModel(AccountQueryDto)
  @ApiDataResponse(AccountPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: AccountQueryDto): PageResult<AccountDto> {
    return this.adminService.listAccounts(query);
  }

  @Get("accounts/:id")
  @ApiAdminDoc({ operationId: "adminAccount.detail", summary: "账号详情", description: "返回账号信息 + 名下角色概要列表。", permissions: [Permission.ACCOUNT_READ] })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(AdminAccountDetailDto, { description: "账号详情" })
  detail(@Param("id") id: string): AdminAccountDetailDto {
    return this.adminService.accountDetail(id);
  }

  @Patch("accounts/:id/status")
  @AuditTarget("account")
  @ApiAdminDoc({
    operationId: "adminAccount.updateStatus",
    summary: "封禁 / 解封账号",
    description:
      "改完立刻生效：守卫每次请求都回查账号状态，在线的玩家下一次请求就被拒。\n\n" +
      "**封禁**可带 `reason`（原因，玩家登录时会看到）与 `durationHours`（时长，小时）—— " +
      "不填时长即永久封禁。临时封禁**到期自动解封**：判定按时间算，不依赖谁来点解封，\n" +
      "定时器只负责把库里的状态扫回去。\n\n" +
      "**解封**（status=active）会把原因、到期时间、执行人、执行时间一并清空。",
    permissions: [Permission.ACCOUNT_STATUS],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(AccountDto, { description: "变更后的账号（含封禁信息）" })
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateAccountStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): AccountDto {
    return this.adminService.updateAccountStatus(id, dto, user.username);
  }

  @Patch("accounts/:id/password")
  @AuditTarget("account")
  @ApiAdminDoc({
    operationId: "adminAccount.resetPassword",
    summary: "重置玩家账号的密码",
    description:
      "玩家忘记密码时用这条（客户端没有找回流程）。\n\n" +
      "**副作用**：该账号此前签发的全部令牌立即作废（服务端令牌版本号 +1）—— " +
      "账号被盗后改密码才能真正把对方踢下线，否则他手上那个 7 天有效期的令牌照样能用。\n\n" +
      "请求体里的密码不会进操作日志（敏感字段自动打码为 `***`）。",
    permissions: [Permission.ACCOUNT_PASSWORD],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(ResetPasswordResultDto, { description: "重置结果（不回显密码）" })
  resetPassword(@Param("id") id: string, @Body() dto: ResetAccountPasswordDto): ResetPasswordResultDto {
    return this.adminService.resetAccountPassword(id, dto);
  }

  @Post("accounts/:id/offline")
  @AuditTarget("account")
  @ApiAdminDoc({
    operationId: "adminAccount.kick",
    summary: "踢下线（清掉账号当前的在线角色）",
    description:
      "幂等：本来就不在线时直接返回当前状态。\n\n" +
      "只清标记是不够的 —— 玩家那台客户端本地缓存还在跑，因此它**下一次推存档会被拒**" +
      "（业务码 20007 `ROLE_KICKED`），客户端据此提示并回到选角界面。",
    permissions: [Permission.ROLE_SELECT],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(AccountDto, { description: "变更后的账号（onlineRoleId 为 null）" })
  kick(@Param("id") id: string): AccountDto {
    return this.adminService.kickAccountOffline(id);
  }

  @Delete("accounts/:id")
  @AuditTarget("account")
  @ApiAdminDoc({
    operationId: "adminAccount.remove",
    summary: "删除账号",
    description: "名下角色一并删除（外键级联），不可恢复。",
    permissions: [Permission.ACCOUNT_DELETE],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    return this.adminService.removeAccount(id);
  }

  @Delete("accounts/:id/roles")
  @AuditTarget("account")
  @ApiAdminDoc({
    operationId: "adminAccount.purgeRoles",
    summary: "清空账号下的全部角色",
    description:
      "账号保留、名下角色全删（重置玩家存档用），不可恢复；作为在线角色的会顺带清掉在线标记。" +
      "与「删除账号」的区别：账号本身还在，玩家可以重新创建角色。",
    permissions: [Permission.ROLE_DELETE],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(BatchDeleteResultDto, { description: "删除结果（requested / deleted / ids / clearedOnlineAccountIds）" })
  purgeRoles(@Param("id") id: string): BatchDeleteResultDto {
    return this.adminService.purgeAccountRoles(id);
  }
}

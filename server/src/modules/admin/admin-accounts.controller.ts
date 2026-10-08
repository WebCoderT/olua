import { Body, Controller, Delete, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AccountDto } from "../auth/dto/account.dto";
import { AdminService } from "./admin.service";
import { BatchDeleteResultDto } from "./dto/batch-role.dto";
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
  @ApiAdminDoc({
    operationId: "adminAccount.updateStatus",
    summary: "封禁 / 解封账号",
    description: "改完立刻生效：守卫每次请求都回查账号状态。",
    permissions: [Permission.ACCOUNT_STATUS],
  })
  @ApiParam({ name: "id", description: "账号 id" })
  @ApiDataResponse(AccountDto, { description: "变更后的账号" })
  updateStatus(@Param("id") id: string, @Body() dto: UpdateAccountStatusDto): AccountDto {
    return this.adminService.updateAccountStatus(id, dto);
  }

  @Delete("accounts/:id")
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

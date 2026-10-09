import { Body, Controller, Delete, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AdminService } from "./admin.service";
import { AdminDto, AdminUpdateDto } from "./dto/admin.dto";
import { ResetAdminPasswordDto, ResetPasswordResultDto } from "./dto/password.dto";
import { AdminQueryDto } from "./dto/query.dto";
import { AdminPageDto } from "./dto/page-result.dto";

/**
 * 管理端 · 管理员管理（权限管理入口）
 *
 * 只有超级管理员（`admin:manage`）能改别人的角色与启停 —— 普通管理员看都看不到这个分组，
 * 这样「管理员不能互相提权」。最后一个启用中的超管受保护，不能降级 / 停用 / 删除。
 */
@ApiAudience("admin")
@Controller("admin/admins")
export class AdminAdminsController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminAdmin.list",
    summary: "管理员列表",
    description: "keyword 模糊匹配管理员账号名；role 可按角色筛选。",
    permissions: [Permission.ADMIN_READ],
  })
  @ApiQueryModel(AdminQueryDto)
  @ApiDataResponse(AdminPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: AdminQueryDto): PageResult<AdminDto> {
    return this.adminService.listAdmins(query);
  }

  @Patch(":id")
  @AuditTarget("admin")
  @ApiAdminDoc({
    operationId: "adminAdmin.update",
    summary: "修改管理员",
    description:
      "改角色或启停。允许改自己（超管轮值），但**最后一个启用中的超级管理员**不能被降级 / 停用 —— 避免没人能进后台。改完立即生效。",
    permissions: [Permission.ADMIN_MANAGE],
  })
  @ApiParam({ name: "id", description: "管理员 id" })
  @ApiDataResponse(AdminDto, { description: "修改后的管理员" })
  update(@Param("id") id: string, @Body() dto: AdminUpdateDto): AdminDto {
    return this.adminService.updateAdmin(id, dto);
  }

  @Patch(":id/password")
  @AuditTarget("admin")
  @ApiAdminDoc({
    operationId: "adminAdmin.resetPassword",
    summary: "重置某个管理员的密码",
    description:
      "只有超级管理员能做（`admin:manage`）—— 管理员之间不能互相改密码。\n\n" +
      "**副作用**：对方此前签发的令牌立即作废，他会被踢回登录页，需要用新密码重新登录。" +
      "不触发「最后一个超管」保护：改密码不会让人失去登录能力，改的也不是身份与状态。" +
      "管理员想改自己的密码应当走 `PATCH /admin/auth/password`（需要原密码）。",
    permissions: [Permission.ADMIN_MANAGE],
  })
  @ApiParam({ name: "id", description: "管理员 id" })
  @ApiDataResponse(ResetPasswordResultDto, { description: "重置结果（不回显密码）" })
  resetPassword(@Param("id") id: string, @Body() dto: ResetAdminPasswordDto): ResetPasswordResultDto {
    return this.adminService.resetAdminPassword(id, dto);
  }

  @Delete(":id")
  @AuditTarget("admin")
  @ApiAdminDoc({
    operationId: "adminAdmin.remove",
    summary: "删除管理员",
    description: "不可恢复；同样保护最后一个启用中的超级管理员。",
    permissions: [Permission.ADMIN_MANAGE],
  })
  @ApiParam({ name: "id", description: "管理员 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    return this.adminService.removeAdmin(id);
  }
}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AdminRoleDto } from "../roles/dto/role.dto";
import { BatchDeleteResultDto, BatchDeleteRolesDto } from "./dto/batch-role.dto";
import { AdminPatchRoleDto } from "./dto/patch-role.dto";
import { RoleQueryDto } from "./dto/query.dto";
import { AdminRolePageDto } from "./dto/page-result.dto";
import { AdminService } from "./admin.service";

/** 管理端 · 角色管理（跨账号检索 / 查看 / 修改 / 删除） */
@ApiAudience("admin")
@Controller("admin/roles")
export class AdminRolesController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminRole.list",
    summary: "角色列表",
    description:
      "keyword 匹配角色名或角色 id；accountId 限定账号；online / occupation / sex / minLevel / maxLevel 做筛选。",
    permissions: [Permission.ROLE_READ],
  })
  @ApiDataResponse(AdminRolePageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: RoleQueryDto): PageResult<AdminRoleDto> {
    return this.adminService.listRoles(query);
  }

  @Post("batch-delete")
  @HttpCode(HttpStatus.OK)
  @ApiAdminDoc({
    operationId: "adminRole.batchRemove",
    summary: "批量删除角色",
    description:
      "按 id 列表删除（最多 100 条）。已不存在的 id 静默跳过（幂等）；作为某个账号在线角色的会被顺带清掉在线标记。" +
      "返回实际删除的条数与涉及的账号 id。\n\nPOST 而不是 DELETE 是因为要带请求体；用 200 而不是 201 —— 它不创建资源。",
    permissions: [Permission.ROLE_DELETE],
  })
  @ApiDataResponse(BatchDeleteResultDto, { description: "删除结果（requested / deleted / ids / clearedOnlineAccountIds）" })
  batchRemove(@Body() dto: BatchDeleteRolesDto): BatchDeleteResultDto {
    return this.adminService.batchRemoveRoles(dto);
  }

  @Get(":id")
  @ApiAdminDoc({ operationId: "adminRole.detail", summary: "角色详情", description: "含完整 data（背包 / 装备等原样返回）。", permissions: [Permission.ROLE_READ] })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDto, { description: "角色详情" })
  detail(@Param("id") id: string): AdminRoleDto {
    return this.adminService.roleDetail(id);
  }

  @Patch(":id")
  @ApiAdminDoc({
    operationId: "adminRole.patch",
    summary: "修改角色",
    description:
      "只提交要改的字段，其余原样保留。开放三类：**基础信息**（角色名 / 职业 / 性别 / 等级 / 时装 / 头像 / 所在地图）、" +
      "**常用数值**（金币 / 绑定元宝 / 银两 / 经验 / 战魂 / 称号 / 军衔）、" +
      "**运行时数据**（装备穿戴表 / 技能等级表 / 背包格子，结构化编辑，传 `bag: []` 即清空背包）。\n\n" +
      "角色名仍需满足「同一账号下不重名」。保存后修订号 +1，在线玩家的下一次进度推送会先同步到这里。",
    permissions: [Permission.ROLE_WRITE],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDto, { description: "修改后的角色" })
  patch(@Param("id") id: string, @Body() dto: AdminPatchRoleDto): AdminRoleDto {
    return this.adminService.patchRole(id, dto);
  }

  @Post(":id/select")
  @HttpCode(HttpStatus.OK)
  @ApiAdminDoc({
    operationId: "adminRole.select",
    summary: "设为在线角色",
    description: "把角色设为所属账号的在线角色（等价于玩家在选角界面选它进游戏）。",
    permissions: [Permission.ROLE_SELECT],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDto, { description: "被设为在线的角色" })
  select(@Param("id") id: string): AdminRoleDto {
    return this.adminService.selectRole(id);
  }

  @Delete(":id")
  @ApiAdminDoc({
    operationId: "adminRole.remove",
    summary: "删除角色",
    description: "不可恢复；是账号在线角色时一并清掉在线标记。",
    permissions: [Permission.ROLE_DELETE],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    return this.adminService.removeRole(id);
  }
}

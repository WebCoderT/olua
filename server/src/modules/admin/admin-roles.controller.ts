import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { AdminRoleDto } from "../roles/dto/role.dto";
import { AdminPatchRoleDto } from "./dto/patch-role.dto";
import { RoleQueryDto } from "./dto/query.dto";
import { AdminService } from "./admin.service";

/** 管理端 · 角色管理（跨账号检索 / 查看 / 修改 / 删除） */
@ApiAudience("admin")
@Controller("admin/roles")
export class AdminRolesController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiAdminDoc({
    summary: "角色列表",
    description: "keyword 匹配角色名或角色 id；accountId 限定账号。",
    permissions: [Permission.ROLE_READ],
  })
  @ApiDataResponse(AdminRoleDto, { isArray: true, description: "分页结果在 data 里（list/total/page/size）" })
  list(@Query() query: RoleQueryDto): PageResult<AdminRoleDto> {
    return this.adminService.listRoles(query);
  }

  @Get(":id")
  @ApiAdminDoc({ summary: "角色详情", description: "含完整 data（背包 / 装备等原样返回）。", permissions: [Permission.ROLE_READ] })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDto, { description: "角色详情" })
  detail(@Param("id") id: string): AdminRoleDto {
    return this.adminService.roleDetail(id);
  }

  @Patch(":id")
  @ApiAdminDoc({
    summary: "修改角色",
    description: "只开放角色名 / 职业 / 性别 / 等级 / 金币 / 绑定元宝 / 银两 / 经验 / 战魂 / 称号 / 军衔；其余字段原样保留。",
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

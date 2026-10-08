import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { RolesService } from "./roles.service";

/**
 * 客户端 · 角色接口
 *
 * 全部以**令牌里的账号**为准：路由里没有 accountId，也不读请求体里的账号，
 * 因此不存在「改个 id 就能操作别人角色」的口子。
 * 分组由方法级装饰器决定（自动类名分组已在 main.ts 关掉）。
 */
@Controller("roles")
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiPlayerDoc({ summary: "角色列表", description: "按创建时间升序；不含 data（选角列表用）。" })
  @ApiDataResponse(RoleSummaryDto, { isArray: true, description: "角色概要列表" })
  list(@CurrentUser() user: AuthenticatedUser): RoleSummaryDto[] {
    return this.rolesService.list(user.id);
  }

  @Get("online")
  @ApiPlayerDoc({ summary: "当前在线角色", description: "未选角色 / 在线角色已删时返回 null。" })
  @ApiDataResponse(RoleDto, { description: "在线角色完整数据，可能为 null" })
  online(@CurrentUser() user: AuthenticatedUser): RoleDto | null {
    return this.rolesService.online(user.id);
  }

  @Post()
  @ApiPlayerDoc({
    summary: "创建角色",
    description: "data 由客户端按自身配置生成；服务端校验结构、索引字段、数量上限与重名。第一个角色自动设为在线。",
  })
  @ApiDataResponse(RoleDto, { status: HttpStatus.CREATED, description: "创建成功" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoleDto): RoleDto {
    return this.rolesService.create(user.id, dto);
  }

  @Get(":id")
  @ApiPlayerDoc({ summary: "角色详情", description: "只能查自己账号下的角色（否则 403）。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "角色完整数据" })
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): RoleDto {
    return this.rolesService.detail(user.id, id);
  }

  @Put(":id")
  @ApiPlayerDoc({ summary: "保存角色进度", description: "全量覆盖 data；id 以路径为准（请求体里的 id 会被忽略）。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "保存后的角色" })
  save(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SaveRoleDto): RoleDto {
    return this.rolesService.save(user.id, id, dto);
  }

  @Post(":id/select")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({ summary: "选中（进入）角色", description: "把该角色设为账号的在线角色。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "被选中的角色" })
  select(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): RoleDto {
    return this.rolesService.select(user.id, id);
  }

  @Delete(":id")
  @ApiPlayerDoc({ summary: "删除角色", description: "不可恢复；删的正好是在线角色时同时清掉在线标记。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): null {
    return this.rolesService.remove(user.id, id);
  }
}

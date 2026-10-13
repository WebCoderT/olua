import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { ROLE_SORT, sortFieldNames } from "../../database/sort-specs";
import { AdminRoleDetailDto, AdminRoleDto } from "../roles/dto/role.dto";
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
      "keyword 匹配角色名或角色 id；accountId 限定账号；online / occupation / sex / minLevel / maxLevel 做筛选。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(ROLE_SORT)}，\`order\` 取 asc / desc（默认 updatedAt 倒序）；` +
      "白名单外的取值静默退回默认排序（排序列要拼进 SQL，服务端只认登记过的字段）。",
    permissions: [Permission.ROLE_READ],
  })
  @ApiQueryModel(RoleQueryDto)
  @ApiDataResponse(AdminRolePageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: RoleQueryDto): PageResult<AdminRoleDto> {
    return this.adminService.listRoles(query);
  }

  @Post("batch-delete")
  @HttpCode(HttpStatus.OK)
  @AuditTarget("role")
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
  @ApiAdminDoc({
    operationId: "adminRole.detail",
    summary: "角色详情",
    description:
      "含完整 data（背包 / 装备等原样返回），并带一组 **derived**：服务端按存档输入**现算**的战斗属性。\n\n" +
      "derived 不在库里、每次读的时候算，与 `data` 里客户端上报的那份并列给出 —— 服务端算的不一定「对」" +
      "（玩家在升级与重算之间存档时，客户端那份才是旧的），所以只把两份摆出来，不做自动判定。\n\n" +
      "`derived.mismatch` 表示两份对不上，**不等于作弊**：配置漂移、存档留着旧装备 id 同样会命中。",
    permissions: [Permission.ROLE_READ],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDetailDto, { description: "角色详情（含服务端重算的 derived）" })
  detail(@Param("id") id: string): AdminRoleDetailDto {
    return this.adminService.roleDetail(id);
  }

  @Patch(":id")
  @AuditTarget("role")
  @ApiAdminDoc({
    operationId: "adminRole.patch",
    summary: "修改角色",
    description:
      "只提交要改的字段，其余原样保留。开放三类：**基础信息**（角色名 / 职业 / 性别 / 等级 / 时装 / 头像 / 所在地图）、" +
      "**常用数值**（金币 / 绑定元宝 / 银两 / 经验 / 战魂 / 称号 / 军衔）、" +
      "**运行时数据**（装备穿戴表 / 技能等级表 / 背包格子，结构化编辑，传 `bag: []` 即清空背包）。\n\n" +
      "角色名仍需满足「同一账号下不重名」。保存后修订号 +1，在线玩家的下一次进度推送会先同步到这里。\n\n" +
      "返回的 `derived` 是**改完之后**服务端现算的战斗属性：改等级 / 战魂 / 称号 / 军衔 / 装备后，" +
      "战斗力**立刻**反映新值，不用等客户端同步。",
    permissions: [Permission.ROLE_WRITE],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDetailDto, { description: "修改后的角色（derived 已按新值重算）" })
  patch(@Param("id") id: string, @Body() dto: AdminPatchRoleDto): AdminRoleDetailDto {
    return this.adminService.patchRole(id, dto);
  }

  @Post(":id/select")
  @HttpCode(HttpStatus.OK)
  @AuditTarget("role")
  @ApiAdminDoc({
    operationId: "adminRole.select",
    summary: "设为在线角色",
    description: "把角色设为所属账号的在线角色（等价于玩家在选角界面选它进游戏）。",
    permissions: [Permission.ROLE_SELECT],
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(AdminRoleDetailDto, { description: "被设为在线的角色" })
  select(@Param("id") id: string): AdminRoleDetailDto {
    return this.adminService.selectRole(id);
  }

  @Delete(":id")
  @AuditTarget("role")
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

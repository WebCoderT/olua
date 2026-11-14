import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { ZoneService } from "../zone/zone.service";
import {
  AdminZoneDto,
  CreateZoneDto,
  MergePrecheckDto,
  MergeReportDto,
  MergeZoneDto,
  SetZoneStatusDto,
  UpdateZoneDto,
} from "../zone/dto/zone.dto";

/**
 * 管理端 · 区服运营（列表 / 开区 / 改设置 / 开关维护 / 合区向导）
 *
 * 这个控制器**刻意不挂 `ZoneContextGuard`**：它管的就是「有哪些区」，要求它先说明
 * 「你在哪个区里」是循环依赖。`tools/audit-admin-zone.cjs` 的白名单里登记了这条理由。
 *
 * 合并区是**搬玩家数据**的运营操作（角色 / 帮会 / 世界实例 / 账号全搬），所以拆成两步：
 * `merge/precheck` 先给一份「能不能合、合了会动多少东西」的预检，运营看过再点确认；
 * 真正执行的那条在事务里做，事务外只留日志与报告。
 */
@ApiAudience("admin")
@Controller("admin/zones")
export class AdminZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminZone.list",
    summary: "区服列表（含聚合列）",
    description:
      "全部区服（含已合并的），附账号数 / 角色数 / 在线数 / 世界实例数 / 帮会数 / 待执行重载数。\n\n" +
      "**账号数**是「在本区有角色的去重账号」（#957 起账号本身不属于区），不是 `active_zone_id` 的分布。",
    permissions: [Permission.ZONE_READ],
  })
  @ApiDataResponse(AdminZoneDto, { description: "区服列表", isArray: true })
  list(): AdminZoneDto[] {
    return this.zoneService.listAll();
  }

  @Post()
  @AuditTarget("zone")
  @ApiAdminDoc({
    operationId: "adminZone.create",
    summary: "开新区",
    description:
      "区名唯一（1~20 字）。可同时定开服时间 / 排序 / 推荐 / 备注。新开的区立即可供注册选择，" +
      "世界在第一个玩家进图时播种。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(AdminZoneDto, { status: HttpStatus.CREATED, description: "新开的区" })
  create(@Body() dto: CreateZoneDto): AdminZoneDto {
    return this.zoneService.create(dto);
  }

  @Patch(":id")
  @AuditTarget("zone")
  @ApiAdminDoc({
    operationId: "adminZone.update",
    summary: "改区服运营字段",
    description: "排序 / 推荐 / 备注 / 开服时间。**改名不提供**：改名会让已发出去的公告与客服话术全部对不上。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(AdminZoneDto, { description: "改完的区" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateZoneDto): AdminZoneDto {
    return this.zoneService.update(id, dto);
  }

  @Post(":id/status")
  @HttpCode(HttpStatus.OK)
  @AuditTarget("zone")
  @ApiAdminDoc({
    operationId: "adminZone.setStatus",
    summary: "改区服状态（维护 / 关闭 / 恢复）",
    description:
      "状态机：`open` ⇄ `maintenance` → `closed`。\n\n" +
      "- 转 `maintenance`：该区立刻停止注册与选服，在线玩家收到 `zoneMaintenance` 倒计时后断开；" +
      "世界**不冻结**（照常 tick 与落盘），恢复后玩家原样回来；\n" +
      "- 转 `closed`：**不可逆**（数据还在，客服可查历史，但玩家侧永久进不去）。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(AdminZoneDto, { description: "改完的区" })
  setStatus(@Param("id", ParseIntPipe) id: number, @Body() dto: SetZoneStatusDto): AdminZoneDto {
    return this.zoneService.setStatus(id, dto.status, dto.reason);
  }

  @Get("merge/precheck")
  @ApiAdminDoc({
    operationId: "adminZone.mergePrecheck",
    summary: "合区预检",
    description:
      "事务外能查的全查一遍：两区都必须 `open` 且不同，源区在线人数（会被断开）、待执行重载数（会作废）、" +
      "帮会数（会搬走）。`ok = false` 时 `blockers` 里是全部原因 —— 前端据此禁用「确认合并」。\n\n" +
      "`guildConflicts` **恒为空**：帮会名是全服唯一的（#958），合并撞不上名。",
    permissions: [Permission.ZONE_READ],
  })
  @ApiDataResponse(MergePrecheckDto, { description: "预检结果" })
  mergePrecheck(@Query("fromZoneId", ParseIntPipe) fromZoneId: number, @Query("toZoneId", ParseIntPipe) toZoneId: number): MergePrecheckDto {
    return this.zoneService.precheckMerge(fromZoneId, toZoneId);
  }

  @Post("merge")
  @HttpCode(HttpStatus.OK)
  @AuditTarget("zone")
  @ApiAdminDoc({
    operationId: "adminZone.merge",
    summary: "合并区（from 并入 to）",
    description:
      "把 from 区整体并入 to 区，一个事务内完成：角色与帮会改挂 to 区（同账号同名角色自动改名，清单进报告）、" +
      "账号改挂 to 区、世界怪物实例重排发牌（instanceId 换成 to 区区段）、源区待执行重载请求作废、" +
      "源区监控投影与角色位置清理、源区标记已合并。\n\n" +
      "**生效方式**：只 bump 参与合并这两个区的世界代际（#961），其他区的内存世界不受影响 ——" +
      "在线玩家的连接会收到 `zoneMerged` 并被断开，回登录页重新选服。\n\n" +
      "边界：预检不通过直接 409 `ZONE_MERGE_BLOCKED`（不进事务）。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(MergeReportDto, { description: "合并报告" })
  merge(@Body() dto: MergeZoneDto, @CurrentUser() user: AuthenticatedUser): MergeReportDto {
    return this.zoneService.merge(dto.fromZoneId, dto.toZoneId);
  }
}

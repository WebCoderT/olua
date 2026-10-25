import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { ZoneService } from "../zone/zone.service";
import { AdminZoneDto, CreateZoneDto, MergeZoneDto } from "../zone/dto/zone.dto";

/**
 * 管理端 · 区服管理（列表 / 开区 / 合并区）
 *
 * 合并区是**搬玩家数据**的运营操作（账号换区、世界实例改牌），执行前先看列表里的
 * 账号数确认规模；界面弹确认框的文案用得上。
 * 区服管理页（可视化）拆到后续 issue，这里先把接口立起来。
 */
@ApiAudience("admin")
@Controller("admin/zones")
export class AdminZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminZone.list",
    summary: "区服列表",
    description: "全部区服（含已合并的，附 `mergedInto` 去向与当前账号数），按开区顺序排列。",
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
    description: "区名唯一（1~20 字）。新开的区立即可供注册选择，世界在第一个玩家进图时播种。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(AdminZoneDto, { status: HttpStatus.CREATED, description: "新开的区" })
  create(@Body() dto: CreateZoneDto): AdminZoneDto {
    return this.zoneService.create(dto.name);
  }

  @Post("merge")
  @HttpCode(HttpStatus.OK)
  @AuditTarget("zone")
  @ApiAdminDoc({
    operationId: "adminZone.merge",
    summary: "合并区（from 并入 to）",
    description:
      "把 from 区整体并入 to 区，一个事务内完成：from 区账号全部改挂 to 区、from 区的世界怪物实例" +
      "改挂 to 区并重排发牌（instanceId 换成 to 区区段）、from 区打上已合并标记。\n\n" +
      "**生效方式**：两个进程的世界内存靠代际信号作废 —— 玩家下一次进图就落在 to 区的世界，" +
      "在线玩家不需要强制下线；合并瞬间各图未落盘的几秒内伤害变化会丢弃（可接受，见 #295）。\n\n" +
      "边界：from 与 to 必须都是活区（未合并）、不能是同一个区。用户名全局唯一，" +
      "所以合并永不撞名（#295 的刻意取舍）。",
    permissions: [Permission.ZONE_WRITE],
  })
  @ApiDataResponse(AdminZoneDto, { description: "合并后的 from 区（含 mergedInto 标记）" })
  merge(@Body() dto: MergeZoneDto, @CurrentUser() user: AuthenticatedUser): AdminZoneDto {
    return this.zoneService.merge(dto.fromZoneId, dto.toZoneId);
  }
}

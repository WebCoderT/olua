import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { CloseInstanceDto, CreateInstanceDto, MapInstanceDto, MapInstanceListDto } from "./dto/map.dto";
import { MapService } from "./map.service";

/**
 * 管理端 · 副本（#1001 第二刀 / docs/20 §2.8）
 *
 * ## 为什么单独一个控制器，而不是塞进 `AdminMapController`
 *
 * 那个控制器是**全局模块**（地图配置全区共用：一张图的刷怪区、碰撞盒在哪个区都一样），
 * 而副本是**分区的**：同一个 `slot`（`i7`）在区 1 与区 2 是两场不同的副本。两者的区口径
 * 正好相反，混在一个类里迟早有人漏掉 `X-Zone-Id`，于是「在区 1 点的收场，关掉了区 2 的
 * 那一场」—— 静默、且看起来完全正常。
 *
 * 所以这里类上挂 `ZoneContextGuard`、每个路由都取 `@ZoneContext()`：任何一次调用都必须
 * 明确「在哪个区开 / 列 / 收」。（`tools/audit-admin-zone.cjs` 会盯着这两条。）
 *
 * ## 管理端能做的只有三件
 *
 * - **开一场**：`POST /admin/maps/:id/instances` —— 写一行登记，世界由第一个进场的人惰性加载；
 * - **看有哪些场**：`GET .../instances` —— 还开着的 + 最近收场的 10 场（原因比行本身有用）；
 * - **让它收场**：`POST .../instances/:slot/close` —— 通关（`cleared`）/ 强制散场（`forced`）。
 *
 * 收场只写行，真正的「把人送回原图 + 销毁房间」由实时进程下一拍扫地做（它才持有连接）。
 * 所以按钮点完到玩家真的被送走，最多差一个扫地间隔（1 秒）。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/maps/:id/instances")
export class AdminMapInstanceController {
  constructor(private readonly mapService: MapService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminMapInstance.list",
    summary: "这张图在当前区的副本",
    description:
      "还开着的副本（按开场先后）+ 最近收场的 10 场。\n\n" +
      "- `instanceId` 就是客户端 `instanceEnter` 要带的那个（= 房间键 `<区>:<图>:i<序号>`）；\n" +
      "- `remainMs` 是距离收场的剩余毫秒（已收场为 0），`startedAt` 为空表示**还没人进过**；\n" +
      "- `players` 是**投影**（实时进程每秒写的监控快照里的人数），界面上当「约 N 人」用，\n" +
      "  别拿它当容量判据 —— 容量在进副本那一刻由实时进程算；\n" +
      "- `closeReason`：`emptied`（人走光了）/ `expired`（超时）/ `cleared`（通关）/ \n" +
      "  `forced`（运营强制）/ `world_lost`（进程重启，这一场的世界没了）。\n\n" +
      "**区是必填的**（`X-Zone-Id`）：同一个 slot 在不同区是两场不同的副本。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiParam({ name: "id", description: "地图 id（副本的底图）" })
  @ApiDataResponse(MapInstanceListDto, { description: "还开着的 + 最近收场的副本" })
  list(@Param("id") id: string, @ZoneContext() zoneId: number): MapInstanceListDto {
    return this.mapService.instancesOf(id, zoneId);
  }

  @Post()
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMapInstance.create",
    summary: "在这张图上开一场副本",
    description:
      "写一行登记（`map_instances`），**世界由第一个进场的人惰性加载**：那一刻按刷怪区现播种，\n" +
      "之后这场副本的怪与其它场、与公共线完全隔离（各自一个 `slot`）。\n\n" +
      "出厂值：**30 分钟 / 6 人 / 谁都能进 / 散场回这张图的公共线**。填了就按填的来：\n" +
      "- `ttlMs`：时限（到点自动收场，收场前 30 秒广播 `instanceClosing`；短副本按一半提前提醒）；\n" +
      "- `maxPlayers`：人数上限（0 = 不限）；\n" +
      "- `ownerRoleIds`：白名单（填了就只认名单里的角色）；\n" +
      "- `originMapId`：散场之后把人送回哪张图。\n\n" +
      "**副本不需要「提前预热」**：开出来没人进也不用管，到点自己收（`expired`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（副本的底图）" })
  @ApiDataResponse(MapInstanceDto, { description: "这一场（含 instanceId / 到期时刻）" })
  create(
    @Param("id") id: string,
    @ZoneContext() zoneId: number,
    @Body() dto: CreateInstanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapInstanceDto {
    return this.mapService.createInstance(id, zoneId, dto, actor);
  }

  @Post(":slot/close")
  @AuditTarget("map")
  @ApiAdminDoc({
    operationId: "adminMapInstance.close",
    summary: "让一场副本收场（通关 / 强制散场）",
    description:
      "**只写登记行**：真正的「把人送回原图 + 销毁这场的世界」由实时进程下一拍扫地做\n" +
      "（它才持有连接），所以玩家最多 1 秒后收到一帧 `world`（已在原图）并被送走。\n\n" +
      "`reason` 留空 = `forced`（运营把人赶出来）；任务系统标记通关时传 `cleared`。\n\n" +
      "**幂等**：已经收过的场再点一次不报错，原样返回它当前的收场状态 —— 运营连点两下、\n" +
      "或者两个人同时点，都不该看到红色报错。真正找错地方（这个 slot 在这张图这个区没有行）\n" +
      "才回 404（`50046`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "地图 id（副本的底图）" })
  @ApiParam({ name: "slot", description: "副本槽位（`i<序号>`，列表里返回的就是它）" })
  @ApiDataResponse(MapInstanceDto, { description: "收场之后的这一场" })
  close(
    @Param("id") id: string,
    @Param("slot") slot: string,
    @ZoneContext() zoneId: number,
    @Body() dto: CloseInstanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): MapInstanceDto {
    return this.mapService.closeInstance(id, zoneId, slot, dto, actor);
  }
}

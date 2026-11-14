import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { Public } from "../../common/decorators/public.decorator";
import { ZoneService } from "./zone.service";
import { MyZoneDto, SelectZoneDto, SelectZoneResultDto, ZoneDto } from "./dto/zone.dto";

/**
 * 区服接口（玩家侧）
 *
 * 注册前拉一次活区列表给下拉框用（公共接口，无需令牌）；
 * 合并掉的区不会出现在这里 —— 玩家永远选不到一个进不去的区。
 */
@Controller("zones")
export class ZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Public()
  @Get()
  @ApiPublicDoc({
    operationId: "zone.list",
    summary: "区服列表（活区）",
    description: "返回全部未合并的区服，按开区顺序排列。注册**不再选**区（#957），选服用 POST /zones/select。",
  })
  @ApiDataResponse(ZoneDto, { description: "活区列表", isArray: true })
  list(): ZoneDto[] {
    return this.zoneService.listLive();
  }

  /**
   * 我的区服（#957）：选服弹窗的数据源
   *
   * 玩家侧**唯一**一次返回多个区的接口：只带「我在这个区有几个角色」，不含别的区的游戏数据。
   */
  @Get("mine")
  @ApiPlayerDoc({
    operationId: "zone.mine",
    summary: "我的区服（含各区角色数与当前区）",
    description: "登录后拉一次渲染选服弹窗。只有一个区有角色时客户端不弹窗，直接进选角页。",
  })
  @ApiDataResponse(MyZoneDto, { description: "区列表（含角色数与当前标记）", isArray: true })
  mine(@CurrentUser() user: AuthenticatedUser): MyZoneDto[] {
    return this.zoneService.mine(user.id) as MyZoneDto[];
  }

  /**
   * 选服（#957）：切「当前浏览区」
   *
   * 只改 `accounts.active_zone_id`，**不改任何角色归属**。选完之后 `GET /roles` 拉到的
   * 就是这个区的角色 —— 客户端不需要（也不允许）在别的接口上再传 zoneId。
   */
  @Post("select")
  @ApiPlayerDoc({
    operationId: "zone.select",
    summary: "切换当前浏览区",
    description: "把所选区写进账号的「当前浏览区」；之后 GET /roles 与建角都落在这个区。区归属不变。",
  })
  @ApiDataResponse(SelectZoneResultDto, { description: "切换后的当前浏览区" })
  select(@CurrentUser() user: AuthenticatedUser, @Body() dto: SelectZoneDto): SelectZoneResultDto {
    return this.zoneService.select(user.id, dto.zoneId);
  }
}

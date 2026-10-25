import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ZoneService } from "./zone.service";
import { ZoneDto } from "./dto/zone.dto";

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
  @ApiPublicDoc({ operationId: "zone.list", summary: "区服列表（活区）", description: "返回全部未合并的区服，按开区顺序排列。注册入参 `zoneId` 从这里选。" })
  @ApiDataResponse(ZoneDto, { description: "活区列表", isArray: true })
  list(): ZoneDto[] {
    return this.zoneService.listLive();
  }
}

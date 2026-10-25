import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { ClientConfigService } from "./client-config.service";
import { GameConfigSnapshotDto } from "./dto/client-config.dto";

/**
 * 客户端 · 配置快照
 *
 * 管理端改的运营配置要真实生效：客户端进游戏拉一次这份快照存内存，
 * 本地 configs 的数据读取函数优先用它、缺省回落本地静态数据。
 * 掉落 / 经验 / 升级 / 购买等**行为的权威在服务端接口**，快照只解决「读同源」。
 */
@Controller("game-config")
export class ClientConfigController {
  constructor(private readonly clientConfig: ClientConfigService) {}

  @Get()
  @ApiPlayerDoc({
    operationId: "gameConfig.snapshot",
    summary: "玩家侧配置快照",
    description:
      "管理端可改的全部运营配置一次下发（称号 / 战魂 / 军衔 / 装备 / 药品 / 物品 / 怪物 / NPC / 时装 / " +
      "升级经验 / 成长曲线与标量 / 商城定价 / 掉落表）。\n\n" +
      "形状与管理端列表接口一致（camelCase）。需要玩家令牌（配置属于玩法数据，不开放给未登录请求）。",
  })
  @ApiDataResponse(GameConfigSnapshotDto, { description: "全部运营配置快照" })
  snapshot(): GameConfigSnapshotDto {
    return this.clientConfig.snapshot();
  }
}

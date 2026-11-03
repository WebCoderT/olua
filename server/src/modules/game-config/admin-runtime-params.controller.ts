import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { RuntimeParamsService } from "./runtime-params.service";
import { RuntimeParamsDto, UpdateRuntimeParamsDto } from "./dto/runtime-params.dto";

/**
 * 管理端 · 客户端运行时参数（#605）
 *
 * 单行配置（id 恒为 1），三个分组：掉落手感 / 自动战斗与寻路 / 帮会规则。
 * **只有 get / update，没有创建与删除** —— 行的形状由 `config-sync.sql` 定义，
 * seed 固定，后台只改数值（与称号 / 商城主页同一取向）。
 *
 * 与其它配置页的区别：`drop` / `autoBattle` 服务端**不消费**，纯属「替客户端存一份可运营的参数」
 * （下发后客户端覆写本地手感）；`guild` 是服务端**校验门槛**，改完下一次建帮立即生效。
 *
 * 写操作带 `@AuditTarget("runtimeParams")`：这类参数一次改动影响全服手感 / 准入，
 * 必须能追溯是谁在什么时候调的。
 */
@ApiAudience("admin")
@Controller("admin/runtime-params")
export class AdminRuntimeParamsController {
  constructor(private readonly runtimeParamsService: RuntimeParamsService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.get",
    summary: "运行时参数",
    description:
      "三个分组一起返回（**单行配置，没有分页**）：\n\n" +
      "- `drop`：掉落物手感（拾取半径 / 散落间距 / 应答超时 / 满包提示间隔）—— 服务端只下发不消费；\n" +
      "- `autoBattle`：自动战斗与寻路（目标距离 / 网格 / 重寻路节奏 / 卡住判定 / 吸附半径）—— 同上；\n" +
      "- `guild`：帮会规则门槛（名字长度 / 公告长度 / 申请留言长度）—— **服务端校验读它**。\n\n" +
      "缺键回落出厂值（`config-sync.sql`），所以新增参数不需要迁移。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(RuntimeParamsDto, { description: "当前生效值（含 updatedAt）" })
  get(): RuntimeParamsDto {
    return this.runtimeParamsService.get();
  }

  @Patch()
  @AuditTarget("runtimeParams")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.update",
    summary: "编辑运行时参数",
    description:
      "**部分更新**：只提交改动过的分组，组内只提交改动过的字段（没提交的保持原值）。\n\n" +
      "单字段取值域由 DTO 校验；跨字段约束「帮会名最短 ≤ 最长」由服务端判（违反 → 40000）。\n\n" +
      "改完立即生效：`guild` 影响下一次建帮 / 改公告的校验，其余两项在玩家下次进游戏拉快照后生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(RuntimeParamsDto, { description: "更新后的生效值" })
  update(@Body() dto: UpdateRuntimeParamsDto): RuntimeParamsDto {
    return this.runtimeParamsService.update(dto);
  }
}

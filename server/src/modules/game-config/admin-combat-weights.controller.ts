import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { CombatWeightsService } from "./combat-weights.service";
import { CombatWeightsResponseDto, UpdateCombatWeightsDto } from "./dto/combat-weights.dto";

/**
 * 管理端 · 战斗力权重（#605）
 *
 * 七项倍率（生命 / 三系攻击 / 三系防御）决定「一点属性算多少战力」，而战力是地图准入
 * 门槛（`maps.combat`）的刻度 —— 一次改动等于全服准入门槛重新标定，所以写操作带
 * `@AuditTarget("combatWeights")`，必须能追溯。
 *
 * **只有 get / update**：有哪几项由算法决定（`config-sync.sql`），后台只改值，
 * 不增删行（与称号 / 商城主页同一取向）。
 */
@ApiAudience("admin")
@Controller("admin/combat-weights")
export class AdminCombatWeightsController {
  constructor(private readonly combatWeightsService: CombatWeightsService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminCombatWeights.get",
    summary: "战斗力权重",
    description:
      "当前生效的七项倍率 + 最后修改时间（**单行配置，没有分页**）。\n\n" +
      "口径（客户端与服务端一致）：区间属性（三系攻击 / 三系防御）按**上下限之和**乘倍率，" +
      "生命按单值乘倍率，最后求和。`hpRecover`（每秒回血）**不计入** —— 回血不改变输出与承伤上限，\n" +
      "算进来会凭空抬高所有地图的门槛。\n\n" +
      "缺行回落出厂值（`config-sync.sql`），所以这张表不需要迁移。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(CombatWeightsResponseDto, { description: "当前生效权重（含 updatedAt）" })
  get(): CombatWeightsResponseDto {
    return this.combatWeightsService.get();
  }

  @Patch()
  @AuditTarget("combatWeights")
  @ApiAdminDoc({
    operationId: "adminCombatWeights.update",
    summary: "编辑战斗力权重",
    description:
      "**部分更新**：只提交改动过的属性（没提交的保持原值）。允许两位小数，取值 0~1000。\n\n" +
      "七项不能同时为 0（否则所有角色战力恒为 0、地图准入全部失效）→ 40000。\n\n" +
      "改完立即生效：服务端下一次算属性就用新倍率；客户端在玩家下次进游戏拉配置快照后生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(CombatWeightsResponseDto, { description: "更新后的生效值" })
  update(@Body() dto: UpdateCombatWeightsDto): CombatWeightsResponseDto {
    return this.combatWeightsService.update(dto);
  }
}

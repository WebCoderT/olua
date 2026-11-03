import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import { sortFieldNames, GROWTH_SCALAR_SORT, ROLE_LEVEL_SORT } from "../../database/sort-specs";
import { GrowthConfigService } from "./growth-config.service";
import {
  GrowthScalarDto,
  GrowthScalarPageDto,
  GrowthScalarQueryDto,
  RoleLevelDto,
  RoleLevelPageDto,
  RoleLevelQueryDto,
  UpdateGrowthScalarDto,
  UpdateRoleLevelDto,
} from "./dto/growth.dto";

/**
 * 管理端 · 角色等级表（#655）
 *
 * 60 行 = 每级的最终裸属性 + 升级经验。曲线（`growth_segments`）已不再是运行时输入，
 * 这张表就是权威：改哪一级就只影响哪一级，没有「改一段曲线带动 10 级」的连带效果。
 * `admin/level-exps` 已随曲线下线 —— 经验就是这张表的 `exp` 列，没有第二个接口。
 */
@ApiAudience("admin")
@Controller("admin/role-levels")
export class AdminRoleLevelController {
  constructor(private readonly growthConfigService: GrowthConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminRoleLevel.list",
    summary: "角色等级表",
    description:
      "等级序列固定（1..roleMaxLevel），**没有创建 / 删除**：一行 = 该级的裸属性（血 / 蓝 / 回血 / 六项攻防区间）+ 升级经验。\n\n" +
      "这是战斗结算与客户端等级表的**唯一来源** —— 曲线已从运行时移除，想调哪一级就改哪一行。\n\n" +
      "`keyword` 按等级号模糊匹配。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(ROLE_LEVEL_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(RoleLevelQueryDto)
  @ApiDataResponse(RoleLevelPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: RoleLevelQueryDto): PageResult<RoleLevelDto> {
    return this.growthConfigService.listRoleLevels(query);
  }

  @Patch(":level")
  @AuditTarget("roleLevel")
  @ApiAdminDoc({
    operationId: "adminRoleLevel.update",
    summary: "编辑角色等级",
    description:
      "**部分更新**：只改传了的字段（等级本身不可改）。\n\n" +
      "- 六个区间都是 `xxxMin` / `xxxMax` 两个字段，校验「下限 ≤ 上限」（合并后判断）。\n" +
      "- 改完立刻重装结算层，**服务端下一次结算就用新值**（不用重启）。\n" +
      "- 客户端下次拉配置快照时生效 —— 已经进游戏的玩家要重进。\n" +
      "- 等级不存在 → 404（`50012`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "level", description: "等级（1 起）" })
  @ApiDataResponse(RoleLevelDto, { description: "更新后的等级行" })
  update(@Param("level", ParseIntPipe) level: number, @Body() dto: UpdateRoleLevelDto): RoleLevelDto {
    return this.growthConfigService.updateRoleLevel(level, dto);
  }
}

@ApiAudience("admin")
@Controller("admin/growth-scalars")
export class AdminGrowthScalarController {
  constructor(private readonly growthConfigService: GrowthConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminGrowthScalar.list",
    summary: "成长标量参数列表",
    description:
      "可调的数值参数（键 × 说明，**没有创建 / 删除**）：等级上限 / 属性区间倍率 / 经验节奏。\n\n" +
      "`keyword` 模糊匹配参数键与说明。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(GROWTH_SCALAR_SORT)}，\`order\` 取 asc / desc（默认 key 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(GrowthScalarQueryDto)
  @ApiDataResponse(GrowthScalarPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: GrowthScalarQueryDto): PageResult<GrowthScalarDto> {
    return this.growthConfigService.listScalars(query);
  }

  @Patch(":key")
  @AuditTarget("growthScalar")
  @ApiAdminDoc({
    operationId: "adminGrowthScalar.update",
    summary: "编辑标量参数",
    description:
      "只改 `value`；每个键的取值域服务端单独校验：" +
      Object.entries(GROWTH_SCALAR_SPECS)
        .map(([key, spec]) => `${key} ∈ [${spec.min}, ${spec.max}]${spec.integer ? "（整数）" : ""}`)
        .join("，") +
      "。\n\n" +
      "- `roleMaxLevel` 还有跨表校验：**四条曲线的末段必须都覆盖到新值**，否则拒收 —— 先改曲线末段，再来抬上限。\n" +
      "- **改参数会影响军衔等效强度**（#250 的映射基准）。\n" +
      "- 参数键不存在 → 404（`50014`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "key", description: "参数键（见列表接口的行）" })
  @ApiDataResponse(GrowthScalarDto, { description: "更新后的标量参数" })
  update(@Param("key") key: string, @Body() dto: UpdateGrowthScalarDto): GrowthScalarDto {
    return this.growthConfigService.updateScalar(key, dto);
  }
}

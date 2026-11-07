import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam, ApiQuery } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import { ROLE_LEVEL_CURVES, ROLE_LEVEL_CURVE_LABELS } from "../../common/constants/role-level-curve";
import { sortFieldNames, GROWTH_SCALAR_SORT } from "../../database/sort-specs";
import { GrowthConfigService } from "./growth-config.service";
import {
  GrowthScalarDto,
  GrowthScalarPageDto,
  GrowthScalarQueryDto,
  LevelAttributesDto,
  LevelCurveDto,
  LevelCurveListDto,
  UpdateGrowthScalarDto,
  UpdateLevelCurveDto,
} from "./dto/growth.dto";

/**
 * 管理端 · 等级曲线（#786）
 *
 * 等级**没有逐级表**了：原先的 `role_levels`（一行一级，60 行）在 100 万级不可行
 * （60MB 库 + 1.5GB 快照 + 客户端几百 MB 内存），已随 #786 删除。
 *
 * 现在 1..100 万级由 **4 条曲线 × 6 段** 定义：
 * `exp`（升级经验）/ `hp`（生命上限）/ `attack_max`（物攻上限）/ `defense_max`（物防上限）。
 * 其余 12 列全是派生的（蓝 = 血/2、回血 = 血/100、下限 = 上限×0.7、三系攻防同值）。
 *
 * 想知道「第 N 级到底多少血」→ `preview` 计算器现算（等级表没了，这是唯一入口）。
 */
@ApiAudience("admin")
@Controller("admin/level-curves")
export class AdminLevelCurveController {
  constructor(private readonly growthConfigService: GrowthConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminLevelCurve.list",
    summary: "等级曲线段",
    description:
      "全部曲线段（4 条 × 6 段 = 24 行，**不分页**）。\n\n" +
      `曲线：${ROLE_LEVEL_CURVES.map((key) => `\`${key}\`（${ROLE_LEVEL_CURVE_LABELS[key]}）`).join(" / ")}。\n\n` +
      "段内公式：`value = startValue + perLevel * k + accel * k * (k - 1) / 2`（`k = level - fromLevel`）。" +
      "`accel` 只有 `exp` 用（经验越涨越快），其余曲线为 0。\n\n" +
      "最后一段的 `toLevel` 就是等级上限；超出上限的等级按该段公式继续外推。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(LevelCurveListDto, { description: "全部曲线段（list）" })
  list(): LevelCurveListDto {
    return this.growthConfigService.listLevelCurves();
  }

  @Get("preview")
  @ApiAdminDoc({
    operationId: "adminLevelCurve.preview",
    summary: "等级属性计算器",
    description:
      "输入等级，算出该级的**基础属性**（不含装备 / 称号 / 战魂 / 军衔加成）：\n" +
      "生命 / 魔法 / 回血 / 六项攻防区间 / 升到下一级所需经验。\n\n" +
      "等级可以超过当前上限（按末段外推）—— 用来预演「开到 200 万级会是什么数值」。\n\n" +
      "曲线没覆盖到该级 → 404（`50013`，四条曲线里至少有一条的段配置断了）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQuery({ name: "level", required: true, type: Number, description: "要计算的等级（1 起；可超过上限，按末段外推）", example: 1000 })
  @ApiDataResponse(LevelAttributesDto, { description: "该等级的基础属性" })
  preview(@Query("level", ParseIntPipe) level: number): LevelAttributesDto {
    return this.growthConfigService.previewLevel(level);
  }

  @Patch(":curve/:seq")
  @AuditTarget("levelCurve")
  @ApiAdminDoc({
    operationId: "adminLevelCurve.update",
    summary: "编辑曲线段",
    description:
      "**部分更新**：只改传了的字段（`curve` / `seq` / `fromLevel` 不可改）。\n\n" +
      "- `toLevel`：本段结束等级；非末段改它会**连带把下一段的起点挪到 `toLevel + 1`**，" +
      "但不能把下一段挤空（否则 400）。\n" +
      "- `startValue` / `perLevel` / `accel`：段的值与斜率。`accel` 只有 `exp` 有意义。\n" +
      "- 改完立刻重装结算层，**服务端下一次结算就用新值**（不用重启）；客户端重进游戏拉快照后生效。\n" +
      "- 曲线键未登记 / 段不存在 → 404（`50013`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "curve", description: `曲线键：${ROLE_LEVEL_CURVES.join(" / ")}` })
  @ApiParam({ name: "seq", description: "段序号（1 起）" })
  @ApiDataResponse(LevelCurveDto, { description: "更新后的曲线段" })
  update(
    @Param("curve") curve: string,
    @Param("seq", ParseIntPipe) seq: number,
    @Body() dto: UpdateLevelCurveDto,
  ): LevelCurveDto {
    return this.growthConfigService.updateLevelCurve(curve, seq, dto);
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
      "可调的全局参数（键 × 说明，**没有创建 / 删除**）：等级上限 / 经验节奏 / 自然回蓝 / 泡点。\n\n" +
      "每级涨多少不在这里 —— 那是「等级曲线」的事（4 条曲线 × 6 段）。\n\n" +
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
      "- `roleMaxLevel`：改完会把四条曲线的末段 `toLevel` 一起拉到新值（两处数字永远一致）。\n" +
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

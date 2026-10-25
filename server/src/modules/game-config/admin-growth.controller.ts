import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { GROWTH_CURVE_KEYS, GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import { sortFieldNames, GROWTH_SCALAR_SORT, GROWTH_SEGMENT_SORT, LEVEL_EXP_SORT } from "../../database/sort-specs";
import { GrowthConfigService } from "./growth-config.service";
import {
  GrowthScalarDto,
  GrowthScalarPageDto,
  GrowthScalarQueryDto,
  GrowthSegmentDto,
  GrowthSegmentPageDto,
  GrowthSegmentQueryDto,
  LevelExpDto,
  LevelExpPageDto,
  LevelExpQueryDto,
  UpdateGrowthScalarDto,
  UpdateGrowthSegmentDto,
  UpdateLevelExpDto,
} from "./dto/growth.dto";

/**
 * 管理端 · 成长曲线（#256：等级经验 / 曲线分段 / 标量参数）
 *
 * 与称号 / 战魂同一取向：**只有 list / update，没有 create / remove** —— 行的形状由
 * 客户端 configs/growth 定义，seed 固定，后台只改内容（e2e 固化「POST/DELETE 404」）。
 * 写操作带 @AuditTarget：改的是全服玩家的数值曲线，必须可追溯。
 */

@ApiAudience("admin")
@Controller("admin/level-exps")
export class AdminLevelExpController {
  constructor(private readonly growthConfigService: GrowthConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminLevelExp.list",
    summary: "升级经验列表",
    description:
      "等级序列固定（1..roleMaxLevel），**没有创建 / 删除**。每行是「升到下一级所需经验」。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(LEVEL_EXP_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(LevelExpQueryDto)
  @ApiDataResponse(LevelExpPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: LevelExpQueryDto): PageResult<LevelExpDto> {
    return this.growthConfigService.listLevelExps(query);
  }

  @Patch(":level")
  @AuditTarget("levelExp")
  @ApiAdminDoc({
    operationId: "adminLevelExp.update",
    summary: "编辑升级经验",
    description:
      "**部分更新**：只改 `exp`（等级本身不可改）。\n\n" +
      "- `exp` ≥ 1（0 经验的等级永远升不上去）。\n" +
      "- 改经验会改变升级节奏；怪物经验产出在客户端 `expGain` 口径里，两边要一起调。\n" +
      "- 等级不存在 → 404（`50012`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "level", description: "等级（1 起）" })
  @ApiDataResponse(LevelExpDto, { description: "更新后的升级经验" })
  update(@Param("level", ParseIntPipe) level: number, @Body() dto: UpdateLevelExpDto): LevelExpDto {
    return this.growthConfigService.updateLevelExp(level, dto);
  }
}

@ApiAudience("admin")
@Controller("admin/growth-segments")
export class AdminGrowthSegmentController {
  constructor(private readonly growthConfigService: GrowthConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminGrowthSegment.list",
    summary: "成长曲线分段列表",
    description:
      "分段线性曲线的段（曲线键 × 段序固定，**没有创建 / 删除**）：`maxHp` / `attack` / `defense` / `killsPerLevel` 四条，" +
      "每段 {fromLevel, toLevel, startValue, perLevel}，段间必须首尾相接、连续覆盖 1..roleMaxLevel。\n\n" +
      "`curve` 按曲线键筛。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(GROWTH_SEGMENT_SORT)}，\`order\` 取 asc / desc（默认 curve + seq 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(GrowthSegmentQueryDto)
  @ApiDataResponse(GrowthSegmentPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: GrowthSegmentQueryDto): PageResult<GrowthSegmentDto> {
    return this.growthConfigService.listSegments(query);
  }

  @Patch(":curve/:seq")
  @AuditTarget("growthSegment")
  @ApiAdminDoc({
    operationId: "adminGrowthSegment.update",
    summary: "编辑曲线分段",
    description:
      "四个数值字段**整份提交、整份替换**（段的边界与斜率是一体的，部分提交会出现「改了 to 忘了下一段 from」的半截状态）。\n\n" +
      "- 跨行校验：改完后该曲线必须仍然连续覆盖 1..roleMaxLevel（首段 from=1、段间首尾相接、末段 to=roleMaxLevel），" +
      "否则整单拒收 400（40000）。\n" +
      "- **改曲线会影响军衔等效强度**（军衔按阶映射角色等级再打折）与怪物数值 —— 保存前想清楚。\n" +
      "- 曲线或段序不存在 → 404（`50013`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "curve", description: `曲线键（${GROWTH_CURVE_KEYS.join(" / ")}）`, enum: [...GROWTH_CURVE_KEYS] })
  @ApiParam({ name: "seq", description: "段序号（1 起）" })
  @ApiDataResponse(GrowthSegmentDto, { description: "更新后的曲线分段" })
  update(
    @Param("curve") curve: string,
    @Param("seq", ParseIntPipe) seq: number,
    @Body() dto: UpdateGrowthSegmentDto,
  ): GrowthSegmentDto {
    return this.growthConfigService.updateSegment(curve, seq, dto);
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

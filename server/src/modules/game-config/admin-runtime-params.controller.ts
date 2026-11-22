import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { RuntimeParamsService } from "./runtime-params.service";
import {
  AoiParamsDto,
  CastRangeParamsDto,
  MonsterAiParamsDto,
  MovementGuardParamsDto,
  RuntimeParamsDto,
  UpdateAoiParamsDto,
  UpdateCastRangeParamsDto,
  UpdateMonsterAiParamsDto,
  UpdateMovementGuardParamsDto,
  UpdateRuntimeParamsDto,
} from "./dto/runtime-params.dto";

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

  @Get("monster-ai")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.getMonsterAi",
    summary: "怪物 AI 参数",
    description:
      "怪物 AI 的手感参数（`runtime_params.monster_ai` 列）。**单独一条接口**，不并进上面那三组：\n\n" +
      "- 这三组会随配置快照下发客户端，AI 参数不下发（客户端一字节都用不上）；\n" +
      "- 这一组是纯服务端消费 —— 攻速 / 距离 / 游走 / 脱战牵引 / 回家速度，改完 AI 在 1 秒内生效。\n\n" +
      "缺键时 AI 用最小可用值兜住并在服务端 warn，不会让本接口失败。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MonsterAiParamsDto, { description: "当前生效值" })
  getMonsterAi(): MonsterAiParamsDto {
    return this.runtimeParamsService.monsterAi() as unknown as MonsterAiParamsDto;
  }

  @Patch("monster-ai")
  @AuditTarget("runtimeParams")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.updateMonsterAi",
    summary: "编辑怪物 AI 参数",
    description:
      "**部分更新**：只提交改动过的字段，没提交的保持原值。\n\n" +
      "跨字段约束由服务端判（违反 → 40000）：两组区间要满足最小 ≤ 最大；" +
      "`leashRange` 必须大于 `attackRange`（否则怪刚看见玩家就脱战）。\n\n" +
      "生效时机：怪物 AI 每 tick 读一次（1 秒 TTL），保存后 1 秒内生效，**不需要重启、也不需要玩家重进**。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MonsterAiParamsDto, { description: "更新后的生效值" })
  updateMonsterAi(@Body() dto: UpdateMonsterAiParamsDto): MonsterAiParamsDto {
    return this.runtimeParamsService.updateMonsterAi(dto) as unknown as MonsterAiParamsDto;
  }

  @Get("movement")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.getMovement",
    summary: "位移校验参数",
    description:
      "移动三道校验的闸门参数（`runtime_params.movement` 列，#811）。与怪物 AI 一样**单独一条接口**、不下发客户端：\n\n" +
      "- `mode`：`off` 不校验（回滚用）/ `log` 只记账放行（**出厂**）/ `enforce` 拒绝该帧并回 `posCorrect` 拉回；\n" +
      "- `maxSpeed` / `tolerance` / `jitterPx`：单帧位移上限 = `maxSpeed × tolerance × Δt + jitterPx`；\n" +
      "- `wallCheck`：穿墙校验开关（碰撞数据出问题时可单独关掉，不牵连速度校验）；\n" +
      "- `correctIntervalMs`：同一连接两次拉回的最小间隔。\n\n" +
      "`log` 档跑满一周、超速占比 < 0.5% 且穿墙抽样误判为 0 之后再切 `enforce`。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(MovementGuardParamsDto, { description: "当前生效值" })
  getMovement(): MovementGuardParamsDto {
    return this.runtimeParamsService.movement() as unknown as MovementGuardParamsDto;
  }

  @Patch("movement")
  @AuditTarget("runtimeParams")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.updateMovement",
    summary: "编辑位移校验参数",
    description:
      "**部分更新**：只提交改动过的字段，没提交的保持原值。\n\n" +
      "改完**下一次 pos 帧**就按新值判（不做缓存），切档位不需要重启、也不需要玩家重进。\n\n" +
      "风险提示：`enforce` 档下被拒的帧会立刻把玩家拉回权威位置 —— 切之前先确认 `log` 档的流水里没有误判。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(MovementGuardParamsDto, { description: "更新后的生效值" })
  updateMovement(@Body() dto: UpdateMovementGuardParamsDto): MovementGuardParamsDto {
    return this.runtimeParamsService.updateMovement(dto) as unknown as MovementGuardParamsDto;
  }

  @Get("cast-range")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.getCastRange",
    summary: "出手距离闸参数",
    description:
      "出手判定链第三道闸的参数（`runtime_params.cast_range` 列，#1030）。与位移校验一样**单独一条接口**、不下发客户端：\n\n" +
      "- `mode`：`off` 不判（回滚用）/ `log` 只记账放行（**出厂**）/ `enforce` 超距即拒该次出手（`rejected: \"range\"`）；\n" +
      "- `jitterPx`：抖动余量（出厂 24），抵掉 10Hz 上报的相位差与怪物插值滞后。\n\n" +
      "判定式与客户端 `canAttackTarget` **同一式**：把两边的碰撞盒（角色 40×70，怪物取 `monster_presentation.content_width/height`）\n" +
      "换成边缘间距再比 `skills.distance`。`distance ≤ 0` 的技能（不限距离）、范围技能、自身增益技能不走这道闸。\n\n" +
      "`log` 档跑满一周、超距占比与误伤抽样都为 0 之后再切 `enforce`。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(CastRangeParamsDto, { description: "当前生效值" })
  getCastRange(): CastRangeParamsDto {
    return this.runtimeParamsService.castRange() as unknown as CastRangeParamsDto;
  }

  @Patch("cast-range")
  @AuditTarget("runtimeParams")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.updateCastRange",
    summary: "编辑出手距离闸参数",
    description:
      "**部分更新**：只提交改动过的字段，没提交的保持原值。\n\n" +
      "改完**下一次出手**就按新值判（不做缓存），切档位不需要重启、也不需要玩家重进。\n\n" +
      "风险提示：`enforce` 档下超距的出手会被直接拒（客户端表现是「点了没反应」）—— 切之前先确认 `log` 档的流水里没有误判。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(CastRangeParamsDto, { description: "更新后的生效值" })
  updateCastRange(@Body() dto: UpdateCastRangeParamsDto): CastRangeParamsDto {
    return this.runtimeParamsService.updateCastRange(dto) as unknown as CastRangeParamsDto;
  }

  @Get("aoi")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.getAoi",
    summary: "AOI 推送口径",
    description:
      "地图数据推送的裁剪口径（`runtime_params.aoi` 列，#1170）。与怪物 AI / 位移校验一样**单独一条接口**、不下发客户端：\n\n" +
      "- `cellSize`：格子边长（像素，出厂 512），视野 = 玩家所在格 + 周围 8 格的并集；\n" +
      "- `maxEntities`：单帧实体上限（出厂 200），超出只留离格心最近的 N 个；\n" +
      "- `leaveDelayMs`：离开视野延迟（出厂 1000ms），站格子边界来回走不闪；\n" +
      "- `broadcastHz`：互见广播节拍（出厂 10Hz），格子索引与进出差量每拍刷新。\n\n" +
      "缺键时服务端按历史常量兜住（512 / 200 / 1000ms / 10Hz，行为与配置化之前一致）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(AoiParamsDto, { description: "当前生效值" })
  getAoi(): AoiParamsDto {
    return this.runtimeParamsService.aoi() as unknown as AoiParamsDto;
  }

  @Patch("aoi")
  @AuditTarget("runtimeParams")
  @ApiAdminDoc({
    operationId: "adminRuntimeParams.updateAoi",
    summary: "编辑 AOI 推送口径",
    description:
      "**部分更新**：只提交改动过的字段，没提交的保持原值。\n\n" +
      "**生效时机是重启**：格子边长变了等于把所有已成形的格子索引作废（实体在旧格里的位置全错），\n" +
      "运行中热切会出现「一半房间按旧值建、一半按新值建」的时段 —— 所以四个参数统一启动时读一次，\n" +
      "保存后**重启服务端**（API 与实时两个进程）才生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(AoiParamsDto, { description: "更新后的生效值" })
  updateAoi(@Body() dto: UpdateAoiParamsDto): AoiParamsDto {
    return this.runtimeParamsService.updateAoi(dto) as unknown as AoiParamsDto;
  }
}

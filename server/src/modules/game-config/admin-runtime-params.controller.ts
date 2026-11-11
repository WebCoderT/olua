import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { RuntimeParamsService } from "./runtime-params.service";
import { MonsterAiParamsDto, MovementGuardParamsDto, RuntimeParamsDto, UpdateMonsterAiParamsDto, UpdateMovementGuardParamsDto, UpdateRuntimeParamsDto } from "./dto/runtime-params.dto";

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
}

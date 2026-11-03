import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { CombatWeightsRepository } from "../../database/repositories/combat-weights.repository";
import { COMBAT_WEIGHTS_SEED } from "../../shared/combat-seed";
import { applyCombatWeightsOverrides } from "../../shared/runtime-overrides";
import { CombatWeightsDto, CombatWeightsResponseDto, UpdateCombatWeightsDto } from "./dto/combat-weights.dto";

/**
 * 战斗力权重（#605）
 *
 * 这七项倍率原来只写在 `shared/combat-seed.ts`（编译期常量）：服务端算战力、客户端提示
 * 「这件装备是不是更好」都用同一组数字，但**运营改不了** —— 改一次要发版、要重打客户端包。
 * 现在它们落在 `combat_weights` 表：出厂值 seed 自 seed 文件，管理端「战斗力权重」页可改。
 *
 * ## 三条读取路径，同一份数字
 * 1. **服务端结算**（面板 / 地图准入门槛）：`role-attributes.computeCombat` 是纯函数、
 *    拿不到 Nest 注入 —— 所以写操作后由本类把当前值装进 `shared/runtime-overrides`，
 *    结算读 `combatWeightsOf()`；
 * 2. **客户端**：配置快照的 `combatWeights` 段（本类 `weights()`），进游戏拉一次覆写本地表；
 * 3. **管理端**：`get()`，改完立刻回读。
 *
 * ## 为什么不像运行时参数那样整组 JSON 存一列
 * 权重表的键就是属性名，与快照 `combatWeights`（`Record<string, number>`）1:1 ——
 * 一行一个属性最直白，读出来直接就是那张表。将来多一个权重属性也只多一行 seed。
 *
 * ## 每次现读库、不缓存
 * 与 `GrowthConfigService` / `RuntimeParamsService` 同一取向：7 行现查，频率极低
 * （快照一次 / 管理端一次），缓存反而要处理失效。
 */
@Injectable()
export class CombatWeightsService implements OnModuleInit {
  constructor(private readonly repository: CombatWeightsRepository) {}

  /** 启动 seed（幂等：行已存在则保留运营改过的值）+ 装进覆盖层 */
  onModuleInit(): void {
    for (const [key, weight] of Object.entries(COMBAT_WEIGHTS_SEED)) {
      this.repository.seed({ key, weight, updated_at: 0 });
    }
    this.apply();
  }

  /** 当前生效值（管理端读）：扁平权重 + 最后修改时间 */
  get(): CombatWeightsResponseDto {
    const dto = new CombatWeightsResponseDto();
    dto.weights = this.weights() as unknown as CombatWeightsDto;
    const row = this.repository.listAll();
    dto.updatedAt = row.reduce((latest, item) => Math.max(latest, Number(item.updated_at) || 0), 0);
    return dto;
  }

  /** 当前生效值（扁平对象：配置快照与覆盖层用，不经 DTO） */
  weights(): Record<string, number> {
    return this.resolve(this.repository.listAll());
  }

  /**
   * 部分更新（只提交改动过的属性）
   *
   * **先算出结果、再校验、最后落库**：先写后验会把被拒的脏值留在库里，
   * 之后所有合法修改都会跟着挂。落库后立刻重装覆盖层 —— 否则服务端结算要等到
   * 下次进程重启才认新倍率（那就是「管理端改了、战力没动」这类最难查的问题）。
   */
  update(dto: UpdateCombatWeightsDto): CombatWeightsResponseDto {
    const current = this.weights();
    const next: Record<string, number> = { ...current };
    for (const key of Object.keys(COMBAT_WEIGHTS_SEED)) {
      // DTO 是 class 实例，未提交的字段是 own property = undefined（不是缺键）—— 只认「有值」的
      const raw = (dto as unknown as Record<string, unknown>)[key];
      if (raw === undefined || raw === null) continue;
      const weight = Number(raw);
      if (!Number.isFinite(weight) || weight < 0) continue;
      next[key] = weight;
    }
    // 跨字段：七项全 0 = 所有人战力恒 0 = 所有地图的准入条件失效（一次误操作足以放开全图）
    const total = Object.values(next).reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        "战斗力权重不能全部为 0（否则所有角色的战力都是 0，地图准入门槛会全部失效）",
      );
    }
    const now = Date.now();
    let changed = false;
    for (const [key, weight] of Object.entries(next)) {
      if (weight === current[key]) continue;
      this.repository.update({ key, weight, updated_at: now });
      changed = true;
    }
    if (changed) this.apply();
    return this.get();
  }

  /** 把当前值装进覆盖层（启动 + 每次写操作后） */
  private apply(): void {
    applyCombatWeightsOverrides(this.weights());
  }

  /** 行 + 出厂值 → 生效值（只认出厂值的键；坏值 / 负数回落出厂） */
  private resolve(rows: ReadonlyArray<{ key: string; weight: number }>): Record<string, number> {
    const stored = new Map<string, number>();
    for (const row of rows) stored.set(row.key, Number(row.weight));
    const out: Record<string, number> = {};
    for (const [key, fallback] of Object.entries(COMBAT_WEIGHTS_SEED)) {
      const value = stored.get(key);
      out[key] = value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
    }
    return out;
  }
}

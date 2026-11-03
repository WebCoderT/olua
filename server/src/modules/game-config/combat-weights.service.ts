import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { applyCombatWeights } from "../../common/runtime-config-cache";
import { CombatWeightsRepository } from "../../database/repositories/combat-weights.repository";
import { CombatWeightsDto, CombatWeightsResponseDto, UpdateCombatWeightsDto } from "./dto/combat-weights.dto";

/**
 * 战斗力权重（#605 / #655）
 *
 * 七项倍率住在 `combat_weights` 表（一行一个属性）：服务端算战力、客户端提示
 * 「这件装备是不是更好」用的都是这组数字，运营在管理端「战斗力权重」页可改。
 *
 * ## 三条读取路径，同一份数字
 * 1. **服务端结算**（面板 / 地图准入门槛）：`role-attributes.computeCombat` 是纯函数、
 *    拿不到 Nest 注入 —— 所以这里把当前值装进 `common/runtime-config-cache`，
 *    结算读 `combatWeightsOf()`；
 * 2. **客户端**：配置快照的 `combatWeights` 段，进游戏拉一次覆写本地表；
 * 3. **管理端**：`get()`，改完立刻回读。
 *
 * ## 键集从库里来，不是从代码里来
 * #655 之前键集与出厂值都在 `config-sync.sql`，于是「加一项权重」= 改代码 + 重生成。
 * 现在**行就是键集**：表里有哪几行，战力就算哪几项；运营删掉一行就等于这一项不计入
 * （这也是「七项全为 0 直接拒」这条校验存在的理由）。
 *
 * ## 每次现读库、不缓存
 * 7 行现查，频率极低（快照一次 / 管理端一次），缓存反而要处理失效。
 */
@Injectable()
export class CombatWeightsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CombatWeightsService.name);

  constructor(private readonly repository: CombatWeightsRepository) {}

  /** 启动时装进结算层（快照与配置服务的 seed 已由 `config-sync.sql` 首启灌好） */
  onApplicationBootstrap(): void {
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

  /** 当前生效值（扁平对象：配置快照与结算层用，不经 DTO） */
  weights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.repository.listAll()) {
      const value = Number(row.weight);
      out[row.key] = Number.isFinite(value) && value >= 0 ? value : 0;
    }
    return out;
  }

  /**
   * 部分更新（只提交改动过的属性）
   *
   * **先算出结果、再校验、最后落库**：先写后验会把被拒的脏值留在库里，
   * 之后所有合法修改都会跟着挂。落库后立刻重装结算层 —— 否则服务端结算要等到
   * 下次进程重启才认新倍率（那就是「管理端改了、战力没动」这类最难查的问题）。
   */
  update(dto: UpdateCombatWeightsDto): CombatWeightsResponseDto {
    const current = this.weights();
    const next: Record<string, number> = { ...current };
    for (const key of Object.keys(current)) {
      // DTO 是 class 实例，未提交的字段是 own property = undefined（不是缺键）—— 只认「有值」的
      const raw = (dto as unknown as Record<string, unknown>)[key];
      if (raw === undefined || raw === null) continue;
      const weight = Number(raw);
      if (!Number.isFinite(weight) || weight < 0) continue;
      next[key] = weight;
    }
    // 跨字段：全 0 = 所有人战力恒 0 = 所有地图的准入条件失效（一次误操作足以放开全图）
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

  /** 把当前值装进结算层（启动 + 每次写操作后） */
  private apply(): void {
    const rows = this.repository.listAll();
    if (rows.length === 0) {
      // 空表 = 出厂快照没灌进来。战力会全为 0，地图门槛随之失效 —— 必须喊出来
      this.logger.warn("combat_weights 表为空：战力权重全按 0 计算（跑 make config-import 恢复出厂值）");
    }
    applyCombatWeights(rows.map((row) => ({ key: row.key, value: Number(row.weight) })));
  }
}

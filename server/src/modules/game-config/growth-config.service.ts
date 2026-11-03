import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import {
  GrowthRepository,
  GrowthScalarListOptions,
} from "../../database/repositories/growth.repository";
import { RoleLevelRepository } from "../../database/repositories/role-level.repository";
import { GrowthScalarRow, RoleLevelRow } from "../../database/rows";
import {
  GrowthScalarDto,
  GrowthScalarQueryDto,
  RoleLevelDto,
  RoleLevelQueryDto,
  UpdateGrowthScalarDto,
  UpdateRoleLevelDto,
} from "./dto/growth.dto";
import { RuntimeConfigService } from "./runtime-config.service";

/** 列表默认每页条数：这些表行数都不大，默认一页装下全量 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * 成长业务（#655：**只剩「角色等级」与「标量参数」两块**）
 *
 * 曲线分段（`growth_segments`）与旧经验表（`level_exps`）已随曲线一起删除：
 * 60 行 `role_levels` 直接存每级的最终裸属性与升级经验，运行时不再采样插值。
 * 后台接口只有 list / update，没有 create / remove —— 等级序列固定 1..roleMaxLevel。
 *
 * 保留的 `growth_scalars` 是**非曲线的参数**（等级上限 / 区间倍率 / 经验节奏 / 回蓝），
 * 改它影响全线而不是某一段。
 */
@Injectable()
export class GrowthConfigService {
  constructor(
    private readonly growth: GrowthRepository,
    private readonly roleLevels: RoleLevelRepository,
    private readonly runtime: RuntimeConfigService,
  ) {}

  // —— 角色等级（#655：曲线展开后的最终值，运行时与快照的唯一来源） ——

  /** 全量行（快照 `levels` 段用；60 行，量表为空时返回空数组由调用方兜底） */
  listRoleLevelRows(): RoleLevelRow[] {
    return this.roleLevels.listAll();
  }

  listRoleLevels(query: RoleLevelQueryDto): PageResult<RoleLevelDto> {
    const options = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const list = this.roleLevels.list(options).map(RoleLevelDto.from);
    return { list, total: this.roleLevels.count(options), page: options.page, size: options.size };
  }

  /**
   * 改一个等级的数值（部分更新）
   *
   * 写完立刻重装运行时覆盖层：`role-attributes` 读的是内存里的 `role_levels` 快照，
   * 不刷新就是「管理端保存了、服务端还算老值」。区间两端的校验放在 service 而不是 DTO：
   * 「下限不能大于上限」要拿合并后的值判断，单字段 DTO 看不到另一半。
   */
  updateRoleLevel(level: number, dto: UpdateRoleLevelDto): RoleLevelDto {
    const existing = this.roleLevels.findByLevel(level);
    if (!existing) throw BizException.notFound(BizCode.LEVEL_EXP_NOT_FOUND, `等级 ${level} 的角色属性不存在`);
    const next: RoleLevelRow = {
      ...existing,
      exp: dto.exp ?? existing.exp,
      max_hp: dto.maxHp ?? existing.max_hp,
      max_mp: dto.maxMp ?? existing.max_mp,
      hp_recover: dto.hpRecover ?? existing.hp_recover,
      physical_attack_min: dto.physicalAttackMin ?? existing.physical_attack_min,
      physical_attack_max: dto.physicalAttackMax ?? existing.physical_attack_max,
      magic_attack_min: dto.magicAttackMin ?? existing.magic_attack_min,
      magic_attack_max: dto.magicAttackMax ?? existing.magic_attack_max,
      taoist_attack_min: dto.taoistAttackMin ?? existing.taoist_attack_min,
      taoist_attack_max: dto.taoistAttackMax ?? existing.taoist_attack_max,
      physical_defense_min: dto.physicalDefenseMin ?? existing.physical_defense_min,
      physical_defense_max: dto.physicalDefenseMax ?? existing.physical_defense_max,
      magic_defense_min: dto.magicDefenseMin ?? existing.magic_defense_min,
      magic_defense_max: dto.magicDefenseMax ?? existing.magic_defense_max,
      taoist_defense_min: dto.taoistDefenseMin ?? existing.taoist_defense_min,
      taoist_defense_max: dto.taoistDefenseMax ?? existing.taoist_defense_max,
      updated_at: Date.now(),
    };
    assertRangeOrder("physicalAttack", next.physical_attack_min, next.physical_attack_max);
    assertRangeOrder("magicAttack", next.magic_attack_min, next.magic_attack_max);
    assertRangeOrder("taoistAttack", next.taoist_attack_min, next.taoist_attack_max);
    assertRangeOrder("physicalDefense", next.physical_defense_min, next.physical_defense_max);
    assertRangeOrder("magicDefense", next.magic_defense_min, next.magic_defense_max);
    assertRangeOrder("taoistDefense", next.taoist_defense_min, next.taoist_defense_max);
    this.roleLevels.update(next);
    this.runtime.refreshAll();
    return RoleLevelDto.from(this.roleLevels.findByLevel(level)!);
  }

  // —— 标量参数 ——

  listScalars(query: GrowthScalarQueryDto): PageResult<GrowthScalarDto> {
    const options: GrowthScalarListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const list = this.growth.listScalars(options).map(GrowthScalarDto.from);
    return { list, total: this.growth.countScalars(options), page: options.page, size: options.size };
  }

  updateScalar(key: string, dto: UpdateGrowthScalarDto): GrowthScalarDto {
    const existing = this.growth.findScalar(key);
    if (!existing) throw BizException.notFound(BizCode.GROWTH_SCALAR_NOT_FOUND, `标量参数 ${key} 不存在`);
    const spec = GROWTH_SCALAR_SPECS[key];
    if (spec) {
      if (dto.value < spec.min || dto.value > spec.max) {
        throw new BizException(BizCode.PARAM_INVALID, `参数 ${key} 的取值范围是 [${spec.min}, ${spec.max}]`);
      }
      if (spec.integer && !Number.isInteger(dto.value)) {
        throw new BizException(BizCode.PARAM_INVALID, `参数 ${key} 必须是整数`);
      }
    }
    // 等级上限不再由「曲线末段覆盖到哪」决定，而是**等级表的行数**：想开到 61 级，
    // 就多一行 61 级；只抬数字会让 61 级没有属性可读（结算取不到裸属性）
    if (key === "roleMaxLevel") {
      const rows = this.roleLevels.count();
      if (dto.value !== rows) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `等级上限必须等于角色等级表的行数（当前 ${rows} 行）—— 想开更高等级就加对应的一行`,
        );
      }
    }
    const next: GrowthScalarRow = { ...existing, value: dto.value, updated_at: Date.now() };
    this.growth.updateScalar(next);
    // 结算层（纯函数）读的是内存里那一份：不重装就是「管理端改了、服务端还算老值」
    this.runtime.refreshAll();
    return GrowthScalarDto.from(this.growth.findScalar(key)!);
  }

  // —— 内部 ——
}

/**
 * 区间两端必须「下限 ≤ 上限」
 *
 * 改单边时最容易踩：把上限调到 10、下限还是 20，属性区间就反了 —— 结算里
 * `[low, high]` 被当成两段独立加总，面板会显示一个负的波动范围，且没有任何报错。
 */
function assertRangeOrder(name: string, min: number, max: number): void {
  if (min > max) {
    throw new BizException(BizCode.PARAM_INVALID, `${name} 的下限（${min}）不能大于上限（${max}）`);
  }
}

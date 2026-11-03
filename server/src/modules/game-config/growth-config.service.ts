import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { GROWTH_SCALAR_DESCRIPTIONS, GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import {
  GrowthRepository,
  GrowthScalarListOptions,
  GrowthSegmentListOptions,
  LevelExpListOptions,
} from "../../database/repositories/growth.repository";
import { RoleLevelRepository } from "../../database/repositories/role-level.repository";
import { GrowthScalarRow, GrowthSegmentRow, RoleLevelRow } from "../../database/rows";
import {
  GROWTH_CURVES,
  GROWTH_SCALARS,
  ROLE_LEVEL_ATTRIBUTES,
} from "../../shared/growth-seed";
import {
  GrowthScalarDto,
  GrowthScalarQueryDto,
  GrowthSegmentDto,
  GrowthSegmentQueryDto,
  LevelExpDto,
  LevelExpQueryDto,
  RoleLevelDto,
  RoleLevelQueryDto,
  UpdateGrowthScalarDto,
  UpdateGrowthSegmentDto,
  UpdateLevelExpDto,
  UpdateRoleLevelDto,
} from "./dto/growth.dto";
import { RuntimeConfigService } from "./runtime-config.service";

/** 曲线表默认每页条数：曲线行数都不大，默认一页装下全量 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * 成长曲线业务（#256）
 *
 * 三张表都是「**只读 seed、只写更新**」：等级序列与曲线形状来自客户端 configs
 * （经 game-data.generated 快照），服务启动时 INSERT OR IGNORE 灌库 —— 幂等，
 * 且**不会覆盖运营已改的值**；后台接口只有 list / update，没有 create / remove。
 *
 * 跨行 / 跨表校验（DTO 只能管单字段）：
 * - 曲线分段改完后，同曲线的分段必须**连续覆盖 1..roleMaxLevel**（首段 from=1、
 *   段间首尾相接、末段 to=roleMaxLevel）—— 插值口径「段间跳档」依赖这个形状，
 *   断档会在玩家升到中途时取到错的曲线值；
 * - `roleMaxLevel` 改值必须与**每条曲线**的末段 to 一致（四条曲线一起覆盖）。
 */
@Injectable()
export class GrowthConfigService implements OnModuleInit {
  constructor(
    private readonly growth: GrowthRepository,
    private readonly roleLevels: RoleLevelRepository,
    private readonly runtime: RuntimeConfigService,
  ) {}

  /** 启动时把出厂值 seed 进库（幂等；已存在的行原样保留） */
  onModuleInit() {
    this.seedLevelExps();
    this.seedRoleLevels();
    this.seedSegments();
    this.seedScalars();
  }

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

  // —— 等级经验 ——

  /** 某一级的最终升级经验（读 role_levels；表里没有时回落旧的 level_exps，迁移前兼容） */
  findLevelExp(level: number) {
    const row = this.roleLevels.findByLevel(level);
    if (row) return { level: row.level, exp: row.exp, updated_at: row.updated_at };
    return this.growth.findLevelExp(level);
  }

  listLevelExps(query: LevelExpQueryDto): PageResult<LevelExpDto> {
    const options: LevelExpListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      sort: query.sort,
      order: query.order,
    };
    // #655：经验已经并进 role_levels，旧接口保留路径（管理端老页面/脚本还在用），
    // 但数据源同一份 —— 两边各读一张表就是「改了这个页面、那个页面不变」。
    const rows = this.roleLevels.list({ page: options.page, size: options.size, sort: options.sort, order: options.order });
    const list = rows.map((row) => LevelExpDto.from({ level: row.level, exp: row.exp, updated_at: row.updated_at }));
    return { list, total: this.roleLevels.count(), page: options.page, size: options.size };
  }

  updateLevelExp(level: number, dto: UpdateLevelExpDto): LevelExpDto {
    const existing = this.roleLevels.findByLevel(level);
    if (!existing) throw BizException.notFound(BizCode.LEVEL_EXP_NOT_FOUND, `等级 ${level} 的升级经验不存在`);
    const next: RoleLevelRow = { ...existing, exp: dto.exp ?? existing.exp, updated_at: Date.now() };
    this.roleLevels.update(next);
    this.runtime.refreshAll();
    const row = this.roleLevels.findByLevel(level)!;
    return LevelExpDto.from({ level: row.level, exp: row.exp, updated_at: row.updated_at });
  }

  // —— 曲线分段 ——

  listSegments(query: GrowthSegmentQueryDto): PageResult<GrowthSegmentDto> {
    const options: GrowthSegmentListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      curve: query.curve,
      sort: query.sort,
      order: query.order,
    };
    const list = this.growth.listSegments(options).map(GrowthSegmentDto.from);
    return { list, total: this.growth.countSegments(options), page: options.page, size: options.size };
  }

  /**
   * 编辑一段曲线（四个数值字段整份提交）
   *
   * 单字段合法性交给 DTO；这里只做跨行约束 —— **先在内存里合并出改后的整条曲线并校验**，
   * 通过了才落库（先写后验会把被拒的脏值留在库里，后续所有合法修改都会跟着挂）。
   * 曲线必须仍然连续覆盖 1..roleMaxLevel，否则整单拒收（40000）。
   */
  updateSegment(curve: string, seq: number, dto: UpdateGrowthSegmentDto): GrowthSegmentDto {
    const existing = this.growth.findSegment(curve, seq);
    if (!existing) throw BizException.notFound(BizCode.GROWTH_SEGMENT_NOT_FOUND, `曲线 ${curve} 的第 ${seq} 段不存在`);
    if (dto.fromLevel > dto.toLevel) {
      throw new BizException(BizCode.PARAM_INVALID, "起始等级不能大于结束等级");
    }
    const merged: GrowthSegmentRow = {
      ...existing,
      from_level: dto.fromLevel,
      to_level: dto.toLevel,
      start_value: dto.startValue,
      per_level: dto.perLevel,
      updated_at: Date.now(),
    };
    const prospective = this.growth
      .listSegmentsOfCurve(curve)
      .filter((row) => row.seq !== seq)
      .concat(merged)
      .sort((a, b) => a.seq - b.seq);
    this.assertCurveContiguous(curve, prospective);
    this.growth.updateSegment(merged);
    return GrowthSegmentDto.from(this.growth.findSegment(curve, seq)!);
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
    // 等级上限是四条曲线的覆盖终点，改它必须连曲线一起改（先改曲线末段，再来抬上限）
    if (key === "roleMaxLevel") {
      const mismatched = Object.keys(GROWTH_CURVES).filter((curve) => {
        const segments = this.growth.listSegmentsOfCurve(curve);
        const last = segments[segments.length - 1];
        return !last || last.to_level !== dto.value;
      });
      if (mismatched.length > 0) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `曲线 ${mismatched.join(" / ")} 的最后一段没有覆盖到 ${dto.value}，先把末段 to 改过来再调等级上限`,
        );
      }
    }
    const next: GrowthScalarRow = { ...existing, value: dto.value, updated_at: Date.now() };
    this.growth.updateScalar(next);
    return GrowthScalarDto.from(this.growth.findScalar(key)!);
  }

  // —— 内部 ——

  /**
   * 曲线连续性校验：首段 from=1、段间首尾相接、末段 to = 标量 roleMaxLevel。
   * 接收**合并后**的段数组（含尚未落库的修改）—— 校验的是「将要变成的形状」。
   */
  private assertCurveContiguous(curve: string, segments: GrowthSegmentRow[]): void {
    const maxLevel = this.growth.findScalar("roleMaxLevel")?.value;
    let expected = 1;
    for (const segment of segments) {
      if (segment.from_level !== expected) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `曲线 ${curve} 第 ${segment.seq} 段从 ${segment.from_level} 开始，应从 ${expected} 开始（段间必须首尾相接）`,
        );
      }
      expected = segment.to_level + 1;
    }
    if (maxLevel !== undefined && expected - 1 !== maxLevel) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `曲线 ${curve} 覆盖到 ${expected - 1} 级，与等级上限 ${maxLevel} 不一致（末段 to 必须等于 roleMaxLevel）`,
      );
    }
  }

  /**
   * 角色等级 seed（#655）：60 行最终属性写进 `role_levels`
   *
   * **只在表为空时跑**：已有行说明迁移跑过 / 运营改过，一行都不能覆盖。
   * 属性直接取 `ROLE_LEVEL_ATTRIBUTES`（曲线展开后的常量），经验优先取刚 seed 的
   * `level_exps` —— 这样「空库自举」与「老库迁移」两条路得到的值逐值相同。
   */
  private seedRoleLevels() {
    if (this.roleLevels.count() > 0) return;
    for (const [levelKey, attributes] of Object.entries(ROLE_LEVEL_ATTRIBUTES)) {
      const level = Number(levelKey);
      const expRow = this.growth.findLevelExp(level);
      this.roleLevels.seedRow({
        level,
        exp: Math.max(1, Math.round(expRow ? expRow.exp : attributes.exp)),
        max_hp: attributes.maxHp,
        max_mp: attributes.maxMp,
        hp_recover: attributes.hpRecover,
        physical_attack_min: attributes.physicalAttack[0],
        physical_attack_max: attributes.physicalAttack[1],
        magic_attack_min: attributes.magicAttack[0],
        magic_attack_max: attributes.magicAttack[1],
        taoist_attack_min: attributes.taoistAttack[0],
        taoist_attack_max: attributes.taoistAttack[1],
        physical_defense_min: attributes.physicalDefense[0],
        physical_defense_max: attributes.physicalDefense[1],
        magic_defense_min: attributes.magicDefense[0],
        magic_defense_max: attributes.magicDefense[1],
        taoist_defense_min: attributes.taoistDefense[0],
        taoist_defense_max: attributes.taoistDefense[1],
        updated_at: 0,
      });
    }
  }

  /** 等级经验 seed：ROLE_LEVEL_ATTRIBUTES 每级的 exp（升级所需经验与曲线共用同一来源） */
  private seedLevelExps() {
    for (const [level, attributes] of Object.entries(ROLE_LEVEL_ATTRIBUTES)) {
      this.growth.seedLevelExp({
        level: Number(level),
        exp: Math.max(1, Math.round(attributes.exp ?? 1)),
        updated_at: 0,
      });
    }
  }

  /** 曲线分段 seed：GROWTH_CURVES 四条曲线的段原样落库 */
  private seedSegments() {
    for (const [curve, segments] of Object.entries(GROWTH_CURVES)) {
      (segments as unknown as Array<Record<string, number>>).forEach((segment, index) => {
        this.growth.seedSegment({
          curve,
          seq: index + 1,
          from_level: Math.round(segment.from ?? 0),
          to_level: Math.round(segment.to ?? 0),
          start_value: Math.round(segment.start ?? 0),
          per_level: Math.round(segment.perLevel ?? 0),
          updated_at: 0,
        });
      });
    }
  }

  /** 标量参数 seed：GROWTH_SCALARS 逐行落库，说明取自服务端自己的字典 */
  private seedScalars() {
    for (const [key, value] of Object.entries(GROWTH_SCALARS)) {
      this.growth.seedScalar({
        key,
        value: Number(value),
        description: GROWTH_SCALAR_DESCRIPTIONS[key] ?? "",
        updated_at: 0,
      });
    }
  }
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

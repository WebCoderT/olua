import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { GROWTH_SCALAR_SPECS } from "../../common/constants/game-config";
import {
  ROLE_LEVEL_CURVES,
  ROLE_LEVEL_CURVE_LABELS,
  buildRoleLevelRow,
  isRoleLevelCurveKey,
} from "../../common/constants/role-level-curve";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import {
  GrowthRepository,
  GrowthScalarListOptions,
} from "../../database/repositories/growth.repository";
import { RoleLevelCurveRepository } from "../../database/repositories/role-level-curve.repository";
import { GrowthScalarRow, RoleLevelCurveRow } from "../../database/rows";
import {
  GrowthScalarDto,
  GrowthScalarQueryDto,
  LevelAttributesDto,
  LevelCurveDto,
  LevelCurveListDto,
  UpdateGrowthScalarDto,
  UpdateLevelCurveDto,
} from "./dto/growth.dto";
import { RuntimeConfigService } from "./runtime-config.service";

/** 列表默认每页条数：这些表行数都不大，默认一页装下全量 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * 成长业务（#786：**等级曲线 + 标量参数**）
 *
 * ## 等级为什么不是表
 * #655 曾经把等级展开成 `role_levels` 一行一级（60 行），好处是「改哪级就是哪级」。
 * 但等级上限要到 100 万：逐级存要 60MB 库、1.5GB 快照、客户端几百 MB 内存，
 * 而且原曲线是指数型，外推到 100 万级直接 `Infinity`。所以 #786 回到**参数化**：
 * 4 条曲线（经验 / 生命 / 物攻上限 / 物防上限）× 6 段 = 24 行，1..100 万级全靠公式算。
 * 其余 12 列是派生的（蓝 = 血/2、回血 = 血/100、下限 = 上限×0.7、三系同值）。
 *
 * ## 管理端给什么
 * 没有「逐级列表」了 —— 运营改的是**段**（这一段从哪级到哪级、起始值、每级涨多少），
 * 想知道「第 123456 级到底多少」，用「等级属性计算器」（`previewLevel`）现算。
 */
@Injectable()
export class GrowthConfigService {
  constructor(
    private readonly growth: GrowthRepository,
    private readonly levelCurves: RoleLevelCurveRepository,
    private readonly runtime: RuntimeConfigService,
  ) {}

  // —— 等级曲线（#786） ——

  /** 全部段（24 行，按曲线 → 段序；管理端表格与快照共用） */
  listLevelCurves(): LevelCurveListDto {
    return { list: this.levelCurves.listAll().map(LevelCurveDto.from) };
  }

  /** 快照用：曲线段的原始行（DTO 转换由 client-config 做） */
  listLevelCurveRows(): RoleLevelCurveRow[] {
    return this.levelCurves.listAll();
  }

  /**
   * 改一段（部分更新）
   *
   * 三条硬约束，缺一条就会「某些等级没有属性」：
   * 1. `curve` 必须是登记过的四条之一（拼错一个字母，那条曲线的改动就静默不生效）；
   * 2. `toLevel >= fromLevel`（段不能为空）；
   * 3. 非末段改 `toLevel` 会**连带把下一段的起点挪到 `toLevel + 1`** ——
   *    不联动就会在中间留空隙（求值虽然能按「前一段继续延伸」兜住，
   *    但管理端表看起来是断的，运营会以为自己改坏了）。
   *    联动也不能吃掉下一段：`toLevel` 必须让下一段还剩下至少一级。
   *
   * 写完立刻 `refreshAll()`：结算层读的是内存投影，不重装就是「管理端改了、服务端还算老值」。
   */
  updateLevelCurve(curve: string, seq: number, dto: UpdateLevelCurveDto): LevelCurveDto {
    if (!isRoleLevelCurveKey(curve)) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `未登记的曲线：${curve}（只有 ${ROLE_LEVEL_CURVES.join(" / ")}）`,
      );
    }
    const existing = this.levelCurves.findByKey(curve, seq);
    if (!existing) {
      throw BizException.notFound(BizCode.GROWTH_SEGMENT_NOT_FOUND, `等级曲线 ${curve} 的第 ${seq} 段不存在`);
    }
    const toLevel = dto.toLevel ?? existing.to_level;
    if (toLevel < existing.from_level) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `${ROLE_LEVEL_CURVE_LABELS[curve]} 第 ${seq} 段的结束等级（${toLevel}）不能小于起始等级（${existing.from_level}）`,
      );
    }
    const next = this.levelCurves.findByKey(curve, seq + 1);
    if (next) {
      const nextFrom = toLevel + 1;
      if (nextFrom > next.to_level) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `${ROLE_LEVEL_CURVE_LABELS[curve]} 第 ${seq} 段结束在 ${toLevel} 级会把下一段挤空（下一段是 ${next.from_level}~${next.to_level} 级）`,
        );
      }
      if (next.from_level !== nextFrom) {
        this.levelCurves.updateFromLevel(curve, next.seq, nextFrom, Date.now());
      }
    }
    this.levelCurves.update(curve, seq, dto, Date.now());
    this.runtime.refreshAll();
    return LevelCurveDto.from(this.levelCurves.findByKey(curve, seq)!);
  }

  /**
   * 等级属性计算器：算出某一级的**基础属性**（不含装备 / 称号等加成）
   *
   * 这是「等级表没了之后」唯一能看「第 N 级多少血」的地方，也是排错入口：
   * 运营调完段参数，先在这里看几级，再去游戏里验证。
   *
   * 等级可以超过上限（按末段外推也算）—— 运营经常要预演「开到 200 万级会是什么数值」，
   * 卡在上限反而不方便。
   */
  previewLevel(level: number): LevelAttributesDto {
    const target = Math.trunc(Number(level));
    if (!Number.isFinite(target) || target < 1) {
      throw new BizException(BizCode.PARAM_INVALID, "等级必须是 1 起的整数");
    }
    const row = buildRoleLevelRow(groupCurves(this.levelCurves.listAll()), target);
    if (!row) {
      throw BizException.notFound(
        BizCode.GROWTH_SEGMENT_NOT_FOUND,
        `等级 ${target} 算不出来 —— 四条曲线里至少有一条没有覆盖到它（检查曲线末段）`,
      );
    }
    return LevelAttributesDto.fromRow(row);
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
    // 等级上限与曲线末段必须一致，否则管理端「末段到 1000000 级」和「上限 2000000」
    // 会同时显示在屏幕上而含义不明。**上限一改就把四条曲线的末段拉过去** ——
    // 求值本身支持外推（不拉也能算），这里纯粹是为了让两处数字对得上。
    if (key === "roleMaxLevel") {
      const curves = this.levelCurves.listAll();
      const now = Date.now();
      for (const curve of ROLE_LEVEL_CURVES) {
        const last = curves.filter((row) => row.curve === curve).sort((a, b) => a.seq - b.seq).pop();
        if (!last) continue;
        if (last.to_level !== dto.value) {
          this.levelCurves.update(curve, last.seq, { toLevel: dto.value }, now);
        }
      }
    }
    const next: GrowthScalarRow = { ...existing, value: dto.value, updated_at: Date.now() };
    this.growth.updateScalar(next);
    // 结算层（纯函数）读的是内存里那一份：不重装就是「管理端改了、服务端还算老值」
    this.runtime.refreshAll();
    return GrowthScalarDto.from(this.growth.findScalar(key)!);
  }
}

/** 按曲线分组（求值要「一条曲线一个有序段数组」，直接扫全表会把别的曲线也算进来） */
function groupCurves(rows: RoleLevelCurveRow[]): Record<string, RoleLevelCurveRow[]> {
  const out: Record<string, RoleLevelCurveRow[]> = {};
  for (const row of rows) {
    const list = out[row.curve];
    if (list) list.push(row);
    else out[row.curve] = [row];
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => a.seq - b.seq);
  return out;
}

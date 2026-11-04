import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import {
  appearanceKeyProblem,
  EQUIPMENT_APPEARANCE_DEFAULTS,
  EQUIPMENT_APPEARANCE_LIMITS,
  EQUIPMENT_COMBO_COUNT,
  EQUIPMENT_PREFIX_MAX,
  EQUIPMENT_SUFFIX_MAX,
} from "../../common/constants/equipment-appearance";
import { EquipmentAppearanceRow } from "../../database/rows";
import { EquipmentAppearanceRepository } from "../../database/repositories/equipment-appearance.repository";
import {
  AppearanceAssignmentDto,
  CustomAppearanceDto,
  EquipmentAppearanceDto,
  UpdateEquipmentAppearanceDto,
} from "./dto/equipment-appearance.dto";

/**
 * 装备外观（#695）：边框 + 详情背景的「谁用哪个 key」
 *
 * ## 表长什么样
 * 单行表（`equipment_appearance`），四列 JSON：前后缀→边框、前后缀→详情背景、
 * 特殊装备→边框、特殊装备→详情背景。边框 / 背景的素材本体与资源清单都在客户端
 * （`configs/border` / `configs/background` 有与磁盘文件一一对应的守卫），
 * 这里只管「哪个组合 / 哪件装备用哪个 key」—— 运营换组合不重打客户端包。
 *
 * ## 读法
 * `appearance()` 每次现读库（与 `GuideSettingsService` 同一取向）：
 * 调用方只有快照（进游戏一次）与管理端（改完回读），频率极低。
 *
 * ## 坏数据自愈
 * JSON 可能被手改坏：坏条目丢掉、好条目留下（**自定义表**与 guide 步骤同一手法）。
 * **前后缀映射表**不同：它是 15 组合的完整覆盖，缺一条 = 那个品质突然没边框，
 * 无法「留下一半」——所以映射表坏了（不是数组 / 条目残缺）**整表回落出厂值**
 * （出厂值在服务常量里，见 `EQUIPMENT_APPEARANCE_DEFAULTS`），并报一条 error。
 *
 * ## 保存 = 整份替换
 * 校验放在写库之前：15 组合恰好全覆盖且不重复、key 格式合法、自定义装备标识唯一。
 * 任何一条不合法 → 40000 且**整份不落库**（半份新表 + 半份旧表比整份旧表更难排查）。
 */
@Injectable()
export class EquipmentAppearanceService implements OnModuleInit {
  private readonly logger = new Logger(EquipmentAppearanceService.name);

  constructor(private readonly repository: EquipmentAppearanceRepository) {}

  /**
   * 启动补行（幂等）：没有行 → 按出厂值 seed。
   *
   * 只补「没有行」这一种情况（不像音效还做 rebase）：出厂值是 15 组合的整份映射，
   * 「运营从没改过但和出厂值不一样」对一份 JSON 没法逐条判断，而 key 格式变了
   * 意味着客户端资源清单也变了（那本来就要改客户端 + 出厂值两处）。
   */
  onModuleInit(): void {
    if (this.repository.get()) return;
    const defaults = EQUIPMENT_APPEARANCE_DEFAULTS;
    this.repository.seed({
      id: 1,
      borders: JSON.stringify(toAssignmentRows(defaults.borders)),
      backgrounds: JSON.stringify(toAssignmentRows(defaults.backgrounds)),
      custom_borders: JSON.stringify(defaults.customBorders),
      custom_backgrounds: JSON.stringify(defaults.customBackgrounds),
      updated_at: 0,
    });
    this.logger.log("equipment_appearance 无行 —— 已按出厂值补上（15 前后缀组合 × 边框/背景）");
  }

  /** 整份读（管理端用；含 updatedAt） */
  get(): EquipmentAppearanceDto {
    const row = this.repository.get();
    return {
      borders: this.effectiveAssignments(row, "borders", "边框"),
      backgrounds: this.effectiveAssignments(row, "backgrounds", "详情背景"),
      customBorders: this.effectiveCustoms(row, "custom_borders", "边框"),
      customBackgrounds: this.effectiveCustoms(row, "custom_backgrounds", "详情背景"),
      updatedAt: Number(row?.updated_at) || 0,
    };
  }

  /** 整份读（配置快照用；updatedAt 客户端不消费，但保持与管理端同一形状，少一套映射） */
  appearance(): EquipmentAppearanceDto {
    return this.get();
  }

  /** 整份替换（校验不过 → 40000，且不落库） */
  update(dto: UpdateEquipmentAppearanceDto): EquipmentAppearanceDto {
    const borders = dto.borders ?? [];
    const backgrounds = dto.backgrounds ?? [];
    this.assertFullCoverage(borders, "边框");
    this.assertFullCoverage(backgrounds, "详情背景");
    const customBorders = this.assertUniqueCustoms(dto.customBorders ?? [], "边框");
    const customBackgrounds = this.assertUniqueCustoms(dto.customBackgrounds ?? [], "详情背景");

    const row: EquipmentAppearanceRow = {
      id: 1,
      borders: JSON.stringify(toAssignmentRows(borders)),
      backgrounds: JSON.stringify(toAssignmentRows(backgrounds)),
      custom_borders: JSON.stringify(customBorders),
      custom_backgrounds: JSON.stringify(customBackgrounds),
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.get();
  }

  /** 前后缀映射表：15 组合恰好全覆盖、各一次、key 格式合法 */
  private assertFullCoverage(rows: AppearanceAssignmentDto[], label: string): void {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const combo = `${row.prefix}|${row.suffix}`;
      if (seen.has(combo)) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}表第 ${index + 1} 条的前后缀组合（${combo}）重复了 —— 每个组合只能有一条`);
      }
      seen.add(combo);
      const problem = appearanceKeyProblem(row.key, label === "边框" ? "border" : "background");
      if (problem) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}表第 ${index + 1} 条（${combo}）：${problem}`);
      }
    }
    const missing: string[] = [];
    for (let suffix = 0; suffix <= EQUIPMENT_SUFFIX_MAX; suffix++) {
      for (let prefix = 0; prefix <= EQUIPMENT_PREFIX_MAX; prefix++) {
        if (!seen.has(`${prefix}|${suffix}`)) missing.push(`${prefix}|${suffix}`);
      }
    }
    if (missing.length) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `${label}表缺了 ${missing.length} 个前后缀组合（${missing.join("、")}）—— 缺哪个组合，哪个品质就没有${label}`,
      );
    }
  }

  /** 自定义表：装备标识唯一 + key 格式合法（重复的两条会让「到底用哪个」变成玄学） */
  private assertUniqueCustoms(rows: CustomAppearanceDto[], label: string): CustomAppearanceDto[] {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.equipment)) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}自定义表第 ${index + 1} 条的装备「${row.equipment}」重复了（标识要唯一）`);
      }
      seen.add(row.equipment);
      const problem = appearanceKeyProblem(row.key, label === "边框" ? "border" : "background");
      if (problem) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}自定义表第 ${index + 1} 条（${row.equipment}）：${problem}`);
      }
    }
    return rows.map((row) => ({ equipment: row.equipment, key: row.key }));
  }

  /**
   * 前后缀映射表读取（坏表整份回落出厂值）
   *
   * 出厂值兜底**只发生在坏数据上**（不是数组 / 条目残缺 / 组合不完整）——
   * 运营在管理端改出来的合法表永远是库里那份。回落时报 error：这是「数据被手改坏了」
   * 的信号，静默回落会让人以为改配置没生效。
   */
  private effectiveAssignments(row: EquipmentAppearanceRow | undefined, column: "borders" | "backgrounds", label: string): AppearanceAssignmentDto[] {
    const kind = label === "边框" ? ("border" as const) : ("background" as const);
    const fallback = () =>
      toAssignmentRows(
        label === "边框" ? EQUIPMENT_APPEARANCE_DEFAULTS.borders : EQUIPMENT_APPEARANCE_DEFAULTS.backgrounds,
      );
    if (!row) {
      this.logger.error(`equipment_appearance 没有行（id = 1）—— ${label}表回落出厂值。重启一次服务会自动补行`);
      return fallback();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row[column]);
    } catch {
      this.logger.error(`equipment_appearance.${column} 不是合法 JSON —— ${label}表回落出厂值（改回合法 JSON 即可恢复）`);
      return fallback();
    }
    if (!Array.isArray(parsed)) {
      this.logger.error(`equipment_appearance.${column} 不是数组 —— ${label}表回落出厂值`);
      return fallback();
    }
    const rows: AppearanceAssignmentDto[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const source = item as Record<string, unknown>;
      const prefix = Number(source.prefix);
      const suffix = Number(source.suffix);
      const key = typeof source.key === "string" ? source.key : "";
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > EQUIPMENT_PREFIX_MAX) continue;
      if (!Number.isInteger(suffix) || suffix < 0 || suffix > EQUIPMENT_SUFFIX_MAX) continue;
      if (!key || appearanceKeyProblem(key, kind)) continue;
      rows.push({ prefix, suffix, key });
    }
    if (rows.length < EQUIPMENT_COMBO_COUNT) {
      // 差一条 = 那个品质没边框，客户端会安静跳过 —— 宁可回落出厂也别让品质光效缺一块
      this.logger.error(`equipment_appearance.${column} 只有 ${rows.length}/${EQUIPMENT_COMBO_COUNT} 条可用 —— ${label}表回落出厂值`);
      return fallback();
    }
    return rows;
  }

  /** 自定义表读取（坏条目丢掉、好条目留下，与 guide 步骤同一手法） */
  private effectiveCustoms(row: EquipmentAppearanceRow | undefined, column: "custom_borders" | "custom_backgrounds", label: string): CustomAppearanceDto[] {
    const kind = label === "边框" ? ("border" as const) : ("background" as const);
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row[column]);
    } catch {
      this.logger.error(`equipment_appearance.${column} 不是合法 JSON —— ${label}自定义表按空表处理`);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const rows: CustomAppearanceDto[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const source = item as Record<string, unknown>;
      const equipment = typeof source.equipment === "string" ? source.equipment : "";
      const key = typeof source.key === "string" ? source.key : "";
      if (!equipment || equipment.length > EQUIPMENT_APPEARANCE_LIMITS.equipmentIdMaxLength) continue;
      if (!key || appearanceKeyProblem(key, kind)) continue;
      rows.push({ equipment, key });
    }
    return rows;
  }
}

/** DTO / seed → 落库形状（多出来的键不往下传：行形状由常量定义） */
function toAssignmentRows(rows: { prefix: number; suffix: number; key: string }[]): { prefix: number; suffix: number; key: string }[] {
  return rows.map((row) => ({ prefix: row.prefix, suffix: row.suffix, key: row.key }));
}

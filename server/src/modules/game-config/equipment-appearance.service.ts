import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import {
  appearanceKeyProblem,
  buildAppearanceDefaults,
  EQUIPMENT_APPEARANCE_DEFAULTS,
  EQUIPMENT_APPEARANCE_LIMITS,
  EQUIPMENT_PREFIX_MAX,
  EQUIPMENT_SUFFIX_MAX,
  EQUIPMENT_TIER_MAX,
} from "../../common/constants/equipment-appearance";
import { EquipmentAppearanceRow } from "../../database/rows";
import { EquipmentAppearanceRepository } from "../../database/repositories/equipment-appearance.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
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
 * **前后缀映射表**不同：它是「当前档数」组合的完整覆盖，缺一条 = 那个品质突然没边框，
 * 无法「留下一半」——所以映射表坏了（不是数组 / 条目残缺 / 组合不完整 / **档数对不上**）
 * **整表回落出厂映射**（按当前档数用公式展开，见 `buildAppearanceDefaults`），并报一条 error。
 *
 * ## 档数是动态的（#697）
 * 前后缀档位可在管理端增删（equipment_meta 文案 / 倍率数组，1~10 档）。
 * 「全覆盖」的口径因此跟着档数走：增档后旧表不覆盖新组合 → 回落公式映射，
 * 新组合的 key 是公式外推的 sfx 编号（客户端资源清单里多半不存在，先没边框，
 * 运营在管理端填上真实素材 key 即可）；缩档后超界条目按坏条目丢弃。
 *
 * ## 保存 = 整份替换
 * 校验放在写库之前：当前档数的组合恰好全覆盖且不重复、key 格式合法、自定义装备标识唯一。
 * 任何一条不合法 → 40000 且**整份不落库**（半份新表 + 半份旧表比整份旧表更难排查）。
 */
@Injectable()
export class EquipmentAppearanceService implements OnModuleInit {
  private readonly logger = new Logger(EquipmentAppearanceService.name);

  constructor(
    private readonly repository: EquipmentAppearanceRepository,
    private readonly equipments: EquipmentRepository,
  ) {}

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
    this.logger.log("equipment_appearance 无行 —— 已按出厂值补上（当前档数的前后缀组合 × 边框/背景）");
  }

  /**
   * 当前前后缀档数（从 equipment_meta 文案长度派生，#697）
   *
   * 用**文案**长度而不是倍率长度：客户端拼品质名读的是文案，档位的「存在」以有名字为准
   * （两者在管理端保存时被校验等长，手改库弄不一致时以文案为准更贴近玩家所见）。
   * meta 缺行 / JSON 坏了 → 回落出厂档数（5 × 3）：外观表此时的口径宁旧勿崩。
   */
  private tiers(): { prefixCount: number; suffixCount: number } {
    const fallback = () => ({ prefixCount: EQUIPMENT_PREFIX_MAX + 1, suffixCount: EQUIPMENT_SUFFIX_MAX + 1 });
    const meta = this.equipments.getMeta();
    if (!meta) return fallback();
    const count = (text: string): number => {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return 0;
        return parsed.filter((item) => typeof item === "string" && item.trim() !== "").length;
      } catch {
        return 0;
      }
    };
    const clamp = (value: number, atLeast: number) => Math.min(Math.max(value, atLeast), EQUIPMENT_TIER_MAX);
    return {
      prefixCount: clamp(count(meta.prefix_labels), 1),
      suffixCount: clamp(count(meta.suffix_labels), 1),
    };
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

  /** 前后缀映射表：当前档数的组合恰好全覆盖、各一次、key 格式合法 */
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
    const { prefixCount, suffixCount } = this.tiers();
    const missing: string[] = [];
    for (let suffix = 0; suffix < suffixCount; suffix++) {
      for (let prefix = 0; prefix < prefixCount; prefix++) {
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
    const { prefixCount, suffixCount } = this.tiers();
    const expectedCount = prefixCount * suffixCount;
    // 回落值按「当前档数」用公式展开（#697）：扩档后旧表必然缺新组合，回落的表要能盖住全部组合
    const fallback = () => toAssignmentRows(buildAppearanceDefaults(prefixCount, suffixCount)[column === "borders" ? "borders" : "backgrounds"]);
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
      if (!Number.isInteger(prefix) || prefix < 0 || prefix >= prefixCount) continue;
      if (!Number.isInteger(suffix) || suffix < 0 || suffix >= suffixCount) continue;
      if (!key || appearanceKeyProblem(key, kind)) continue;
      rows.push({ prefix, suffix, key });
    }
    if (rows.length < expectedCount) {
      // 差一条 = 那个品质没边框，客户端会安静跳过 —— 宁可回落出厂也别让品质光效缺一块
      this.logger.error(
        `equipment_appearance.${column} 只有 ${rows.length}/${expectedCount} 条可用（当前档数 ${prefixCount}×${suffixCount}）—— ${label}表回落出厂映射`,
      );
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

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import {
  appearanceEffectProblem,
  appearanceKeyProblem,
  buildAppearanceDefaults,
  effectiveAppearanceEffect,
  EQUIPMENT_APPEARANCE_DEFAULTS,
  EQUIPMENT_APPEARANCE_LIMITS,
  EQUIPMENT_PREFIX_MAX,
  EQUIPMENT_SUFFIX_MAX,
  EQUIPMENT_TIER_MAX,
} from "../../common/constants/equipment-appearance";
import type { AppearanceEffect } from "../../common/constants/equipment-appearance";
import { EquipmentAppearanceRow } from "../../database/rows";
import { EquipmentAppearanceRepository } from "../../database/repositories/equipment-appearance.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import {
  AppearanceAssignmentDto,
  AppearanceItemDto,
  CustomAppearanceDto,
  EquipmentAppearanceDto,
  EquipmentBackgroundDto,
  EquipmentBorderDto,
  UpdateEquipmentBackgroundDto,
  UpdateEquipmentBorderDto,
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
 * 条目上的 `effect`（显示效果，#700）坏的时候**只丢 effect、条目保留**——
 * 效果错了顶多显示不对，映射本身还是好的。
 *
 * ## 档数是动态的（#697）
 * 前后缀档位可在管理端增删（equipment_meta 文案 / 倍率数组，1~10 档）。
 * 「全覆盖」的口径因此跟着档数走：增档后旧表不覆盖新组合 → 回落公式映射，
 * 新组合的 key 是公式外推的 sfx 编号（客户端资源清单里多半不存在，先没边框，
 * 运营在管理端填上真实素材 key 即可）；缩档后超界条目按坏条目丢弃。
 *
 * ## 保存 = 整边替换（#699 拆边）
 * 边框 / 背景在管理端是两个独立页面，各自整份读写自己的半边（`getBorder` / `updateBorder`
 * 与 `getBackground` / `updateBackground`），另一边两列原样保留 —— 两个页面互不覆盖。
 * 校验放在写库之前：当前档数的组合恰好全覆盖且不重复、key 格式合法、effect 合法、
 * 自定义装备标识唯一。任何一条不合法 → 40000 且**整边不落库**。
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
   * 只补「没有行」这一种情况（不像音效还做 rebase）：出厂值是全部组合的整份映射，
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
      border_items: "[]",
      background_items: "[]",
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

  /** 单边读 · 边框页（#699 起边框 / 背景是两个独立页面，各自整份读写自己的半边） */
  getBorder(): EquipmentBorderDto {
    return this.getKind("border") as EquipmentBorderDto;
  }

  /** 单边读 · 背景页 */
  getBackground(): EquipmentBackgroundDto {
    return this.getKind("background") as EquipmentBackgroundDto;
  }

  /** 整份读（配置快照用；updatedAt 客户端不消费，但保持与管理端同一形状，少一套映射） */
  appearance(): EquipmentAppearanceDto {
    const border = this.getKind("border");
    const background = this.getKind("background");
    return {
      borders: border.assignments,
      backgrounds: background.assignments,
      customBorders: border.customs,
      customBackgrounds: background.customs,
      updatedAt: border.updatedAt,
    };
  }

  /**
   * 单边替换（#699）：只写自己这边的两列，**另一边原样保留** ——
   * 边框页和背景页可以各自独立保存，互不覆盖（整份替换会让后保存的页面
   * 把先保存页面的改动冲掉）。
   *
   * 校验不过 → 40000 且**整边不落库**（本边半新半旧比整边旧更难排查）。
   */
  updateBorder(dto: UpdateEquipmentBorderDto): EquipmentBorderDto {
    this.updateKind("border", dto.assignments ?? [], dto.customs ?? [], dto.items);
    return this.getBorder();
  }

  /** 单边替换 · 背景页 */
  updateBackground(dto: UpdateEquipmentBackgroundDto): EquipmentBackgroundDto {
    this.updateKind("background", dto.assignments ?? [], dto.customs ?? [], dto.items);
    return this.getBackground();
  }

  /** 单边读的共享实现：kind 决定读哪几列（清单 + 映射 + 自定义表） */
  private getKind(kind: AppearanceKind): { items: AppearanceItemDto[]; assignments: AppearanceAssignmentDto[]; customs: CustomAppearanceDto[]; updatedAt: number } {
    const spec = KIND_SPECS[kind];
    const row = this.repository.get();
    const assignments = this.effectiveAssignments(row, spec);
    const customs = this.effectiveCustoms(row, spec);
    return {
      items: this.effectiveItems(row, spec, assignments, customs),
      assignments,
      customs,
      updatedAt: Number(row?.updated_at) || 0,
    };
  }

  /**
   * 单边写的共享实现：另一边的列从当前行**原样带回**（行缺失时先按出厂值垫底 ——
   * 正常情况下 onModuleInit 已 seed 过，这里只是防御）。
   *
   * ## 清单与引用（#714）
   * `items` 是边框 / 背景清单本体：不传 = 沿用库里的清单并自动并入被引用的 key
   * （老调用方与既有 e2e 兼容）；传了 = 整份替换，且——
   * - 每个被引用的 key（棋盘 + 自定义表）都必须在清单里（删掉被引用的条目 → 400）；
   * - **引用处的 effect 以清单为准传播**：清单是效果的唯一来源，棋盘 / 自定义表里的
   *   effect 字段只是给客户端快照的副本（契约不变），写库时按清单覆盖。
   */
  private updateKind(kind: AppearanceKind, assignments: AppearanceAssignmentDto[], customs: CustomAppearanceDto[], items?: AppearanceItemDto[]): void {
    const spec = KIND_SPECS[kind];
    this.assertFullCoverage(assignments, spec);
    const checkedCustoms = this.assertUniqueCustoms(customs, spec);
    const current = this.repository.get();
    const checkedItems = this.assertUniqueItems(items, spec, current, assignments, checkedCustoms);

    // 引用完整性：每个被引用的 key 都得在清单里（清单是唯一实体来源）
    const known = new Set(checkedItems.map((item) => item.key));
    for (const [index, row] of assignments.entries()) {
      if (!known.has(row.key)) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `${spec.label}表第 ${index + 1} 条（${row.prefix}|${row.suffix}）引用的「${row.key}」不在清单里 —— 先在清单里添加它，或改引用别的 ${spec.label}`,
        );
      }
    }
    for (const [index, row] of checkedCustoms.entries()) {
      if (!known.has(row.key)) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `${spec.label}自定义表第 ${index + 1} 条（${row.equipment}）引用的「${row.key}」不在清单里 —— 先在清单里添加它，或改引用别的 ${spec.label}`,
        );
      }
    }

    // effect 以清单为准传播进引用处（客户端快照契约不变：effect 仍在 assignments / customs 条目上）
    const effectOf = (key: string): AppearanceEffect | undefined => checkedItems.find((item) => item.key === key)?.effect;
    const propagatedAssignments = assignments.map((row) => ({ prefix: row.prefix, suffix: row.suffix, key: row.key, ...(effectOf(row.key) ? { effect: effectOf(row.key) } : {}) }));
    const propagatedCustoms = checkedCustoms.map((row) => ({ equipment: row.equipment, key: row.key, ...(effectOf(row.key) ? { effect: effectOf(row.key) } : {}) }));

    const { prefixCount, suffixCount } = this.tiers();
    const defaults = buildAppearanceDefaults(prefixCount, suffixCount);
    const row: EquipmentAppearanceRow = current ?? {
      id: 1,
      borders: JSON.stringify(toAssignmentRows(defaults.borders)),
      backgrounds: JSON.stringify(toAssignmentRows(defaults.backgrounds)),
      custom_borders: "[]",
      custom_backgrounds: "[]",
      border_items: "[]",
      background_items: "[]",
      updated_at: 0,
    };
    if (kind === "border") {
      row.borders = JSON.stringify(toAssignmentRows(propagatedAssignments));
      row.custom_borders = JSON.stringify(propagatedCustoms);
      row.border_items = JSON.stringify(checkedItems);
    } else {
      row.backgrounds = JSON.stringify(toAssignmentRows(propagatedAssignments));
      row.custom_backgrounds = JSON.stringify(propagatedCustoms);
      row.background_items = JSON.stringify(checkedItems);
    }
    row.updated_at = Date.now();
    this.repository.update(row);
  }

  /** 清单提交校验：key 唯一且格式合法、effect 合法；不传 = 库里清单 ∪ 被引用 key（自动补齐，见 effectiveItems） */
  private assertUniqueItems(
    items: AppearanceItemDto[] | undefined,
    spec: KindSpec,
    row: EquipmentAppearanceRow | undefined,
    assignments: AppearanceAssignmentDto[],
    customs: CustomAppearanceDto[],
  ): AppearanceItemDto[] {
    if (items === undefined) return this.effectiveItems(row, spec, assignments, customs);
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.key)) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}清单第 ${index + 1} 条的 key「${item.key}」重复了（清单里每个 key 只能有一条）`);
      }
      seen.add(item.key);
      const problem = appearanceKeyProblem(item.key, spec.kind);
      if (problem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}清单第 ${index + 1} 条：${problem}`);
      }
      const effectProblem = effectProblemOf(item.effect);
      if (effectProblem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}清单第 ${index + 1} 条（${item.key}）的显示效果：${effectProblem}`);
      }
    }
    return items.map((item) => ({ key: item.key, ...(item.effect ? { effect: item.effect } : {}) }));
  }

  /**
   * 清单读取（#714）：库里的注册表 ∪ 被引用的 key
   *
   * 出厂 / 老库里注册表是空的 —— 被引用的 key（棋盘 15 格 + 自定义表）自动补进清单，
   * effect 取引用处的现值，所以**老数据零迁移**：GET 出来的清单天然完整。
   * 坏条目（key 格式不对 / effect 坏）丢掉，与自定义表同一自愈口径。
   */
  private effectiveItems(row: EquipmentAppearanceRow | undefined, spec: KindSpec, assignments: AppearanceAssignmentDto[], customs: CustomAppearanceDto[]): AppearanceItemDto[] {
    const items: AppearanceItemDto[] = [];
    const seen = new Set<string>();
    if (row) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row[spec.itemColumn]);
      } catch {
        this.logger.error(`equipment_appearance.${spec.itemColumn} 不是合法 JSON —— ${spec.label}清单按空表处理（引用处会自动补齐）`);
        parsed = [];
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const source = item as Record<string, unknown>;
          const key = typeof source.key === "string" ? source.key : "";
          if (!key || seen.has(key) || appearanceKeyProblem(key, spec.kind)) continue;
          const effect = effectiveAppearanceEffect(source.effect);
          if (source.effect !== undefined && source.effect !== null && !effect) {
            this.logger.warn(`equipment_appearance.${spec.itemColumn} 有一条（${key}）的 effect 坏了 —— 该条回落默认效果`);
          }
          items.push({ key, ...(effect ? { effect } : {}) });
          seen.add(key);
        }
      }
    }
    // 引用处自动补齐（effect 取引用处现值）：保证 GET 出来的清单覆盖所有在用的 key
    const append = (key: string, effect: AppearanceEffect | undefined) => {
      if (seen.has(key)) return;
      items.push({ key, ...(effect ? { effect } : {}) });
      seen.add(key);
    };
    for (const assignment of assignments) append(assignment.key, assignment.effect);
    for (const custom of customs) append(custom.key, custom.effect);
    return items;
  }

  /** 前后缀映射表：当前档数的组合恰好全覆盖、各一次、key 与 effect 格式合法 */
  private assertFullCoverage(rows: AppearanceAssignmentDto[], spec: KindSpec): void {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const combo = `${row.prefix}|${row.suffix}`;
      if (seen.has(combo)) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}表第 ${index + 1} 条的前后缀组合（${combo}）重复了 —— 每个组合只能有一条`);
      }
      seen.add(combo);
      const problem = appearanceKeyProblem(row.key, spec.kind);
      if (problem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}表第 ${index + 1} 条（${combo}）：${problem}`);
      }
      const effectProblem = effectProblemOf(row.effect);
      if (effectProblem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}表第 ${index + 1} 条（${combo}）的显示效果：${effectProblem}`);
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
        `${spec.label}表缺了 ${missing.length} 个前后缀组合（${missing.join("、")}）—— 缺哪个组合，哪个品质就没有${spec.label}`,
      );
    }
  }

  /** 自定义表：装备标识唯一 + key 与 effect 格式合法（重复的两条会让「到底用哪个」变成玄学） */
  private assertUniqueCustoms(rows: CustomAppearanceDto[], spec: KindSpec): CustomAppearanceDto[] {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.equipment)) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}自定义表第 ${index + 1} 条的装备「${row.equipment}」重复了（标识要唯一）`);
      }
      seen.add(row.equipment);
      const problem = appearanceKeyProblem(row.key, spec.kind);
      if (problem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}自定义表第 ${index + 1} 条（${row.equipment}）：${problem}`);
      }
      const effectProblem = effectProblemOf(row.effect);
      if (effectProblem) {
        throw new BizException(BizCode.PARAM_INVALID, `${spec.label}自定义表第 ${index + 1} 条（${row.equipment}）的显示效果：${effectProblem}`);
      }
    }
    return rows.map((row) => ({ equipment: row.equipment, key: row.key, ...(row.effect ? { effect: row.effect } : {}) }));
  }

  /**
   * 前后缀映射表读取（坏表整份回落出厂值）
   *
   * 出厂值兜底**只发生在坏数据上**（不是数组 / 条目残缺 / 组合不完整）——
   * 运营在管理端改出来的合法表永远是库里那份。回落时报 error：这是「数据被手改坏了」
   * 的信号，静默回落会让人以为改配置没生效。
   */
  private effectiveAssignments(row: EquipmentAppearanceRow | undefined, spec: KindSpec): AppearanceAssignmentDto[] {
    const { prefixCount, suffixCount } = this.tiers();
    const expectedCount = prefixCount * suffixCount;
    // 回落值按「当前档数」用公式展开（#697）：扩档后旧表必然缺新组合，回落的表要能盖住全部组合
    const fallback = () => toAssignmentRows(buildAppearanceDefaults(prefixCount, suffixCount)[spec.seedKey]);
    if (!row) {
      this.logger.error(`equipment_appearance 没有行（id = 1）—— ${spec.label}表回落出厂值。重启一次服务会自动补行`);
      return fallback();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row[spec.assignmentColumn]);
    } catch {
      this.logger.error(`equipment_appearance.${spec.assignmentColumn} 不是合法 JSON —— ${spec.label}表回落出厂值（改回合法 JSON 即可恢复）`);
      return fallback();
    }
    if (!Array.isArray(parsed)) {
      this.logger.error(`equipment_appearance.${spec.assignmentColumn} 不是数组 —— ${spec.label}表回落出厂值`);
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
      if (!key || appearanceKeyProblem(key, spec.kind)) continue;
      // effect 坏只丢 effect（回落默认效果），条目本身保留 —— 映射是对的，别一杆子打死
      const effect = effectiveAppearanceEffect(source.effect);
      if (source.effect !== undefined && source.effect !== null && !effect) {
        this.logger.warn(`equipment_appearance.${spec.assignmentColumn} 有一条（${prefix}|${suffix}）的 effect 坏了 —— 该条回落默认效果`);
      }
      rows.push({ prefix, suffix, key, ...(effect ? { effect } : {}) });
    }
    if (rows.length < expectedCount) {
      // 差一条 = 那个品质没边框，客户端会安静跳过 —— 宁可回落出厂也别让品质光效缺一块
      this.logger.error(
        `equipment_appearance.${spec.assignmentColumn} 只有 ${rows.length}/${expectedCount} 条可用（当前档数 ${prefixCount}×${suffixCount}）—— ${spec.label}表回落出厂映射`,
      );
      return fallback();
    }
    return rows;
  }

  /** 自定义表读取（坏条目丢掉、好条目留下，与 guide 步骤同一手法；effect 坏只丢 effect） */
  private effectiveCustoms(row: EquipmentAppearanceRow | undefined, spec: KindSpec): CustomAppearanceDto[] {
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row[spec.customColumn]);
    } catch {
      this.logger.error(`equipment_appearance.${spec.customColumn} 不是合法 JSON —— ${spec.label}自定义表按空表处理`);
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
      if (!key || appearanceKeyProblem(key, spec.kind)) continue;
      const effect = effectiveAppearanceEffect(source.effect);
      if (source.effect !== undefined && source.effect !== null && !effect) {
        this.logger.warn(`equipment_appearance.${spec.customColumn} 有一条（${equipment}）的 effect 坏了 —— 该条回落默认效果`);
      }
      rows.push({ equipment, key, ...(effect ? { effect } : {}) });
    }
    return rows;
  }
}

/** 单边（边框 / 背景）在行与出厂值里的读写口径 */
interface KindSpec {
  /** 给人看的名字（错误消息用） */
  label: string;
  /** key 格式种类 */
  kind: "border" | "background";
  /** 行里的映射列 */
  assignmentColumn: "borders" | "backgrounds";
  /** 行里的自定义表列 */
  customColumn: "custom_borders" | "custom_backgrounds";
  /** 行里的实体清单列（#714：清单本体，引用处只存 key） */
  itemColumn: "border_items" | "background_items";
  /** 出厂值里对应的键 */
  seedKey: "borders" | "backgrounds";
}

type AppearanceKind = "border" | "background";

const KIND_SPECS: Record<AppearanceKind, KindSpec> = {
  border: { label: "边框", kind: "border", assignmentColumn: "borders", customColumn: "custom_borders", itemColumn: "border_items", seedKey: "borders" },
  background: { label: "详情背景", kind: "background", assignmentColumn: "backgrounds", customColumn: "custom_backgrounds", itemColumn: "background_items", seedKey: "backgrounds" },
};

/** effect 缺省合法（不传 = 默认效果）；传了就按人话校验 */
function effectProblemOf(effect: AppearanceEffect | undefined): string | null {
  return effect === undefined || effect === null ? null : appearanceEffectProblem(effect);
}

/** DTO / seed → 落库形状（多出来的键不往下传：行形状由常量定义） */
function toAssignmentRows(rows: { prefix: number; suffix: number; key: string; effect?: AppearanceEffect }[]): { prefix: number; suffix: number; key: string; effect?: AppearanceEffect }[] {
  return rows.map((row) => ({ prefix: row.prefix, suffix: row.suffix, key: row.key, ...(row.effect ? { effect: row.effect } : {}) }));
}

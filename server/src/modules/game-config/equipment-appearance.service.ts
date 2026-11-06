import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
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
  normalizeAppearanceLabel,
} from "../../common/constants/equipment-appearance";
import type { AppearanceEffect } from "../../common/constants/equipment-appearance";
import { EquipmentAppearanceRow } from "../../database/rows";
import { EquipmentAppearanceRepository } from "../../database/repositories/equipment-appearance.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import {
  AppearanceAssignmentDto,
  AppearanceItemDto,
  AppearanceResourceScanDto,
  AppearanceResourceSyncDto,
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

  /** 行缺失时的防御性垫底（onModuleInit 正常已 seed；这里只是防御，与 updateKind 同一口径） */
  private fallbackRow(): EquipmentAppearanceRow {
    const { prefixCount, suffixCount } = this.tiers();
    const defaults = buildAppearanceDefaults(prefixCount, suffixCount);
    return {
      id: 1,
      borders: JSON.stringify(toAssignmentRows(defaults.borders)),
      backgrounds: JSON.stringify(toAssignmentRows(defaults.backgrounds)),
      custom_borders: "[]",
      custom_backgrounds: "[]",
      border_items: "[]",
      background_items: "[]",
      updated_at: 0,
    };
  }

  private rowWithFallback(): EquipmentAppearanceRow {
    return this.repository.get() ?? this.fallbackRow();
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

  /**
   * 资源文件夹扫描（#716「从文件夹同步」的预览）
   *
   * 扫 `EQUIPMENT_APPEARANCE_RES_DIR`（缺省 = 仓库布局的 `../client/assets/resources`，
   * 线上由 compose 把 `game/resources/` 只读挂进容器）下本边素材目录，与**当前清单**
   * （GET 口径，含被引用自动并入的 key）求差集。管理端拿它弹「将新增 / 将移除」确认框。
   */
  scanResources(kind: AppearanceKind): AppearanceResourceScanDto {
    const { dir, keys } = scanAppearanceFolder(kind);
    const spec = KIND_SPECS[kind];
    const row = this.repository.get();
    const assignments = this.effectiveAssignments(row, spec);
    const customs = this.effectiveCustoms(row, spec);
    const items = this.effectiveItems(row, spec, assignments, customs);
    const folder = new Set(keys);
    const known = new Set(items.map((item) => item.key));
    const referenced = new Set([...assignments.map((assignment) => assignment.key), ...customs.map((custom) => custom.key)]);
    const removed = items.map((item) => item.key).filter((key) => !folder.has(key));
    return {
      dir,
      keys,
      added: keys.filter((key) => !known.has(key)),
      removed,
      removedReferenced: removed.filter((key) => referenced.has(key)),
    };
  }

  /**
   * 从资源文件夹同步清单（#716）：**文件夹是「游戏里有哪些边框 / 背景」的事实来源**
   *
   * - 同步后清单 = 文件夹里的全部素材（按 sfx 编号升序）；存活条目的 `effect`
   *   原样保留（effect 的单一来源在清单，不能被同步冲掉），新条目缺省；
   * - 文件夹里没了的素材 → 条目移除，**哪怕仍被棋盘 / 自定义表引用** —— 这是与
   *   `updateKind` 引用完整性校验的唯一分歧点：手工编辑仍走校验（防手滑删错），
   *   而同步是运营明确「以文件夹为准」的整批动作，引用处显示异常（客户端安静跳过）
   *   是需求接受的后果，读接口会把被引用的 key 自动并回清单，下次同步前一直可见；
   * - 棋盘 / 自定义表两列**不动** —— 它们的归属页（前后缀管理 / 本页绑定区）各自修。
   *
   * 只写本边的清单列，另一边与映射列不受影响；任何异常（目录读不到 / 空目录 /
   * 超上限）→ 40000 且**不落库**（空目录多半是挂载配错，拿它清空清单等于删库）。
   */
  syncResources(kind: AppearanceKind): AppearanceResourceSyncDto {
    const preview = this.scanResources(kind);
    const spec = KIND_SPECS[kind];
    if (preview.keys.length === 0) {
      throw new BizException(BizCode.PARAM_INVALID, `资源目录里没扫到任何${spec.label}素材（${preview.dir}）—— 目录多半配错了，拒绝清空清单`);
    }
    if (preview.keys.length > EQUIPMENT_APPEARANCE_LIMITS.itemMax) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `资源目录里有 ${preview.keys.length} 个${spec.label}素材，超过清单上限 ${EQUIPMENT_APPEARANCE_LIMITS.itemMax} —— 先清理素材或扩上限`,
      );
    }
    // effect 单一来源在清单：存活条目连同 effect / 别名 / 分组一起保留（#718），新条目缺省
    const savedByKey = new Map(this.getKind(kind).items.map((item) => [item.key, item]));
    const items = preview.keys.map((key) => savedByKey.get(key) ?? { key });
    const row = this.rowWithFallback();
    row[spec.itemColumn] = JSON.stringify(items);
    row.updated_at = Date.now();
    this.repository.update(row);
    this.logger.log(
      `${spec.label}清单已按资源文件夹同步：新增 ${preview.added.length}、移除 ${preview.removed.length}` +
        (preview.removedReferenced.length ? `（其中 ${preview.removedReferenced.length} 个仍被引用，引用处待修复）` : "") +
        `，共 ${items.length} 条`,
    );
    return {
      added: preview.added,
      removed: preview.removed,
      removedReferenced: preview.removedReferenced,
      kept: items.length,
      updatedAt: row.updated_at,
    };
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

    const row: EquipmentAppearanceRow = current ?? this.fallbackRow();
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

  /** 清单提交校验：key 唯一且格式合法、effect / 别名 / 分组合法；不传 = 库里清单 ∪ 被引用 key（自动补齐，见 effectiveItems） */
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
      const labelProblem = labelProblemOf(item.name, item.group, index + 1, item.key, spec.label);
      if (labelProblem) {
        throw new BizException(BizCode.PARAM_INVALID, labelProblem);
      }
    }
    return items.map((item) => normalizeItem(item));
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
          // 别名 / 分组（#718）坏只丢字段（管理端属性，不影响游戏渲染），条目保留
          const name = normalizeAppearanceLabel(source.name, EQUIPMENT_APPEARANCE_LIMITS.nameMaxLength) ?? undefined;
          const group = normalizeAppearanceLabel(source.group, EQUIPMENT_APPEARANCE_LIMITS.groupMaxLength) ?? undefined;
          items.push({ key, ...(effect ? { effect } : {}), ...(name ? { name } : {}), ...(group ? { group } : {}) });
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

/** 别名 / 分组（#718）的提交校验：格式不对 → 人话错误（null = 合法） */
function labelProblemOf(name: string | undefined, group: string | undefined, index: number, key: string, label: string): string | null {
  const nameMax = EQUIPMENT_APPEARANCE_LIMITS.nameMaxLength;
  if (normalizeAppearanceLabel(name, nameMax) === null) {
    return `${label}清单第 ${index} 条（${key}）的别名最长 ${nameMax} 字`;
  }
  const groupMax = EQUIPMENT_APPEARANCE_LIMITS.groupMaxLength;
  if (normalizeAppearanceLabel(group, groupMax) === null) {
    return `${label}清单第 ${index} 条（${key}）的分组名最长 ${groupMax} 字`;
  }
  return null;
}

/** 落库形状：trim 过的别名 / 分组，空串与没填一样不存（读出来字段干净） */
function normalizeItem(item: AppearanceItemDto): AppearanceItemDto {
  const name = normalizeAppearanceLabel(item.name, EQUIPMENT_APPEARANCE_LIMITS.nameMaxLength) ?? undefined;
  const group = normalizeAppearanceLabel(item.group, EQUIPMENT_APPEARANCE_LIMITS.groupMaxLength) ?? undefined;
  return {
    key: item.key,
    ...(item.effect ? { effect: item.effect } : {}),
    ...(name ? { name } : {}),
    ...(group ? { group } : {}),
  };
}

/** DTO / seed → 落库形状（多出来的键不往下传：行形状由常量定义） */
function toAssignmentRows(rows: { prefix: number; suffix: number; key: string; effect?: AppearanceEffect }[]): { prefix: number; suffix: number; key: string; effect?: AppearanceEffect }[] {
  return rows.map((row) => ({ prefix: row.prefix, suffix: row.suffix, key: row.key, ...(row.effect ? { effect: row.effect } : {}) }));
}

//#region 资源文件夹扫盘（#716「从文件夹同步」）

/** 每种素材在 resources 下的子目录与 key → 文件名（去扩展名）的规则 */
const RES_FOLDER_SPECS: Record<AppearanceKind, { subdir: string; filePattern: RegExp }> = {
  border: { subdir: "effect/border", filePattern: /^border-\d+$/ },
  background: { subdir: "effect/background", filePattern: /^bg-\d+$/ },
};

/**
 * 资源目录：显式配置优先；缺省按「服务端 cwd 在 server/ 里」的仓库布局取隔壁 client。
 * 字面量取 env（不走常量间接）是有意的：tools/audit-api-hardcode 的登记检查按
 * 「process.env + 点号键名」的形状搜集 —— 用了哪个键、.env.example 里就得登记哪个。
 */
function appearanceResDir(): string {
  const configured = process.env.EQUIPMENT_APPEARANCE_RES_DIR?.trim();
  return configured || path.resolve(process.cwd(), "..", "client", "assets", "resources");
}

/** 从 key 里抠编号（排序用；抠不到排最前，反正格式校验在别处） */
function appearanceSerialOf(key: string): number {
  return Number(key.match(/(\d+)/)?.[1] ?? 0);
}

/**
 * 扫资源文件夹拿全部 key（按编号升序）
 *
 * 边框与背景**都是平铺图集**（`border-30123.plist` / `bg-16000.plist` + 同名 png），
 * 所以规则一致：认 `.plist` 且同名 png 存在（有图集定义没图是坏素材，跳过）。
 * `.meta`（Cocos 的杂鱼文件）天然不匹配任何规则，不用特判。
 */
function scanAppearanceFolder(kind: AppearanceKind): { dir: string; keys: string[] } {
  const spec = RES_FOLDER_SPECS[kind];
  const dir = path.resolve(appearanceResDir(), spec.subdir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new BizException(
      BizCode.PARAM_INVALID,
      `资源目录读不到：${dir} —— 用环境变量 EQUIPMENT_APPEARANCE_RES_DIR 把它指到客户端 resources 目录` +
        `（本地开发缺省就是 ../client/assets/resources；线上由 compose 把 game/resources 挂进容器）`,
    );
  }
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".plist")) continue;
    const key = entry.name.slice(0, -".plist".length);
    if (!spec.filePattern.test(key)) continue;
    if (!entries.some((other) => other.isFile() && other.name === `${key}.png`)) continue;
    keys.push(key);
  }
  keys.sort((a, b) => appearanceSerialOf(a) - appearanceSerialOf(b));
  return { dir, keys };
}

//#endregion

import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { AcquireChannel } from "../../common/constants/game-config";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { RankRepository, RankListOptions } from "../../database/repositories/rank.repository";
import { DrugRepository, DrugListOptions } from "../../database/repositories/drug.repository";
import { EquipmentRepository, EquipmentListOptions } from "../../database/repositories/equipment.repository";
import { SoulRepository, SoulListOptions } from "../../database/repositories/soul.repository";
import { TitleRepository, TitleListOptions } from "../../database/repositories/title.repository";
import { DrugRow, EquipmentRow, RankRow, SoulRow, TitleRow } from "../../database/rows";
import {
  DRUGS,
  EQUIPMENT_BASES,
  RANK_LABELS,
  RANK_LEVEL_ATTRIBUTES,
  RANK_LEVEL_META,
  SOUL_LABELS,
  SOUL_LEVEL_ATTRIBUTES,
  SOUL_LEVEL_META,
  TITLE_LABELS,
  TITLE_LEVEL_ATTRIBUTES,
  TITLE_LEVEL_META,
} from "../../shared/game-data.generated";
import { EquipmentDto, EquipmentQueryDto, UpdateEquipmentDto } from "./dto/equipment.dto";
import { DrugDto, DrugQueryDto, UpdateDrugDto } from "./dto/drug.dto";
import { RankDto, RankQueryDto, UpdateRankDto } from "./dto/rank.dto";
import { SoulDto, SoulQueryDto, UpdateSoulDto } from "./dto/soul.dto";
import {
  attributesFromRow,
  ConfigAttributesDto,
  SoulRowShape,
  TitleDto,
  TitleQueryDto,
  UpdateTitleDto,
  UpgradeOrderDto,
} from "./dto/title.dto";

/** 列表默认每页条数：34 / 37 行一页装得下，默认就是全量价目表 */
const DEFAULT_PAGE_SIZE = 100;

/** 区间型属性键（与 ConfigAttributesDto 的六个区间字段一致） */
const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"] as const;

/**
 * 养成配置（称号 / 战魂）业务
 *
 * **只读 seed、只写更新**：等级序列来自客户端 configs（经 game-data.generated 快照），
 * 服务启动时 INSERT OR IGNORE 灌进 titles / souls 表 —— 幂等，且**不会覆盖运营已改的值**；
 * 后台接口只有 list / update，没有 create / remove（序列固定，e2e 固化这一约束）。
 */
@Injectable()
export class GameConfigService implements OnModuleInit {
  constructor(
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly equipments: EquipmentRepository,
    private readonly drugs: DrugRepository,
  ) {}

  /** 启动时把客户端配置 seed 进库（幂等；已存在的行原样保留） */
  onModuleInit() {
    this.seedTitles();
    this.seedSouls();
    this.seedRanks();
    this.seedEquipments();
    this.seedDrugs();
  }

  // —— 称号 ——

  listTitles(query: TitleQueryDto): PageResult<TitleDto> {
    const options: TitleListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      acquireChannel: query.acquireChannel,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.titles.list(options);
    const total = this.titles.count(options);
    return { list: rows.map(TitleDto.from), total, page: options.page, size: options.size };
  }

  updateTitle(level: number, dto: UpdateTitleDto): TitleDto {
    const existing = this.requireTitle(level);
    const attributes = dto.attributes ?? attributesFromRow(existing);
    assertAttributeRanges(attributes);
    const nextChannel = dto.acquireChannel ?? existing.acquire_channel;

    const next: TitleRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      animation: dto.animation ?? existing.animation,
      animation_frame_rate: dto.animationFrameRate ?? existing.animation_frame_rate,
      bind_gold: dto.bindGold ?? existing.bind_gold,
      acquire_channel: nextChannel,
      // 渠道切换时的序号联动（顺序没有直接改的口子 —— 拖动排序只走 reorderUpgradeTitles）：
      // 切到 upgrade → 追加到成长列表尾（max+1）；切走 → 清空序号（价格保留，切回来重新排到尾）
      upgrade_order: this.nextUpgradeOrder(existing, nextChannel),
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.titles.update(next);
    return TitleDto.from(this.requireTitle(level));
  }

  /** 称号成长列表：upgrade 渠道按顺序号升序（独立于主列表的「升级链」视图） */
  listUpgradeTitles(): TitleDto[] {
    return this.titles.listUpgrade().map(TitleDto.from);
  }

  /**
   * 称号成长列表重排（拖动排序的落库口）
   *
   * `levels` 必须恰好等于当前 upgrade 渠道的等级集合：缺失说明漏传、多出说明传了
   * 不在列表里的行、重复说明前端状态脏了 —— 三种都整单拒收，不做增量合并。
   */
  reorderUpgradeTitles(dto: UpgradeOrderDto): TitleDto[] {
    const current = this.titles.listUpgrade();
    const currentLevels = current.map((row) => row.level).sort((a, b) => a - b);
    const submitted = [...dto.levels].sort((a, b) => a - b);
    if (
      dto.levels.length !== new Set(dto.levels).size ||
      submitted.length !== currentLevels.length ||
      submitted.some((value, index) => value !== currentLevels[index])
    ) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        "levels 必须与当前升级渠道的称号等级集合完全一致（不多、不少、不重复）",
      );
    }
    const orderByLevel = new Map(dto.levels.map((value, index) => [value, index + 1]));
    this.titles.reassignUpgradeOrders([...orderByLevel].map(([value, order]) => ({ level: value, order })));
    return this.listUpgradeTitles();
  }

  // —— 战魂 ——

  listSouls(query: SoulQueryDto): PageResult<SoulDto> {
    const options: SoulListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.souls.list(options);
    const total = this.souls.count(options);
    return { list: rows.map(SoulDto.from), total, page: options.page, size: options.size };
  }

  updateSoul(level: number, dto: UpdateSoulDto): SoulDto {
    const existing = this.requireSoul(level);
    const attributes = dto.attributes ?? attributesFromRow(existing);
    assertAttributeRanges(attributes);

    const next: SoulRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      animation: dto.animation ?? existing.animation,
      animation_frame_rate: dto.animationFrameRate ?? existing.animation_frame_rate,
      bind_gold: dto.bindGold ?? existing.bind_gold,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.souls.update(next);
    return SoulDto.from(this.requireSoul(level));
  }

  /** 战魂成长列表：37 阶全量按顺序号升序（升级链视图，顺序与阶数解耦） */
  listUpgradeSouls(): SoulDto[] {
    return this.souls.listUpgrade().map(SoulDto.from);
  }

  /**
   * 战魂成长列表重排（拖动排序的落库口）
   *
   * `levels` 必须恰好等于全部阶数集合：战魂没有渠道进出，37 阶永远全量在列表里 ——
   * 缺失说明漏传、多出说明传了不存在的阶、重复说明前端状态脏了，三种都整单拒收。
   */
  reorderUpgradeSouls(dto: UpgradeOrderDto): SoulDto[] {
    const current = this.souls.listUpgrade();
    const currentLevels = current.map((row) => row.level).sort((a, b) => a - b);
    const submitted = [...dto.levels].sort((a, b) => a - b);
    if (
      dto.levels.length !== new Set(dto.levels).size ||
      submitted.length !== currentLevels.length ||
      submitted.some((value, index) => value !== currentLevels[index])
    ) {
      throw new BizException(BizCode.PARAM_INVALID, "levels 必须与全部战魂阶数集合完全一致（不多、不少、不重复）");
    }
    const orderByLevel = new Map(dto.levels.map((value, index) => [value, index + 1]));
    this.souls.reassignUpgradeOrders([...orderByLevel].map(([value, order]) => ({ level: value, order })));
    return this.listUpgradeSouls();
  }

  // —— 军衔（#250：100 阶全量就是成长链，顺序天然按阶，没有拖动排序）——

  listRanks(query: RankQueryDto): PageResult<RankDto> {
    const options: RankListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      tier: query.tier,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.ranks.list(options);
    const total = this.ranks.count(options);
    return { list: rows.map(RankDto.from), total, page: options.page, size: options.size };
  }

  updateRank(level: number, dto: UpdateRankDto): RankDto {
    const existing = this.requireRank(level);
    const attributes = dto.attributes ?? attributesFromRow(existing);
    assertAttributeRanges(attributes);

    const next: RankRow = {
      ...existing,
      label: dto.label ?? existing.label,
      tier: dto.tier ?? existing.tier,
      description: dto.description ?? existing.description,
      bind_gold: dto.bindGold ?? existing.bind_gold,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.ranks.update(next);
    return RankDto.from(this.requireRank(level));
  }

  // —— 装备基础件（#252：id / 部位结构固定，只改数值；变体在客户端按倍率展开）——

  listEquipments(query: EquipmentQueryDto): PageResult<EquipmentDto> {
    const options: EquipmentListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      slot: query.slot,
      minLevel: query.minLevel,
      maxLevel: query.maxLevel,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.equipments.list(options);
    const total = this.equipments.count(options);
    return { list: rows.map(EquipmentDto.from), total, page: options.page, size: options.size };
  }

  updateEquipment(id: string, dto: UpdateEquipmentDto): EquipmentDto {
    const existing = this.requireEquipment(id);
    const attributes = dto.attributes ?? attributesFromRow(existing as EquipmentRow & SoulRowShape);
    assertAttributeRanges(attributes);

    const next: EquipmentRow = {
      ...existing,
      level: dto.level ?? existing.level,
      sell_price: dto.sellPrice ?? existing.sell_price,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.equipments.update(next);
    return EquipmentDto.from(this.requireEquipment(id));
  }

  // —— 药品（#253：id 清单固定只改数值；effects 按键求和成四列）——

  listDrugs(query: DrugQueryDto): PageResult<DrugDto> {
    const options: DrugListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.drugs.list(options);
    const total = this.drugs.count(options);
    return { list: rows.map(DrugDto.from), total, page: options.page, size: options.size };
  }

  updateDrug(id: string, dto: UpdateDrugDto): DrugDto {
    const existing = this.requireDrug(id);
    const next: DrugRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      sell_price: dto.sellPrice ?? existing.sell_price,
      max_stack: dto.maxStack ?? existing.max_stack,
      cooldown: dto.cooldown ?? existing.cooldown,
      effect_hp: dto.effectHp ?? existing.effect_hp,
      effect_mp: dto.effectMp ?? existing.effect_mp,
      effect_hp_percent: dto.effectHpPercent ?? existing.effect_hp_percent,
      effect_mp_percent: dto.effectMpPercent ?? existing.effect_mp_percent,
      updated_at: Date.now(),
    };
    this.drugs.update(next);
    return DrugDto.from(this.requireDrug(id));
  }

  // —— 内部 ——

  private requireTitle(level: number): TitleRow {    const row = this.titles.findByLevel(level);
    if (!row) throw BizException.notFound(BizCode.TITLE_NOT_FOUND, `称号等级 ${level} 不存在`);
    return row;
  }

  /** 渠道切换时的成长列表序号走向：渠道不变原样保留；切到 upgrade 追加到尾；切走清空 */
  private nextUpgradeOrder(existing: TitleRow, nextChannel: string): number | null {
    if (nextChannel === existing.acquire_channel) return existing.upgrade_order;
    if (nextChannel === AcquireChannel.UPGRADE) return this.titles.maxUpgradeOrder() + 1;
    return null;
  }

  private requireSoul(level: number): SoulRow {
    const row = this.souls.findByLevel(level);
    if (!row) throw BizException.notFound(BizCode.SOUL_NOT_FOUND, `战魂阶数 ${level} 不存在`);
    return row;
  }

  private requireRank(level: number): RankRow {
    const row = this.ranks.findByLevel(level);
    if (!row) throw BizException.notFound(BizCode.RANK_NOT_FOUND, `军衔阶数 ${level} 不存在`);
    return row;
  }

  private requireEquipment(id: string): EquipmentRow {
    const row = this.equipments.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.EQUIPMENT_NOT_FOUND, `装备基础件 ${id} 不存在`);
    return row;
  }

  private requireDrug(id: string): DrugRow {
    const row = this.drugs.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.DRUG_NOT_FOUND, `药品 ${id} 不存在`);
    return row;
  }

  /** 药品 seed：DRUGS 直接灌（effects 已按键求和），8 种 */
  private seedDrugs() {
    for (const [id, meta] of Object.entries(DRUGS as Record<string, Record<string, unknown>>)) {
      this.drugs.seedRow({
        id,
        label: String(meta.label ?? ""),
        description: String(meta.description ?? ""),
        level: Number(meta.level) || 0,
        sell_price: Number(meta.sellPrice) || 0,
        max_stack: Number(meta.maxStack) || 99,
        cooldown: Number(meta.cooldown) || 0,
        effect_hp: Number(meta.hp) || 0,
        effect_mp: Number(meta.mp) || 0,
        effect_hp_percent: Number(meta.hpPercent) || 0,
        effect_mp_percent: Number(meta.mpPercent) || 0,
        updated_at: 0,
      });
    }
  }

  /** 装备基础件 seed：EQUIPMENT_BASES（slot/level/sellPrice/label/属性）直接灌，37 件基础件 */
  private seedEquipments() {
    for (const [id, meta] of Object.entries(EQUIPMENT_BASES as Record<string, Record<string, unknown>>)) {
      this.equipments.seedRow({
        id,
        slot: String(meta.slot ?? ""),
        level: Number(meta.level) || 0,
        sell_price: Number(meta.sellPrice) || 0,
        label: String(meta.label ?? ""),
        ...flatAttributes(meta.attributes as Record<string, unknown>),
        updated_at: 0,
      });
    }
  }

  /** 军衔 seed：RANK_LABELS（段名/衔名）/ RANK_LEVEL_META（文案/价格）/ RANK_LEVEL_ATTRIBUTES（属性）三表按阶 zip */
  private seedRanks() {
    const attributeTable = RANK_LEVEL_ATTRIBUTES as Record<string, Record<string, unknown>>;
    const labelTable = RANK_LABELS as Record<string, { tier: string; label: string }>;
    for (const [index, meta] of Object.entries(RANK_LEVEL_META)) {
      const rank = labelTable[index] ?? { tier: "", label: "" };
      this.ranks.seedRow({
        level: Number(index) + 1,
        label: rank.label,
        tier: rank.tier,
        description: meta.description,
        bind_gold: meta.bindGold,
        ...flatAttributes(attributeTable[index]),
        updated_at: 0,
      });
    }
  }

  /**
   * 称号 seed：TITLE_LABELS（名）/ TITLE_LEVEL_META（文案/价格/动画）/ TITLE_LEVEL_ATTRIBUTES（属性）
   * 三张表按等级键 zip；渠道默认「无法获取」，由运营逐个开放（赠送逻辑暂未实现）
   */
  private seedTitles() {
    // 属性表是字面量键（"0".."33"）的 Record，用通用形状取值避免逐键字面量索引
    const attributeTable = TITLE_LEVEL_ATTRIBUTES as Record<string, Record<string, unknown>>;
    for (const [index, meta] of Object.entries(TITLE_LEVEL_META)) {
      const attributes = attributeTable[index];
      this.titles.seedRow({
        level: Number(index) + 1,
        label: TITLE_LABELS[index] ?? "",
        description: meta.description,
        animation: meta.animation,
        animation_frame_rate: meta.animationFrameRate,
        bind_gold: meta.bindGold,
        acquire_channel: AcquireChannel.UNAVAILABLE,
        upgrade_order: null,
        ...flatAttributes(attributes),
        updated_at: 0,
      });
    }
  }

  /** 战魂 seed：与称号同构（少渠道列） */
  private seedSouls() {
    const attributeTable = SOUL_LEVEL_ATTRIBUTES as Record<string, Record<string, unknown>>;
    for (const [index, meta] of Object.entries(SOUL_LEVEL_META)) {
      const attributes = attributeTable[index];
      this.souls.seedRow({
        level: Number(index) + 1,
        label: SOUL_LABELS[index] ?? "",
        description: meta.description,
        animation: meta.animation,
        animation_frame_rate: meta.animationFrameRate,
        bind_gold: meta.bindGold,
        upgrade_order: Number(index) + 1,
        ...flatAttributes(attributes),
        updated_at: 0,
      });
    }
  }
}

/** 生成物的属性形状（{maxHp, physicalAttack:[min,max], ...}）→ 拍平的行属性列 */
function flatAttributes(attributes: Record<string, unknown>): Pick<TitleRow, AttrColumnNames> {
  const range = (key: string): [number, number] => {
    const value = attributes[key];
    return Array.isArray(value) ? [Number(value[0]) || 0, Number(value[1]) || 0] : [0, 0];
  };
  return {
    max_hp: Number(attributes.maxHp) || 0,
    hp_recover: Number(attributes.hpRecover) || 0,
    physical_attack_min: range("physicalAttack")[0],
    physical_attack_max: range("physicalAttack")[1],
    magic_attack_min: range("magicAttack")[0],
    magic_attack_max: range("magicAttack")[1],
    taoist_attack_min: range("taoistAttack")[0],
    taoist_attack_max: range("taoistAttack")[1],
    physical_defense_min: range("physicalDefense")[0],
    physical_defense_max: range("physicalDefense")[1],
    magic_defense_min: range("magicDefense")[0],
    magic_defense_max: range("magicDefense")[1],
    taoist_defense_min: range("taoistDefense")[0],
    taoist_defense_max: range("taoistDefense")[1],
  };
}

/** 行属性列名（flatAttributes / attributeColumns 共用的键集合） */
type AttrColumnNames =
  | "max_hp"
  | "hp_recover"
  | "physical_attack_min"
  | "physical_attack_max"
  | "magic_attack_min"
  | "magic_attack_max"
  | "taoist_attack_min"
  | "taoist_attack_max"
  | "physical_defense_min"
  | "physical_defense_max"
  | "magic_defense_min"
  | "magic_defense_max"
  | "taoist_defense_min"
  | "taoist_defense_max";

/** 嵌套属性对象 → 拍平行属性列（update 合并后写库用） */
function attributeColumns(attributes: ConfigAttributesDto): Pick<TitleRow, AttrColumnNames> {
  const pair = (key: (typeof RANGE_KEYS)[number]): [number, number] => {
    const value = attributes[key];
    return [value.min, value.max];
  };
  return {
    max_hp: attributes.maxHp,
    hp_recover: attributes.hpRecover,
    physical_attack_min: pair("physicalAttack")[0],
    physical_attack_max: pair("physicalAttack")[1],
    magic_attack_min: pair("magicAttack")[0],
    magic_attack_max: pair("magicAttack")[1],
    taoist_attack_min: pair("taoistAttack")[0],
    taoist_attack_max: pair("taoistAttack")[1],
    physical_defense_min: pair("physicalDefense")[0],
    physical_defense_max: pair("physicalDefense")[1],
    magic_defense_min: pair("magicDefense")[0],
    magic_defense_max: pair("magicDefense")[1],
    taoist_defense_min: pair("taoistDefense")[0],
    taoist_defense_max: pair("taoistDefense")[1],
  };
}

/**
 * 区间属性的组合校验（0 ≤ min ≤ max）
 *
 * 单字段的「非负 / 整数」交给 DTO；「min ≤ max」是跨字段约束，只有 service
 * 拿到合并后的完整对象才能判（只传 attributes 一半是判不了的——它本来就是整份替换）。
 */
function assertAttributeRanges(attributes: ConfigAttributesDto): void {
  for (const key of RANGE_KEYS) {
    const { min, max } = attributes[key];
    if (min > max) {
      throw new BizException(BizCode.PARAM_INVALID, "属性下限不能大于上限");
    }
  }
}

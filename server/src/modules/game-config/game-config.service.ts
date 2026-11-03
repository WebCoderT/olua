import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { AcquireChannel } from "../../common/constants/game-config";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { RankRepository, RankListOptions } from "../../database/repositories/rank.repository";
import { DrugRepository, DrugListOptions } from "../../database/repositories/drug.repository";
import { EquipmentRepository, EquipmentListOptions } from "../../database/repositories/equipment.repository";
import {
  EquipmentVariantListOptions,
  EquipmentVariantRepository,
} from "../../database/repositories/equipment-variant.repository";
import { FashionRepository, FashionListOptions } from "../../database/repositories/fashion.repository";
import { ItemRepository, ItemListOptions } from "../../database/repositories/item.repository";
import { MonsterRepository, MonsterListOptions } from "../../database/repositories/monster.repository";
import { MonsterDropRepository } from "../../database/repositories/monster-drop.repository";
import { SkillRepository, SkillListOptions } from "../../database/repositories/skill.repository";
import { MonsterSkillRepository } from "../../database/repositories/monster-skill.repository";
import { StatusRepository, StatusListOptions } from "../../database/repositories/status.repository";
import { NpcRepository, NpcListOptions } from "../../database/repositories/npc.repository";
import { QuestRepository, QuestListOptions } from "../../database/repositories/quest.repository";
import {
  AchievementRepository,
  AchievementListOptions,
} from "../../database/repositories/achievement.repository";
import { RoleAchievementRepository } from "../../database/repositories/role-achievement.repository";
import { QuestProgressRepository } from "../../database/repositories/quest-progress.repository";
import { SoulRepository, SoulListOptions } from "../../database/repositories/soul.repository";
import { TitleRepository, TitleListOptions } from "../../database/repositories/title.repository";
import { itemExists } from "../../common/runtime-config-cache";
import { RuntimeConfigService } from "./runtime-config.service";
import {
  DrugRow,
  EquipmentRow,
  EquipmentVariantRow,
  FashionRow,
  ItemRow,
  MonsterRow,
  MonsterSkillRow,
  NpcRow,
  QuestRow,
  AchievementRow,
  RankRow,
  SkillRow,
  SoulRow,
  StatusRow,
  TitleRow,
} from "../../database/rows";
import {
  EquipmentDto,
  EquipmentMetaDto,
  EquipmentQueryDto,
  EquipmentSlotDto,
  EquipmentVariantDto,
  EquipmentVariantQueryDto,
  UpdateEquipmentDto,
  UpdateEquipmentMetaDto,
  UpdateEquipmentSlotDto,
  UpdateEquipmentVariantDto,
} from "./dto/equipment.dto";

import { DrugDto, DrugQueryDto, UpdateDrugDto } from "./dto/drug.dto";
import { FashionDto, FashionQueryDto, UpdateFashionDto } from "./dto/fashion.dto";
import { ItemDto, ItemQueryDto, UpdateItemDto } from "./dto/item.dto";
import { AdminMonsterDto, MonsterAttributesDto, MonsterDto, MonsterQueryDto, UpdateMonsterDto, monsterAttributesFromRow } from "./dto/monster.dto";
import { NpcDto, NpcQueryDto, UpdateNpcDto } from "./dto/npc.dto";
import { CreateQuestDto, parseRewardItems, QuestDto, QuestQueryDto, UpdateQuestDto } from "./dto/quest.dto";
import {
  AchievementDto,
  AchievementQueryDto,
  CreateAchievementDto,
  UpdateAchievementDto,
} from "./dto/achievement.dto";
import { CreateSkillDto, parseDamageCoefficients, SkillDto, SkillQueryDto, UpdateSkillDto } from "./dto/skill.dto";
import { MonsterSkillDto, MonsterSkillListDto, ReplaceMonsterSkillsDto } from "./dto/monster-skill.dto";
import { serializeCombat, StatusDto, StatusQueryDto, UpdateStatusDto } from "./dto/status.dto";
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
export class GameConfigService {
  private readonly logger = new Logger(GameConfigService.name);

  constructor(
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly equipments: EquipmentRepository,
    private readonly equipmentVariants: EquipmentVariantRepository,
    private readonly drugs: DrugRepository,
    private readonly items: ItemRepository,
    private readonly monstersRepo: MonsterRepository,
    private readonly monsterDropsRepo: MonsterDropRepository,
    private readonly npcsRepo: NpcRepository,
    private readonly fashionsRepo: FashionRepository,
    private readonly skillsRepo: SkillRepository,
    private readonly statusesRepo: StatusRepository,
    private readonly monsterSkillsRepo: MonsterSkillRepository,
    private readonly questsRepo: QuestRepository,
    private readonly questProgressRepo: QuestProgressRepository,
    private readonly achievementsRepo: AchievementRepository,
    private readonly roleAchievementsRepo: RoleAchievementRepository,
    private readonly runtime: RuntimeConfigService,
  ) {}

  /**
   * 写完库立刻把运营库的当前值装进结算层（#544）
   *
   * 「管理端保存 → 服务端下一次结算就按新值」靠这一行成立。只在这六张表（称号 / 战魂 /
   * 军衔 / 装备 / 药品 / 技能）的写操作后调用 —— 它们进了 `shared/runtime-overrides`
   * 的覆盖层；其余表（怪物 / 掉落 / 商城 / 成长）本来就是**直读库**的，不需要刷新。
   *
   * 全量重装而不是增量：数据量是「37 件装备 + 34 级称号 + …」这个级别，几十毫秒，
   * 换来的是「永不漏刷」——漏一处就是「保存了但没生效」这种最费时的 bug。
   */
  private touchRuntime(): void {
    this.runtime.refreshAll();
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
    this.touchRuntime();
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
    this.touchRuntime();
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
    this.touchRuntime();
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
    this.touchRuntime();
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
    this.touchRuntime();
    return RankDto.from(this.requireRank(level));
  }

  // —— 装备变体（#655：555 行逐一配置，不再由基础件乘倍率现算）——

  /**
   * 快照用：全部 555 个变体的**完整装备清单**（显示字段取基础件、数值取变体行）
   *
   * 客户端 `applyEquipmentData` 直接吃这份清单建表，不再自己展开 —— 「管理端改
   * 某一个变体」从此在客户端可见（以前只改基础件才会被展开逻辑带过去）。
   *
   * 基础件不存在时**跳过**而不是抛错：孤儿变体只可能来自手改库/迁移残留，
   * 为它让整个配置快照 500（客户端直接进不去游戏）是不划算的。
   */
  listEquipmentVariants(): EquipmentVariantDto[] {
    const bases = new Map(this.equipments.list({ page: 1, size: 1_000_000 }).map((row) => [row.id, row]));
    const list: EquipmentVariantDto[] = [];
    for (const row of this.equipmentVariants.listAll()) {
      const base = bases.get(row.base_id);
      if (!base) {
        this.logger.warn(`装备变体 ${row.id} 的基础件 ${row.base_id} 不存在，快照里已跳过`);
        continue;
      }
      list.push(EquipmentVariantDto.fromVariant(base, row));
    }
    return list;
  }

  /** 管理端：分页列变体（可按基础件筛，装备页里点开一件基础件看它的 15 个变体） */
  listVariantPage(query: EquipmentVariantQueryDto): PageResult<EquipmentVariantDto> {
    const options: EquipmentVariantListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      baseId: query.baseId,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const bases = new Map(this.equipments.list({ page: 1, size: 1_000_000 }).map((row) => [row.id, row]));
    const list: EquipmentVariantDto[] = [];
    for (const row of this.equipmentVariants.list(options)) {
      const base = bases.get(row.base_id);
      if (base) list.push(EquipmentVariantDto.fromVariant(base, row));
    }
    return { list, total: this.equipmentVariants.count(options), page: options.page, size: options.size };
  }

  /** 管理端：改一个变体（属性整份提交；名称 / 等级 / 回收价部分更新） */
  updateEquipmentVariant(id: string, dto: UpdateEquipmentVariantDto): EquipmentVariantDto {
    const existing = this.equipmentVariants.findById(id);
    if (!existing) throw BizException.notFound(BizCode.EQUIPMENT_NOT_FOUND, `装备变体 ${id} 不存在`);
    if (dto.attributes) assertAttributeRanges(dto.attributes);
    const next: EquipmentVariantRow = {
      ...existing,
      label: dto.label ?? existing.label,
      level: dto.level ?? existing.level,
      sell_price: dto.sellPrice ?? existing.sell_price,
      ...(dto.attributes ? attributeColumns(dto.attributes) : {}),
      updated_at: Date.now(),
    };
    this.equipmentVariants.update(next);
    this.touchRuntime();
    const base = this.equipments.list({ page: 1, size: 1_000_000 }).find((row) => row.id === next.base_id);
    if (!base) throw BizException.notFound(BizCode.EQUIPMENT_NOT_FOUND, `装备变体 ${id} 的基础件不存在`);
    return EquipmentVariantDto.fromVariant(base, this.equipmentVariants.findById(id)!);
  }

  // —— 装备基础件（#252：id / 部位结构固定，只改数值；变体见上面的 #655 区）——

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
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      occupation: dto.occupation ?? existing.occupation,
      sex: dto.sex ?? existing.sex,
      icon: dto.icon ?? existing.icon,
      in_atlas: dto.inAtlas ?? existing.in_atlas,
      out_atlas: dto.outAtlas ?? existing.out_atlas,
      tags: dto.tags ? JSON.stringify(dto.tags) : existing.tags,
      out_scale: dto.outScale ?? existing.out_scale,
      in_scale_x: dto.inScaleX ?? existing.in_scale_x,
      in_scale_y: dto.inScaleY ?? existing.in_scale_y,
      in_rotate: dto.inRotate ?? existing.in_rotate,
      in_pos_x: dto.inPosX ?? existing.in_pos_x,
      in_pos_y: dto.inPosY ?? existing.in_pos_y,
      // 8 向位置整份替换：只留 x / y 两个字段，防止把前端多余字段写进 JSON 列
      out_positions: dto.outPositions
        ? JSON.stringify(dto.outPositions.map((point) => ({ x: point.x, y: point.y })))
        : existing.out_positions,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.equipments.update(next);
    this.touchRuntime();
    return EquipmentDto.from(this.requireEquipment(id));
  }

  // —— 装备槽位与规则（#603 第九域：客户端不再存槽位表 / 倍率 / 回收价曲线）——

  /** 槽位表（13 行，顺序即角色弹窗排列与背包整理序） */
  listEquipmentSlots(): EquipmentSlotDto[] {
    return this.equipments.listSlots().map(EquipmentSlotDto.from);
  }

  updateEquipmentSlot(key: string, dto: UpdateEquipmentSlotDto): EquipmentSlotDto {
    const existing = this.equipments.findSlot(key);
    if (!existing) throw BizException.notFound(BizCode.NOT_FOUND, `装备槽位不存在：${key}`);
    this.equipments.updateSlot({
      ...existing,
      label: dto.label ?? existing.label,
      image_src: dto.imageSrc ?? existing.image_src,
      position: dto.position ?? existing.position,
      // 排序同时是背包「一键整理」的部位序（客户端 equipmentSlotOrder 直接读它）
      sort_order: dto.order ?? existing.sort_order,
      updated_at: Date.now(),
    });
    const updated = this.equipments.findSlot(key);
    if (!updated) throw BizException.notFound(BizCode.NOT_FOUND, `装备槽位不存在：${key}`);
    // 槽位不影响结算（只影响界面），但仍重装一次：槽位名会随快照下发，管理端要能立刻看到自己改的值
    this.touchRuntime();
    return EquipmentSlotDto.from(updated);
  }

  /**
   * 装备规则（单行：前后缀倍率 / 文案 / 回收价曲线）
   *
   * #655 起这些倍率与曲线**不再参与任何现算**（555 个变体各自一行、自带属性与价签），
   * 它们只剩两个用途：客户端拼「强化的·天级」这类名称时读文案，以及作为「这一档默认长什么样」
   * 的参考。行由 `config-sync.sql` 建库时灌入，缺行直接报错 —— 造一份假数据返回只会让
   * 客户端拼出空档名。
   */
  getEquipmentMeta(): EquipmentMetaDto {
    const row = this.equipments.getMeta();
    if (!row) throw new BizException(BizCode.INTERNAL, "装备规则行缺失（equipment_meta 被清了？跑 make config-import）");
    return EquipmentMetaDto.from(row);
  }

  /**
   * 改装备规则（部分更新；整份替换语义）
   *
   * 跨字段校验只在这里做：**倍率与文案必须等长**（差一位就是「某一档没有名字」，
   * 客户端名称会拼出 `undefined·人级`）。回收价不在这里（#655：逐条在 `equipment_variants`）。
   */
  updateEquipmentMeta(dto: UpdateEquipmentMetaDto): EquipmentMetaDto {
    const current = this.getEquipmentMeta();
    const prefixRates = dto.prefixRates ?? current.prefixRates;
    const suffixRates = dto.suffixRates ?? current.suffixRates;
    const prefixLabels = dto.prefixLabels ?? current.prefixLabels;
    const suffixLabels = dto.suffixLabels ?? current.suffixLabels;
    if (prefixRates.length !== prefixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `前缀倍率（${prefixRates.length} 项）与文案（${prefixLabels.length} 项）长度必须一致`);
    }
    if (suffixRates.length !== suffixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `后缀倍率（${suffixRates.length} 项）与文案（${suffixLabels.length} 项）长度必须一致`);
    }
    this.equipments.updateMeta({
      id: 1,
      prefix_rates: JSON.stringify(prefixRates),
      suffix_rates: JSON.stringify(suffixRates),
      prefix_labels: JSON.stringify(prefixLabels),
      suffix_labels: JSON.stringify(suffixLabels),
      updated_at: Date.now(),
    });
    this.touchRuntime();
    return this.getEquipmentMeta();
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
      icon: dto.icon ?? existing.icon,
      level: dto.level ?? existing.level,
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
    this.touchRuntime();
    return DrugDto.from(this.requireDrug(id));
  }

  // —— 物品与材料（#255：id 清单固定只改数值；只收 MATERIAL / OTHER 大类）——

  listItems(query: ItemQueryDto): PageResult<ItemDto> {
    const options: ItemListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      type: query.type,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.items.list(options);
    const total = this.items.count(options);
    return { list: rows.map(ItemDto.from), total, page: options.page, size: options.size };
  }

  updateItem(id: string, dto: UpdateItemDto): ItemDto {
    const existing = this.requireItem(id);
    const next: ItemRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      icon: dto.icon ?? existing.icon,
      sell_price: dto.sellPrice ?? existing.sell_price,
      max_stack: dto.maxStack ?? existing.max_stack,
      updated_at: Date.now(),
    };
    this.items.update(next);
    this.touchRuntime();
    return ItemDto.from(this.requireItem(id));
  }

  // —— 怪物基础数据（#258：key 清单固定只改数值与名称；世界播种 / 伤害结算直读本表）——

  listMonsters(query: MonsterQueryDto): PageResult<MonsterDto> {
    const options: MonsterListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      tier: query.tier,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.monstersRepo.list(options);
    const total = this.monstersRepo.count(options);
    return { list: rows.map(MonsterDto.from), total, page: options.page, size: options.size };
  }

  /**
   * 管理端怪物列表（= 基础数据 + 掉落摘要）
   *
   * 摘要只补这一页的 20 只：`listByKeys` 一次 IN 查完再按 key 对齐，
   * 不要逐只 `findByKey`（一页 20 次单查）。玩家侧快照走 `listMonsters`，不带摘要。
   */
  listAdminMonsters(query: MonsterQueryDto): PageResult<AdminMonsterDto> {
    const page = this.listMonsters(query);
    const drops = new Map(
      this.monsterDropsRepo.listByKeys(page.list.map((item) => item.id)).map((row) => [row.monster_key, row]),
    );
    return { ...page, list: page.list.map((item) => AdminMonsterDto.withDrop(item, drops.get(item.id))) };
  }

  /**
   * 改怪物 → 回管理端视图（PATCH 的响应要与管理端列表同形，
   * 否则「刚改完那行」和「刷新后那行」长得不一样）
   */
  updateMonsterAdmin(id: string, dto: UpdateMonsterDto): AdminMonsterDto {
    const saved = this.updateMonster(id, dto);
    return AdminMonsterDto.withDrop(saved, this.monsterDropsRepo.findByKey(id));
  }

  updateMonster(id: string, dto: UpdateMonsterDto): MonsterDto {
    const existing = this.requireMonster(id);
    const attributes = dto.attributes ?? monsterAttributesFromRow(existing);
    assertMonsterAttributeRanges(attributes);

    const next: MonsterRow = {
      ...existing,
      label: dto.label ?? existing.label,
      level: dto.level ?? existing.level,
      max_hp: dto.maxHp ?? existing.max_hp,
      ...monsterAttributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.monstersRepo.update(next);
    return MonsterDto.from(this.requireMonster(id));
  }

  // —— NPC 基础数据（#258：id 清单固定只改名称与对话；外观资源是表现层不进服务端）——

  listNpcs(query: NpcQueryDto): PageResult<NpcDto> {
    const options: NpcListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.npcsRepo.list(options);
    const total = this.npcsRepo.count(options);
    return { list: rows.map(NpcDto.from), total, page: options.page, size: options.size };
  }

  updateNpc(id: string, dto: UpdateNpcDto): NpcDto {
    const existing = this.requireNpc(id);
    const next: NpcRow = {
      ...existing,
      label: dto.label ?? existing.label,
      dialog: dto.dialog ?? existing.dialog,
      // #603 第七域：外观也归管理端（客户端不再存一份），改完下次进游戏由快照重建
      src: dto.src ?? existing.src,
      scale_x: dto.scaleX ?? existing.scale_x,
      scale_y: dto.scaleY ?? existing.scale_y,
      pos_x: dto.posX ?? existing.pos_x,
      pos_y: dto.posY ?? existing.pos_y,
      updated_at: Date.now(),
    };
    this.npcsRepo.update(next);
    return NpcDto.from(this.requireNpc(id));
  }

  // —— 时装配置（#257：id 清单固定只改文案 / 价格 / 渠道 / 属性；资源路径是表现层不改）——

  listFashions(query: FashionQueryDto): PageResult<FashionDto> {
    const options: FashionListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      channel: query.acquireChannel,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.fashionsRepo.list(options);
    const total = this.fashionsRepo.count(options);
    return { list: rows.map(FashionDto.from), total, page: options.page, size: options.size };
  }

  updateFashion(id: string, dto: UpdateFashionDto): FashionDto {
    const existing = this.requireFashion(id);
    const attributes = dto.attributes ?? attributesFromRow(existing);
    assertAttributeRanges(attributes);
    const next: FashionRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      sell_price: dto.sellPrice ?? existing.sell_price,
      acquire_channel: dto.acquireChannel ?? existing.acquire_channel,
      // #641：资源路径也开放（管理端图片选择器选出来的就是这三个值）
      icon: dto.icon ?? existing.icon,
      in_res: dto.inRes ?? existing.in_res,
      out_res: dto.outRes ?? existing.out_res,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.fashionsRepo.update(next);
    return FashionDto.from(this.requireFashion(id));
  }

  // —— 技能（#367：角色与怪物同表，owner 区分；只有 list / update）——

  listSkills(query: SkillQueryDto): PageResult<SkillDto> {
    const options: SkillListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      owner: query.owner,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.skillsRepo.list(options);
    const total = this.skillsRepo.count(options);
    return { list: rows.map(SkillDto.from), total, page: options.page, size: options.size };
  }

  updateSkill(id: string, dto: UpdateSkillDto): SkillDto {
    const existing = this.requireSkill(id);
    const next: SkillRow = { ...existing };
    if (dto.label !== undefined) next.label = dto.label;
    if (dto.icon !== undefined) next.icon = dto.icon;
    if (dto.category !== undefined) next.category = dto.category;
    if (dto.targetType !== undefined) next.target_type = dto.targetType;
    if (dto.action !== undefined) next.action = dto.action;
    if (dto.effect !== undefined) next.effect = dto.effect;
    if (dto.effectOnSelf !== undefined) next.effect_on_self = dto.effectOnSelf ? 1 : 0;
    if (dto.cooldown !== undefined) next.cooldown = dto.cooldown;
    if (dto.mpCost !== undefined) next.mp_cost = dto.mpCost;
    if (dto.distance !== undefined) next.distance = dto.distance;
    if (dto.levelReq !== undefined) next.level_req = dto.levelReq;
    if (dto.description !== undefined) next.description = dto.description;
    if (dto.damageCoefficients !== undefined) {
      next.damage_coefficients = JSON.stringify(
        dto.damageCoefficients.map((entry) => ({ baseType: entry.baseType, baseTypeRate: entry.baseTypeRate })),
      );
    }
    if (dto.statusId !== undefined) next.status_id = dto.statusId;
    if (dto.castLockMs !== undefined) next.cast_lock_ms = dto.castLockMs;
    if (dto.requireTarget !== undefined) next.require_target = dto.requireTarget ? 1 : 0;
    if (dto.canAuto !== undefined) next.can_auto = dto.canAuto ? 1 : 0;
    // #603 第十一域：职业归属与击退距离也可改（前者决定技能栏归谁，后者只对单体技能生效）
    if (dto.occupation !== undefined) next.occupation = dto.occupation;
    if (dto.pushDistance !== undefined) next.push_distance = dto.pushDistance;
    // 跨字段约束放在写库之前：状态必须真实存在、主动技能得能打出伤害、状态型技能得挂到状态。
    // 只在本次请求**动了分类 / 倍率 / 状态**时才校验 —— 这三个字段之外的部分（名字、冷却、
    // 动作锁……）与约束无关；而且库里存在「分类是主动但没配倍率」的历史行（如 1008 十步一杀，
    // 客户端把它当控制技），按合并后的行无条件校验会让这些行连改名都改不了。
    const touchesConsistency = dto.category !== undefined || dto.damageCoefficients !== undefined || dto.statusId !== undefined;
    if (touchesConsistency) this.assertSkillConsistency(next);
    next.updated_at = Date.now();
    this.skillsRepo.update(next);
    this.touchRuntime();
    return SkillDto.from(this.requireSkill(id));
  }

  /**
   * 新增怪物技能（#372）
   *
   * **只开给怪物技能**：owner 只能是 monster，id 在 DTO 层就限死在 9000 段。角色技能的 id
   * 被技能栏 / 快捷键 / 角色存档引用，清单固定在生成物里 —— 在这里放行任何一个 1xxx id，
   * 都等于造出一行「客户端永远学不会」的技能。
   *
   * 校验比 update 更严：新行没有历史包袱，直接按合并后的整行全量校验（不像 update 只看
   * 请求有没有动「分类 / 倍率 / 挂载状态」）。
   */
  createSkill(dto: CreateSkillDto): SkillDto {
    const owner = dto.owner ?? "monster";
    if (owner !== "monster") {
      throw new BizException(BizCode.PARAM_INVALID, "只支持创建怪物技能（角色技能清单固定，被技能栏 / 存档引用）");
    }
    if (this.skillsRepo.findByKey(dto.id)) {
      throw new BizException(BizCode.PARAM_INVALID, `技能 ${dto.id} 已存在`);
    }
    const coefficients = dto.damageCoefficients ?? [];
    const row: SkillRow = {
      id: dto.id,
      owner,
      label: dto.label ?? `怪物技能 ${dto.id}`,
      icon: dto.icon ?? "",
      category: dto.category ?? "0",
      target_type: dto.targetType ?? "1",
      action: dto.action ?? "",
      effect: dto.effect ?? "",
      effect_on_self: dto.effectOnSelf === true ? 1 : 0,
      cooldown: dto.cooldown ?? 0,
      mp_cost: dto.mpCost ?? 0,
      distance: dto.distance ?? 0,
      level_req: dto.levelReq ?? 1,
      description: dto.description ?? "",
      damage_coefficients: JSON.stringify(
        coefficients.map((entry) => ({ baseType: entry.baseType, baseTypeRate: entry.baseTypeRate })),
      ),
      status_id: dto.statusId ?? "",
      cast_lock_ms: dto.castLockMs ?? 0,
      require_target: dto.requireTarget === false ? 0 : 1,
      can_auto: dto.canAuto === true ? 1 : 0,
      // 怪物技能没有「归哪个职业」的语义（服务端 AI 释放），一律全职业；击退默认不配
      occupation: dto.occupation ?? "4",
      push_distance: dto.pushDistance ?? 0,
      updated_at: Date.now(),
    };
    this.assertSkillConsistency(row);
    this.skillsRepo.insert(row);
    this.touchRuntime();
    return SkillDto.from(this.requireSkill(dto.id));
  }

  /**
   * 删除怪物技能（#372）
   *
   * 两条拒绝，都是真实会出事的组合：
   * - **角色技能不可删**：技能栏 / 快捷键 / 角色存档按 id 引用，删了就是坏档；
   * - **被怪物挂载引用中的技能不可删**：与掉落表「被引用中拒删」同一纪律 ——
   *   先解绑再删，否则 AI 会拿着一个查不到的技能 id 空跑（还看不出来为什么）。
   */
  deleteSkill(id: string): { deleted: boolean } {
    const row = this.requireSkill(id);
    if (row.owner !== "monster") {
      throw new BizException(BizCode.PARAM_INVALID, `技能 ${id} 属于角色，不支持删除`);
    }
    const refs = this.monsterSkillsRepo.countBySkill(id);
    if (refs > 0) {
      throw new BizException(BizCode.PARAM_INVALID, `技能 ${id} 仍被 ${refs} 只怪挂载，先解绑再删`);
    }
    this.skillsRepo.remove(id);
    this.touchRuntime();
    return { deleted: true };
  }

  // —— 怪物技能挂载（#372：整份替换，与每怪掉落表同形态）——

  listMonsterSkills(monsterKey: string): MonsterSkillListDto {
    this.requireMonster(monsterKey);
    const list = this.monsterSkillsRepo
      .listByMonster(monsterKey)
      .map((row) => MonsterSkillDto.from(row, this.skillsRepo.findByKey(row.skill_id)?.label ?? ""));
    return { list, total: list.length };
  }

  /**
   * 整份替换一只怪的挂载清单（空数组 = 不再放技能，AI 回退到普攻）
   *
   * 逐条校验：技能必须存在、必须 owner=monster、同一只怪不能重复挂同一个技能。
   * 这些都是运营在界面上点得出来的组合，进库前挡掉比让 AI 空跑便宜得多。
   */
  replaceMonsterSkills(monsterKey: string, dto: ReplaceMonsterSkillsDto): MonsterSkillListDto {
    this.requireMonster(monsterKey);
    const seen = new Set<string>();
    const now = Date.now();
    const rows: MonsterSkillRow[] = dto.skills.map((item) => {
      if (seen.has(item.skillId)) throw new BizException(BizCode.PARAM_INVALID, `技能 ${item.skillId} 重复挂载`);
      seen.add(item.skillId);
      const skill = this.requireSkill(item.skillId);
      if (skill.owner !== "monster") {
        throw new BizException(BizCode.PARAM_INVALID, `技能 ${item.skillId} 属于角色，不能挂给怪物`);
      }
      return {
        monster_key: monsterKey,
        skill_id: item.skillId,
        priority: item.priority ?? 0,
        cooldown: item.cooldown === undefined ? null : item.cooldown,
        updated_at: now,
      };
    });
    this.monsterSkillsRepo.replaceForMonster(monsterKey, rows);
    return this.listMonsterSkills(monsterKey);
  }

  // —— 状态（#367）——

  listStatuses(query: StatusQueryDto): PageResult<StatusDto> {
    const options: StatusListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      owner: query.owner,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.statusesRepo.list(options);
    const total = this.statusesRepo.count(options);
    return { list: rows.map(StatusDto.from), total, page: options.page, size: options.size };
  }

  updateStatus(id: string, dto: UpdateStatusDto): StatusDto {
    const existing = this.requireStatus(id);
    const next: StatusRow = { ...existing };
    if (dto.label !== undefined) next.label = dto.label;
    if (dto.icon !== undefined) next.icon = dto.icon;
    if (dto.duration !== undefined) next.duration = dto.duration;
    if (dto.source !== undefined) next.source = dto.source;
    if (dto.description !== undefined) next.description = dto.description;
    if (dto.effect !== undefined) next.effect = dto.effect;
    if (dto.effectHoldLast !== undefined) next.effect_hold_last = dto.effectHoldLast ? 1 : 0;
    if (dto.combat !== undefined) next.combat = serializeCombat(dto.combat);
    next.updated_at = Date.now();
    this.statusesRepo.update(next);
    return StatusDto.from(this.requireStatus(id));
  }

  // —— 任务配置（#396：允许动态增删；被进度 / 链前置引用中的行拒删）——

  listQuests(query: QuestQueryDto): PageResult<QuestDto> {
    const options: QuestListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      kind: query.kind,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.questsRepo.list(options);
    const total = this.questsRepo.count(options);
    return { list: rows.map(QuestDto.from), total, page: options.page, size: options.size };
  }

  updateQuest(id: string, dto: UpdateQuestDto): QuestDto {
    const existing = this.requireQuest(id);
    // objective / rewards 逐字段合并（items 传了就整份替换）——比「传了就整份替换」宽松一档：
    // 管理端只改金币时不至于把物品清单静默清空
    const objective = dto.objective ?? {};
    const rewards = dto.rewards ?? {};
    const next: QuestRow = {
      ...existing,
      kind: dto.kind ?? existing.kind,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      prev_quest_id: dto.prevQuestId ?? existing.prev_quest_id,
      min_level: dto.minLevel ?? existing.min_level,
      npc_id: dto.npcId ?? existing.npc_id,
      objective_type: objective.type ?? existing.objective_type,
      objective_target: objective.target ?? existing.objective_target,
      objective_count: objective.count ?? existing.objective_count,
      reward_gold: rewards.gold ?? existing.reward_gold,
      reward_exp: rewards.exp ?? existing.reward_exp,
      reward_items: JSON.stringify(
        (rewards.items ?? parseRewardItems(existing.reward_items)).map((item) => ({ goodId: item.goodId, count: item.count })),
      ),
      updated_at: Date.now(),
    };
    this.assertQuestConsistency(next);
    this.questsRepo.update(next);
    return QuestDto.from(this.requireQuest(id));
  }

  /** 新建任务（id 唯一；跨字段校验与 update 同一套） */
  createQuest(dto: CreateQuestDto): QuestDto {
    if (this.questsRepo.findByKey(dto.id)) {
      throw new BizException(BizCode.PARAM_INVALID, `任务 ${dto.id} 已存在`);
    }
    const row: QuestRow = {
      id: dto.id,
      kind: dto.kind ?? "main",
      label: dto.label ?? `任务 ${dto.id}`,
      description: dto.description ?? "",
      prev_quest_id: dto.prevQuestId ?? "",
      min_level: dto.minLevel ?? 1,
      npc_id: dto.npcId ?? "",
      objective_type: dto.objective?.type ?? "kill",
      objective_target: dto.objective?.target ?? "",
      objective_count: dto.objective?.count ?? 1,
      reward_gold: dto.rewards?.gold ?? 0,
      reward_exp: dto.rewards?.exp ?? 0,
      reward_items: JSON.stringify(
        (dto.rewards?.items ?? []).map((item) => ({ goodId: item.goodId, count: item.count })),
      ),
      updated_at: Date.now(),
    };
    this.assertQuestConsistency(row);
    this.questsRepo.insert(row);
    return QuestDto.from(this.requireQuest(dto.id));
  }

  /**
   * 删除任务 —— 两条拒绝，与掉落表「被引用中拒删」同一纪律：
   * - 有玩家进度（哪怕只是 accepted）→ 先清进度再删，否则那些角色永远卡在一个不存在的任务上；
   * - 被别的任务当主线链前置 → 先解开那条链再删，否则后继任务永远接不了。
   */
  deleteQuest(id: string): { deleted: boolean } {
    this.requireQuest(id);
    const progress = this.questProgressRepo.countByQuest(id);
    if (progress > 0) {
      throw new BizException(BizCode.PARAM_INVALID, `任务 ${id} 仍被 ${progress} 个角色的进度引用，先清理进度再删`);
    }
    const followers = this.questsRepo.listAll().filter((row) => row.prev_quest_id === id);
    if (followers.length > 0) {
      throw new BizException(BizCode.PARAM_INVALID, `任务 ${id} 是 ${followers.map((row) => row.id).join("、")} 的主线链前置，先解除引用再删`);
    }
    this.questsRepo.remove(id);
    return { deleted: true };
  }

  // —— 成就配置（#401：允许动态增删；被玩家成就记录引用中的行拒删）——

  listAchievements(query: AchievementQueryDto): PageResult<AchievementDto> {
    const options: AchievementListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      category: query.category,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.achievementsRepo.list(options);
    const total = this.achievementsRepo.count(options);
    return { list: rows.map((row) => AchievementDto.from(row)), total, page: options.page, size: options.size };
  }

  updateAchievement(id: string, dto: UpdateAchievementDto): AchievementDto {
    const existing = this.requireAchievement(id);
    const condition = dto.condition ?? {};
    const rewards = dto.rewards ?? {};
    const next: AchievementRow = {
      ...existing,
      category: dto.category ?? existing.category,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      condition_type: condition.type ?? existing.condition_type,
      condition_target: condition.target ?? existing.condition_target,
      condition_count: condition.count ?? existing.condition_count,
      reward_gold: rewards.gold ?? existing.reward_gold,
      reward_exp: rewards.exp ?? existing.reward_exp,
      reward_items: JSON.stringify(
        (rewards.items ?? parseRewardItems(existing.reward_items)).map((item) => ({
          goodId: item.goodId,
          count: item.count,
        })),
      ),
      sort_order: dto.sortOrder ?? existing.sort_order,
      hidden: dto.hidden === undefined ? existing.hidden : dto.hidden ? 1 : 0,
      updated_at: Date.now(),
    };
    this.assertAchievementConsistency(next);
    this.achievementsRepo.update(next);
    return AchievementDto.from(this.requireAchievement(id));
  }

  /** 新建成就（id 唯一；跨字段校验与编辑同一套） */
  createAchievement(dto: CreateAchievementDto): AchievementDto {
    if (this.achievementsRepo.findByKey(dto.id)) {
      throw new BizException(BizCode.PARAM_INVALID, `成就 ${dto.id} 已存在`);
    }
    const row: AchievementRow = {
      id: dto.id,
      category: dto.category ?? "battle",
      label: dto.label ?? `成就 ${dto.id}`,
      description: dto.description ?? "",
      condition_type: dto.condition?.type ?? "kill",
      condition_target: dto.condition?.target ?? "",
      condition_count: dto.condition?.count ?? 1,
      reward_gold: dto.rewards?.gold ?? 0,
      reward_exp: dto.rewards?.exp ?? 0,
      reward_items: JSON.stringify(
        (dto.rewards?.items ?? []).map((item) => ({ goodId: item.goodId, count: item.count })),
      ),
      sort_order: dto.sortOrder ?? 0,
      hidden: dto.hidden ? 1 : 0,
      updated_at: Date.now(),
    };
    this.assertAchievementConsistency(row);
    this.achievementsRepo.insert(row);
    return AchievementDto.from(this.requireAchievement(dto.id));
  }

  /**
   * 删除成就 —— 一条拒绝，与任务配置「被引用中拒删」同一纪律：
   * 有玩家记录（哪怕只是累计进度、没达成）就不能删 —— 那些角色的成就墙上会留一条
   * 指向不存在成就的空记录，而客户端拿不到配置就只能显示一个 id。
   */
  deleteAchievement(id: string): { deleted: boolean } {
    this.requireAchievement(id);
    const records = this.roleAchievementsRepo.countByAchievement(id);
    if (records > 0) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `成就 ${id} 仍被 ${records} 个角色的成就记录引用，先清理记录再删`,
      );
    }
    this.achievementsRepo.remove(id);
    return { deleted: true };
  }

  // —— 内部 ——

  /**
   * 技能跨字段约束（单字段上下限在 DTO，这里管「字段之间」）
   *
   * 三条都是**真实会出事**的组合，不是形式主义：
   * - 状态型技能没有 statusId → 释放后什么都不发生，玩家会以为技能坏了；
   * - 主动技能一条倍率都没有 → 结算取 `damageCoefficients[level-1]` 拿到 undefined，伤害恒 0；
   * - statusId 指向不存在的状态 → 客户端 apply 时打一条 error 日志，玩家看不到任何反馈。
   *
   * 调用点只在请求动了「分类 / 倍率 / 挂载状态」时进来（见 `updateSkill`）：库里存在
   * 「分类是主动但倍率为空」的历史行，按合并后的行无条件校验会让它们连改名都改不了。
   */
  private assertSkillConsistency(row: SkillRow): void {
    const coefficients = parseDamageCoefficients(row.damage_coefficients);
    if (row.status_id) this.requireStatus(row.status_id);
    // category "2" = 客户端 SkillType.STATUS
    if (row.category === "2" && !row.status_id) {
      throw new BizException(BizCode.PARAM_INVALID, "状态型技能必须配置 statusId（否则释放后什么都不发生）");
    }
    // category "0" = 客户端 SkillType.PROACTIVE（要打出伤害的那种）
    if (row.category === "0" && coefficients.length === 0) {
      throw new BizException(BizCode.PARAM_INVALID, "主动技能至少要有一条伤害系数（否则伤害恒为 0）");
    }
  }

  private requireSkill(id: string): SkillRow {
    const row = this.skillsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.SKILL_NOT_FOUND, `技能 ${id} 不存在`);
    return row;
  }

  private requireStatus(id: string): StatusRow {
    const row = this.statusesRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.STATUS_NOT_FOUND, `状态 ${id} 不存在`);
    return row;
  }

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

  private requireItem(id: string): ItemRow {
    const row = this.items.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.ITEM_NOT_FOUND, `物品 ${id} 不存在`);
    return row;
  }

  private requireMonster(id: string): MonsterRow {
    const row = this.monstersRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.MONSTER_NOT_FOUND, `怪物 ${id} 不存在`);
    return row;
  }

  private requireNpc(id: string): NpcRow {
    const row = this.npcsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.NPC_NOT_FOUND, `NPC ${id} 不存在`);
    return row;
  }

  private requireAchievement(id: string): AchievementRow {
    const row = this.achievementsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.ACHIEVEMENT_NOT_FOUND, `成就 ${id} 不存在`);
    return row;
  }

  /**
   * 成就跨字段约束（单字段上下限在 DTO，这里管「字段之间」）——
   * 两类错都会让玩家「怎么打都不解锁」：
   * - `kill` 的 target 既不是 `"*"` 也不是已配置怪物 → 永远不命中；
   * - `collect` 的 target 不是真实物品 → 背包里永远数不出来；
   * - 奖励物品不存在 → 领取时才炸，而那时玩家已经以为领到了。
   *
   * `level` / `combat` / `quest` 不看 target（门槛只在 count），传什么都忽略。
   */
  private assertAchievementConsistency(row: AchievementRow): void {
    const target = String(row.condition_target ?? "");
    if (row.condition_type === "kill" && target !== "*") {
      if (!this.monstersRepo.findByKey(target)) {
        throw new BizException(
          BizCode.PARAM_INVALID,
          `成就 ${row.id} 的击杀目标 ${target || "(空)"} 不是已配置的怪物（任意怪请写 *）`,
        );
      }
    }
    if (row.condition_type === "collect" && !itemExists(target)) {
      throw new BizException(BizCode.PARAM_INVALID, `成就 ${row.id} 的持有目标 ${target || "(空)"} 不是已配置的物品`);
    }
    for (const item of parseRewardItems(row.reward_items)) {
      if (!itemExists(item.goodId)) {
        throw new BizException(BizCode.PARAM_INVALID, `成就 ${row.id} 的奖励物品 ${item.goodId} 不存在`);
      }
    }
  }

  private requireQuest(id: string): QuestRow {
    const row = this.questsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.QUEST_NOT_FOUND, `任务 ${id} 不存在`);
    return row;
  }

  /**
   * 任务跨字段约束（单字段上下限在 DTO，这里管「字段之间」）——
   * 四条都是真实会出事的组合：
   * - 目标键指向不存在的怪物 / NPC / 物品 → 任务永远做不完；
   * - 发布 NPC 不存在 → 客户端头顶标记没有落点；
   * - prevQuestId 指向不存在的任务或成环 → 后继任务永远接不了；
   * - 奖励物品不存在 → 交付时才炸，玩家看着「可交付」按钮点不出结果。
   */
  private assertQuestConsistency(row: QuestRow): void {
    if (row.objective_type === "kill") {
      if (!this.monstersRepo.findByKey(String(row.objective_target))) {
        throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的击杀目标 ${row.objective_target} 不是已配置的怪物`);
      }
    } else if (row.objective_type === "talk") {
      if (!this.npcsRepo.findByKey(String(row.objective_target))) {
        throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的对话目标 ${row.objective_target} 不是已配置的 NPC`);
      }
    } else if (!itemExists(row.objective_target)) {
      throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的收集目标 ${row.objective_target} 不是已配置的物品`);
    }
    if (row.npc_id && !this.npcsRepo.findByKey(String(row.npc_id))) {
      throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的发布 NPC ${row.npc_id} 不是已配置的 NPC`);
    }
    if (row.prev_quest_id) {
      if (row.prev_quest_id === row.id) {
        throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的前置不能是自己`);
      }
      const chain = new Map(this.questsRepo.listAll().map((item) => [item.id, item.prev_quest_id]));
      if (!chain.has(row.prev_quest_id)) {
        throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的前置 ${row.prev_quest_id} 不存在`);
      }
      // 沿前置链向上走：走回自己 = 成环（链上任何一环成环都会让后继永远接不了）
      chain.set(row.id, row.prev_quest_id);
      const seen = new Set<string>([row.id]);
      let cursor = row.prev_quest_id;
      while (cursor) {
        if (seen.has(cursor)) {
          throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的前置链成环（经过 ${cursor}）`);
        }
        seen.add(cursor);
        cursor = chain.get(cursor) ?? "";
      }
    }
    for (const item of parseRewardItems(row.reward_items)) {
      if (!itemExists(item.goodId)) {
        throw new BizException(BizCode.PARAM_INVALID, `任务 ${row.id} 的奖励物品 ${item.goodId} 不存在`);
      }
    }
  }

  private requireFashion(id: string): FashionRow {
    const row = this.fashionsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.FASHION_NOT_FOUND, `时装 ${id} 不存在`);
    return row;
  }

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

/** 怪物行属性列名（flatMonsterAttributes / monsterAttributeColumns 共用的键集合） */
type MonsterAttrColumnNames =
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

/** 怪物六项区间：DTO 形状（{min,max}）→ 拍平行属性列 */
function monsterAttributeColumns(attributes: MonsterAttributesDto): Pick<MonsterRow, MonsterAttrColumnNames> {
  return {
    physical_attack_min: attributes.physicalAttack.min,
    physical_attack_max: attributes.physicalAttack.max,
    magic_attack_min: attributes.magicAttack.min,
    magic_attack_max: attributes.magicAttack.max,
    taoist_attack_min: attributes.taoistAttack.min,
    taoist_attack_max: attributes.taoistAttack.max,
    physical_defense_min: attributes.physicalDefense.min,
    physical_defense_max: attributes.physicalDefense.max,
    magic_defense_min: attributes.magicDefense.min,
    magic_defense_max: attributes.magicDefense.max,
    taoist_defense_min: attributes.taoistDefense.min,
    taoist_defense_max: attributes.taoistDefense.max,
  };
}


/**
 * 怪物区间属性的组合校验（0 ≤ min ≤ max）
 *
 * 与 assertAttributeRanges 同一口径，但作用于 MonsterAttributesDto（六项、无 maxHp/hpRecover）。
 * 区间值非负交给 DTO（@Min）；「min ≤ max」是跨字段约束，只有 service 判得了。
 */
function assertMonsterAttributeRanges(attributes: MonsterAttributesDto): void {
  const ranges = [
    attributes.physicalAttack,
    attributes.magicAttack,
    attributes.taoistAttack,
    attributes.physicalDefense,
    attributes.magicDefense,
    attributes.taoistDefense,
  ];
  for (const { min, max } of ranges) {
    if (min > max) {
      throw new BizException(BizCode.PARAM_INVALID, "属性下限不能大于上限");
    }
  }
}

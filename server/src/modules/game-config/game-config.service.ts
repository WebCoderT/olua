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
import { MallRepository } from "../../database/repositories/mall.repository";
import { EquipAlignRepository } from "../../database/repositories/equip-align.repository";
import { EquipInAlignRepository } from "../../database/repositories/equip-in-align.repository";
import { FashionRepository, FashionListOptions } from "../../database/repositories/fashion.repository";
import { ItemRepository, ItemListOptions } from "../../database/repositories/item.repository";
import { MoneyItemRepository, MoneyItemListOptions } from "../../database/repositories/money-item.repository";
import { LevelScrollRepository, LevelScrollListOptions } from "../../database/repositories/level-scroll.repository";
import { MonsterRepository, MonsterListOptions } from "../../database/repositories/monster.repository";
import { MonsterDropRepository } from "../../database/repositories/monster-drop.repository";
import { MonsterPresentationRepository } from "../../database/repositories/monster-presentation.repository";
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
import { moneyItemSeedOf } from "../../common/constants/money-items";
import { levelScrollDraftOf } from "../../common/constants/level-scrolls";
import { itemExists } from "../../common/runtime-config-cache";
import { RuntimeConfigService } from "./runtime-config.service";
import {
  DrugRow,
  EquipmentRow,
  EquipmentVariantRow,
  FashionRow,
  ItemRow,
  LevelScrollRow,
  MoneyItemRow,
  MonsterRow,
  MonsterBehaviorRow,
  MonsterPresentationRow,
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
  CreateEquipmentDto,
  CreateEquipmentResultDto,
  EQUIPMENT_DIRECTIONS,
  EquipmentDto,
  EquipmentListItemDto,
  EquipmentMetaDto,
  EquipmentQueryDto,
  EquipmentSlotDto,
  EquipmentSlotSummaryDto,
  EquipmentVariantDto,
  EquipmentVariantQueryDto,
  EquipmentVariantRebuildResultDto,
  RemoveEquipmentResultDto,
  UpdateEquipmentDto,
  UpdateEquipmentMetaDto,
  UpdateEquipmentSlotDto,
  UpdateEquipmentVariantDto,
} from "./dto/equipment.dto";

import { DrugDto, DrugQueryDto, UpdateDrugDto } from "./dto/drug.dto";
import { FashionDto, FashionQueryDto, UpdateFashionDto } from "./dto/fashion.dto";
import { ItemDto, ItemQueryDto, UpdateItemDto } from "./dto/item.dto";
import {
  CreateMoneyItemDto,
  MoneyItemDto,
  MoneyItemQueryDto,
  RemoveMoneyItemResultDto,
  UpdateMoneyItemDto,
} from "./dto/money-item.dto";
import {
  CreateLevelScrollDto,
  LevelScrollDto,
  LevelScrollQueryDto,
  RemoveLevelScrollResultDto,
  UpdateLevelScrollDto,
} from "./dto/level-scroll.dto";
import {
  AdminMonsterDto,
  MONSTER_ACTION_KEYS,
  MONSTER_SPEED_RATE_MAX,
  MONSTER_SPEED_RATE_MIN,
  MonsterAttributesDto,
  MonsterDto,
  MonsterQueryDto,
  UpdateMonsterDto,
  UpdateMonsterPresentationDto,
  monsterAttributesFromRow,
} from "./dto/monster.dto";
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
    /** 删装备前查「还在商城架上吗」（#773） */
    private readonly mall: MallRepository,
    /** 删装备时连带清掉指向它的工作台几何（#773） */
    private readonly equipAligns: EquipAlignRepository,
    private readonly equipInAligns: EquipInAlignRepository,
    private readonly drugs: DrugRepository,
    private readonly items: ItemRepository,
    private readonly moneyItems: MoneyItemRepository,
    private readonly levelScrolls: LevelScrollRepository,
    private readonly monstersRepo: MonsterRepository,
    private readonly monsterDropsRepo: MonsterDropRepository,
    private readonly monsterPresentations: MonsterPresentationRepository,
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
   * 「管理端保存 → 服务端下一次结算就按新值」靠这一行成立。只在这些表（称号 / 战魂 /
   * 军衔 / 装备 / 药品 / 技能 / 状态）的写操作后调用 —— 它们进了 `shared/runtime-overrides`
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

  // —— 装备变体（#655：逐行配置，不再由基础件乘倍率现算）——

  /**
   * 快照用：全部变体的**完整装备清单**（显示字段取基础件、数值取变体行）
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
    const rows = this.equipmentVariants.list(options);
    // 只补这一页真正引用的基础件（显示字段从基础件复制）；查不到的那几行直接跳过 ——
    // 基础件已被删除的孤儿变体不该在管理端露出来
    const bases = new Map(this.equipments.listByIds(Array.from(new Set(rows.map((row) => row.base_id)))).map((row) => [row.id, row]));
    const list: EquipmentVariantDto[] = [];
    for (const row of rows) {
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

  /**
   * 重建全部装备变体（管理端「重新生成变体」按钮，#697）
   *
   * 按 equipment_meta **当前**的前后缀倍率，把每个基础件 × 每个组合整批重算（与 #655
   * 迁移同一口径）：
   * - 属性 = `round(基础值 × 前缀倍率 × 后缀倍率)`（12 列逐列算）；
   * - 名称 / 穿戴等级 = 基础件（前后缀文案由客户端拼在名字前后，不入 label）；
   * - **卖价保留原值**：出厂价签来自已下架的回收价曲线，公式复算不出来，运营逐条调过
   *   的价也不该被一键覆盖。只有新出现的组合（扩档后重建）没有原值可保，按
   *   `round(10 × 等级 × 前缀倍率 × 后缀倍率)` 垫底（之后可在装备列表的「N 个变体」弹窗里逐条调）。
   *
   * 档位缩小后，被删组合的变体行在这里消失 —— 背包 / 穿戴 / 掉落表里还引用那些 id
   * 的装备会变成无效引用（属性 / 卖价查不到、名字回落基础件名）。这是确认弹窗必须
   * 讲清楚的事；变体 id 的拼法与客户端 `getEquipmentVariantKey` 逐字符一致
   * （p0s0 就是基础件 id 本身，不带后缀）。
   */
  rebuildEquipmentVariants(): EquipmentVariantRebuildResultDto {
    const meta = this.getEquipmentMeta();
    const bases = this.equipments.list({ page: 1, size: 1_000_000 });
    const pricePreserved = new Map(this.equipmentVariants.listAll().map((row) => [row.id, row.sell_price]));
    const now = Date.now();
    const rows: EquipmentVariantRow[] = [];
    for (const base of bases) {
      for (const row of variantsOfBase(base, meta, now)) {
        // 卖价保留原值：重建不改运营逐条调过的价，只有新组合（扩档后）才按公式垫底
        rows.push({ ...row, sell_price: pricePreserved.get(row.id) ?? row.sell_price });
      }
    }
    this.equipmentVariants.replaceAll(rows);
    this.touchRuntime();
    return {
      bases: bases.length,
      combos: meta.prefixRates.length * meta.suffixRates.length,
      variants: rows.length,
    };
  }

  // —— 装备基础件（#252 可改数值；#773 起可新建 / 删除；变体见上面的 #655 区）——

  listEquipments(query: EquipmentQueryDto): PageResult<EquipmentListItemDto> {
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
    // 变体件数只查当前页这几十个基础件（#781：列表要显示「有几个变体」）
    const counts = new Map(this.equipmentVariants.countByBaseIds(rows.map((row) => row.id)).map((row) => [row.baseId, row.count]));
    return { list: rows.map((row) => EquipmentListItemDto.of(row, counts.get(row.id) ?? 0)), total, page: options.page, size: options.size };
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
      // 掉落强制绑定（#789）：库里是 0/1，DTO 是 boolean，缺省 = 不改
      bind_on_drop: dto.bindOnDrop === undefined ? existing.bind_on_drop : dto.bindOnDrop ? 1 : 0,
      ...attributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.equipments.update(next);
    this.touchRuntime();
    return EquipmentDto.from(this.requireEquipment(id));
  }

  /** 部位盘点（管理端部位页签的计数徽章，#773） */
  equipmentSlotSummary(): EquipmentSlotSummaryDto {
    const counted = this.equipments.countBySlot();
    const counts = new Map(counted.map((row) => [row.slot, row.count]));
    const slots = this.equipments.listSlots().map((row) => ({
      slot: row.key,
      label: row.label,
      count: counts.get(row.key) ?? 0,
    }));
    // 槽位表里没有、但 equipments 里有的部位（历史脏数据 / 手改库）补在末尾：
    // 不补的话那几件永远点不到，运营也看不出「有一批装备挂在野部位上」
    for (const row of counted) {
      if (slots.some((slot) => slot.slot === row.slot)) continue;
      slots.push({ slot: row.slot, label: row.slot, count: row.count });
    }
    return { total: slots.reduce((sum, slot) => sum + slot.count, 0), slots };
  }

  /**
   * 新建装备基础件（#773）
   *
   * 三件事按顺序做，每件都先校验再写库（不留半截数据）：
   * 1. **身份**：部位必须在槽位表里；id 缺省按 `部位_序号` 生成，撞已有 id 直接 409 ——
   *    不覆盖（一个 id 两件装备会让背包 / 穿戴 / 掉落表里的引用说不清指谁）。
   * 2. **模板**：给了 `templateId` 就把它的资源 / 几何 / 职业性别 / 描述 / 属性整份抄过来，
   *    再让 DTO 里显式给的值盖在上面（等级 / 售价 / 名称 / 资源路径 …）。
   * 3. **变体**：按 `equipment_meta` 当前档数整批展开（与「重新生成变体」同一份规则），
   *    否则这件装备在客户端**不存在** —— 客户端只认 `equipment_variants` 的行。
   *
   * 写完重装结算层：服务端下一次算属性 / 掉落就能看到它（客户端下次拉快照）。
   */
  createEquipment(dto: CreateEquipmentDto): CreateEquipmentResultDto {
    const slot = this.equipments.findSlot(dto.slot);
    if (!slot) throw new BizException(BizCode.PARAM_INVALID, `部位 ${dto.slot} 不在装备槽位表里`);

    const template = dto.templateId ? this.requireEquipment(dto.templateId) : undefined;
    const id = dto.id?.trim() || this.nextEquipmentId(dto.slot);
    if (this.equipments.findByKey(id)) {
      throw BizException.conflict(BizCode.EQUIPMENT_ALREADY_EXISTS, `装备 ${id} 已存在（换个 id，或直接编辑它）`);
    }

    const now = Date.now();
    const attributes = template
      ? attributeColumns(attributesFromRow(template as EquipmentRow & SoulRowShape))
      : zeroAttributeColumns();
    const row: EquipmentRow = {
      id,
      slot: dto.slot,
      level: dto.level ?? template?.level ?? 1,
      sell_price: dto.sellPrice ?? template?.sell_price ?? 0,
      label: dto.label.trim(),
      occupation: dto.occupation ?? template?.occupation ?? "4",
      sex: dto.sex ?? template?.sex ?? "3",
      description: dto.description ?? template?.description ?? "",
      icon: dto.icon ?? template?.icon ?? "",
      in_atlas: dto.inAtlas ?? template?.in_atlas ?? "",
      out_atlas: dto.outAtlas ?? template?.out_atlas ?? "",
      tags: dto.tags ? JSON.stringify(dto.tags) : (template?.tags ?? "[]"),
      in_pos_x: template?.in_pos_x ?? 0,
      in_pos_y: template?.in_pos_y ?? 0,
      in_scale_x: template?.in_scale_x ?? 1,
      in_scale_y: template?.in_scale_y ?? 1,
      in_rotate: template?.in_rotate ?? 0,
      out_scale: template?.out_scale ?? 1,
      out_positions: template?.out_positions ?? zeroPositions(),
      // 掉落强制绑定（#789）：跟着模板走，DTO 显式给了就以 DTO 为准
      bind_on_drop: dto.bindOnDrop === undefined ? (template?.bind_on_drop ?? 0) : dto.bindOnDrop ? 1 : 0,
      ...attributes,
      updated_at: now,
    };

    const variants = variantsOfBase(row, this.getEquipmentMeta(), now);
    this.equipments.insert(row);
    for (const variant of variants) this.equipmentVariants.seedRow(variant);
    this.touchRuntime();
    return { equipment: EquipmentDto.from(this.requireEquipment(id)), variants: variants.length };
  }

  /**
   * 删除装备基础件（#773）
   *
   * 连带清掉：这件基础件的**全部变体** + `equip_aligns` / `equip_in_aligns` 里指向它们的
   * 工作台几何（都是这件装备的派生数据，留着只是孤儿行）。
   *
   * **还在商城上架清单里 → 409**：先下架再来删。`mall_goods.id` 就是变体 id，删了会留下
   * 「名字退回 id、图标空」的幽灵商品，客户端照实陈列 —— 与其留给人以后收拾，不如当场拦。
   *
   * **不碰玩家存档**：背包 / 身上还引用这些 id 的角色，那些格子会变成认不出的路径
   * （服务端 `collectEquipmentBundles` 与客户端取表都只是跳过，不会崩），管理端的删除确认
   * 必须把这条讲清楚 —— 这是「删装备」真正的代价。
   */
  removeEquipment(id: string): RemoveEquipmentResultDto {
    const base = this.requireEquipment(id);
    const variants = this.equipmentVariants.listOfBase(base.id);
    const ids = [base.id, ...variants.map((row) => row.id)];

    const listed = this.mall.countGoodsAmong(ids);
    if (listed > 0) {
      throw BizException.conflict(
        BizCode.EQUIPMENT_LISTED_IN_MALL,
        `装备 ${id} 还有 ${listed} 行挂在商城上架清单里，先在「商城」页下架再删`,
      );
    }

    let aligns = 0;
    for (const variantId of ids) {
      // 两套工作台各自一行；没有行就是 0 行受影响，不用先判存在
      aligns += this.equipAligns.remove(variantId).changes;
      aligns += this.equipInAligns.remove(variantId).changes;
    }
    const removedVariants = this.equipmentVariants.removeOfBase(base.id);
    this.equipments.remove(base.id);
    this.touchRuntime();
    return { id: base.id, variants: removedVariants, aligns };
  }

  /** 下一个可用 id（`部位_序号`：该部位现有 id 的最大数字序号 + 1；非数字尾缀不参与） */
  private nextEquipmentId(slot: string): string {
    const prefix = `${slot}_`;
    let max = 0;
    for (const row of this.equipments.list({ page: 1, size: 1_000_000 })) {
      if (!row.id.startsWith(prefix)) continue;
      const serial = Number(row.id.slice(prefix.length));
      if (Number.isInteger(serial) && serial > max) max = serial;
    }
    return `${prefix}${max + 1}`;
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
   * #655 起这些倍率与曲线**不再参与任何现算**（每个变体各自一行、自带属性与价签），
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
   * 颜色（#720）口径不同：是渲染装饰、不参与档数派生 ——
   * - **显式传了**才校验：与文案等长（逐档精确控制）或空数组（清空 = 客户端内置色）；
   * - **没传而档数变了**（扩档 / 缩档）：颜色自动对齐新档数（截短 / 用最后一色垫补），
   *   不让「只想改档位」的调用被颜色长度卡死 —— 管理端总是整份带上颜色，这条兜的是直连 API。
   */
  updateEquipmentMeta(dto: UpdateEquipmentMetaDto): EquipmentMetaDto {
    const current = this.getEquipmentMeta();
    const prefixRates = dto.prefixRates ?? current.prefixRates;
    const suffixRates = dto.suffixRates ?? current.suffixRates;
    const prefixLabels = dto.prefixLabels ?? current.prefixLabels;
    const suffixLabels = dto.suffixLabels ?? current.suffixLabels;
    let prefixColors = dto.prefixColors ?? current.prefixColors;
    let suffixColors = dto.suffixColors ?? current.suffixColors;
    if (prefixRates.length !== prefixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `前缀倍率（${prefixRates.length} 项）与文案（${prefixLabels.length} 项）长度必须一致`);
    }
    if (suffixRates.length !== suffixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `后缀倍率（${suffixRates.length} 项）与文案（${suffixLabels.length} 项）长度必须一致`);
    }
    if (dto.prefixColors !== undefined && dto.prefixColors.length > 0 && dto.prefixColors.length !== prefixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `前缀颜色（${dto.prefixColors.length} 项）与文案（${prefixLabels.length} 项）长度必须一致（或传空数组 = 全部用内置色）`);
    }
    if (dto.suffixColors !== undefined && dto.suffixColors.length > 0 && dto.suffixColors.length !== suffixLabels.length) {
      throw new BizException(BizCode.PARAM_INVALID, `后缀颜色（${dto.suffixColors.length} 项）与文案（${suffixLabels.length} 项）长度必须一致（或传空数组 = 全部用内置色）`);
    }
    // 没传颜色而档数变了 → 自动对齐（#720：改档位不该被颜色长度拦住）
    if (dto.prefixColors === undefined) prefixColors = reconcileTierColors(prefixColors, prefixLabels.length);
    if (dto.suffixColors === undefined) suffixColors = reconcileTierColors(suffixColors, suffixLabels.length);
    this.equipments.updateMeta({
      id: 1,
      prefix_rates: JSON.stringify(prefixRates),
      suffix_rates: JSON.stringify(suffixRates),
      prefix_labels: JSON.stringify(prefixLabels),
      suffix_labels: JSON.stringify(suffixLabels),
      prefix_colors: JSON.stringify(prefixColors),
      suffix_colors: JSON.stringify(suffixColors),
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
      // 掉落强制绑定（#789）：库里是 0/1，DTO 是 boolean，缺省 = 不改
      bind_on_drop: dto.bindOnDrop === undefined ? existing.bind_on_drop : dto.bindOnDrop ? 1 : 0,
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
      // 掉落强制绑定（#789）：库里是 0/1，DTO 是 boolean，缺省 = 不改
      bind_on_drop: dto.bindOnDrop === undefined ? existing.bind_on_drop : dto.bindOnDrop ? 1 : 0,
      updated_at: Date.now(),
    };
    this.items.update(next);
    this.touchRuntime();
    return ItemDto.from(this.requireItem(id));
  }

  // —— 货币物品（#785：使用后直接入账；与药品 / 物品不同，**可以增删改行**）——

  listMoneyItems(query: MoneyItemQueryDto): PageResult<MoneyItemDto> {
    const options: MoneyItemListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      currency: query.currency,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.moneyItems.list(options);
    const total = this.moneyItems.count(options);
    return { list: rows.map(MoneyItemDto.from), total, page: options.page, size: options.size };
  }

  /** 配置快照用：全部行（货币 → 面值；客户端按这个顺序陈列背包 / 图鉴） */
  listMoneyItemRows(): MoneyItemRow[] {
    return this.moneyItems.listAll();
  }

  /**
   * 新建货币物品
   *
   * 面值相同的「同一种货币」只能有一条：id 按 `money_<货币>_<面值>` 派生（可手填），
   * 撞 id 直接 409 —— 否则背包里同一个 id 指到哪一种面值就说不清了。
   */
  createMoneyItem(dto: CreateMoneyItemDto): MoneyItemDto {
    const seed = moneyItemSeedOf(dto.currency, dto.amount);
    const id = (dto.id ?? "").trim() || seed.id;
    if (this.moneyItems.findByKey(id)) {
      throw BizException.conflict(BizCode.MONEY_ITEM_ALREADY_EXISTS, `货币物品 ${id} 已存在`);
    }
    const row: MoneyItemRow = {
      id,
      // 名称 / 描述 / 图标缺省都按「货币 + 面值」派生：运营只想开一档面值时不用填 4 个字段
      label: dto.label !== undefined ? dto.label : seed.label,
      description: dto.description !== undefined ? dto.description : seed.description,
      icon: dto.icon !== undefined ? dto.icon : seed.icon,
      currency: dto.currency,
      amount: dto.amount,
      max_stack: dto.maxStack ?? seed.maxStack,
      sell_price: dto.sellPrice ?? seed.sellPrice,
      // 掉落强制绑定（#789）：新建默认不强制
      bind_on_drop: dto.bindOnDrop ? 1 : 0,
      updated_at: Date.now(),
    };
    this.moneyItems.insert(row);
    this.touchRuntime();
    return MoneyItemDto.from(this.requireMoneyItem(id));
  }

  updateMoneyItem(id: string, dto: UpdateMoneyItemDto): MoneyItemDto {
    const existing = this.requireMoneyItem(id);
    const next: MoneyItemRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      icon: dto.icon ?? existing.icon,
      currency: dto.currency ?? existing.currency,
      amount: dto.amount ?? existing.amount,
      max_stack: dto.maxStack ?? existing.max_stack,
      sell_price: dto.sellPrice ?? existing.sell_price,
      // 掉落强制绑定（#789）：库里是 0/1，DTO 是 boolean，缺省 = 不改
      bind_on_drop: dto.bindOnDrop === undefined ? existing.bind_on_drop : dto.bindOnDrop ? 1 : 0,
      updated_at: Date.now(),
    };
    this.moneyItems.update(next);
    this.touchRuntime();
    return MoneyItemDto.from(this.requireMoneyItem(id));
  }

  /**
   * 删除货币物品
   *
   * **不碰玩家存档**：背包里还引用这个 id 的格子会变成「认不出的道具」——
   * 客户端与结算都只是跳过（与删装备同一条口径），不报错也不会崩。
   * 所以这里只删配置行，返回删掉了几行。
   */
  removeMoneyItem(id: string): RemoveMoneyItemResultDto {
    this.requireMoneyItem(id);
    const { changes } = this.moneyItems.remove(id);
    this.touchRuntime();
    return { id, removed: changes };
  }

  // —— 升级卷轴（#787：使用后硬性 +1 级，带等级区间；可增删改行）——

  listLevelScrolls(query: LevelScrollQueryDto): PageResult<LevelScrollDto> {
    const options: LevelScrollListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.levelScrolls.list(options);
    const total = this.levelScrolls.count(options);
    return { list: rows.map(LevelScrollDto.from), total, page: options.page, size: options.size };
  }

  /** 配置快照用：全部行（等级下限升序 —— 卷轴天生有序，别按 id 字符串排） */
  listLevelScrollRows(): LevelScrollRow[] {
    return this.levelScrolls.listAll();
  }

  /**
   * 新建升级卷轴
   *
   * 只填两列等级区间就能建：id / 名称 / 描述 / 图标缺省按区间派生（见 `levelScrollDraftOf`）。
   * **`minLevel > maxLevel` 直接 400**（40000）—— 一卷不可能「下限比上限高」，
   * 存进去的结果是「任何等级都用不了」，比报错难查得多。
   *
   * 区间重叠**不拦**：两卷都能用是运营的自由（比如活动期发一卷「1~10000 通用」），
   * 不会产生数据问题，只是客户端会按等级挑到区间里任意一卷。
   */
  createLevelScroll(dto: CreateLevelScrollDto): LevelScrollDto {
    if (dto.minLevel > dto.maxLevel) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `等级下限（${dto.minLevel}）不能大于上限（${dto.maxLevel}）`,
      );
    }
    const draft = levelScrollDraftOf(dto.minLevel, dto.maxLevel);
    const id = (dto.id ?? "").trim() || draft.id;
    if (this.levelScrolls.findByKey(id)) {
      throw BizException.conflict(BizCode.LEVEL_SCROLL_ALREADY_EXISTS, `升级卷轴 ${id} 已存在`);
    }
    const row: LevelScrollRow = {
      id,
      label: dto.label !== undefined ? dto.label : draft.label,
      description: dto.description !== undefined ? dto.description : draft.description,
      icon: dto.icon !== undefined ? dto.icon : draft.icon,
      min_level: dto.minLevel,
      max_level: dto.maxLevel,
      max_stack: dto.maxStack ?? 999,
      sell_price: dto.sellPrice ?? 0,
      // 掉落强制绑定（#789）：新建默认不强制
      bind_on_drop: dto.bindOnDrop ? 1 : 0,
      updated_at: Date.now(),
    };
    this.levelScrolls.insert(row);
    this.touchRuntime();
    return LevelScrollDto.from(this.requireLevelScroll(id));
  }

  updateLevelScroll(id: string, dto: UpdateLevelScrollDto): LevelScrollDto {
    const existing = this.requireLevelScroll(id);
    const minLevel = dto.minLevel ?? existing.min_level;
    const maxLevel = dto.maxLevel ?? existing.max_level;
    // 改完的**合成结果**也要校验：只改下限也可能把区间改反（原本 1000~1999，下限填 3000）
    if (minLevel > maxLevel) {
      throw new BizException(BizCode.PARAM_INVALID, `等级下限（${minLevel}）不能大于上限（${maxLevel}）`);
    }
    const next: LevelScrollRow = {
      ...existing,
      label: dto.label ?? existing.label,
      description: dto.description ?? existing.description,
      icon: dto.icon ?? existing.icon,
      min_level: minLevel,
      max_level: maxLevel,
      max_stack: dto.maxStack ?? existing.max_stack,
      sell_price: dto.sellPrice ?? existing.sell_price,
      // 掉落强制绑定（#789）：库里是 0/1，DTO 是 boolean，缺省 = 不改
      bind_on_drop: dto.bindOnDrop === undefined ? existing.bind_on_drop : dto.bindOnDrop ? 1 : 0,
      updated_at: Date.now(),
    };
    this.levelScrolls.update(next);
    this.touchRuntime();
    return LevelScrollDto.from(this.requireLevelScroll(id));
  }

  /**
   * 删除升级卷轴
   *
   * **不碰玩家存档**：背包里还引用这个 id 的格子会变成「认不出的道具」——
   * 客户端与结算都只是跳过（用不了，也不报错），与删装备 / 删货币道具同一条口径。
   */
  removeLevelScroll(id: string): RemoveLevelScrollResultDto {
    this.requireLevelScroll(id);
    const { changes } = this.levelScrolls.remove(id);
    this.touchRuntime();
    return { id, removed: changes };
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
   * 管理端怪物列表（= 基础数据 + 掉落摘要 + 表现参数）
   *
   * 后两段只补这一页的行：各自的 `listByKeys` 一次 IN 查完再按 key 对齐，
   * 不要逐只 `findByKey`（一页 20 次单查 × 两张表）。玩家侧快照走 `listMonsters`，不带这两段。
   */
  listAdminMonsters(query: MonsterQueryDto): PageResult<AdminMonsterDto> {
    const page = this.listMonsters(query);
    const keys = page.list.map((item) => item.id);
    const drops = new Map(this.monsterDropsRepo.listByKeys(keys).map((row) => [row.monster_key, row]));
    const presentations = new Map(this.monsterPresentations.listByKeys(keys).map((row) => [row.id, row]));
    return {
      ...page,
      list: page.list.map((item) => AdminMonsterDto.withDrop(item, drops.get(item.id), presentations.get(item.id))),
    };
  }

  /**
   * 改怪物 → 回管理端视图（PATCH 的响应要与管理端列表同形，
   * 否则「刚改完那行」和「刷新后那行」长得不一样）
   */
  updateMonsterAdmin(id: string, dto: UpdateMonsterDto): AdminMonsterDto {
    const saved = this.updateMonster(id, dto);
    return AdminMonsterDto.withDrop(saved, this.monsterDropsRepo.findByKey(id), this.monsterPresentations.getById(id) ?? undefined);
  }

  /**
   * 编辑怪物（基础数值 + 定位 + 行为参数，#751）
   *
   * 两段分别落在 `monsters` 与 `monster_presentation`：服务端权威 AI 与伤害结算直读库，
   * 所以数值改完**即时生效**；行为参数走 AI 的 1 秒 TTL，最迟 1 秒生效；
   * 客户端表现要重进地图重拉快照。
   *
   * **校验全部放在写之前**：`presentation` 缺行、`speedRate` 键非法都在这里就抛，
   * 不会出现「基础数值写进去了、行为参数报错」这种半截提交。
   */
  updateMonster(id: string, dto: UpdateMonsterDto): MonsterDto {
    const existing = this.requireMonster(id);
    const attributes = dto.attributes ?? monsterAttributesFromRow(existing);
    assertMonsterAttributeRanges(attributes);

    // 行为参数：先取现值（缺行直接 404）+ 校验，再动手写
    const currentPresentation = dto.presentation ? this.requireMonsterPresentation(id) : null;
    if (dto.presentation?.speedRate) assertMonsterSpeedRate(dto.presentation.speedRate);

    const next: MonsterRow = {
      ...existing,
      label: dto.label ?? existing.label,
      tier: dto.tier ?? existing.tier,
      level: dto.level ?? existing.level,
      max_hp: dto.maxHp ?? existing.max_hp,
      ...monsterAttributeColumns(attributes),
      updated_at: Date.now(),
    };
    this.monstersRepo.update(next);

    if (dto.presentation && currentPresentation) {
      this.monsterPresentations.updateBehavior(
        mergeMonsterBehavior(currentPresentation, dto.presentation),
      );
    }
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
    if (dto.pushChance !== undefined) next.push_chance = dto.pushChance;
    // #826：暴击与破防。三个都只影响「这一发怎么算伤害」，不参与跨字段校验
    if (dto.critRate !== undefined) next.crit_rate = dto.critRate;
    if (dto.critDamage !== undefined) next.crit_damage = dto.critDamage;
    if (dto.defIgnore !== undefined) next.def_ignore = dto.defIgnore;
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
      // 撞飞概率默认 1（必撞）：push_distance 配了却没有概率列的旧行为就是必撞
      push_chance: dto.pushChance ?? 1,
      // 暴击 / 破防默认 0：新建的技能在运营配之前行为与改动前一致
      crit_rate: dto.critRate ?? 0,
      crit_damage: dto.critDamage ?? 0,
      def_ignore: dto.defIgnore ?? 0,
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
    // 状态的 combat 从 #822 起进了结算层（`runtime-config-cache` 的 statusOf）——
    // 不重装就是「管理端把格挡改成 100%、服务端还按老值掷骰」，而且没有任何报错
    this.touchRuntime();
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
    // 管理端只改绑定元宝时不至于把物品清单静默清空
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
      reward_bind_gold: rewards.bindGold ?? existing.reward_bind_gold,
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
      reward_bind_gold: dto.rewards?.bindGold ?? 0,
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
   *
   * daily 的 claimed 行不算「卡住」（#815 起日常也保留 claimed 行）：那是「今天领过」的记账，
   * 拿它拦下架会让日常永远删不掉 —— 每天都有玩家领过。
   */
  deleteQuest(id: string): { deleted: boolean } {
    const quest = this.requireQuest(id);
    const progress = this.questProgressRepo.countByQuest(id, quest.kind === "daily" ? "claimed" : undefined);
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
      reward_bind_gold: rewards.bindGold ?? existing.reward_bind_gold,
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
      reward_bind_gold: dto.rewards?.bindGold ?? 0,
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

  private requireMoneyItem(id: string): MoneyItemRow {
    const row = this.moneyItems.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.MONEY_ITEM_NOT_FOUND, `货币物品 ${id} 不存在`);
    return row;
  }

  private requireLevelScroll(id: string): LevelScrollRow {
    const row = this.levelScrolls.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.LEVEL_SCROLL_NOT_FOUND, `升级卷轴 ${id} 不存在`);
    return row;
  }

  private requireMonster(id: string): MonsterRow {
    const row = this.monstersRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.MONSTER_NOT_FOUND, `怪物 ${id} 不存在`);
    return row;
  }

  /**
   * 取怪物的表现行（改行为参数的前提）
   *
   * 行由几何生成器按图集建，与 `monsters` 一一对应；缺行说明这只怪还没量过素材，
   * 后台也不该凭空造一行（icon / out 是素材事实）—— 直接 404 让运营去跑生成器。
   */
  private requireMonsterPresentation(id: string): MonsterPresentationRow {
    const row = this.monsterPresentations.getById(id);
    if (!row) {
      throw BizException.notFound(BizCode.MONSTER_PRESENTATION_NOT_FOUND, `怪物 ${id} 没有资源表现行，先跑几何生成器`);
    }
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
 * 属性列全零（新建装备不给模板时的底：一件「能吃能穿但没有任何加成」的白装）
 *
 * 直接写出 14 个 0 而不是 `attributesFromRow(空对象)` —— 后者要靠 `undefined` → NaN 兜底，
 * 这里少一层推理：新建的行每一列都是显式的。
 */
function zeroAttributeColumns(): Pick<TitleRow, AttrColumnNames> {
  return {
    max_hp: 0,
    hp_recover: 0,
    physical_attack_min: 0,
    physical_attack_max: 0,
    magic_attack_min: 0,
    magic_attack_max: 0,
    taoist_attack_min: 0,
    taoist_attack_max: 0,
    physical_defense_min: 0,
    physical_defense_max: 0,
    magic_defense_min: 0,
    magic_defense_max: 0,
    taoist_defense_min: 0,
    taoist_defense_max: 0,
  };
}

/** 8 向位置的零值（新建且不给模板时：客户端按 `(0,0)` 画在脚底锚点上，不会画到屏幕外） */
function zeroPositions(): string {
  return JSON.stringify(Array.from({ length: EQUIPMENT_DIRECTIONS }, () => ({ x: 0, y: 0 })));
}

/**
 * 一件基础件 → 它当前档数下的**全部变体行**（#773 新建装备 与 #697 整表重建共用这一份展开规则）
 *
 * 属性 = `round(基础值 × 前缀倍率 × 后缀倍率)`；名称 / 穿戴等级取基础件（前后缀文案由客户端
 * 拼在名字前后，不进 `label`）；卖价按 `round(10 × 等级 × 倍率)` 垫底（重建时调用方还会用
 * 「原值优先」再覆盖一遍）。变体 id 的拼法与客户端 `getEquipmentVariantKey` 逐字符一致
 * （p0s0 就是基础件 id 本身，不带后缀）。
 */
function variantsOfBase(base: EquipmentRow, meta: EquipmentMetaDto, now: number): EquipmentVariantRow[] {
  const rows: EquipmentVariantRow[] = [];
  for (let prefix = 0; prefix < meta.prefixRates.length; prefix++) {
    for (let suffix = 0; suffix < meta.suffixRates.length; suffix++) {
      const prefixRate = meta.prefixRates[prefix];
      const suffixRate = meta.suffixRates[suffix];
      const scale = (value: number): number => Math.round(value * prefixRate * suffixRate);
      rows.push({
        id: prefix === 0 && suffix === 0 ? base.id : `${base.id}_p${prefix}s${suffix}`,
        base_id: base.id,
        prefix,
        suffix,
        label: base.label,
        level: base.level,
        sell_price: scale(10 * base.level),
        max_hp: scale(base.max_hp),
        hp_recover: scale(base.hp_recover),
        physical_attack_min: scale(base.physical_attack_min),
        physical_attack_max: scale(base.physical_attack_max),
        magic_attack_min: scale(base.magic_attack_min),
        magic_attack_max: scale(base.magic_attack_max),
        taoist_attack_min: scale(base.taoist_attack_min),
        taoist_attack_max: scale(base.taoist_attack_max),
        physical_defense_min: scale(base.physical_defense_min),
        physical_defense_max: scale(base.physical_defense_max),
        magic_defense_min: scale(base.magic_defense_min),
        magic_defense_max: scale(base.magic_defense_max),
        taoist_defense_min: scale(base.taoist_defense_min),
        taoist_defense_max: scale(base.taoist_defense_max),
        updated_at: now,
      });
    }
  }
  return rows;
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

/**
 * 动作速度覆盖的键 / 值校验（#751）
 *
 * 两种错都只在「跑起来才看得见」，所以宁可写不进去：
 * - **键不在白名单**：怪物素材只有 stand / walk / run / injured / die 五个动作有帧，
 *   给 `attackNear` 配了速度也不会播（客户端回退待机）—— 存进去等于假装生效；
 * - **值越界**：0 会让帧不动、负数会让 `AnimationState` 行为未定义。
 *
 * 空对象合法（= 清空回客户端 `monsterDefaultSpeedRate`），所以这里不看「有没有键」。
 */
function assertMonsterSpeedRate(speedRate: Record<string, number>): void {
  const unknown = Object.keys(speedRate).filter((key) => !MONSTER_ACTION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new BizException(
      BizCode.PARAM_INVALID,
      `动作「${unknown.join("、")}」在怪物素材里没有帧，只能覆盖 ${MONSTER_ACTION_KEYS.join(" / ")}`,
    );
  }
  for (const [key, value] of Object.entries(speedRate)) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < MONSTER_SPEED_RATE_MIN || rate > MONSTER_SPEED_RATE_MAX) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `动作「${key}」的速度倍率需在 ${MONSTER_SPEED_RATE_MIN}~${MONSTER_SPEED_RATE_MAX} 之间`,
      );
    }
  }
}

/**
 * 行为参数的部分更新 → 整行（#751）
 *
 * 缺省字段补成库里现值：`aggressive` / `detectRange` / `moveSpeed` 不传就不改；
 * `speedRate` **不传 = 不改、传 `{}` = 清空回默认**（客户端是
 * `{...monsterDefaultSpeedRate, ...行里的覆盖}`，清空 = 让覆盖为空）。
 * 几何列一个都不在这里出现 —— 那是生成器的地盘。
 */
function mergeMonsterBehavior(current: MonsterPresentationRow, patch: UpdateMonsterPresentationDto): MonsterBehaviorRow {
  return {
    id: current.id,
    aggressive: patch.aggressive === undefined ? current.aggressive : patch.aggressive ? 1 : 0,
    detect_range: patch.detectRange ?? current.detect_range,
    move_speed: patch.moveSpeed ?? current.move_speed,
    speed_rate: patch.speedRate === undefined ? current.speed_rate : JSON.stringify(patch.speedRate),
    updated_at: Date.now(),
  };
}

/**
 * 档数变化时把颜色数组对齐到新长度（#720）
 *
 * 只在「这次调用没传颜色」时兜：截短（缩档丢掉多余色）/ 用最后一色垫补（扩档新档先沿用
 * 邻档色，运营随后在管理端挑）。空数组（= 客户端内置色）原样返回，不存在「对齐」问题。
 */
function reconcileTierColors(colors: string[], tierCount: number): string[] {
  if (colors.length === 0 || colors.length === tierCount) return colors;
  if (colors.length > tierCount) return colors.slice(0, tierCount);
  return [...colors, ...Array.from({ length: tierCount - colors.length }, () => colors[colors.length - 1])];
}

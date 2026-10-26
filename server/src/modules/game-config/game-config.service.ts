import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { AcquireChannel } from "../../common/constants/game-config";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { RankRepository, RankListOptions } from "../../database/repositories/rank.repository";
import { DrugRepository, DrugListOptions } from "../../database/repositories/drug.repository";
import { EquipmentRepository, EquipmentListOptions } from "../../database/repositories/equipment.repository";
import { FashionRepository, FashionListOptions } from "../../database/repositories/fashion.repository";
import { ItemRepository, ItemListOptions } from "../../database/repositories/item.repository";
import { MonsterRepository, MonsterListOptions } from "../../database/repositories/monster.repository";
import { SkillRepository, SkillListOptions } from "../../database/repositories/skill.repository";
import { MonsterSkillRepository } from "../../database/repositories/monster-skill.repository";
import { StatusRepository, StatusListOptions } from "../../database/repositories/status.repository";
import { NpcRepository, NpcListOptions } from "../../database/repositories/npc.repository";
import { SoulRepository, SoulListOptions } from "../../database/repositories/soul.repository";
import { TitleRepository, TitleListOptions } from "../../database/repositories/title.repository";
import {
  DrugRow,
  EquipmentRow,
  FashionRow,
  ItemRow,
  MonsterRow,
  MonsterSkillRow,
  NpcRow,
  RankRow,
  SkillRow,
  SoulRow,
  StatusRow,
  TitleRow,
} from "../../database/rows";
import {
  DRUGS,
  EQUIPMENT_BASES,
  FASHIONS,
  ITEM_BASES,
  MONSTER_SKILLS,
  MONSTERS,
  NPCS,
  RANK_LABELS,
  RANK_LEVEL_ATTRIBUTES,
  RANK_LEVEL_META,
  SKILLS,
  SOUL_LABELS,
  STATUSES,
  SOUL_LEVEL_ATTRIBUTES,
  SOUL_LEVEL_META,
  TITLE_LABELS,
  TITLE_LEVEL_ATTRIBUTES,
  TITLE_LEVEL_META,
} from "../../shared/game-data.generated";
import { EquipmentDto, EquipmentQueryDto, UpdateEquipmentDto } from "./dto/equipment.dto";
import { DrugDto, DrugQueryDto, UpdateDrugDto } from "./dto/drug.dto";
import { FashionDto, FashionPageDto, FashionQueryDto, UpdateFashionDto } from "./dto/fashion.dto";
import { ItemDto, ItemQueryDto, UpdateItemDto } from "./dto/item.dto";
import { MonsterAttributesDto, MonsterDto, MonsterQueryDto, UpdateMonsterDto, monsterAttributesFromRow } from "./dto/monster.dto";
import { NpcDto, NpcQueryDto, UpdateNpcDto } from "./dto/npc.dto";
import { CreateSkillDto, parseDamageCoefficients, SkillDto, SkillQueryDto, UpdateSkillDto } from "./dto/skill.dto";
import { MonsterSkillDto, MonsterSkillListDto, ReplaceMonsterSkillsDto } from "./dto/monster-skill.dto";
import { serializeCombat, StatusDto, StatusQueryDto, UpdateStatusDto } from "./dto/status.dto";
import { RankDto, RankQueryDto, UpdateRankDto } from "./dto/rank.dto";
import { SoulDto, SoulQueryDto, UpdateSoulDto } from "./dto/soul.dto";
import {
  attributesFromRow,
  ConfigAttributesDto,
  SEED_ACQUIRE_CHANNEL,
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
    private readonly items: ItemRepository,
    private readonly monstersRepo: MonsterRepository,
    private readonly npcsRepo: NpcRepository,
    private readonly fashionsRepo: FashionRepository,
    private readonly skillsRepo: SkillRepository,
    private readonly statusesRepo: StatusRepository,
    private readonly monsterSkillsRepo: MonsterSkillRepository,
  ) {}

  /** 启动时把客户端配置 seed 进库（幂等；已存在的行原样保留） */
  onModuleInit() {
    this.seedTitles();
    this.seedSouls();
    this.seedRanks();
    this.seedEquipments();
    this.seedDrugs();
    this.seedItems();
    this.seedMonsters();
    this.seedNpcs();
    this.seedFashions();
    this.seedSkills();
    this.seedStatuses();
    this.seedMonsterSkills();
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
      sell_price: dto.sellPrice ?? existing.sell_price,
      max_stack: dto.maxStack ?? existing.max_stack,
      updated_at: Date.now(),
    };
    this.items.update(next);
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
    // 跨字段约束放在写库之前：状态必须真实存在、主动技能得能打出伤害、状态型技能得挂到状态。
    // 只在本次请求**动了分类 / 倍率 / 状态**时才校验 —— 这三个字段之外的部分（名字、冷却、
    // 动作锁……）与约束无关；而且库里存在「分类是主动但没配倍率」的历史行（如 1008 十步一杀，
    // 客户端把它当控制技），按合并后的行无条件校验会让这些行连改名都改不了。
    const touchesConsistency = dto.category !== undefined || dto.damageCoefficients !== undefined || dto.statusId !== undefined;
    if (touchesConsistency) this.assertSkillConsistency(next);
    next.updated_at = Date.now();
    this.skillsRepo.update(next);
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
      updated_at: Date.now(),
    };
    this.assertSkillConsistency(row);
    this.skillsRepo.insert(row);
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

  private requireFashion(id: string): FashionRow {
    const row = this.fashionsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.FASHION_NOT_FOUND, `时装 ${id} 不存在`);
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

  /** 物品与材料 seed：ITEM_BASES 直接灌（只收 MATERIAL / OTHER 大类），5 种 */
  private seedItems() {
    for (const [id, meta] of Object.entries(ITEM_BASES as Record<string, Record<string, unknown>>)) {
      this.items.seedRow({
        id,
        type: String(meta.type ?? ""),
        label: String(meta.label ?? ""),
        description: String(meta.description ?? ""),
        level: Number(meta.level) || 0,
        sell_price: Number(meta.sellPrice) || 0,
        max_stack: Number(meta.maxStack) || 99,
        updated_at: 0,
      });
    }
  }

  /** 怪物 seed：MONSTERS 直接灌（名称 + 已展开战斗数值），220 只（#258） */
  private seedMonsters() {
    for (const [id, meta] of Object.entries(MONSTERS as Record<string, Record<string, unknown>>)) {
      const attributes = meta as unknown as MonsterAttributesRowShape;
      this.monstersRepo.seedRow({
        id,
        label: String(meta.label ?? ""),
        tier: String(meta.tier ?? "normal"),
        level: Number(meta.level) || 1,
        max_hp: Number(meta.maxHp) || 1,
        ...flatMonsterAttributes(attributes),
        updated_at: 0,
      });
    }
  }

  /** NPC seed：NPCS 直接灌（id + 名称），21 个；对话文案客户端没有数据形态，seed 空串（#258） */
  private seedNpcs() {
    for (const [id, meta] of Object.entries(NPCS as Record<string, Record<string, unknown>>)) {
      this.npcsRepo.seedRow({
        id,
        label: String(meta.label ?? ""),
        dialog: "",
        updated_at: 0,
      });
    }
  }

  /** 时装 seed：FASHIONS 直接灌（名称 / 文案 / 资源路径 / 售卖价 / 属性），20 套；渠道默认 unavailable（#257） */
  private seedFashions() {
    for (const [id, meta] of Object.entries(FASHIONS as Record<string, Record<string, unknown>>)) {
      this.fashionsRepo.seedRow({
        id,
        label: String(meta.label ?? ""),
        description: String(meta.description ?? ""),
        icon: String(meta.icon ?? ""),
        in_res: String(meta.in ?? ""),
        out_res: String(meta.out ?? ""),
        sell_price: Number(meta.sellPrice) || 0,
        acquire_channel: SEED_ACQUIRE_CHANNEL,
        ...flatAttributes(meta),
        updated_at: 0,
      });
    }
  }

  /**
   * 技能 seed（#367）：SKILLS 是**整行**快照（owner/分类/动作/特效/冷却/倍率/挂载状态/释放限制），
   * 直接按字段灌；damageCoefficients 落库前序列化成 JSON。
   *
   * 角色技能行 id 固定（客户端技能栏 / 快捷键 / 角色存档都引用它），所以这里只有 INSERT OR IGNORE。
   */
  private seedSkills() {
    for (const [id, meta] of Object.entries(SKILLS as Record<string, Record<string, unknown>>)) {
      const coefficients = Array.isArray(meta.damageCoefficients) ? meta.damageCoefficients : [];
      this.skillsRepo.seedRow({
        id,
        owner: String(meta.owner ?? "role"),
        label: String(meta.label ?? ""),
        icon: String(meta.icon ?? ""),
        category: String(meta.category ?? "0"),
        target_type: String(meta.targetType ?? "1"),
        action: String(meta.action ?? ""),
        effect: String(meta.effect ?? ""),
        effect_on_self: meta.effectOnSelf === true ? 1 : 0,
        cooldown: Number(meta.cooldown) || 0,
        mp_cost: Number(meta.mpCost) || 0,
        distance: Number(meta.distance) || 0,
        level_req: Number(meta.levelReq) || 1,
        description: String(meta.description ?? ""),
        damage_coefficients: JSON.stringify(
          coefficients.map((entry) => {
            const item = (entry ?? {}) as Record<string, unknown>;
            return { baseType: String(item.baseType ?? ""), baseTypeRate: Number(item.baseTypeRate) || 0 };
          }),
        ),
        status_id: String(meta.statusId ?? ""),
        cast_lock_ms: Number(meta.castLockMs) || 0,
        require_target: meta.requireTarget === false ? 0 : 1,
        can_auto: meta.canAuto === true ? 1 : 0,
        updated_at: 0,
      });
    }
  }

  /**
   * 状态 seed（#367）：状态 id 被技能（status_id）引用，清单固定，同样只 INSERT OR IGNORE。
   * combat 落库成 JSON —— 空对象 = 纯表现状态。
   */
  private seedStatuses() {
    for (const [id, meta] of Object.entries(STATUSES as Record<string, Record<string, unknown>>)) {
      this.statusesRepo.seedRow({
        id,
        owner: String(meta.owner ?? "role"),
        label: String(meta.label ?? ""),
        icon: String(meta.icon ?? ""),
        duration: Number(meta.duration) || 0,
        source: String(meta.source ?? "other"),
        description: String(meta.description ?? ""),
        effect: String(meta.effect ?? ""),
        effect_hold_last: meta.effectHoldLast === true ? 1 : 0,
        combat: JSON.stringify(meta.combat ?? {}),
        updated_at: 0,
      });
    }
  }

  /**
   * 怪物技能挂载 seed（#372）：生成物 `MONSTER_SKILLS` 是 `{怪物 key: 条目数组}`
   *
   * 同样只 INSERT OR IGNORE —— 运营在管理端整份替换过的清单不会被重启覆盖回去。
   * 与其它的差别只在「可增删」：删掉的行重启后会被 seed 补回来（配置是基线），
   * 想永久删就同时改 `configs/monster-skills`。这条口径写进服务端 README。
   */
  private seedMonsterSkills() {
    const table = MONSTER_SKILLS as Record<string, Array<{ skillId?: string; priority?: number; cooldown?: number }>>;
    for (const [monsterKey, entries] of Object.entries(table)) {
      for (const entry of entries ?? []) {
        this.monsterSkillsRepo.seedRow({
          monster_key: monsterKey,
          skill_id: String(entry.skillId ?? ""),
          priority: Number(entry.priority) || 0,
          cooldown: entry.cooldown === undefined ? null : Number(entry.cooldown),
          updated_at: 0,
        });
      }
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

/** 生成物 MONSTERS 条目的属性形状（六项区间数组，无 maxHp / hpRecover —— maxHp 是独立字段） */
type MonsterAttributesRowShape = Record<string, unknown> & {
  physicalAttack: number[];
  magicAttack: number[];
  taoistAttack: number[];
  physicalDefense: number[];
  magicDefense: number[];
  taoistDefense: number[];
};

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

/** 生成物 MONSTERS 条目（区间数组形状）→ 拍平行属性列（seed 用） */
function flatMonsterAttributes(attributes: MonsterAttributesRowShape): Pick<MonsterRow, MonsterAttrColumnNames> {
  const range = (value: number[]): [number, number] =>
    Array.isArray(value) && value.length >= 2 ? [Number(value[0]) || 0, Number(value[1]) || 0] : [0, 0];
  return {
    physical_attack_min: range(attributes.physicalAttack)[0],
    physical_attack_max: range(attributes.physicalAttack)[1],
    magic_attack_min: range(attributes.magicAttack)[0],
    magic_attack_max: range(attributes.magicAttack)[1],
    taoist_attack_min: range(attributes.taoistAttack)[0],
    taoist_attack_max: range(attributes.taoistAttack)[1],
    physical_defense_min: range(attributes.physicalDefense)[0],
    physical_defense_max: range(attributes.physicalDefense)[1],
    magic_defense_min: range(attributes.magicDefense)[0],
    magic_defense_max: range(attributes.magicDefense)[1],
    taoist_defense_min: range(attributes.taoistDefense)[0],
    taoist_defense_max: range(attributes.taoistDefense)[1],
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

import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { equipmentLevelOf, equipmentSlotOf, itemLabelOf } from "../../common/runtime-config-cache";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { DrugRepository } from "../../database/repositories/drug.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import { EquipmentVariantRepository } from "../../database/repositories/equipment-variant.repository";
import { MallRepository } from "../../database/repositories/mall.repository";
import {
  CreateMallCategoryDto,
  CreateMallGoodDto,
  MallCatalogItemDto,
  MallCatalogPageDto,
  MallCatalogQueryDto,
  MallCategoryDto,
  MallGoodEntryDto,
  MallGoodItemDto,
  MallGoodQueryDto,
  MALL_CATEGORY_DRUG,
  UpdateMallCategoryDto,
  UpdateMallGoodDto,
} from "./dto/mall.dto";

/**
 * 商品目录里的一行（商品本体 = 装备变体 / 药品，来自各自的表；上架校验与展示共用）
 *
 * 品类（`kind`）决定展示字段怎么读：装备有部位与前后缀，药品都没有（`slot` 空、两位 0）。
 */
interface CatalogEntry {
  id: string;
  /** equipment（装备变体）/ drug（药品） */
  kind: string;
  label: string;
  /** resources 相对路径（装备取基础件图标，药品取 drugs.icon） */
  icon: string;
  /** 部位（药品空串） */
  slot: string;
  /** 装备等级需求 / 药品等级 */
  level: number;
  /** 前缀序号（品质）—— 同一件装备 15 个变体同名，只有这两个序号能分辨；药品恒 0 */
  prefix: number;
  /** 后缀序号（阶级） */
  suffix: number;
}

/** 全量拉取参数：service 层调用不经过 ValidationPipe，size 不受 HTTP 边界的 100 限制 */
const ALL = { page: 1, size: 1_000_000 };

/**
 * 商城分类与上架商品（#251 / #655 / #758）
 *
 * **商品是关联数据**：一件商品 = 装备变体（`equipment_variants` 表）+ 两个运营字段
 * （售价 / 购买等级，`mall_goods` 表）。运营不能凭空造商品 —— 上架时服务端校验 id
 * 在装备目录里；已上架的商品也**只许改售价与购买等级**，名称/图标/部位归装备管理管。
 *
 * 陈列结构：运营先建分类（`mall_categories`，动态增删），再把商品上架到某个分类
 * （`mall_goods`，动态增删；一件装备全商城只能挂一行，换分类先下架再上架）。
 * 出厂数据为空 —— 商城开张前必须先建分类（存量库迁移会带一个「默认分类」接住老特殊价）。
 *
 * 购买链路（`RolesService.purchaseMallGood`）与本服务**同源**：`priceOf` /
 * `requireGood` 都查 `mall_goods`，后台下架 / 改价 / 改等级立即对购买生效；等级校验
 * 也在服务端做（客户端按钮置灰只是提前提示，不是防线）。
 */
@Injectable()
export class MallPricingService {
  constructor(
    private readonly mall: MallRepository,
    private readonly variants: EquipmentVariantRepository,
    private readonly equipments: EquipmentRepository,
    private readonly drugs: DrugRepository,
  ) {}

  //#region 分类

  listCategories(): MallCategoryDto[] {
    const goods = this.mall.listGoods();
    const counts = new Map<string, number>();
    goods.forEach((row) => counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1));
    return this.mall.listCategories().map((row) => MallCategoryDto.from(row, counts.get(row.id) ?? 0));
  }

  createCategory(dto: CreateMallCategoryDto): MallCategoryDto {
    const row = {
      id: `mc_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
      label: dto.label,
      sort_order: dto.sortOrder ?? Number.MAX_SAFE_INTEGER,
      updated_at: Date.now(),
    };
    this.mall.insertCategory(row);
    return MallCategoryDto.from(row, 0);
  }

  updateCategory(id: string, dto: UpdateMallCategoryDto): MallCategoryDto {
    this.requireCategory(id);
    this.mall.updateCategory(id, { label: dto.label, sort_order: dto.sortOrder });
    return MallCategoryDto.from(this.mall.findCategory(id)!, this.mall.countGoodsInCategory(id));
  }

  /** 删分类：分类下还有上架商品 → 409（先移走或下架，不静默搬走运营摆好的货） */
  deleteCategory(id: string): { id: string; removed: true } {
    this.requireCategory(id);
    if (this.mall.countGoodsInCategory(id) > 0) {
      throw BizException.conflict(BizCode.MALL_CATEGORY_NOT_EMPTY, "分类下还有上架商品，先移走或下架再删除");
    }
    this.mall.deleteCategory(id);
    return { id, removed: true };
  }

  //#endregion

  //#region 上架商品

  /**
   * 上架商品列表 = `mall_goods` LEFT JOIN 装备目录后**内存分页**
   *
   * 目录每次现查库（#655 同口径）：管理端改了装备名 / 等级，商城列表立刻反映。
   * 查询条件：分类 / 关键字（id 与显示名）/ 部位。排序按 分类序 → 部位序 → 等级 → id。
   */
  listGoods(query: MallGoodQueryDto): PageResult<MallGoodItemDto> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const keyword = query.keyword?.trim() ?? "";
    const keywordLower = keyword ? keyword.toLowerCase() : "";

    const catalog = new Map(this.catalogEntries().map((entry) => [entry.id, entry]));
    const categoryOrder = new Map(this.mall.listCategories().map((row, index) => [row.id, index]));
    const rows = this.mall
      .listGoods()
      .filter((row) => {
        if (query.categoryId && row.category_id !== query.categoryId) return false;
        const entry = catalog.get(row.id);
        if (!entry) return true; // 上架后装备/药品被删了的孤儿行：照实列出（label 退回 id），运营看得见才好处理
        if (query.kind && entry.kind !== query.kind) return false;
        if (query.slot && entry.slot !== query.slot) return false;
        if (keywordLower && !row.id.toLowerCase().includes(keywordLower) && !entry.label.includes(keyword)) return false;
        return true;
      })
      .map((row) => this.itemOf(row, catalog.get(row.id)))
      .sort(
        (a, b) =>
          (categoryOrder.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) ||
          (catalog.get(a.id)?.level ?? 0) - (catalog.get(b.id)?.level ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );

    const total = rows.length;
    const list = rows.slice((page - 1) * size, page * size);
    return { list, total, page, size };
  }

  /**
   * 上架弹窗的候选物品目录（#763）：装备变体 + 药品，按 **分类（部位 / 药品）与等级** 筛
   *
   * 弹窗不再自己拼 `equipmentVariantsApi` —— 两类物品的字段口径不同（药品没有部位与前后缀），
   * 统一在这里拼成同一形状，管理端只认 `kind / slot / level` 三个筛选键。
   *
   * `levels` 回的是**当前分类下出现过的等级**（不受关键字影响）：等级下拉需要知道有哪些档，
   * 让运营照着点，而不是拿键盘试。
   */
  listCatalog(query: MallCatalogQueryDto): MallCatalogPageDto {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const keyword = query.keyword?.trim() ?? "";
    const keywordLower = keyword ? keyword.toLowerCase() : "";
    const inCategory = (entry: CatalogEntry) =>
      !query.category || (query.category === MALL_CATEGORY_DRUG ? entry.kind === MALL_CATEGORY_DRUG : entry.slot === query.category);

    const catalog = this.catalogEntries();
    const levels = Array.from(
      new Set(catalog.filter(inCategory).map((entry) => entry.level)),
    ).sort((a, b) => a - b);
    const listed = new Set(this.mall.listGoods().map((row) => row.id));

    const rows = catalog.filter((entry) => {
      if (!inCategory(entry)) return false;
      if (query.level !== undefined && entry.level !== query.level) return false;
      if (keywordLower && !entry.id.toLowerCase().includes(keywordLower) && !entry.label.includes(keyword)) return false;
      return true;
    });

    const total = rows.length;
    const list = rows.slice((page - 1) * size, page * size).map((entry) => {
      const item = new MallCatalogItemDto();
      item.id = entry.id;
      item.kind = entry.kind;
      item.label = entry.label;
      item.icon = entry.icon;
      item.slot = entry.slot;
      item.level = entry.level;
      item.prefix = entry.prefix;
      item.suffix = entry.suffix;
      item.listed = listed.has(entry.id);
      return item;
    });
    return { list, total, page, size, levels };
  }

  /** 上架：商品 id 必须是装备变体（404 50021）、分类必须存在（404 50025）、不能重复上架（409 50026） */
  createGood(dto: CreateMallGoodDto): MallGoodItemDto {
    this.requireCategory(dto.categoryId);
    const entry = this.requireCatalogEntry(dto.id);
    if (this.mall.findGood(dto.id)) {
      throw BizException.conflict(BizCode.MALL_GOOD_ALREADY_LISTED, `商品 ${dto.id} 已在商城上架（一件装备只能挂一行，换分类先下架）`);
    }
    const row = {
      id: dto.id,
      category_id: dto.categoryId,
      price: dto.price ?? 0,
      required_level: dto.requiredLevel ?? 0,
      updated_at: Date.now(),
    };
    this.mall.insertGood(row);
    return this.itemOf(row, entry);
  }

  /** 改售价 / 购买等级（商品本体字段不接受修改 —— 关联数据只开放这两个运营字段） */
  updateGood(id: string, dto: UpdateMallGoodDto): MallGoodItemDto {
    this.requireGood(id);
    this.mall.updateGood(id, { price: dto.price, required_level: dto.requiredLevel });
    const catalog = new Map(this.catalogEntries().map((entry) => [entry.id, entry]));
    return this.itemOf(this.mall.findGood(id)!, catalog.get(id));
  }

  /** 下架（删行）：不在上架清单 → 404 50021（删无可删不静默成功） */
  removeGood(id: string): { id: string; removed: true } {
    this.requireGood(id);
    this.mall.removeGood(id);
    return { id, removed: true };
  }

  //#endregion

  // —— 购买链路（RolesService 用；与管理端同源） ——

  /**
   * 读一件商品的**成交价**（玩家侧购买用，#304）：只在 `mall_goods` 里 ——
   * 没有特殊价 / 统一价两层了，上架时的售价就是唯一价格，改了立即生效。
   * @throws BizException 商品不在上架清单 → 404 MALL_GOOD_NOT_FOUND
   */
  priceOf(id: string): number {
    return this.requireGood(id).price;
  }

  /** 读一件商品的购买等级（购买链路的等级校验用） */
  requiredLevelOf(id: string): number {
    return this.requireGood(id).required_level;
  }

  // —— 内部 ——

  /** 分类必须存在（404 50025） */
  private requireCategory(id: string): void {
    if (!this.mall.findCategory(id)) {
      throw BizException.notFound(BizCode.MALL_CATEGORY_NOT_FOUND, `分类 ${id} 不存在（可能已被删除）`);
    }
  }

  /** 上架商品必须存在（404 50021）；返回库里那行 */
  private requireGood(id: string) {
    const row = this.mall.findGood(id);
    if (!row) throw BizException.notFound(BizCode.MALL_GOOD_NOT_FOUND, `商品 ${id} 不在商城上架清单里`);
    return row;
  }

  /**
   * 目录校验（上架时用；目录 = 装备全量变体 + 药品，现查库）
   *
   * 装备先按 runtime cache 判存在（与结算同源），药品查 `drugs` 表 —— 两类物品的
   * 「在不在目录里」是两张表，不能只留装备那条，否则药品永远上不了架。
   */
  private requireCatalogEntry(id: string): CatalogEntry {
    const equipLevel = equipmentLevelOf(id);
    if (equipLevel !== null) {
      const variant = this.variants.findById(id);
      return {
        id,
        kind: "equipment",
        label: itemLabelOf(id) ?? id,
        icon: this.iconOfBase(variant?.base_id),
        slot: equipmentSlotOf(id) ?? "",
        level: equipLevel,
        prefix: Number(variant?.prefix) || 0,
        suffix: Number(variant?.suffix) || 0,
      };
    }
    const drug = this.drugs.findByKey(id);
    if (drug) {
      return {
        id,
        kind: "drug",
        label: drug.label,
        icon: drug.icon,
        slot: "",
        level: Number(drug.level) || 0,
        prefix: 0,
        suffix: 0,
      };
    }
    throw BizException.notFound(BizCode.MALL_GOOD_NOT_FOUND, `商品 ${id} 不在商城目录里（只卖装备与药品）`);
  }

  /** 上架行 + 目录 → 展示视图（孤儿行 label 退回 id，照实显示便于运营清理） */
  private itemOf(row: { id: string; category_id: string; price: number; required_level: number; updated_at: number }, entry?: CatalogEntry): MallGoodItemDto {
    return {
      id: row.id,
      categoryId: row.category_id,
      kind: entry?.kind ?? "",
      label: entry?.label ?? row.id,
      icon: entry?.icon ?? "",
      slot: entry?.slot ?? "",
      level: entry?.level ?? 0,
      prefix: entry?.prefix ?? 0,
      suffix: entry?.suffix ?? 0,
      price: row.price,
      requiredLevel: row.required_level,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 商城目录（= 全部装备变体 + 全部药品 + 名称 / 图标 / 部位 / 等级 / 前后缀序号），每次现查库
   *
   * 排序：装备在前（部位序 `equipment_slots.sort_order` → 等级 → id），药品在后（等级 → id）。
   * 两类不能混着排 —— 药品没有部位，混排会让「武器」和「金创药」交替出现。
   */
  private catalogEntries(): CatalogEntry[] {
    const slotOrder = new Map(this.equipments.listSlots().map((row) => [row.key, Number(row.sort_order) || 0]));
    const bases = this.equipments.list({ ...ALL });
    const slotOfBase = new Map(bases.map((row) => [row.id, row.slot]));
    const iconOfBase = new Map(bases.map((row) => [row.id, row.icon]));
    const equipments: CatalogEntry[] = this.variants.listAll().map((row) => ({
      id: row.id,
      kind: "equipment",
      label: row.label,
      icon: iconOfBase.get(row.base_id) ?? "",
      slot: slotOfBase.get(row.base_id) ?? "",
      level: Number(row.level) || 0,
      prefix: Number(row.prefix) || 0,
      suffix: Number(row.suffix) || 0,
    }));
    equipments.sort(
      (a, b) =>
        (slotOrder.get(a.slot) ?? Number.MAX_SAFE_INTEGER) - (slotOrder.get(b.slot) ?? Number.MAX_SAFE_INTEGER) ||
        a.level - b.level ||
        (a.id < b.id ? -1 : 1),
    );
    const drugs: CatalogEntry[] = this.drugs.list({ ...ALL }).map((row) => ({
      id: row.id,
      kind: "drug",
      label: row.label,
      icon: row.icon,
      slot: "",
      level: Number(row.level) || 0,
      prefix: 0,
      suffix: 0,
    }));
    drugs.sort((a, b) => a.level - b.level || (a.id < b.id ? -1 : 1));
    return equipments.concat(drugs);
  }

  /** 基础件的图标路径（上架响应里给一件装备时用；查不到返回空串，管理端显示占位图） */
  private iconOfBase(baseId: string | undefined): string {
    if (!baseId) return "";
    return this.equipments.list({ ...ALL }).find((row) => row.id === baseId)?.icon ?? "";
  }

  /** 快照段：上架商品（客户端陈列与购买同源） */
  snapshotGoods(): MallGoodEntryDto[] {
    return this.mall.listGoods().map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      price: row.price,
      requiredLevel: row.required_level,
    }));
  }
}

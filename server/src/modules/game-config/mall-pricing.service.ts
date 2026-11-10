import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { equipmentLevelOf, equipmentSlotOf, itemLabelOf, sellPriceOf } from "../../common/runtime-config-cache";
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
  MallGoodPageDto,
  MallGoodQueryDto,
  MallLimitDto,
  MallLimitsDto,
  MallStockResetDto,
  MALL_CATEGORY_DRUG,
  MALL_DAILY_LIMIT_MAX,
  MALL_PRICE_MIN,
  MALL_RECYCLE_RATIO_MAX,
  MALL_STOCK_MAX,
  MALL_STOCK_UNLIMITED,
  UpdateMallCategoryDto,
  UpdateMallGoodDto,
} from "./dto/mall.dto";
import { todayResetDay } from "../../common/utils/daily-clock";

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
   * 上架商品列表 = `mall_goods` LEFT JOIN 目录后**内存分页**
   *
   * 目录每次现查库（#655 同口径）：管理端改了装备名 / 等级，商城列表立刻反映。
   * 检索四件套：**商城分类**（陈列分组）/ 关键字（id 与显示名）/ 物品等级 / 品类与部位。
   *
   * `levels` 回的是**当前分类范围内**出现过的物品等级（不受关键字与等级筛选影响）——
   * 等级下拉要有选项可选，跟着筛选结果收缩就只剩当前选中的那一档了。
   */
  listGoods(query: MallGoodQueryDto): MallGoodPageDto {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const keyword = query.keyword?.trim() ?? "";
    const keywordLower = keyword ? keyword.toLowerCase() : "";

    const catalog = new Map(this.catalogEntries().map((entry) => [entry.id, entry]));
    const categoryOrder = new Map(this.mall.listCategories().map((row, index) => [row.id, index]));
    const sold = this.mall.soldMap();
    const scoped = this.mall
      .listGoods()
      .filter((row) => !query.categoryId || row.category_id === query.categoryId)
      .map((row) => this.itemOf(row, catalog.get(row.id), sold.get(row.id) ?? 0));
    const levels = Array.from(new Set(scoped.map((item) => item.level))).sort((a, b) => a - b);

    const rows = scoped
      .filter((item) => {
        // 孤儿行（上架后本体被删）的 kind 为空：照实列出，别拿它去比品类/部位
        if (item.kind) {
          if (query.kind && item.kind !== query.kind) return false;
          if (query.slot && item.slot !== query.slot) return false;
        }
        if (keywordLower && !item.id.toLowerCase().includes(keywordLower) && !item.label.includes(keyword)) return false;
        if (query.level !== undefined && item.level !== query.level) return false;
        return true;
      })
      .sort(
        (a, b) =>
          (categoryOrder.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) ||
          a.level - b.level ||
          (a.id < b.id ? -1 : 1),
      );

    const total = rows.length;
    const list = rows.slice((page - 1) * size, page * size);
    return { list, total, page, size, levels };
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
      // 缺省价是 1 而不是 0：见 MALL_PRICE_MIN 的注释（0 = 免费印钞）
      price: this.ensurePriceSane(dto.id, Math.max(MALL_PRICE_MIN, dto.price ?? MALL_PRICE_MIN)),
      required_level: dto.requiredLevel ?? 0,
      // 缺省 = 不限购 / 不限量：与加这两列之前的行为一致（新上架的商品不该默认买不了）
      daily_limit: this.ensureDailyLimit(dto.dailyLimit),
      stock: this.ensureStock(dto.stock),
      updated_at: Date.now(),
    };
    this.mall.insertGood(row);
    return this.itemOf(row, entry, 0);
  }

  /**
   * 改商城字段：所属分类 / 售价 / 购买等级 / 每日限购 / 库存
   *
   * 商品本体字段一概不改 —— 关联数据只开放这几个运营字段。改分类要先确认目标分类存在
   * （404 50025），否则会留下一条指向不存在分类的孤儿行（客户端页签里看不见它）。
   *
   * 限购与库存改完**立即生效**：购买链路现查库（`priceOf` 同源），不缓存。
   */
  updateGood(id: string, dto: UpdateMallGoodDto): MallGoodItemDto {
    this.requireGood(id);
    if (dto.categoryId !== undefined) this.requireCategory(dto.categoryId);
    // 改价同样过定价不变式：只改分类时跳过（价格没动，不需要重判）
    const price = dto.price === undefined ? undefined : this.ensurePriceSane(id, Math.max(MALL_PRICE_MIN, dto.price));
    this.mall.updateGood(id, {
      category_id: dto.categoryId,
      price,
      required_level: dto.requiredLevel,
      daily_limit: dto.dailyLimit === undefined ? undefined : this.ensureDailyLimit(dto.dailyLimit),
      stock: dto.stock === undefined ? undefined : this.ensureStock(dto.stock),
    });
    const catalog = new Map(this.catalogEntries().map((entry) => [entry.id, entry]));
    return this.itemOf(this.mall.findGood(id)!, catalog.get(id), this.mall.soldOf(id));
  }

  /**
   * 下架（删行）：不在上架清单 → 404 50021（删无可删不静默成功）
   *
   * **同时清掉已售计数**：下架 = 这一轮售卖结束，重新上架是一件新商品。
   * 不清的话，卖满 100 件的商品重新上架时会沿用旧的 `sold = 100`，配一个 `stock = 50`
   * 就变成「刚上架就售罄」，运营只会以为是 bug。
   */
  removeGood(id: string): { id: string; removed: true } {
    this.requireGood(id);
    this.mall.removeGood(id);
    this.mall.resetStock(id);
    return { id, removed: true };
  }

  /**
   * 重置库存（#846 运营手动续货）：把已售件数清零，商品重新可买
   *
   * 与「把 `stock` 改大」的区别在**数据**上：改 `stock` 是改配置（快照内容变了），
   * 重置销量只动运行时计数（快照一个字节不变）。
   *
   * 注意配置版本：这个接口带 `gameConfig:write` 权限点，而版本 +1 的判据就是这个权限点
   * （`ConfigVersionInterceptor`），所以它**照样会让版本 +1**、客户端重拉一次快照。
   * 不为这一个动作新开权限点 —— 「能改全服配置」本来就只有一个门槛，多开一个只会多一处漏配。
   */
  resetStock(id: string): MallStockResetDto {
    this.requireGood(id);
    this.mall.resetStock(id);
    return { id, sold: 0, reset: true };
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

  /** 读限购与库存配置（购买链路的判据；0 / -1 都表示「这条规则不生效」） */
  limitsOfGood(id: string): { dailyLimit: number; stock: number } {
    const row = this.requireGood(id);
    return { dailyLimit: Number(row.daily_limit) || 0, stock: Number.isFinite(row.stock) ? Number(row.stock) : MALL_STOCK_UNLIMITED };
  }

  /**
   * 当前角色在**全部上架商品**上的限购 / 库存视图（#846，客户端打开商城时拉一遍）
   *
   * 一次给全量而不是按商品拉：商城弹窗一屏就要陈列十几件，逐件请求既慢又会出现
   * 「一半是旧数一半是新数」的中途态。上架商品是运营手挑的（出厂 1 行、几十行的量级），
   * 整份返回不心疼。
   */
  limitsOf(roleId: string): MallLimitsDto {
    const day = todayResetDay();
    const bought = new Map(this.mall.listSalesOf(roleId, day).map((row) => [row.good_id, Number(row.count) || 0]));
    const sold = this.mall.soldMap();
    const dto = new MallLimitsDto();
    dto.day = day;
    dto.list = this.mall.listGoods().map((row) => {
      const item = new MallLimitDto();
      const dailyLimit = Number(row.daily_limit) || 0;
      const stock = Number.isFinite(row.stock) ? Number(row.stock) : MALL_STOCK_UNLIMITED;
      const soldCount = sold.get(row.id) ?? 0;
      item.goodId = row.id;
      item.dailyBought = bought.get(row.id) ?? 0;
      item.dailyLimit = dailyLimit;
      item.sold = soldCount;
      item.stock = stock;
      // 只看限购与库存：等级 / 余额是「这个角色此刻的另一个维度」，客户端另有判据（置灰同理）
      item.purchasable = (dailyLimit <= 0 || item.dailyBought < dailyLimit) && (stock < 0 || soldCount < stock);
      return item;
    });
    return dto;
  }

  // —— 内部 ——

  /**
   * 定价不变式（#814 / C3）：**回收价 ≤ 售价 × 50%**
   *
   * 为什么必须在写配置时就拦，而不是只在结算时兜：回收价是客户端展示的价签
   * （`sell_price` 列，背包「一键回收」与详情弹窗都读它），服务端结算又按同一列付钱 ——
   * 若在付款时才夹取，玩家看到 100 实得 50，就退回 #545「价签不对」那类投诉。
   * 所以这里让**配置本身**不合法，价签与结算永远同一个数。
   *
   * 与「售价下限 1」是同一条不变式的两半：只压回收价（价 0 / 回收 0）虽然免费但不产金币，
   * 只抬售价（价 1 / 回收 1）仍然不亏 —— 合起来才有「买进卖出净亏一半」。
   * 推论要提前知道：售价 1 的商品 `floor(1 × 0.5) = 0`，也就是**卖不掉**；
   * 想让某件能回收 20，售价至少得 40。
   *
   * 回收价取自 `sellPriceOf`（与结算同一来源：运营库覆盖层 → 出厂价签），不另查一份表，
   * 否则两边漂移时校验形同虚设。
   *
   * @param raw 待校验的售价（写配置传运营输入，购买链路传库里那行的现值）
   * @returns 规范化后的售价（不会自行夹到 ≥ 1：购买链路要看到库里的真值）
   */
  ensurePriceSane(goodId: string, raw: number): number {
    const price = Math.max(0, Math.floor(raw));
    const recycle = Math.max(0, Math.floor(sellPriceOf(goodId) ?? 0));
    if (recycle > price * MALL_RECYCLE_RATIO_MAX) {
      throw BizException.conflict(
        BizCode.MALL_PRICE_INVALID,
        `定价不合法：${goodId} 的回收价 ${recycle} 高于售价 ${price} 的 ${MALL_RECYCLE_RATIO_MAX * 100}%（上限 ${Math.floor(price * MALL_RECYCLE_RATIO_MAX)}）—— 这样的商品买进卖出就能刷金币`,
      );
    }
    return price;
  }

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
  private itemOf(
    row: { id: string; category_id: string; price: number; required_level: number; daily_limit: number; stock: number; updated_at: number },
    entry?: CatalogEntry,
    sold = 0,
  ): MallGoodItemDto {
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
      dailyLimit: Number(row.daily_limit) || 0,
      stock: Number.isFinite(row.stock) ? Number(row.stock) : MALL_STOCK_UNLIMITED,
      sold,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 每日限购规范化：缺省 0（不限购），负数当 0 —— 与 `DO` 层校验同一口径
   *
   * 服务端这里只做「夹到合法区间的整数」而不抛错：DTO 已经把 HTTP 入参拦住了，
   * 走到这里还越界只可能是内部调用（例如迁移脚本），那里不该因为一个默认值炸掉。
   */
  private ensureDailyLimit(raw: number | undefined): number {
    if (raw === undefined) return 0;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, MALL_DAILY_LIMIT_MAX);
  }

  /** 库存规范化：缺省 -1（不限量），`0` 是合法值（售罄停售） */
  private ensureStock(raw: number | undefined): number {
    if (raw === undefined) return MALL_STOCK_UNLIMITED;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 0) return MALL_STOCK_UNLIMITED;
    return Math.min(value, MALL_STOCK_MAX);
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

  /**
   * 快照段：上架商品（客户端陈列与购买同源）
   *
   * 只带**配置**（售价 / 等级 / 限购 / 库存）。「今天买了几个」「已售几件」是运行时数字，
   * 随角色与时刻变，走 `limitsOf`（`GET /roles/:roleId/mall-limits`）。
   */
  snapshotGoods(): MallGoodEntryDto[] {
    return this.mall.listGoods().map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      price: row.price,
      requiredLevel: row.required_level,
      dailyLimit: Number(row.daily_limit) || 0,
      stock: Number.isFinite(row.stock) ? Number(row.stock) : MALL_STOCK_UNLIMITED,
    }));
  }
}

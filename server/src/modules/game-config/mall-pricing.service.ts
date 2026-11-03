import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { equipmentLevelOf, equipmentSlotOf, itemLabelOf } from "../../common/runtime-config-cache";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import { EquipmentVariantRepository } from "../../database/repositories/equipment-variant.repository";
import { MallRepository } from "../../database/repositories/mall.repository";
import {
  MallPriceItemDto,
  MallPriceQueryDto,
  MallSettingsDto,
  PutMallPriceDto,
  UpdateMallSettingsDto,
} from "./dto/mall.dto";

/** 商品目录里的一行（商品本体 = 装备全量变体，来自 `equipment_variants` 表） */
interface CatalogEntry {
  id: string;
  label: string;
  slot: string;
  level: number;
}

/** 全量拉取参数：service 层调用不经过 ValidationPipe，size 不受 HTTP 边界的 100 限制 */
const ALL = { page: 1, size: 1_000_000 };

/**
 * 商城定价（#251 / #655）
 *
 * **与配置表方向相反**：商品清单不是独立数据 —— 它就是装备全量变体（555 件，
 * `equipment_variants` 表）；价格才是商城自己的数据 —— `mall_prices` 特殊价行
 * **动态增删**（PUT upsert / DELETE 删行回到统一价），`mall_settings` 单行统一价
 * （出厂值随 `config-sync.sql` 首次建库灌入）。
 *
 * 列表 = 装备变体 LEFT JOIN 特殊价后**内存分页**（555 件一页装不下但内存排序毫无压力），
 * 未定价的 `price` 为 null（走统一价）—— 与客户端 getMallPrice「特殊价优先，否则统一价」
 * 的取值口径一致。
 *
 * ## #655：目录每次现查库
 * 以前目录在启动时按生成物构建一次（`EQUIPMENT_ATTRIBUTES` 等四张表联查）。
 * 那是「代码里的第二份装备清单」：管理端改名 / 调等级后，商城列表还是旧值。
 * 现在每次 `listPrices` 现查三张表（变体 / 基础件 / 部位），改完立刻反映。
 */
@Injectable()
export class MallPricingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MallPricingService.name);

  constructor(
    private readonly mall: MallRepository,
    private readonly variants: EquipmentVariantRepository,
    private readonly equipments: EquipmentRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.mall.getSettings()) {
      this.logger.error("mall_settings 没有行 —— 商城统一价缺失，购买会一直报错（跑 make config-import）");
    }
  }

  getSettings(): MallSettingsDto {
    const row = this.mall.getSettings();
    if (!row) throw new BizException(BizCode.INTERNAL, "统一价配置行缺失（mall_settings 被清了？）");
    return MallSettingsDto.from(row);
  }

  updateSettings(dto: UpdateMallSettingsDto): MallSettingsDto {
    this.mall.updateSettings(dto.defaultPrice);
    return this.getSettings();
  }

  listPrices(query: MallPriceQueryDto): PageResult<MallPriceItemDto> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const keyword = query.keyword?.trim() ?? "";
    const pricedFilter = query.priced === undefined ? undefined : query.priced === "true";

    // 特殊价索引（每次现读 —— 与其他配置列表同一口径，不做缓存）
    const special = new Map(this.mall.listAll().map((row) => [row.id, row]));

    const keywordLower = keyword ? keyword.toLowerCase() : "";
    const rows = this.catalog()
      .filter((entry) => {
        if (query.slot && entry.slot !== query.slot) return false;
        if (keywordLower && !entry.id.toLowerCase().includes(keywordLower) && !entry.label.includes(keyword)) return false;
        if (pricedFilter !== undefined && special.has(entry.id) !== pricedFilter) return false;
        return true;
      })
      .map((entry): MallPriceItemDto => {
        const row = special.get(entry.id);
        return {
          id: entry.id,
          label: entry.label,
          slot: entry.slot,
          level: entry.level,
          price: row ? row.price : null,
          updatedAt: row ? row.updated_at : null,
        };
      });

    const total = rows.length;
    const list = rows.slice((page - 1) * size, page * size);
    return { list, total, page, size };
  }

  /** 设置单件特殊价（PUT = upsert；商品 id 必须是装备变体） */
  putPrice(id: string, dto: PutMallPriceDto): MallPriceItemDto {
    const entry = this.requireGood(id);
    this.mall.upsert({ id, price: dto.price, updated_at: Date.now() });
    return this.itemOf(entry, dto.price, Date.now());
  }

  /** 删一条特殊价（商品回到统一价） */
  removePrice(id: string): { id: string; removed: true } {
    this.requireGood(id);
    const removed = this.mall.remove(id);
    if (removed.changes === 0) {
      throw BizException.notFound(BizCode.MALL_GOOD_NOT_FOUND, `商品 ${id} 没有特殊价（本来就走统一价）`);
    }
    return { id, removed: true };
  }

  /**
   * 读一件商品的**成交价**（玩家侧购买用，#304）：特殊价优先，没有特殊价走统一价
   *
   * 与管理端列表接口同源（同读 mall_prices / mall_settings），后台改价立即对购买生效。
   * @throws BizException 商品不在商城目录（只卖装备变体）→ 404 MALL_GOOD_NOT_FOUND
   */
  priceOf(id: string): number {
    this.requireGood(id);
    const special = this.mall.findByKey(id);
    return special ? special.price : this.getSettings().defaultPrice;
  }

  // —— 内部 ——

  /** 商品 id 必须是装备变体（结算层已经知道所有装备 id，不必再查一次表） */
  private requireGood(id: string): CatalogEntry {
    const level = equipmentLevelOf(id);
    if (level === null) throw BizException.notFound(BizCode.MALL_GOOD_NOT_FOUND, `商品 ${id} 不在商城商品清单里`);
    return {
      id,
      label: itemLabelOf(id) ?? id,
      slot: equipmentSlotOf(id) ?? "",
      level,
    };
  }

  private itemOf(entry: CatalogEntry, price: number, updatedAt: number): MallPriceItemDto {
    return { id: entry.id, label: entry.label, slot: entry.slot, level: entry.level, price, updatedAt };
  }

  /**
   * 构建商品目录：装备变体 + 基础件（部位）+ 部位表（排序）
   *
   * 排序口径与客户端 `getMallGoods` 一致：部位序 → 等级 → id。部位序来自
   * `equipment_slots.sort_order`，所以运营调整部位顺序会直接反映到商城列表。
   */
  private catalog(): CatalogEntry[] {
    const slotOrder = new Map(this.equipments.listSlots().map((row) => [row.key, Number(row.sort_order) || 0]));
    const slotOfBase = new Map(this.equipments.list({ ...ALL }).map((row) => [row.id, row.slot]));
    const entries = this.variants.listAll().map((row) => ({
      id: row.id,
      label: row.label,
      slot: slotOfBase.get(row.base_id) ?? "",
      level: Number(row.level) || 0,
    }));
    entries.sort(
      (a, b) =>
        (slotOrder.get(a.slot) ?? Number.MAX_SAFE_INTEGER) - (slotOrder.get(b.slot) ?? Number.MAX_SAFE_INTEGER) ||
        a.level - b.level ||
        (a.id < b.id ? -1 : 1),
    );
    return entries;
  }
}

import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizException } from "../../common/errors/biz.exception";
import { BizCode } from "../../common/constants/biz-code";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { MallRepository } from "../../database/repositories/mall.repository";
import {
  EQUIPMENT_ATTRIBUTES,
  EQUIPMENT_BASES,
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOT_OF,
  EQUIPMENT_SLOT_ORDER,
  MALL,
} from "../../shared/game-data.generated";
import {
  MallPriceItemDto,
  MallPricePageDto,
  MallPriceQueryDto,
  MallSettingsDto,
  PutMallPriceDto,
  UpdateMallSettingsDto,
} from "./dto/mall.dto";

/** 商品目录里的一行（构建一次，复用到进程退出；商品本体 = 装备全量变体，清单来自生成物） */
interface CatalogEntry {
  id: string;
  label: string;
  slot: string;
  level: number;
}

/**
 * 商城定价（#251）
 *
 * **与配置表方向相反**：商品清单来自生成物（装备七部位全量变体，555 件），价格才是
 * 服务端数据 —— `mall_prices` 特殊价行**动态增删**（PUT upsert / DELETE 删行回到统一价），
 * `mall_settings` 单行统一价 seed 自生成物 MALL_DEFAULT_PRICE。
 * 列表 = 商品目录 LEFT JOIN 特殊价后**内存分页**（555 件一页装不下但内存排序毫无压力），
 * 未定价的 `price` 为 null（走统一价）—— 与客户端 getMallPrice「特殊价优先，否则统一价」
 * 的取值口径一致。
 */
@Injectable()
export class MallPricingService implements OnModuleInit {
  /** 商品目录（进程内只构建一次；装备清单是生成物，运行期不变） */
  private catalog: CatalogEntry[] = [];

  constructor(private readonly mall: MallRepository) {}

  /** 启动时构建商品目录 + seed 统一价（幂等；已存在的行原样保留） */
  onModuleInit() {
    this.catalog = this.buildCatalog();
    this.mall.seedSettings(Number(MALL.defaultPrice) || 0);
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
    const rows = this.catalog
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

  /** 设置单件特殊价（PUT = upsert；商品 id 必须在生成物清单里） */
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

  // —— 内部 ——

  /** 商品 id 必须在生成物的装备清单里（商品本体不归定价管，但没有商品就没有定价） */
  private requireGood(id: string): CatalogEntry {
    const entry = this.catalog.find((item) => item.id === id);
    if (!entry) throw BizException.notFound(BizCode.MALL_GOOD_NOT_FOUND, `商品 ${id} 不在商城商品清单里`);
    return entry;
  }

  private itemOf(entry: CatalogEntry, price: number, updatedAt: number): MallPriceItemDto {
    return { id: entry.id, label: entry.label, slot: entry.slot, level: entry.level, price, updatedAt };
  }

  /** 构建商品目录：生成物四表联查 + 排序（部位序 → 等级 → id；与客户端 getMallGoods 同口径） */
  private buildCatalog(): CatalogEntry[] {
    const slotOrder = (slot: string) => EQUIPMENT_SLOT_ORDER[slot as keyof typeof EQUIPMENT_SLOT_ORDER] ?? Number.MAX_SAFE_INTEGER;
    const entries = Object.keys(EQUIPMENT_ATTRIBUTES).map((id) => {
      // 变体 id = `${baseId}_pXsY`；剥掉品质后缀即基础件 id（基础件本身没有 _p 段）
      const baseId = id.replace(/_p\d+s\d+$/, "");
      const base = EQUIPMENT_BASES[baseId as keyof typeof EQUIPMENT_BASES] as { level?: unknown } | undefined;
      return {
        id,
        label: String(EQUIPMENT_DISPLAY_NAMES[id as keyof typeof EQUIPMENT_DISPLAY_NAMES] ?? id),
        slot: String(EQUIPMENT_SLOT_OF[id as keyof typeof EQUIPMENT_SLOT_OF] ?? ""),
        level: Number(base?.level) || 0,
        order: 0,
      };
    });
    entries.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || a.level - b.level || (a.id < b.id ? -1 : 1));
    return entries;
  }
}

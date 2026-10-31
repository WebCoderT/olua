import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { DropTableRepository } from "../../database/repositories/drop-table.repository";
import { MonsterDropRepository, MonsterDropListOptions } from "../../database/repositories/monster-drop.repository";
import { DropTableRow, MonsterDropRow } from "../../database/rows";
import { DROP_DEFAULT, DROP_TABLES, ITEM_LABELS, MONSTER_DROPS } from "../../shared/game-data.generated";
import {
  CreateDropTableDto,
  DropTableDto,
  DropTableListDto,
  MonsterDropDto,
  MonsterDropQueryDto,
  UpdateDropTableDto,
  UpdateMonsterDropDto,
} from "./dto/drop.dto";

/** 默认页大小：怪表一页装得下全部具名表；每怪列表沿用 20/50/100 的分页习惯 */
const DEFAULT_PAGE_SIZE = 20;

/**
 * 掉落配置（#254）业务
 *
 * 两张表两种纪律：
 * - `drop_tables` **允许动态增删**（运营自建新表给多怪复用，同 mall_prices 定位）；
 * - `monster_drops` 与怪物一一对应（key 清单固定），只许 PATCH 整份替换。
 *
 * seed 全部 INSERT OR IGNORE 幂等；JSON 列（picks / entries）的结构校验收在这里
 * （goodId 要查物品总表、picks 是联合类型），DTO 只负责 whitelist 认键。
 * 将来的服务端掉落结算直读这两张表（与 monsters 表同一读法，改表即时生效）。
 */
@Injectable()
export class DropConfigService implements OnModuleInit {
  constructor(
    private readonly dropTablesRepo: DropTableRepository,
    private readonly monsterDropsRepo: MonsterDropRepository,
  ) {}

  /** 启动时把客户端配置 seed 进库（幂等；已存在的行原样保留） */
  onModuleInit() {
    this.seedTables();
    this.seedMonsterDrops();
  }

  // —— 具名掉落表（CRUD）——

  listTables(): DropTableListDto {
    const rows = this.dropTablesRepo.list();
    return { list: rows.map(DropTableDto.from), total: rows.length };
  }

  createTable(dto: CreateDropTableDto): DropTableDto {
    if (this.dropTablesRepo.findByKey(dto.id)) {
      throw new BizException(BizCode.PARAM_INVALID, `掉落表 id 已存在：${dto.id}`);
    }
    const entries = this.assertEntries(dto.entries);
    const picks = this.assertPicks(dto.picks, "抽取次数");
    const row: DropTableRow = { id: dto.id, picks: JSON.stringify(picks), entries: JSON.stringify(entries), updated_at: Date.now() };
    this.dropTablesRepo.insert(row);
    return DropTableDto.from(this.requireTable(dto.id));
  }

  updateTable(id: string, dto: UpdateDropTableDto): DropTableDto {
    const existing = this.requireTable(id);
    const picks = dto.picks === undefined ? JSON.parse(existing.picks) : this.assertPicks(dto.picks, "抽取次数");
    const entries = dto.entries === undefined ? JSON.parse(existing.entries) : this.assertEntries(dto.entries);
    const next: DropTableRow = { id: existing.id, picks: JSON.stringify(picks), entries: JSON.stringify(entries), updated_at: Date.now() };
    this.dropTablesRepo.update(next);
    return DropTableDto.from(this.requireTable(id));
  }

  removeTable(id: string): void {
    this.requireTable(id);
    const references = this.dropTablesRepo.countMonsterReferences(id);
    if (references > 0) {
      throw new BizException(BizCode.PARAM_INVALID, `掉落表 ${id} 仍被 ${references} 只怪物引用，先解除引用再删除`);
    }
    this.dropTablesRepo.remove(id);
  }

  // —— 每怪掉落配置（list + PATCH 整份替换）——

  listMonsterDrops(query: MonsterDropQueryDto): PageResult<MonsterDropDto> {
    const options: MonsterDropListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      source: query.source,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.monsterDropsRepo.list(options);
    const total = this.monsterDropsRepo.count(options);
    return { list: rows.map(MonsterDropDto.from), total, page: options.page, size: options.size };
  }

  /**
   * 整份替换一只怪的掉落配置（三选一）：
   * tableId 非空 → 引用具名表（picks 可覆盖件数，entries 必须不传）；
   * tableId 为 null 且 entries 非空 → 内联条目池（picks 必填）；
   * tableId 为 null 且 entries 为 null → 清空（走兜底表）。
   */
  updateMonsterDrop(monsterKey: string, dto: UpdateMonsterDropDto): MonsterDropDto {
    const existing = this.requireMonsterDrop(monsterKey);

    const tableId = dto.tableId === undefined ? null : dto.tableId;
    const hasEntries = dto.entries !== undefined && dto.entries !== null;
    if (tableId !== null && tableId !== undefined && hasEntries) {
      throw new BizException(BizCode.PARAM_INVALID, "tableId 与 entries 只能二选一：引用具名表时不要传 entries");
    }

    let source: MonsterDropRow["source"];
    let picksJson: string | null = null;
    let entriesJson: string | null = null;

    if (tableId !== null && tableId !== undefined) {
      const table = this.dropTablesRepo.findByKey(tableId);
      if (!table) throw BizException.notFound(BizCode.DROP_TABLE_NOT_FOUND, `掉落表 ${tableId} 不存在`);
      source = "table";
      if (dto.picks !== undefined) picksJson = JSON.stringify(this.assertPicks(dto.picks, "抽取次数"));
    } else if (hasEntries) {
      const picks = this.assertPicks(dto.picks, "内联条目的抽取次数");
      source = "entries";
      picksJson = JSON.stringify(picks);
      entriesJson = JSON.stringify(this.assertEntries(dto.entries!));
    } else {
      if (dto.picks !== undefined) {
        throw new BizException(BizCode.PARAM_INVALID, "清空掉落配置时不带抽取次数（picks 只在引用具名表或内联条目时有意义）");
      }
      source = "none";
    }

    const next: MonsterDropRow = {
      monster_key: existing.monster_key,
      source,
      table_id: source === "table" ? (tableId as string) : null,
      picks: picksJson,
      entries: entriesJson,
      updated_at: Date.now(),
    };
    this.monsterDropsRepo.update(next);
    return MonsterDropDto.from(this.requireMonsterDrop(monsterKey));
  }

  // —— 内部 ——

  private requireTable(id: string): DropTableRow {
    const row = this.dropTablesRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.DROP_TABLE_NOT_FOUND, `掉落表 ${id} 不存在`);
    return row;
  }

  private requireMonsterDrop(monsterKey: string): MonsterDropRow {
    const row = this.monsterDropsRepo.findByKey(monsterKey);
    if (!row) throw BizException.notFound(BizCode.MONSTER_DROP_NOT_FOUND, `怪物 ${monsterKey} 没有掉落配置`);
    return row;
  }

  /**
   * 抽取次数校验：数字（≥1 整数）或 [min, max]（1 ≤ min ≤ max 整数）
   * DTO 里是 unknown（联合类型声明式校验很拧巴），在这里统一判。
   */
  private assertPicks(picks: unknown, label: string): number | [number, number] {
    if (typeof picks === "number") {
      if (!Number.isInteger(picks) || picks < 1) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}必须是 ≥1 的整数（或 [最小, 最大] 区间）`);
      }
      return picks;
    }
    if (Array.isArray(picks) && picks.length === 2) {
      const [min, max] = picks;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max) {
        throw new BizException(BizCode.PARAM_INVALID, `${label}区间必须是 1 ≤ 最小 ≤ 最大 的整数`);
      }
      return [min, max];
    }
    throw new BizException(BizCode.PARAM_INVALID, `${label}必须是数字或 [最小, 最大] 区间`);
  }

  /**
   * 条目池校验：goodId 必须在物品总表里（生成物 ITEM_LABELS = 装备全量变体 + 药品 + 材料），
   * count 区间 0 ≤ min ≤ max。weight / chance 的单字段范围已由 DTO 挡过。
   */
  private assertEntries(entries: Array<{ goodId: string; weight?: number; chance?: number; count?: number[] }>): Array<{ goodId: string; weight: number; chance: number; count: [number, number] }> {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BizException(BizCode.PARAM_INVALID, "条目池不能为空（掉不出东西的表不如不建）");
    }
    return entries.map((entry, index) => {
      const where = `条目[${index}]`;
      if (!ITEM_LABELS[entry.goodId]) {
        throw new BizException(BizCode.PARAM_INVALID, `${where} 的物品 ${entry.goodId} 不在物品总表里`);
      }
      if (entry.count !== undefined) {
        const [min, max] = entry.count;
        if (min > max) {
          throw new BizException(BizCode.PARAM_INVALID, `${where} 的数量下限不能大于上限`);
        }
      }
      return {
        goodId: entry.goodId,
        weight: entry.weight ?? 1,
        chance: entry.chance ?? 1,
        count: entry.count ? [entry.count[0], entry.count[1]] : [1, 1],
      };
    });
  }

  /** 具名表 seed：DROP_TABLES 直接灌（common/elite/boss）+ 兜底表 default（#254） */
  private seedTables() {
    const tables: Record<string, unknown> = { ...DROP_TABLES, ...DROP_DEFAULT };
    for (const [id, table] of Object.entries(tables)) {
      const shape = table as { picks: number | [number, number]; entries: Array<{ goodId: string; weight: number; chance: number; count: [number, number] }> };
      this.dropTablesRepo.seedRow({
        id,
        picks: JSON.stringify(shape.picks),
        entries: JSON.stringify(shape.entries),
        updated_at: 0,
      });
    }
  }

  /** 每怪掉落 seed：MONSTER_DROPS 直接灌（220 只全内联；key 与怪物清单已由生成器对齐） */
  private seedMonsterDrops() {
    for (const [monsterKey, table] of Object.entries(MONSTER_DROPS as Record<string, { picks: number | [number, number]; entries: unknown[] }>)) {
      this.monsterDropsRepo.seedRow({
        monster_key: monsterKey,
        source: "entries",
        table_id: null,
        picks: JSON.stringify(table.picks),
        entries: JSON.stringify(table.entries),
        updated_at: 0,
      });
    }
  }
}

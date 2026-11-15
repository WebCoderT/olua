import { Injectable } from "@nestjs/common";
import { DROP_RESULT_LABELS, DROP_RESULTS } from "../../common/constants/drop";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { bindOnDropOf, itemLabelOf } from "../../common/runtime-config-cache";
import { normalizePage } from "../../common/utils/page.util";
import { DropRecordListOptions, DropRecordRepository } from "../../database/repositories/drop-record.repository";
import { DropTableRepository } from "../../database/repositories/drop-table.repository";
import { MonsterDropRepository } from "../../database/repositories/monster-drop.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { DropGroundListOptions, WorldDropRepository } from "../../database/repositories/world-drop.repository";
import type { DropTableRow, MonsterDropRow } from "../../database/rows";
import { RuntimeParamsService } from "../game-config/runtime-params.service";
import {
  DropGroundDto,
  DropGroundQueryDto,
  DropGroundSummaryDto,
  DropGroundSummaryItemDto,
  MonsterDropIndexItemDto,
  MonsterDropIndexQueryDto,
} from "./dto/drop-ground.dto";
import {
  DropRecordDto,
  DropRecordQueryDto,
  DropRecordSummaryDto,
  DropRecordSummaryItemDto,
} from "./dto/drop-record.dto";

/**
 * 管理端 · 掉落（#803 流水 / #805 监控与反查）
 *
 * 只读：写入在**实时进程**（`DropService` 攒批 + 重启清场转 `restart_lost`），
 * 这里只负责按区把两张表读出来。两个进程共用同一个 SQLite 文件。
 *
 * 三个数据面，别混：
 * - `world_drops` 是**投影**（100ms 批量刷，重启清空）→ 回答「现在地上有什么」；
 * - `drop_records` 是**终态流水**（append-only）→ 回答「这件东西最后去哪了」；
 * - `monster_drops` / `drop_tables` 是**配置** → 回答「这只怪会掉什么」。
 *
 * 区由调用方传（控制器从 `X-Zone-Id` 取，经 `ZoneContextGuard` 校验）：**本服务不接受
 * 「不传区」的查询** —— 掉落分区、管理端一次只在一个区里干活（docs/39 §2.4）。
 * 唯一例外是 `monsterIndex`：那是**配置反查**，配置不分区。
 */
@Injectable()
export class DropsService {
  constructor(
    private readonly records: DropRecordRepository,
    private readonly ground: WorldDropRepository,
    private readonly monsterDrops: MonsterDropRepository,
    private readonly dropTables: DropTableRepository,
    private readonly monsters: MonsterRepository,
    private readonly runtimeParams: RuntimeParamsService,
  ) {}

  /** 一页流水（条件之间是「与」的关系；默认按终态时刻倒序） */
  list(zoneId: number, query: DropRecordQueryDto): PageResult<DropRecordDto> {
    const { page, size } = normalizePage(query);
    const options = this.optionsOf(zoneId, query, page, size);
    return {
      list: this.records.list(options).map((row) => DropRecordDto.from(row)),
      total: this.records.count(options),
      page,
      size,
    };
  }

  /**
   * 按终态的计数（页面顶部概况卡）
   *
   * 与 `list` 共用同一套筛选条件，但**刻意丢掉 `result`**（`summary` 的仓储实现里固定如此）：
   * 传了 `result` 只剩一行，那不是概况。四个终态恒出现，没有数据的给 0。
   */
  summary(zoneId: number, query: DropRecordQueryDto): DropRecordSummaryDto {
    const counts = new Map(this.records.summary(this.optionsOf(zoneId, query, 1, 1)).map((row) => [row.result, row.total] as const));
    const items: DropRecordSummaryItemDto[] = DROP_RESULTS.map((result) => ({
      result,
      resultLabel: DROP_RESULT_LABELS[result],
      total: counts.get(result) ?? 0,
    }));
    // 理论上不会有未登记的 result，但真出现了也要能看见 —— 悄悄从概况里消失比多一格更糟
    for (const [result, total] of counts) {
      if (!items.some((item) => item.result === result)) items.push({ result, resultLabel: result, total });
    }
    return { items, total: items.reduce((sum, item) => sum + item.total, 0) };
  }

  /** DTO → 仓储查询条件（列表与概况共用，避免两处条件写岔；`result` 的取舍见各自注释） */
  private optionsOf(zoneId: number, query: DropRecordQueryDto, page: number, size: number): DropRecordListOptions {
    return {
      zoneId,
      mapId: query.mapId?.trim() || undefined,
      result: query.result?.trim() || undefined,
      ownerName: query.ownerName?.trim() || undefined,
      goodId: query.goodId?.trim() || undefined,
      from: query.from,
      to: query.to,
      page,
      size,
      sort: query.sort,
      order: query.order,
    };
  }

  //#region 当前地面（#805）

  /**
   * 一页「现在地上有什么」
   *
   * 读的是投影表：实时进程 100ms 批量刷一次，所以**最多差一拍**（`flushMs`）。措辞上别承诺
   * 毫秒级精确 —— 运营看到的东西，下一拍可能已经被捡走了（那时流水里会多一行 `picked`）。
   */
  listGround(zoneId: number, query: DropGroundQueryDto): PageResult<DropGroundDto> {
    const { page, size } = normalizePage(query, GROUND_DEFAULT_SIZE);
    const now = Date.now();
    const options = this.groundOptionsOf(zoneId, query, page, size);
    return {
      list: this.ground
        .listGround(options)
        .map((row) => DropGroundDto.from(row, now, itemLabelOf(row.good_id) ?? row.good_id)),
      total: this.ground.countGround(options),
      page,
      size,
    };
  }

  /**
   * 概况卡（当前地面总件数 / 保护中 / 即将过期 / 单图水位）
   *
   * 四个数字都从**同一次** `GROUP BY map_id` 求和出来：分三次独立 COUNT 的话，三次会落在
   * 不同时间点上（投放与拾取一直在发生），四个格子加起来对不上，运营第一眼就会怀疑数据。
   */
  groundSummary(zoneId: number, query: DropGroundQueryDto): DropGroundSummaryDto {
    const now = Date.now();
    const capPerMap = this.capPerMap();
    const rows = this.ground.summaryGround(
      this.groundOptionsOf(zoneId, query, 1, 1),
      now,
      DROP_GROUND_EXPIRING_WINDOW_MS,
    );
    const byMap: DropGroundSummaryItemDto[] = rows.map((row) => ({
      mapId: row.map_id,
      total: row.total ?? 0,
      protectedTotal: row.protected_total ?? 0,
      expiringTotal: row.expiring_total ?? 0,
      cap: capPerMap,
    }));
    return {
      total: byMap.reduce((sum, item) => sum + item.total, 0),
      protectedTotal: byMap.reduce((sum, item) => sum + item.protectedTotal, 0),
      expiringTotal: byMap.reduce((sum, item) => sum + item.expiringTotal, 0),
      expiringWindowMs: DROP_GROUND_EXPIRING_WINDOW_MS,
      capPerMap,
      byMap,
      serverNow: now,
    };
  }

  /** DTO → 地面查询条件（列表与概况共用；`page/size` 概况侧不用，传 1 占位） */
  private groundOptionsOf(
    zoneId: number,
    query: DropGroundQueryDto,
    page: number,
    size: number,
  ): DropGroundListOptions {
    return {
      zoneId,
      mapId: query.mapId?.trim() || undefined,
      keyword: query.keyword?.trim() || undefined,
      ownerName: query.ownerName?.trim() || undefined,
      page,
      size,
      sort: query.sort,
      order: query.order,
    };
  }

  /**
   * 单图上限（运行时参数 `drop.maxGroundPerMap`）
   *
   * 读不到 / 坏值一律返回 `null`，**不在这一层补一个写死的 200**：那个数字是实时域的出厂值
   * （`DropService` 私有常量），在这里再写一遍就成了「两处配置」。页面按 `null` 显示「上限未知」，
   * 比拿一个可能已经过期的数字画水位条更诚实。
   */
  private capPerMap(): number | null {
    const value = Number(this.runtimeParams.params().drop?.maxGroundPerMap);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  //#endregion

  //#region 怪物掉落反查（#805）

  /**
   * 「这件东西都有谁会掉」：把每只怪的掉落池**摊平**成 `怪物 × 物品` 的行
   *
   * 配置有两种写法（`monster_drops.source`）：内联条目池 `entries`、引用具名表 `table_id`
   * —— 两种都要摊平，否则「查这件装备谁掉」会漏掉一半的怪。`none`（没配、走兜底表）不产生行：
   * 「走兜底」不是一个可比对的条目。
   *
   * 这里读的是**配置**，不分表、不分页取全量（行数就是怪物数量级）：反查是横向扫描，
   * 分页取只会把答案切碎。展开后行数 = 怪物数 × 条目数，内存排序分页足够。
   */
  monsterIndex(query: MonsterDropIndexQueryDto): PageResult<MonsterDropIndexItemDto> {
    const { page, size } = normalizePage(query, GROUND_DEFAULT_SIZE);
    const monsterKey = query.monsterKey?.trim() || undefined;
    const goodId = query.goodId?.trim() || undefined;
    const keyword = query.keyword?.trim()?.toLowerCase() || undefined;

    const tables = new Map(this.dropTables.list().map((row) => [row.id, row] as const));
    const rows: Array<{ row: MonsterDropRow; tableId: string | null; entry: MonsterDropEntry }> = [];
    for (const row of this.monsterDrops.listAll()) {
      if (monsterKey && row.monster_key !== monsterKey) continue;
      for (const entry of entriesOf(row, tables)) {
        if (goodId && entry.goodId !== goodId) continue;
        if (keyword && !entry.goodId.toLowerCase().includes(keyword)) continue;
        rows.push({ row, tableId: row.source === "table" ? row.table_id : null, entry });
      }
    }

    // 稳定顺序：先怪物 key、再物品 id —— 同一只怪的多个条目挨在一起，页面读起来才顺
    rows.sort((left, right) => {
      const byMonster = compareText(left.row.monster_key, right.row.monster_key);
      return byMonster !== 0 ? byMonster : compareText(left.entry.goodId, right.entry.goodId);
    });

    const start = (page - 1) * size;
    const currentPage = rows.slice(start, start + size);
    // 名字只给当前页补（整表查一遍 label 没有意义）；解析不到的回落成 key / id
    const labels = this.monsters.labelsByKeys([...new Set(currentPage.map((item) => item.row.monster_key))]);
    return {
      list: currentPage.map(({ row, tableId, entry }) => {
        const bindDrops = row.bind_drops === 1;
        const bindOnDrop = bindOnDropOf(entry.goodId);
        return {
          monsterKey: row.monster_key,
          monsterLabel: labels.get(row.monster_key) ?? row.monster_key,
          goodId: entry.goodId,
          goodLabel: itemLabelOf(entry.goodId) ?? entry.goodId,
          source: row.source,
          tableId,
          weight: numberOr(entry.weight, 1),
          chance: numberOr(entry.chance, 1),
          minCount: countRangeOf(entry).min,
          maxCount: countRangeOf(entry).max,
          bindDrops,
          bindOnDrop,
          bound: bindDrops || bindOnDrop,
        } satisfies MonsterDropIndexItemDto;
      }),
      total: rows.length,
      page,
      size,
    };
  }

  //#endregion
}

/**
 * 「即将过期」的窗口：概况卡问「1 分钟内将过期几件」（#805 原文）
 *
 * 代码常量而不是运行时参数：它是**页面口径**（一眼能看完的一小段时间），不是掉落手感；
 * 开成参数只会多一列没人会去调的配置。
 */
const DROP_GROUND_EXPIRING_WINDOW_MS = 60_000;

/** 监控与反查的默认每页条数（比配置页的 20 大：这两页都是「扫一眼」的重表格） */
const GROUND_DEFAULT_SIZE = 50;

/** 一个掉落条目（配置 JSON 摊平后的形状；`weight/chance/count` 缺省按 1 / 1 / [1,1]） */
interface MonsterDropEntry {
  goodId: string;
  weight?: number;
  chance?: number;
  count?: number[];
}

/** 把一只怪的配置摊平成条目数组（坏 JSON / 空池一律返回空数组，不让一条脏数据拖垮整页） */
function entriesOf(row: MonsterDropRow, tables: Map<string, DropTableRow>): MonsterDropEntry[] {
  const raw = row.source === "table" ? (row.table_id ? tables.get(row.table_id)?.entries : null) : row.entries;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is MonsterDropEntry =>
        Boolean(item) && typeof item === "object" && typeof (item as MonsterDropEntry).goodId === "string",
    );
  } catch {
    return [];
  }
}

function countRangeOf(entry: MonsterDropEntry): { min: number; max: number } {
  const raw = Array.isArray(entry.count) ? entry.count : [];
  const min = numberOr(raw[0], 1);
  const max = numberOr(raw[1], min);
  return { min, max };
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


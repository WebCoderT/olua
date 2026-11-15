import { Injectable } from "@nestjs/common";
import { DROP_RESULT_LABELS, DROP_RESULTS } from "../../common/constants/drop";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { normalizePage } from "../../common/utils/page.util";
import { DropRecordListOptions, DropRecordRepository } from "../../database/repositories/drop-record.repository";
import {
  DropRecordDto,
  DropRecordQueryDto,
  DropRecordSummaryDto,
  DropRecordSummaryItemDto,
} from "./dto/drop-record.dto";

/**
 * 管理端 · 掉落流水（#803）
 *
 * 只读：写入在**实时进程**（`DropService.resolve()` 攒批 + 重启清场转 `restart_lost`），
 * 这里只负责按区把那张 append-only 的表读出来。两个进程共用同一个 SQLite 文件。
 *
 * 区由调用方传（控制器从 `X-Zone-Id` 取，经 `ZoneContextGuard` 校验）：**本服务不接受
 * 「不传区」的查询** —— 掉落流水分区、管理端一次只在一个区里干活（docs/39 §2.4）。
 */
@Injectable()
export class DropsService {
  constructor(private readonly records: DropRecordRepository) {}

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
}

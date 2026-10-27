import { Injectable } from "@nestjs/common";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { normalizePage } from "../../common/utils/page.util";
import { ReportRepository } from "../../database/repositories/report.repository";
import { ReportDto, ReportQueryDto } from "./dto/report.dto";

/**
 * 举报的**管理端只读**视图（#398）
 *
 * 刻意只有 `list`：这一刀不做状态流转、不做处罚（边界写在 issue #398 里）——
 * 少一个写接口，就少一处「谁改的、凭什么改」要交代的地方。等真做处罚体系时，
 * 状态流转、处置记录与申诉会是一整刀，那时再往这里加。
 */
@Injectable()
export class ReportService {
  constructor(private readonly reports: ReportRepository) {}

  list(query: ReportQueryDto): PageResult<ReportDto> {
    const { page, size } = normalizePage(query);
    const result = this.reports.list({
      category: query.category,
      status: query.status,
      keyword: query.keyword,
      page,
      size,
    });
    return { ...result, list: result.list.map((row) => ReportDto.from(row)) };
  }
}

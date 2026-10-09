import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AnnouncementLevel } from "../../common/constants/announcement";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { AnnouncementRepository, AnnouncementListOptions } from "../../database/repositories/announcement.repository";
import { AnnouncementRow } from "../../database/rows";
import {
  ActiveAnnouncementDto,
  AnnouncementDto,
  AnnouncementQueryDto,
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from "./dto/announcement.dto";

/** 列表默认每页条数（与其它列表接口一致） */
const DEFAULT_PAGE_SIZE = 20;

/**
 * 公告业务
 *
 * 两条路径的字段口径不同，因此返回两种 DTO：
 * - 公共 `listActive` → `ActiveAnnouncementDto`（只给展示需要的字段）
 * - 管理端 CRUD → `AnnouncementDto`（含启停开关与发布人）
 *
 * 「编辑」做成**部分更新**：列表上的启停按钮只回传 `enabled`，
 * 不必把整篇正文一起带上（否则运营正在编辑的正文会被表单里的旧值覆盖回去）。
 */
@Injectable()
export class AnnouncementService {
  constructor(private readonly announcements: AnnouncementRepository) {}

  /** 公共：当前生效中的公告（重要在前，同级按发布时间倒序） */
  listActive(): ActiveAnnouncementDto[] {
    return this.announcements.listActive(Date.now()).map(ActiveAnnouncementDto.from);
  }

  /** 管理端：分页列表（可选关键字 / 级别 / 启用 / 生效状态筛选） */
  list(query: AnnouncementQueryDto): PageResult<AnnouncementDto> {
    const now = Date.now();
    const options: AnnouncementListOptions = {
      page: query.page ?? 1,
      size: query.size ?? DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      level: query.level,
      enabled: query.enabled,
      active: query.active,
      sort: query.sort,
      order: query.order,
      now,
    };
    const rows = this.announcements.list(options);
    const total = this.announcements.count(options);
    return { list: rows.map((row) => AnnouncementDto.from(row, now)), total, page: options.page, size: options.size };
  }

  /** 新建公告（发布人取令牌里的管理员账号名，不接受入参指定） */
  create(actor: AuthenticatedUser, dto: CreateAnnouncementDto): AnnouncementDto {
    const now = Date.now();
    const startsAt = dto.startsAt ?? null;
    const endsAt = dto.endsAt ?? null;
    assertTimeRange(startsAt, endsAt);

    const row: AnnouncementRow = {
      id: randomUUID(),
      title: dto.title,
      content: dto.content,
      level: dto.level ?? AnnouncementLevel.NORMAL,
      enabled: dto.enabled === undefined ? 1 : dto.enabled ? 1 : 0,
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: actor.username,
      created_at: now,
      updated_at: now,
    };
    this.announcements.insert(row);
    return AnnouncementDto.from(row, now);
  }

  /**
   * 编辑公告（部分更新）
   *
   * 时间窗按「合并后的结果」校验：只传 `endsAt` 时也要能识别出它早于库里已有的 `startsAt` ——
   * 逐字段校验是抓不到这种「单个字段合法、组合起来不合法」的。
   *
   * ⚠️ 区分「没传」与「显式传了 null」只能用 `=== undefined`，**不能用 `hasOwnProperty`**：
   * ValidationPipe 开了 `enableImplicitConversion`，class-transformer 会把**所有声明字段**
   * 都变成 own property（没传的那些值是 `undefined`），于是 `hasOwnProperty` 恒为 true。
   */
  update(id: string, dto: UpdateAnnouncementDto): AnnouncementDto {
    const existing = this.requireById(id);
    const now = Date.now();

    const startsAt = dto.startsAt === undefined ? existing.starts_at : dto.startsAt;
    const endsAt = dto.endsAt === undefined ? existing.ends_at : dto.endsAt;
    assertTimeRange(startsAt, endsAt);

    const next: AnnouncementRow = {
      ...existing,
      title: dto.title ?? existing.title,
      content: dto.content ?? existing.content,
      level: dto.level ?? existing.level,
      enabled: dto.enabled === undefined ? existing.enabled : dto.enabled ? 1 : 0,
      starts_at: startsAt,
      ends_at: endsAt,
      updated_at: now,
    };
    this.announcements.update(next);
    return AnnouncementDto.from(next, now);
  }

  /** 删除公告（不可恢复） */
  remove(id: string): null {
    const changes = this.announcements.remove(id).changes;
    if (changes === 0) throw BizException.notFound(BizCode.ANNOUNCEMENT_NOT_FOUND, "公告不存在");
    return null;
  }

  /** 取一条，不存在就抛（更新路径前的统一入口，免得每个写方法各写一遍判空） */
  private requireById(id: string): AnnouncementRow {
    const row = this.announcements.findById(id);
    if (!row) throw BizException.notFound(BizCode.ANNOUNCEMENT_NOT_FOUND, "公告不存在");
    return row;
  }
}

/**
 * 时间窗校验（两侧都为 null 是合法的：立即生效且不设截止）
 *
 * 只校验「什么时候结束不该早于什么时候开始」，**不校验是否已过期** ——
 * 把结束时间设在过去是运营的正当操作（例如补录一条已经下线的公告），
 * 它天然不会被 `listActive` 返回。
 */
function assertTimeRange(startsAt: number | null, endsAt: number | null): void {
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    throw new BizException(BizCode.ANNOUNCEMENT_TIME_RANGE_INVALID, "生效结束时间必须晚于开始时间");
  }
}

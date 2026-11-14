import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AnnouncementLevel, AnnouncementScope } from "../../common/constants/announcement";
import { BizCode } from "../../common/constants/biz-code";
import { Permission, roleHasPermission } from "../../common/constants/permission";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { AnnouncementRepository, AnnouncementListOptions } from "../../database/repositories/announcement.repository";
import { AnnouncementRow } from "../../database/rows";
import { RolesService } from "../roles/roles.service";
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
 *
 * **投放范围（#963）**：一条公告要么投给「当前区」、要么投给「全服」——
 * 区由服务端算（管理端取 `X-Zone-Id`，玩家侧取账号当前区），客户端只说范围不说区。
 */
@Injectable()
export class AnnouncementService {
  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly roles: RolesService,
  ) {}

  /**
   * 公共：当前生效中的公告（重要在前，同级按发布时间倒序）
   *
   * 没有令牌、也就没有区 → **只给全服公告**。这是登录页那条路径：
   * 玩家还没选区，任何「本区公告」在他眼里都还是未知的。
   */
  listActive(): ActiveAnnouncementDto[] {
    return this.announcements.listActive(Date.now(), null).map(ActiveAnnouncementDto.from);
  }

  /**
   * 玩家侧：全服 + **我自己所在区**的公告（游戏内公告板）
   *
   * 区从账号推导（在线角色所在区），**不接受入参** —— 传了就变成「读别区公告」的口子
   * （docs/39 §2.4 规则 1）。
   *
   * 没有在线角色（还没建角 / 还在选角页）→ 只给全服：这时他还没属于任何一个区，
   * 把「浏览区」的公告推给他等于替他把区选了。
   */
  listActiveForAccount(accountId: string): ActiveAnnouncementDto[] {
    const zoneId = this.roles.onlineZoneOf(accountId);
    return this.announcements.listActive(Date.now(), zoneId).map(ActiveAnnouncementDto.from);
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

  /**
   * 新建公告（发布人取令牌里的管理员账号名，不接受入参指定）
   *
   * 投放范围默认**当前区**：管理员一次只在一个区里干活，「本区发一条」是最高频的动作；
   * 要打到所有区得显式说 `scope=all`，而那是要 `announcement:publish-all` 的。
   */
  create(actor: AuthenticatedUser, dto: CreateAnnouncementDto, currentZoneId: number): AnnouncementDto {
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
      zone_id: this.zoneIdOfScope(actor, dto.scope, currentZoneId),
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
  update(id: string, dto: UpdateAnnouncementDto, actor: AuthenticatedUser, currentZoneId: number): AnnouncementDto {
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
      // 不传 scope = 投放范围不动（只改标题 / 只停用都不该把它悄悄搬回当前区）
      zone_id:
        dto.scope === undefined ? existing.zone_id : this.zoneIdOfScope(actor, dto.scope, currentZoneId),
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

  /**
   * 投放范围 → `zone_id`（`null` = 全服）
   *
   * 「全服」是**影响面权限**：管理员本来就能切任意区，逐区各发一次是正常动作；
   * 一条公告同时打到所有区才需要 `announcement:publish-all`。
   * 这一条只能在业务里判（同一个接口按入参决定要不要权限），所以不在路由装饰器上。
   */
  private zoneIdOfScope(actor: AuthenticatedUser, scope: string | undefined, currentZoneId: number): number | null {
    if (scope !== AnnouncementScope.ALL) return currentZoneId;
    if (!roleHasPermission(actor.role, Permission.ANNOUNCEMENT_PUBLISH_ALL)) {
      throw BizException.forbidden(
        BizCode.ADMIN_PERMISSION_DENIED,
        "「全服公告」会影响所有区，需要超级管理员权限；只想让当前区看到，用默认的「当前区」即可",
      );
    }
    return null;
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

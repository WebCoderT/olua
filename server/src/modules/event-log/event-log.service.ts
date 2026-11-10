import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { EVENT_TYPE_LABELS, EventType } from "../../common/constants/event-type";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { normalizePage } from "../../common/utils/page.util";
import { EventLogListOptions, EventLogRepository } from "../../database/repositories/event-log.repository";
import { EventLogRow } from "../../database/rows";
import { EventLogDto, EventLogQueryDto, EventTypeDto, EventTypeListDto } from "./dto/event-log.dto";

/**
 * 写一条流水（除 type 外都可省）
 *
 * 字段口径（各类型填哪几个）：
 * - `login`：accountId / ip / success（失败时 accountId 为空，detail 里带尝试的用户名）
 * - `enter_map`：roleId / roleName / zoneId / mapId
 * - `kill`：roleId / roleName / mapId / target=怪物 key / detail={ tier, label, x, y }
 * - `pick`：roleId / roleName / mapId / target=物品 id / amount=数量 / detail={ x, y, bound }
 * - `gain` / `consume`：roleId / roleName / target=物品 id / amount=数量 / detail={ source | reason }
 * - `mail`：roleId / roleName / target=邮件 id / detail={ subject, attachments }
 * - `quest`：roleId / roleName / target=任务 id / detail={ kind }
 */
export interface EventLogEntryInput {
  /** 事件类型（EVENT_TYPE 的取值） */
  type: string;
  accountId?: string | null;
  roleId?: string | null;
  roleName?: string | null;
  zoneId?: number | null;
  mapId?: string | null;
  target?: string | null;
  amount?: number | null;
  detail?: unknown;
  ip?: string | null;
  /** 默认 true；只有登录失败这类「事件本身失败了」才传 false */
  success?: boolean;
}

/** 每写这么多条就顺手清一次超量的旧流水（比审计表稀疏：这张表写得快，但清理是全表扫描） */
const PRUNE_EVERY = 500;

/**
 * 玩家行为流水（#886 / J3）
 *
 * ## 为什么与 audit_logs 分开
 * `audit_logs` 的主语是**管理员**（谁点了哪个接口、成没成），这张表的主语是**玩家角色**
 * （在哪张图对谁做了什么）。两者的字段、保留期、查询页、权限点没有一处相同；
 * 合表的结果是审计页被拾取流水刷没，而「查某个角色一晚干了什么」依然查不动。
 *
 * ## 写入有两条路，但落库只有一个口
 * 1. **总线订阅**（`EventLogListener`）：`monster:killed` / `quest:claimed` —— 这两件事
 *    本来就有采集点（#401 定的「结算只 emit 一次」），订阅即可，不必再改一次结算代码；
 * 2. **直接调用**（登录 / 进图 / 拾取 / 获得 / 消耗 / 邮件）：这几件事**没有**总线事件，
 *    硬造 8 个总线事件等于给总线塞一半「只有一个订阅方」的类型，反而让「哪些事件真的
 *    有人在用」变模糊。它们直接调 `record`。
 *
 * 两条路最后都进 `record` / `recordMany`，落库方式只有一种。
 *
 * ## 两条硬约束
 * 1. **同步写**：`record` 返回时数据已经落库。理由是没有 flush 定时器与进程退出兜底
 *    也能保证「刚打完怪立刻查库」看得到东西 —— #886 原文写的是异步批量，实做按
 *    「同步 + 调用方内合并」定（一次群攻的 8 条击杀由调用方攒成一次 `recordMany`，
 *    即原文要的那个「批」）。
 * 2. **绝不抛异常**：写流水失败只打日志。世界状态是权威，少记一笔流水可接受；
 *    绝不能因为日志表出问题让一次真实的击杀 / 拾取失败。
 */
@Injectable()
export class EventLogService implements OnModuleInit {
  private readonly logger = new Logger(EventLogService.name);
  private writeCount = 0;

  constructor(
    private readonly logs: EventLogRepository,
    private readonly config: ConfigService,
  ) {}

  /** 记一条（永不抛异常） */
  record(entry: EventLogEntryInput): void {
    this.recordMany([entry]);
  }

  /**
   * 一次记多条（永不抛异常）
   *
   * 调用方攒批的地方：一次群攻的 N 条击杀、一键批量回收的 N 条消耗。
   * 内部拼成一条多值 INSERT 放进同一个事务 —— 逐条提交会在这个最热的路径上产生 N 次 WAL 提交。
   */
  recordMany(entries: EventLogEntryInput[]): void {
    if (entries.length === 0) return;
    try {
      const now = Date.now();
      this.logs.insertMany(entries.map((entry) => this.rowOf(entry, now)));
      this.pruneIfNeeded();
    } catch (error) {
      this.logger.warn(`行为流水写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 分页查询 */
  list(query: EventLogQueryDto): PageResult<EventLogDto> {
    const { page, size } = normalizePage(query);
    const options: EventLogListOptions = {
      page,
      size,
      keyword: query.keyword?.trim() || undefined,
      type: query.type?.trim() || undefined,
      roleId: query.roleId?.trim() || undefined,
      accountId: query.accountId?.trim() || undefined,
      mapId: query.mapId?.trim() || undefined,
      success: query.success,
      from: query.from,
      to: query.to,
    };
    return {
      list: this.logs.list(options).map((row) => EventLogDto.from(row)),
      total: this.logs.count(options),
      page,
      size,
    };
  }

  /** 某个角色最近 N 条（排查用；管理端角色详情可以接这个） */
  recentOfRole(roleId: string, limit = 50): EventLogDto[] {
    return this.logs.recentOfRole(roleId, Math.max(1, Math.min(200, Math.floor(limit)))).map((row) => EventLogDto.from(row));
  }

  /**
   * 类型清单（字典 ∪ 库里出现过的）
   *
   * 每条带 `total`：`trade` / `enhance` 这类**暂时放置**的类型会以 0 条出现，
   * 一眼就能看出「字典里有、就是还没埋上」，而不是在界面上凭空消失。
   */
  types(): EventTypeListDto {
    const seen = new Map(this.logs.countByType().map((row) => [row.type, row.total] as const));
    const values = new Set<string>([...Object.keys(EVENT_TYPE_LABELS), ...Array.from(seen.keys())]);
    const types: EventTypeDto[] = Array.from(values)
      .sort((a, b) => a.localeCompare(b))
      .map((value) => {
        const dto = new EventTypeDto();
        dto.value = value;
        dto.label = labelOf(value);
        dto.total = seen.get(value) ?? 0;
        return dto;
      });
    return { types };
  }

  /**
   * 启动时先按保留策略清一次
   *
   * 否则陈年流水要等累计写满 `PRUNE_EVERY` 条才被清 —— 一个每天只写几十条的部署
   * 永远轮不到清理，保留天数形同虚设（与 AuditService.onModuleInit 同一理由）。
   */
  onModuleInit(): void {
    this.prune();
  }

  /** input → 行（时间统一取这一批的同一毫秒，便于一次操作的多条记录在列表里连成一串） */
  private rowOf(entry: EventLogEntryInput, now: number): EventLogRow {
    return {
      id: randomUUID(),
      type: entry.type,
      account_id: entry.accountId ?? null,
      role_id: entry.roleId ?? null,
      role_name: entry.roleName ?? null,
      zone_id: entry.zoneId ?? null,
      map_id: entry.mapId ?? null,
      target: entry.target ?? null,
      amount: entry.amount ?? null,
      detail: serializeDetail(entry.detail),
      ip: entry.ip ?? null,
      success: entry.success === false ? 0 : 1,
      created_at: now,
    };
  }

  private pruneIfNeeded(): void {
    this.writeCount += 1;
    if (this.writeCount % PRUNE_EVERY !== 0) return;
    this.prune();
  }

  /** 按保留策略清理：先按天数、再按条数（两道闸独立生效，都为 0 = 不清理） */
  private prune(): void {
    try {
      const days = this.config.get<number>("eventLogRetentionDays") ?? 0;
      if (days > 0) {
        const removed = this.logs.pruneOlderThan(Date.now() - days * 24 * 3600_000);
        if (removed > 0) this.logger.log(`行为流水超过保留期 ${days} 天，已清理 ${removed} 条`);
      }
      const maxRows = this.config.get<number>("eventLogMaxRows") ?? 0;
      const overflow = this.logs.prune(maxRows);
      if (overflow > 0) this.logger.log(`行为流水超过上限 ${maxRows} 条，已清理最旧的 ${overflow} 条`);
    } catch (error) {
      this.logger.warn(`行为流水清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 载荷序列化上限（字符）。超了直接截断并标注 —— 一条流水不值得把整份背包塞进库 */
const DETAIL_MAX_CHARS = 2000;

/**
 * 载荷 → JSON 字符串
 *
 * 这里**不打码**（与 audit 的 `serialize` 不同）：这些载荷全部由服务端自己构造，
 * 不含口令 / 令牌；而背包操作那类「用户给的原样数据」也不需要脱敏 —— 包里只有物品。
 * 真正要防的是**体积**：`bagOp` 可以拖着整格背包过来，几百条流水就能把库写胖。
 */
function serializeDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  try {
    const text = JSON.stringify(detail);
    if (text === undefined) return null;
    return text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS)}…[截断]`;
  } catch {
    return null;
  }
}

/** 类型 → 中文名（未知类型回显原值） */
function labelOf(value: string): string {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_LABELS, value)
    ? EVENT_TYPE_LABELS[value as EventType]
    : value;
}

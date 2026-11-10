import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { ConfigRevisionRepository } from "../../database/repositories/config-revision.repository";
import { ConfigActor, ConfigVersionService } from "./config-version.service";
import {
  ConfigRestoreResultDto,
  ConfigRevisionDiffDto,
  ConfigRevisionDto,
  ConfigRevisionListDto,
  ConfigRevisionTableDiffDto,
} from "./dto/config-revision.dto";

/**
 * 配置表的**唯一清单**（`server/scripts/lib/config-tables.cjs`）
 *
 * 为什么要跨目录 require 这份 .cjs 而不是在 src 里再抄一份：
 * 那张清单是「哪些数据能跟着 git 走」的唯一判据（导出脚本、导入脚本、本服务都要用）。
 * 抄一份进 TS 就等于两个真相 —— 加一张表时只改一处，另一处静默漏掉：
 * 回滚会漏恢复一张表（少写），或者把运行时表当配置恢复（多写，可能写进别人的账号行）。
 *
 * 回滚时它还是**白名单**：payload 里的表名只有在这份清单里才允许 `DELETE` / `INSERT`
 * （payload 被人工改过也碰不到账号 / 存档）。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONFIG_TABLES } = require("../../../scripts/lib/config-tables.cjs") as { CONFIG_TABLES: readonly string[] };

/** 一层历史里存的东西：整份配置（按表分块），不是 diff */
interface ConfigPayload {
  /** 落层时的版本号（与行上的 version 一致；用于自检） */
  version: number;
  /** 表名 → 全部行（列名 → 值，与 `config-sync.sql` 的投影一致） */
  tables: Record<string, Record<string, unknown>[]>;
}

/** 列表一次最多取多少层（运营不会翻到第 50 层，取多了只是白读 payload 行头） */
const LIST_LIMIT_MAX = 100;

/**
 * 配置回滚历史（#882 / J2）
 *
 * ===========================================================================
 * 为什么存**全量**而不是 diff
 * ===========================================================================
 * 回滚要「一键」。diff 回滚得按顺序重放，中间任一层失败就是「半套配置」——
 * 那比不回滚更难查（玩家看到一个既不是旧版也不是新版的游戏）。
 * 全量恢复是「每张配置表 DELETE + 逐行 INSERT」，一个事务，要么全成要么全不动。
 *
 * 代价是每层几 MB（38 张表 JSON），保留 20 层 ≤ 100MB —— 运维上可接受。
 *
 * ## 节流
 *
 * 管理端「保存」按钮连点 8 次不该吃掉 8 层历史：`CONFIG_REVISION_THROTTLE_MS`（默认 10s）
 * 内**同一个人**的多次写合并成一层（删掉上一行、按新版本号重写，内容取最新）。
 * 跨人的改动从不合并 —— 合并会丢掉一方的 diff 归属（`created_by` 只剩一个人）。
 *
 * ## 回滚也是一层新版本
 *
 * 回滚不删历史、不改旧版本号：它把内容写回去、版本 +1、再落一层（label = 回滚到 vN）。
 * 于是「回滚错了」还能再滚回来。
 *
 * ## 分工
 *
 * 这一层只做**判定与叙事**（谁算同一层、保留几层、差在哪、该不该拒）——
 * 所有 SQL 在 `ConfigRevisionRepository`（表名是数据，只能运行期拼串，那属于仓储的事）。
 */
@Injectable()
export class ConfigRevisionService {
  private readonly logger = new Logger(ConfigRevisionService.name);

  constructor(
    private readonly revisions: ConfigRevisionRepository,
    private readonly versions: ConfigVersionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 落一层历史（由 `ConfigVersionInterceptor` 在写接口成功后调用）
   *
   * 失败**不抛**：配置本身已经写进库了，回滚历史是旁路 —— 不能因为「历史没记上」
   * 让一次成功的保存变成 500（运营会以为没保存，然后再点一次）。
   */
  record(version: number, actor: ConfigActor | null, label: string, options: { throttle?: boolean } = {}): void {
    try {
      const payload = this.dump(version);
      const text = JSON.stringify(payload);
      const now = Date.now();
      const retain = this.retain();
      const mergeable = options.throttle !== false;
      const throttle = mergeable ? (this.config.get<number>("configRevisionThrottleMs") ?? 0) : 0;
      const previous = this.revisions.latestMeta();
      const owner = actor?.username ?? "";

      this.revisions.transaction(() => {
        // 合并：同一人在窗口内的连点，删掉上一行（内容是旧一点的同一段改动）
        if (previous && throttle > 0 && previous.created_by === owner && now - previous.created_at <= throttle) {
          this.revisions.deleteRevision(previous.version);
        }
        // 保留层数：**先删最老的再插**，否则「满了写不进去」得靠异常来表达
        const total = this.revisions.countRevisions();
        if (total >= retain) this.revisions.deleteOldest(total - retain + 1);
        this.revisions.insertRevision({
          version,
          label,
          payload: text,
          byte_size: Buffer.byteLength(text),
          table_count: Object.keys(payload.tables).length,
          row_count: Object.values(payload.tables).reduce((sum, rows) => sum + rows.length, 0),
          created_by: owner,
          created_at: now,
        });
      });
    } catch (error) {
      this.logger.warn(`配置回滚历史没记上（不影响本次改动）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 版本列表（不含 payload） */
  list(limit = 20): ConfigRevisionListDto {
    const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), LIST_LIMIT_MAX);
    const rows = this.revisions.listRevisions(size);
    const dto = new ConfigRevisionListDto();
    dto.list = rows.map((row) => {
      const item = new ConfigRevisionDto();
      item.version = row.version;
      item.label = row.label;
      item.byteSize = row.byte_size;
      item.tableCount = row.table_count;
      item.rowCount = row.row_count;
      item.createdBy = row.created_by;
      item.createdAt = row.created_at;
      return item;
    });
    dto.total = dto.list.length;
    return dto;
  }

  /**
   * 两层之间的差异（**按表统计行数**，不到字段级）
   *
   * 为什么是行级：payload 是不透明 JSON，没有「主键」这个概念可用 ——
   * 靠主键猜（id / key / 复合键）会在没有 id 的表上给出错误答案。
   * 行级 + 「改一行 = 一删一加」至少是**永远正确**的口径：
   * 它不告诉你改了哪个字段，但它绝不谎报「这张表没变」。
   */
  diff(from: number, to: number): ConfigRevisionDiffDto {
    const before = this.payloadOf(from);
    const after = this.payloadOf(to);
    const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);

    const tables: ConfigRevisionTableDiffDto[] = [];
    for (const table of [...names].sort()) {
      const rowsBefore = before.tables[table] ?? [];
      const rowsAfter = after.tables[table] ?? [];
      const counter = new Map<string, number>();
      for (const row of rowsBefore) counter.set(signature(row), (counter.get(signature(row)) ?? 0) - 1);
      for (const row of rowsAfter) counter.set(signature(row), (counter.get(signature(row)) ?? 0) + 1);
      let added = 0;
      let removed = 0;
      for (const delta of counter.values()) {
        if (delta > 0) added += delta;
        else removed -= delta;
      }
      if (added === 0 && removed === 0 && rowsBefore.length === rowsAfter.length) continue;
      const item = new ConfigRevisionTableDiffDto();
      item.table = table;
      item.from = rowsBefore.length;
      item.to = rowsAfter.length;
      item.added = added;
      item.removed = removed;
      tables.push(item);
    }

    const dto = new ConfigRevisionDiffDto();
    dto.from = from;
    dto.to = to;
    dto.changed = tables.length;
    dto.tables = tables;
    return dto;
  }

  /**
   * 回滚到某一版（**单事务**，38 张表要么全回去要么一行不动）
   *
   * 三条自保：
   * 1. 只写 `CONFIG_TABLES` 里的表 —— payload 被人工改过也不会拿它去碰账号 / 存档；
   * 2. 库里没有的表（旧版本 payload 里多出来的）**跳过并告警**，不做结构迁移；
   * 3. 只插 payload 与当前表结构**交集**的列，多出来的列忽略（加过列的老 payload 也能用）。
   *
   * `PRAGMA defer_foreign_keys = ON` 让外键检查推到 COMMIT：配置表之间有引用
   * （比如掉落条目引用物品），逐表 DELETE/INSERT 的中途状态本来是不合法的。
   */
  restore(version: number, actor: ConfigActor | null): ConfigRestoreResultDto {
    if (!this.revisions.findRevision(version)) {
      throw BizException.notFound(BizCode.CONFIG_REVISION_NOT_FOUND, `没有第 ${version} 版配置历史（可能已被保留策略清掉）`);
    }

    const payload = this.payloadOf(version);
    const allowed = new Set(CONFIG_TABLES);
    const skipped: string[] = [];
    let tables = 0;
    let rows = 0;

    this.revisions.transaction(() => {
      this.revisions.deferForeignKeys();
      for (const [table, tableRows] of Object.entries(payload.tables)) {
        // payload 里有、库里没有这张表（或表名压根不是配置表）：不擅自建表，跳过并告警
        if (!allowed.has(table) || this.revisions.tableColumns(table).length === 0) {
          skipped.push(table);
          continue;
        }
        const inserted = this.revisions.replaceTable(table, tableRows);
        tables += 1;
        rows += inserted;
      }
    });

    if (skipped.length > 0) {
      this.logger.warn(`回滚到 v${version}：这些表被跳过（库里没有这个结构）—— ${[...new Set(skipped)].join(", ")}`);
    }

    // 回滚本身是一层新版本：内容回去了，历史继续往前长。
    // **不参与节流**：回滚前的那一层必须留着 —— 三者若合并成一层，「回滚点」就被自己的
    // 回滚操作吃掉了，想再滚回去时已经没有那一版可回
    const next = this.versions.bump(actor);
    this.record(next, actor, `restore:v${version}`, { throttle: false });

    const dto = new ConfigRestoreResultDto();
    dto.version = next;
    dto.restoredFrom = version;
    dto.tables = tables;
    dto.rows = rows;
    dto.skipped = [...new Set(skipped)];
    return dto;
  }

  /** 取一层的 payload（坏行直接拒，不做「尽量恢复」） */
  private payloadOf(version: number): ConfigPayload {
    const row = this.revisions.findRevision(version);
    if (!row) throw BizException.notFound(BizCode.CONFIG_REVISION_NOT_FOUND, `没有第 ${version} 版配置历史`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      throw new BizException(
        BizCode.CONFIG_REVISION_PAYLOAD_INVALID,
        `第 ${version} 版的配置内容不是合法 JSON（这一行被人工改过？）`,
        HttpStatus.CONFLICT,
      );
    }
    const payload = parsed as ConfigPayload;
    if (!payload || typeof payload !== "object" || !payload.tables || typeof payload.tables !== "object") {
      throw new BizException(
        BizCode.CONFIG_REVISION_PAYLOAD_INVALID,
        `第 ${version} 版的配置内容结构不对（缺 tables）`,
        HttpStatus.CONFLICT,
      );
    }
    return payload;
  }

  /** 整份配置 → `{tables: {表名: 行[]}}`（`config-sync.sql` 的 JSON 版投影） */
  private dump(version: number): ConfigPayload {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of CONFIG_TABLES) {
      // 老库 / 半升级的库里可能少表：`tableRows` 会抛，所以先问列（空 = 这张表不存在）
      if (this.revisions.tableColumns(table).length === 0) continue;
      tables[table] = this.revisions.tableRows(table);
    }
    return { version, tables };
  }

  private retain(): number {
    const value = this.config.get<number>("configRevisionRetain") ?? 20;
    return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 20;
  }
}

/** 行签名：列顺序不影响比较（两次 dump 的列顺序可能因 ALTER 历史而不同） */
function signature(row: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]));
}

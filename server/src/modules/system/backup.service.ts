import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { humanizeDuration } from "../../common/utils/ban.util";
import { backupIntervalMs, parseBackupStamp, resolveBackupDir } from "../../common/utils/backup.util";

/**
 * 自动备份的执行与记账
 *
 * ## 为什么不另写一份 VACUUM INTO
 *
 * 备份的核心套路（快照怎么产出、产出后怎么校验、旧的怎么淘汰）已经在
 * `scripts/backup.cjs` 里有一份，也是 `make db-backup` 走的那份。这里**复用它**
 * 而不是照抄 —— 两份实现各自漂移只会产生「手工备份跟自动备份不是同一个东西」
 * 这种很难查的结果。
 *
 * ## 为什么是子进程而不是就地 exec
 *
 * `VACUUM INTO` 会把整个库重写一遍，几十 MB 的库也要几秒。放在当前进程里跑
 * （哪怕是同步 API）都会让 Node 的事件循环停摆 —— 那几秒里所有玩家的请求一起卡住。
 * 交给独立进程，主进程只是在最后收个结果。
 *
 * ## 为什么结果要记账
 *
 * **静默失败的备份等于没有备份**。退出码、耗时、产出文件、失败原因都要留下来，
 * 由「系统信息」页显示（见 `SystemInfoDto.backup`），并且失败必然打一条 error 日志。
 */
export interface BackupState {
  /** 是否开启了自动备份（还要数据确实是个文件库） */
  enabled: boolean;
  /** 未启用时的原因（说明是人看的：内存库 / 关了开关）；启用时为空串 */
  reason: string;
  /** 备份间隔（毫秒）；0 = 未启用 */
  intervalMs: number;
  /** 备份间隔的人读文案 */
  intervalText: string;
  /** 备份目录（绝对路径）；内存库或未启用时可能是 null */
  dir: string | null;
  /** 保留份数（0 = 不按份数淘汰） */
  keepCount: number;
  /** 保留天数（0 = 不按天数淘汰） */
  retentionDays: number;
  /** 最后一次**尝试**的时刻（null = 从没跑过） */
  lastAttemptAt: number | null;
  /** 最后一次成功的时刻（null = 从没成功过） */
  lastSuccessAt: number | null;
  /** 最后一次的结果（null = 还没跑过，不看它）；true = 成功 */
  lastOk: boolean | null;
  /** 最后一次产出（或上次成功）的文件名 */
  lastFile: string | null;
  /** 最后一次产出（或上次成功）的体积（字节） */
  lastSizeBytes: number | null;
  /** 最后一次耗时（毫秒） */
  lastDurationMs: number | null;
  /** 最后一次失败的原因（成功时为空） */
  lastError: string | null;
  /** 目录里的备份份数 */
  count: number;
  /** 目录里备份的总体积（字节） */
  totalBytes: number;
  /** 下一次备份的时刻（未启用为 null） */
  nextAt: number | null;
}

/** 编译产物到 server/ 根的层数：`dist/modules/system/backup.service.js` → `server/` */
const SERVER_DIR = join(__dirname, "..", "..", "..");

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly dbPath: string;
  private readonly intervalHours: number;
  private state: BackupState;
  /** 上一轮还没跑完就又到点了：跳过这一轮，别把数据库压着连续重写两遍 */
  private running = false;

  constructor(private readonly config: ConfigService) {
    this.dbPath = config.get<string>("dbPath") ?? ":memory:";
    this.intervalHours = Number(config.get<number>("backupIntervalHours") ?? 24);
    const keepCount = Number(config.get<number>("backupKeepCount") ?? 7);
    const retentionDays = Number(config.get<number>("backupRetentionDays") ?? 30);
    const dir = resolveBackupDir(this.dbPath, config.get<string>("backupDir") ?? "", SERVER_DIR);
    const intervalMs = backupIntervalMs(this.intervalHours);
    // 内存库（e2e 与部分临时环境）根本没有文件可备份 —— 不是「配错了」，所以静静地关掉
    const enabled = intervalMs > 0 && dir !== null;

    this.state = {
      enabled,
      reason: enabled
        ? ""
        : dir === null
          ? "数据为内存库（:memory:），没有文件可备份"
          : "BACKUP_INTERVAL_HOURS=0（未启用）",
      intervalMs,
      intervalText: enabled ? `每 ${humanizeDuration(intervalMs)}` : "未启用",
      dir,
      keepCount: Number.isFinite(keepCount) ? Math.max(0, Math.trunc(keepCount)) : 0,
      retentionDays: Number.isFinite(retentionDays) ? Math.max(0, Math.trunc(retentionDays)) : 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastOk: null,
      lastFile: null,
      lastSizeBytes: null,
      lastDurationMs: null,
      lastError: null,
      count: 0,
      totalBytes: 0,
      nextAt: enabled ? Date.now() + intervalMs : null,
    };

    // 重启后从磁盘上的产物把「上次备到什么时候」捞回来：
    // 否则每重启一次就当成「从没备过」立刻重备一份，频繁重启会攒出一堆同名不同秒的备份
    this.syncFromDisk();
  }

  /**
   * 当前状态快照（读接口只拿这个，不碰内部字段）
   *
   * 份数与体积是**每次现扫**的（`make db-backup` 手工跑出来的备份也在同一个目录、
   * 走同样的保留策略），缓存下来只会让这一页和磁盘不一致。
   */
  snapshot(): BackupState {
    this.syncFromDisk();
    return { ...this.state };
  }

  /**
   * 跑一次备份（幂等：已经在跑就直接返回）
   *
   * 子进程是**异步**的，是为了不阻塞主进程；因此脚本起不来（`error` 事件，连退出码都没有）
   * 时也必须自己兜住，否则 `runOnce` 的 Promise 永远不 settle，到点判定就此停摆。
   */
  async runOnce(now: number = Date.now()): Promise<boolean> {
    if (!this.state.enabled || !this.state.dir) return false;
    if (this.running) {
      this.logger.warn("上一轮备份还没跑完，跳过这一轮");
      return false;
    }
    this.running = true;
    const startedAt = Date.now();
    const before = new Set(this.listFiles(this.state.dir));
    try {
      const result = await this.callScript(this.state.dir);
      this.state.lastAttemptAt = now;
      this.state.lastDurationMs = Date.now() - startedAt;
      this.refresh(this.state.dir, before, result, now);
      return result.ok;
    } finally {
      this.running = false;
    }
  }

  /** 调用运维用的同一份备份脚本，收集退出码与输出 */
  private callScript(dir: string): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 受限终端注入的 NODE_OPTIONS 会让子进程**静默起不来**（详见 docs/deploy.md），
      // 备份又是「失败也必须看得见」的东西，所以这里显式把它摘掉
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const child = spawn(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          join(SERVER_DIR, "scripts", "backup.cjs"),
          "--db",
          this.dbPath,
          "--out",
          dir,
          "--keep",
          // 传 0 = 不淘汰（脚本据此跳过清理）；这里**永远不会传出一个会把目录清空的值**
          String(this.state.keepCount),
          "--days",
          String(this.state.retentionDays),
        ],
        { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
      // 起不来（脚本缺失 / 权限问题）与「跑完但失败」是两种错，前者连退出码都没有
      child.on("error", (error: Error) => {
        stderr.push(error.message);
        resolve({ ok: false, code: null, stdout: stdout.join(""), stderr: stderr.join("") });
      });
      child.on("close", (code: number | null) => {
        resolve({ ok: code === 0, code, stdout: stdout.join(""), stderr: stderr.join("") });
      });
    });
  }

  /** 跑完之后更新记账；产出文件用「前后目录差集」认出来，不依赖脚本的输出文案 */
  private refresh(dir: string, before: Set<string>, result: { ok: boolean; stdout: string; stderr: string }, now: number): void {
    const after = this.listFiles(dir);
    const produced = after.find((name) => !before.has(name)) ?? null;

    if (result.ok) {
      const size = produced ? this.sizeOf(join(dir, produced)) : null;
      this.state.lastOk = true;
      this.state.lastSuccessAt = now;
      this.state.lastError = null;
      this.state.lastFile = produced;
      this.state.lastSizeBytes = size;
      this.logger.log(
        `自动备份完成：${produced ?? "（没认出产出文件）"} · ${(size ?? 0) / 1024 < 1024 ? `${Math.ceil((size ?? 0) / 1024)} KB` : `${Math.round((size ?? 0) / 1024 / 1024)} MB`} · 耗时 ${this.state.lastDurationMs}ms`,
      );
    } else {
      this.state.lastOk = false;
      this.state.lastError = this.errorText(result);
      // 失败也要清掉「上次成功」的错觉吗？**不**：信息页同时显示成功时刻与本次结果，
      // 运维需要知道「最近一次好的备份是多久以前」，把它抹掉只会让人以为从来没备份过
      this.logger.error(`自动备份失败：${this.state.lastError}`);
    }
    this.state.nextAt = this.state.enabled ? now + this.state.intervalMs : null;
  }

  /**
   * 从磁盘上的产物把状态补齐（构造时与每次读快照时都跑）
   *
   * 认下来的是**目录里最新的那份**：手工与自动跑出来的备份在同一个目录、走同一套保留策略，
   * 所以「上一次成功」应该按磁盘说话，而不是按本进程有没有亲自跑过。
   * `lastAttemptAt`（参与「到点没有」的判定）只在还没有记录时补 —— 它是服务端的记账，
   * 被手工产物一直往后推会让自动备份迟迟不到点。
   *
   * ⚠️ **这里是 `lastAttemptAt` 的第二个写者**（另一个是 `runOnce()` 里的 `refresh()`）。
   * 于是「磁盘上有产物」**不等于**「这一轮跑完了」：备份脚本先把文件写到盘上、父进程才在
   * `child.on("close")` 里记账，中间这条缝里 `lastFile` / `lastSizeBytes` / `lastAttemptAt`
   * 已经有值（体积甚至还是一份**写到一半**的文件），而 `lastOk` 还是 null。
   * 想知道「一轮真的跑完了」，只能看 `lastOk` —— 它**只有 `refresh()` 会写**，且写它的那段
   * 代码没有 await（同一口气里把 lastAttemptAt / lastFile / lastSizeBytes / lastSuccessAt /
   * nextAt 全部写完）。e2e 的等待判据就建在这条区分上（见 `server/test/backup.cjs`，#110）。
   */
  private syncFromDisk(): void {
    const dir = this.state.dir;
    if (!dir) return;
    const files = this.listFiles(dir);
    this.state.count = files.length;
    this.state.totalBytes = files.reduce((sum, name) => sum + this.sizeOf(join(dir, name)), 0);

    const latest = files[files.length - 1];
    if (!latest) return;
    const at = parseBackupStamp(latest);
    if (at === null) return;
    this.state.lastFile = latest;
    this.state.lastSizeBytes = this.sizeOf(join(dir, latest));
    if (this.state.lastSuccessAt === null || at > this.state.lastSuccessAt) this.state.lastSuccessAt = at;
    if (this.state.lastAttemptAt === null) this.state.lastAttemptAt = at;
  }

  /** 目录里的备份文件（按名字升序 = 时间升序；忽略不认识的文件，那些可能是别人的东西） */
  private listFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => parseBackupStamp(name) !== null)
      .sort();
  }

  private sizeOf(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  /** 失败原因：脚本的中文报错在一行里，取最后一段非空文字即可 */
  private errorText(result: { code?: number | null; stdout: string; stderr: string }): string {
    const raw = [result.stderr, result.stdout].map((text) => text.trim()).filter(Boolean).join(" | ");
    const fallback = result.code === null ? "备份脚本没能启动（文件缺失或无权执行）" : `备份脚本退出码 ${result.code}`;
    return raw ? raw.slice(-400) : fallback;
  }
}

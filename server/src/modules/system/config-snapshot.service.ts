import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";

/**
 * 配置快照导入导出（#1266）
 *
 * ## 为什么 spawn 脚本而不是移植一份 TS 实现
 *
 * 快照的生成 / 校验 / 版本闸 / 导入前留档 / 逐字节读回校验，全部已经在
 * `scripts/config-export.cjs` 与 `scripts/config-import.cjs` 里（`make config-export`
 * 与 `make config-import` 走的就是它们）。界面化的导入导出如果另写一份，迟早和命令行
 * 各自漂移 —— 「管理端导出的文件 make config-import 认不了」这种事只要发生一次就够了。
 * 所以这里**只负责把参数递进去、把输出递出来**，安全语义一概继承脚本。
 *
 * ## 为什么是子进程
 *
 * 导出要把全部配置表序列化成 SQL（几 MB），导入还要做一次完整的读回校验（再生成一遍）。
 * 放在本进程里跑会停摆事件循环；与自动备份（`backup.service.ts` 拉起 `scripts/backup.cjs`）
 * 同一个取向：交给独立进程，主进程只收结果。
 *
 * ## 互斥
 *
 * 导入是**整表替换**：两个管理员同时上传，后一个会把前一个刚写完的配置再盖一遍，
 * 版本闸也拦不住（两个文件都「比库新」）。所以服务端进程内一把互斥锁，进行中的导入
 * 直接 409。导出是只读的，不需要锁。
 *
 * ## 生效时机
 *
 * 导入写的是**库**；`RuntimeConfigService` 这些启动时装进内存的覆盖层不会自动刷新，
 * 与命令行口径一致 —— 界面上明确提示「导入成功后需重启服务端」。
 */

/** 编译产物到 server/ 根的层数：`dist/modules/system/config-snapshot.service.js` → `server/` */
const SERVER_DIR = join(__dirname, "..", "..", "..");

/** 导入上传内容的体积上限。当前快照约 4MB，64MB 给配置增长留足余量 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** 子进程超时：全量导出 + 读回校验在慢机器上也该在两分钟内完成；超时视为失败并杀掉 */
const SCRIPT_TIMEOUT_MS = 120_000;

/** 导出结果（给界面展示与下载） */
export interface ConfigSnapshotExportResult {
  /** config-sync.sql 全文（UTF-8 文本；前端转 Blob 落盘下载） */
  sql: string;
  /** 配置表张数（按文件里的 DELETE 段数统计，与格式标记解耦） */
  tables: number;
  /** 配置行数（按文件里的 INSERT 条数统计） */
  rows: number;
  /** 导出时库里的配置版本 */
  version: number;
}

/** 脚本运行结果（退出码 + 输出） */
interface ScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

@Injectable()
export class ConfigSnapshotService {
  private readonly logger = new Logger(ConfigSnapshotService.name);
  private readonly dbPath: string;
  /** 导入进行中标志（单进程内互斥；Nest 默认单实例，够用） */
  private importing = false;

  constructor(config: ConfigService) {
    this.dbPath = config.get<string>("dbPath") ?? ":memory:";
  }

  /** 导出当前库的配置快照（内容与 `make config-export` 完全一致） */
  async export(): Promise<ConfigSnapshotExportResult> {
    if (this.dbPath === ":memory:") {
      throw new BizException(
        BizCode.CONFIG_SNAPSHOT_EXPORT_FAILED,
        "数据为内存库（:memory:），没有文件可导出 —— 配置快照导入导出只在文件库部署形态下可用",
      );
    }

    const dir = await mkdtemp(join(tmpdir(), "olua-config-export-"));
    const out = join(dir, "config-sync.sql");
    try {
      const result = await this.runScript(["scripts/config-export.cjs", "--db", this.dbPath, "--out", out]);
      if (!result.ok) {
        this.logger.error(`配置快照导出失败：${extractCliMessage(result)}`);
        throw new BizException(
          BizCode.CONFIG_SNAPSHOT_EXPORT_FAILED,
          `配置快照导出失败：${extractCliMessage(result)}`,
        );
      }
      const sql = await readFile(out, "utf8");
      const version = parseVersion(sql);
      return { sql, tables: countDeletes(sql), rows: countInserts(sql), version };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * 导入一份配置快照（整表替换；语义全部继承 `config-import.cjs`）
   *
   * `force` = 确认回退：文件版本比库旧时，界面先给用户看过版本差、用户勾了
   * 「我确认要回退」才会带这个标记重试。导入前脚本仍会自动留档。
   */
  async import(sql: string, force: boolean): Promise<{ report: string }> {
    if (this.dbPath === ":memory:") {
      throw new BizException(
        BizCode.CONFIG_SNAPSHOT_IMPORT_FAILED,
        "数据为内存库（:memory:），没有文件可导入 —— 配置快照导入导出只在文件库部署形态下可用",
      );
    }
    if (this.importing) {
      throw BizException.conflict(
        BizCode.CONFIG_SNAPSHOT_IMPORT_BUSY,
        "已有一次导入正在进行 —— 整表替换必须独占，请等它结束后再试",
      );
    }

    this.importing = true;
    const dir = await mkdtemp(join(tmpdir(), "olua-config-import-"));
    const file = join(dir, "config-sync.sql");
    try {
      await writeFile(file, sql, "utf8");
      const args = ["scripts/config-import.cjs", "--db", this.dbPath, "--file", file];
      if (force) args.push("--force");
      const result = await this.runScript(args);

      if (!result.ok) {
        const message = extractCliMessage(result);
        // 失败也记日志但不打 error 级：版本闸拒绝是**正常业务分支**（界面会引导用户确认回退）
        this.logger.warn(`配置快照导入被拒绝：${message}`);
        throw new BizException(BizCode.CONFIG_SNAPSHOT_IMPORT_FAILED, `配置快照导入失败：${message}`);
      }

      const report = result.stdout.trim();
      this.logger.log(`配置快照导入成功（force=${force}）`);
      return { report };
    } finally {
      this.importing = false;
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 调用运维用的同一份脚本，收集退出码与输出（与 backup.service 同款，另加超时） */
  private runScript(args: string[]): Promise<ScriptResult> {
    return new Promise((resolve) => {
      // 与 backup.service 相同的坑：受限终端注入的 NODE_OPTIONS 会让子进程静默起不来，摘掉
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const child = spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", ...args],
        { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        stderr.push(`脚本执行超时（${SCRIPT_TIMEOUT_MS / 1000} 秒），已终止`);
      }, SCRIPT_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        stderr.push(error.message);
        resolve({ ok: false, stdout: stdout.join(""), stderr: stderr.join("") });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout: stdout.join(""), stderr: stderr.join("") });
      });
    });
  }
}

//#region 文件与输出的纯函数解析（e2e 直接锁这些判据）

/** 快照头部的配置版本（`-- config-version: N`；缺行按 0 —— 与 config-sql.cjs 同口径） */
export function parseVersion(sql: string): number {
  const prefix = "-- config-version: ";
  const line = sql.split("\n", 12).find((item) => item.startsWith(prefix));
  const value = line ? Number(line.slice(prefix.length).trim()) : 0;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** 配置表张数 = DELETE 段数（快照格式约定每张表恰好一条 DELETE） */
export function countDeletes(sql: string): number {
  return [...sql.matchAll(/^DELETE FROM "/gm)].length;
}

/** 配置行数 = INSERT 条数 */
export function countInserts(sql: string): number {
  return [...sql.matchAll(/^INSERT INTO "/gm)].length;
}

/**
 * 从脚本的 stderr / stdout 里提取可展示的中文报错
 *
 * CLI 失败是 throw 出来的：Node 打印的是「Error: 中文报错（可多行）+ 英文栈帧」。
 * 栈帧（4 空格缩进的 `at …`）对界面是噪音，从「Error: 」截到第一个栈帧；
 * 找不到标记（脚本直接崩 / 端上问题）就退回原文尾部。
 */
export function extractCliMessage(result: { stdout: string; stderr: string }): string {
  const raw = [result.stderr, result.stdout].map((text) => text.trim()).filter(Boolean).join("\n");
  const start = raw.lastIndexOf("Error: ");
  if (start < 0) return raw.slice(-600);
  const from = start + "Error: ".length;
  let end = raw.indexOf("\n    at ", from);
  if (end < 0) end = raw.length;
  const message = raw.slice(from, end).trim();
  return message || raw.slice(-600);
}

//#endregion

/** 上传体积超上限的报错（供控制器在收流时抛） */
export function importBodyTooLarge(): BizException {
  return new BizException(
    BizCode.CONFIG_SNAPSHOT_IMPORT_FAILED,
    `上传内容超过 ${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)} MB 上限 —— 这不像一份配置快照，拒绝接收`,
  );
}

export { MAX_IMPORT_BYTES };

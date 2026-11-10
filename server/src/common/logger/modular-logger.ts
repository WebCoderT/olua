import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoggerService, LogLevel } from "@nestjs/common";

const DEFAULT_LEVELS: LogLevel[] = ["log", "warn", "error"];
const LEVEL_STYLES: Record<LogLevel, { icon: string; color: string }> = {
  log: { icon: "ℹ", color: "\u001b[36m" },
  warn: { icon: "⚠", color: "\u001b[33m" },
  error: { icon: "✖", color: "\u001b[31m" },
  debug: { icon: "●", color: "\u001b[90m" },
  verbose: { icon: "·", color: "\u001b[90m" },
  fatal: { icon: "‼", color: "\u001b[35m" },
};
const COLOR_RESET = "\u001b[0m";

/** 将所有模块日志汇总到控制台，并按 Logger context 分文件追加保存。 */
export class ModularLogger implements LoggerService {
  private logDirectory: string;
  private levels = new Set<LogLevel>(DEFAULT_LEVELS);

  constructor(logDirectory = join(process.cwd(), "logs")) {
    this.logDirectory = resolve(logDirectory);
  }

  setLogDirectory(logDirectory: string): void {
    this.logDirectory = resolve(logDirectory);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.levels = new Set(levels);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (!this.levels.has(level)) return;

    const params = [...optionalParams];
    const context = typeof params.at(-1) === "string" ? (params.pop() as string) : "Application";
    const details = [message, ...params].map(formatValue).filter(Boolean).join(" ");
    const timestamp = new Date().toISOString();
    const lines = (details || "").split(/\r?\n/).map((line) => `${timestamp} [${level.toUpperCase()}] [${context}] ${line}`);
    const output = lines.join("\n");
    const style = LEVEL_STYLES[level];
    const consoleOutput = lines.map((line) => `${style.icon} ${line}`);
    const isTty = level === "error" || level === "fatal" ? process.stderr.isTTY : process.stdout.isTTY;
    const formattedConsoleOutput = isTty
      ? consoleOutput.map((line) => `${style.color}${line}${COLOR_RESET}`).join("\n")
      : consoleOutput.join("\n");

    if (level === "error" || level === "fatal") console.error(formattedConsoleOutput);
    else console.log(formattedConsoleOutput);

    try {
      mkdirSync(this.logDirectory, { recursive: true });
      const filename = context.replace(/[^a-zA-Z0-9._-]/g, "_") || "Application";
      appendFileSync(join(this.logDirectory, `${filename}.log`), `${output}\n`, "utf8");
    } catch (error) {
      console.error(`日志文件写入失败：${formatValue(error)}`);
    }
  }
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
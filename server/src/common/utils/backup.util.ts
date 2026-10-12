import { dirname, isAbsolute, join } from "node:path";

/**
 * 自动备份的纯逻辑（不碰文件系统、不起子进程，可在 e2e 里直接 require dist 产物验证）
 *
 * 单独放在这里有两个理由：
 *
 * 1. **到点判定是最容易写错的一段**（时间戳单位、首次要不要跑、关闭时是什么语义），
 *    让它成为纯函数后，「多久备份一次」这件事能被边界值测出来，不必起真服务，
 *    也不用真等 24 小时；
 * 2. 备份目录的落点同样需要一处判据 —— 服务端与运维脚本（`scripts/backup.cjs`）
 *    必须算出同一个目录，算岔了就是「备份写到容器临时层」这种事后才发现的事故。
 */

/** 备份文件名：`olua-20261009-153000.db`（字典序 = 时间序，所以按名字排序就是按时间排序） */
export const BACKUP_FILE_PATTERN = /^olua-(\d{8})-(\d{6})\.db$/;

/** 一小时有多少毫秒（配置项以小时为单位，内部一律换算成毫秒再算） */
export const HOUR_MS = 60 * 60 * 1000;

/** 一天有多少毫秒（保留天数同理） */
export const DAY_MS = 24 * HOUR_MS;

/**
 * 检查节拍的下限（毫秒）
 *
 * 定时**不是**每毫秒去看一次，而是周期性瞄一眼「到点没有」。下限防止有人把
 * `BACKUP_INTERVAL_HOURS` 配成极小值（或手滑写错单位）时，定时器变成忙循环。
 */
export const BACKUP_CHECK_MIN_MS = 10 * 1000;

/** 检查节拍的上限（毫秒）：最迟一分钟瞄一眼，保证备份不会因为检查间隔而迟到太多 */
export const BACKUP_CHECK_MAX_MS = 60 * 1000;

/** 间隔（小时）→ 毫秒；`<= 0` 表示**关闭自动备份**，返回 0 */
export function backupIntervalMs(intervalHours: number): number {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return 0;
  return intervalHours * HOUR_MS;
}

/**
 * 到点了没有
 *
 * `lastAttemptAt = null`（从没跑过）一律算**到点**：新部署的服务应该在第一个节拍
 * 就拿到第一份备份，而不是空等一个周期。进程重启后这个值会从磁盘上的备份推断出来
 * （见 `BackupService`），所以重启也不会反复重备。
 */
export function isBackupDue(lastAttemptAt: number | null, now: number, intervalHours: number): boolean {
  const intervalMs = backupIntervalMs(intervalHours);
  if (intervalMs <= 0) return false;
  if (lastAttemptAt === null) return true;
  return now - lastAttemptAt >= intervalMs;
}

/**
 * 定时器的检查节拍（毫秒）；返回 0 = 不启用（不要起定时器）
 *
 * 取「一个周期」与上下限的夹逼：周期短于下限按下限，长于上限按上限 ——
 * 备份不必精确到秒，检查间隔不该成为论文题材。
 */
export function backupCheckMs(intervalHours: number): number {
  const intervalMs = backupIntervalMs(intervalHours);
  if (intervalMs <= 0) return 0;
  return Math.min(Math.max(intervalMs, BACKUP_CHECK_MIN_MS), BACKUP_CHECK_MAX_MS);
}

/**
 * 解析备份文件名里的时间戳；不是备份文件返回 null
 *
 * 用文件名而不是 `mtime` 是因为**拷贝会改掉 mtime**：把备份 scp 到另一台机器、
 * 打包再解开，文件时间就变成了「复制的时刻」，按天数淘汰时该清的老文件会被算成新的。
 * 文件名是产出时写死的，跟着文件走。
 */
export function parseBackupStamp(name: string): number | null {
  const matched = BACKUP_FILE_PATTERN.exec(name);
  if (!matched) return null;
  const [, day, time] = matched;
  const at = new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  ).getTime();
  return Number.isNaN(at) ? null : at;
}

/**
 * 备份目录的解析：**默认跟着数据文件走**
 *
 * 写成数据文件同级而不是固定的 `server/backups`，是因为容器里只有数据卷是持久的：
 * `docker-compose.yml` 把 `olua-data` 挂到 `/app/data`，要是备份落到 `/app/backups`
 * 这种没挂载的路径上，容器一重建备份就全没了 —— 而「自动备份在跑」这件事表面上看不出
 * 任何异常，直到真需要恢复的那天。
 *
 * 显式配了 `BACKUP_DIR` 就以它为准（相对路径按传入的基准目录解析）。
 * 内存库没有数据文件，返回 null（也就意味着没有可备份的东西）。
 */
export function resolveBackupDir(dbPath: string, explicit: string, cwd: string): string | null {
  if (dbPath === ":memory:") return null;
  if (explicit.trim()) return isAbsolute(explicit) ? explicit : join(cwd, explicit);
  return join(dirname(dbPath), "backups");
}

/**
 * 配置快照的原始传输调用（#1266，**手写** —— 生成层覆盖不了的特殊传输）
 *
 * 导出走生成好的 `systemApi.exportConfigSnapshot`（SQL 是文本，随 JSON 信封回来）；
 * 导入的请求体是 4MB+ 的 SQL **纯文本**，不走 JSON 信封（会被解析器默认上限顶回去），
 * 所以单独一个手写模块用 `http.postText` 直发。路径与类型仍然来自生成物
 * （`./routes` / `./models`），页面不写路径字面量。
 */
import { http } from "./http";
import { routes } from "./routes";
import type { ConfigSnapshotExport, ConfigSnapshotImportResult } from "./models";

/** 导入比一般接口慢（整表替换 + 导入后逐字节读回校验），单独放宽到 3 分钟 */
const IMPORT_TIMEOUT_MS = 180_000;

export const configSnapshotApi = {
  /** 导入一份 config-sync.sql 全文；`force` = 用户已确认「文件比库旧也要回退」 */
  importRaw: (sql: string, force: boolean) =>
    http.postText<ConfigSnapshotImportResult>(routes.adminSystem.importConfigSnapshot, sql, {
      query: force ? { force: "true" } : undefined,
      timeout: IMPORT_TIMEOUT_MS,
    }),
};

export type { ConfigSnapshotExport, ConfigSnapshotImportResult };

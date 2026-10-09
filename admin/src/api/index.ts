/**
 * 接口层统一出口
 *
 * 页面只从这里 import（`import { rolesApi } from "../api"`），
 * 于是「地址从哪来、怎么发、错误怎么归一」永远收在 api/ 目录里。
 *
 * 三块内容各有归属：
 * - **生成物**（禁止手改）：`./endpoints` 接口方法 + `./models` 实体类型 + `./routes` 路径表，
 *   由 `tools/gen-api.cjs` 从服务端 OpenAPI 文档生成；
 * - **手写**：`./types` 里的错误模型、业务码、权限点、展示字典（服务端文档描述不了它们）；
 * - `./config` / `./http`：地址与请求实现，页面不直接碰。
 */
export { announcementsApi, authApi, accountsApi, adminsApi, rolesApi, auditApi, statsApi, systemApi } from "./endpoints";
export { routes } from "./routes";
export type * from "./models";

export { ApiError } from "./types";
export type { ApiEnvelope, PageResult, PermissionValue } from "./types";
export {
  ADMIN_ROLE,
  ADMIN_ROLE_LABELS,
  adminRoleLabel,
  ANNOUNCEMENT_LEVEL,
  ANNOUNCEMENT_LEVEL_LABELS,
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_LABELS,
  auditActionLabel,
  auditTargetLabel,
  BAN_DURATION_MAX_HOURS,
  BAN_DURATION_PRESETS,
  BAN_REASON_MAX_LENGTH,
  banStateOf,
  BIZ_CODE,
  formatBytes,
  formatDuration,
  formatTime,
  formatTimeFull,
  localInputToMs,
  msToLocalInput,
  OCCUPATION_LABELS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSION,
  PERMISSION_LABELS,
  permissionLabel,
  ROLE_BAG_AXIS_MAX,
  SEX_LABELS,
} from "./types";

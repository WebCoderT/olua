/**
 * 接口层统一出口
 *
 * 页面只从这里 import（`import { accountsApi } from "../api"`），
 * 于是「地址从哪来、怎么发、错误怎么归一」永远收在 api/ 目录里。
 */
export { authApi } from "./auth.api";
export { accountsApi } from "./accounts.api";
export { adminsApi } from "./admins.api";
export { rolesApi } from "./roles.api";
export { ApiError } from "./types";
export type {
  Account,
  AccountDetail,
  AdminInfo,
  AdminRole,
  AdminStats,
  AdminUpdatePayload,
  BatchDeleteResult,
  PageResult,
  RoleBagCell,
  RoleListQuery,
  RolePatchPayload,
  RoleSummary,
} from "./types";
export {
  ADMIN_ROLE,
  adminRoleLabel,
  ADMIN_ROLE_LABELS,
  formatTime,
  OCCUPATION_LABELS,
  PERMISSION,
  ROLE_BAG_AXIS_MAX,
  SEX_LABELS,
} from "./types";

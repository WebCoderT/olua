import { SetMetadata } from "@nestjs/common";
import { PermissionValue } from "../constants/permission";

export const PERMISSIONS_KEY = "olua:permissions";

/**
 * 标记接口所需的权限点（仅管理端接口使用，可传多个 = 全都要有）
 *
 * 校验在 common/guards/permission.guard：从 AuthGuard 查库后挂上的 `request.user.role`
 * 反查角色权限表，不通过则 403（业务码 30006）。**只在这里声明，业务代码里不许写角色判断**。
 */
export const RequirePermissions = (...permissions: PermissionValue[]) => SetMetadata(PERMISSIONS_KEY, permissions);

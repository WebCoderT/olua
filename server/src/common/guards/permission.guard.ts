import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { BizCode } from "../constants/biz-code";
import { PERMISSION_LABELS, PermissionValue, roleHasPermission } from "../constants/permission";
import { PERMISSIONS_KEY } from "../decorators/permission.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { BizException } from "../errors/biz.exception";
import { AuthenticatedUser } from "../interfaces/api-envelope.interface";

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/**
 * 全局权限守卫（**在 AuthGuard 之后执行**，注册顺序见 app.module）
 *
 * 分工：AuthGuard 负责「你是谁」（令牌 + 受众 + 回查库），这里负责「你能不能干这件事」。
 * 因此它不再查库 —— 直接用 AuthGuard 填好的 `request.user.role`（角色变更下次请求即生效）。
 *
 * 规则：
 * - 公共接口 / 没标 `@RequirePermissions` 的接口：放行（客户端接口只靠受众与归属校验）
 * - 标了权限点的接口：必须持有**全部**列出的权限点，否则 403（业务码 30006）
 *
 * 权限点与角色的对应关系只存在 `constants/permission.ROLE_PERMISSIONS` 一处，
 * 业务代码里**不要**再写 `if (role === "admin")` 这类判断。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<PermissionValue[]>(PERMISSIONS_KEY, targets);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) throw BizException.unauthorized(BizCode.UNAUTHORIZED, "请先登录");

    // 权限点只用于管理端；玩家令牌不该走到这里（受众守卫已拦），这里再兜一层
    if (user.kind !== "admin") throw BizException.forbidden(BizCode.FORBIDDEN, "无权访问该接口");

    const missing = required.filter((permission) => !roleHasPermission(user.role, permission));
    if (missing.length > 0) {
      const names = missing.map((permission) => PERMISSION_LABELS[permission]).join("、");
      throw BizException.forbidden(BizCode.ADMIN_PERMISSION_DENIED, `当前角色没有该操作权限：${names}`);
    }
    return true;
  }
}

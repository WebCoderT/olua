import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { BizCode } from "../constants/biz-code";
import { isAdminRole } from "../constants/permission";
import { ENTITY_STATUS } from "../constants/status";
import { AUDIENCE_KEY } from "../decorators/audience.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { BizException } from "../errors/biz.exception";
import { Audience, AuthenticatedUser } from "../interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import { AdminRepository } from "../../database/repositories/admin.repository";
import { TokenService } from "../../modules/token/token.service";

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/**
 * 全局认证守卫
 *
 * 路由默认「需要登录」，且默认面向玩家（audience = player）；规则：
 * - `@Public()`：完全放行（注册 / 登录 / 健康检查）
 * - `@ApiAudience("admin")`：必须用管理端令牌（令牌 aud 不符即拒绝）
 * - 通过后把 `{ id, username, kind }` 挂到 request.user，控制器用 `@CurrentUser()` 取
 *
 * 每次请求都回查一次库（而不是只信令牌）：账号被封禁 / 被删除时令牌立即失效，
 * 否则封禁要等令牌过期才生效。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly accounts: AccountRepository,
    private readonly admins: AdminRepository,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const audience = this.reflector.getAllAndOverride<Audience>(AUDIENCE_KEY, targets) ?? "player";
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = TokenService.extractBearer(request.headers.authorization);
    if (!token) throw BizException.unauthorized(BizCode.UNAUTHORIZED, "请先登录");

    const payload = this.tokens.verify(token, audience);

    if (audience === "admin") {
      const admin = this.admins.findById(payload.sub);
      if (!admin) throw BizException.unauthorized(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
      if (admin.status !== ENTITY_STATUS.ACTIVE) throw BizException.unauthorized(BizCode.ADMIN_DISABLED, "管理员账号已停用");
      request.user = {
        id: admin.id,
        username: admin.username,
        kind: "admin",
        // 角色每次从库里取（改了角色下次请求即生效）；脏角色兜底成「无角色」= 无任何权限
        role: isAdminRole(admin.role) ? admin.role : undefined,
      } satisfies AuthenticatedUser;
      return true;
    }

    const account = this.accounts.findById(payload.sub);
    if (!account) throw BizException.unauthorized(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    if (account.status !== ENTITY_STATUS.ACTIVE) throw BizException.unauthorized(BizCode.ACCOUNT_DISABLED, "账号已被封禁，请联系客服");
    request.user = { id: account.id, username: account.username, kind: "player" } satisfies AuthenticatedUser;
    return true;
  }
}

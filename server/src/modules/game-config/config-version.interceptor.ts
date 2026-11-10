import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { Observable, tap } from "rxjs";
import { AUDIT_ACTION_KEY } from "../../common/decorators/audit-target.decorator";
import { PERMISSIONS_KEY } from "../../common/decorators/permission.decorator";
import { Permission, PermissionValue } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { ConfigRevisionService } from "./config-revision.service";
import { ConfigVersionService } from "./config-version.service";

type ConfigRequest = Request & { user?: AuthenticatedUser };

/** 只有这些方法算「改配置」（GET 再怎么写都不该 +1） */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 配置版本自增（#881 / J1）—— **一处做，不在 50 个 service 里写**
 *
 * ===========================================================================
 * 判据是权限点，不是路径
 * ===========================================================================
 * 配置写接口散在四个模块里（game-config / map / ui-effect / audio-setting，共 71 个路由），
 * 按路径列清单一定会漏 —— 漏掉的那个接口表现为「管理端改了、客户端一直拿 304」，
 * 而且日志里一个字都没有。
 *
 * 而它们**都带 `gameConfig:write` 权限点**（这一层的唯一入口在 constants/permission）：
 * 「能改全服数值」这件事本来就只有一个权限点，用它当判据既不会漏也不会误伤
 * （`role:write` 改的是某个玩家的存档，不进配置版本；`config:restore` 回滚自己会 +1，
 * 见 `ConfigRevisionService.restore`）。
 *
 * ## 时序
 *
 * 写在 `tap({ next })` 里：**响应成功之后**才 +1。校验失败 / 业务异常不改版本 ——
 * 否则一次 400 也会让全服客户端重拉一遍快照（几 MB）。
 *
 * 失败一律吞掉：版本号与回滚历史都是旁路，不能因为旁路出问题把一次成功的保存变成 500。
 */
@Injectable()
export class ConfigVersionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ConfigVersionInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly versions: ConfigVersionService,
    private readonly revisions: ConfigRevisionService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ConfigRequest>();
    if (!WRITE_METHODS.has(request.method.toUpperCase())) return next.handle();

    const targets = [context.getHandler(), context.getClass()];
    const permissions = this.reflector.getAllAndOverride<PermissionValue[]>(PERMISSIONS_KEY, targets) ?? [];
    if (!permissions.includes(Permission.GAME_CONFIG_WRITE)) return next.handle();

    const user = request.user;
    const actor = user && user.kind === "admin" ? { id: user.id, username: user.username } : null;
    const label = this.reflector.getAllAndOverride<string>(AUDIT_ACTION_KEY, targets) ?? `${request.method} ${request.path}`;

    return next.handle().pipe(
      tap({
        next: () => {
          try {
            const version = this.versions.bump(actor);
            this.revisions.record(version, actor, label);
          } catch (error) {
            this.logger.warn(`配置版本没 +1（本次改动已生效，客户端可能不会立刻重拉）：${describe(error)}`);
          }
        },
      }),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { BizCode } from "../constants/biz-code";
import { AUDIT_ACTION_KEY, AUDIT_TARGET_KEY, AuditTargetMeta } from "../decorators/audit-target.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { BizException } from "../errors/biz.exception";
import { AuthenticatedUser } from "../interfaces/api-envelope.interface";
import { AuditService } from "../../modules/audit/audit.service";

type AuditRequest = Request & { user?: AuthenticatedUser };

/** 只审这些方法（读接口不记，否则一页列表就把日志刷满） */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 管理端写操作审计（全局拦截器）
 *
 * 设计要点：
 * - **动作不另设清单**：action 直接取 `ApiAdminDoc({ operationId })` 顺带写入的元数据，
 *   于是「文档里的接口标识」与「日志里的动作」永远是同一个字符串，加接口时零额外工作。
 * - **只审管理端**：玩家接口量大且属于玩家自己的数据，不在「运营操作留痕」的范围内
 *   （登录、改密这类关键认证事件由各 service 显式记，见 AuditService.record）。
 * - **不碰主流程**：记录放在 tap 里，且 AuditService.record 自身吞异常 ——
 *   审计是旁路，不该让一次正常的管理操作因为日志表出问题而失败。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const http = context.switchToHttp();
    const request = http.getRequest<AuditRequest>();

    // 公开接口（登录等）没有已认证的操作人，由 service 自己记
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return next.handle();
    const action = this.reflector.getAllAndOverride<string>(AUDIT_ACTION_KEY, targets);
    if (!action) return next.handle();
    if (!WRITE_METHODS.has(request.method.toUpperCase())) return next.handle();

    const user = request.user;
    if (!user || user.kind !== "admin") return next.handle();

    const meta = this.reflector.getAllAndOverride<AuditTargetMeta>(AUDIT_TARGET_KEY, targets);
    const targetId = meta
      ? meta.source === "self"
        ? user.id
        : ((request.params?.id as string | undefined) ?? null)
      : null;

    // 请求体就是「改了什么」的原始记录（ValidationPipe 已按白名单过滤；AuditService 会打码）
    const detail = detailOf(request);

    const base = {
      actor: { id: user.id, username: user.username, role: user.role },
      action,
      targetType: meta?.type ?? null,
      targetId,
      detail,
      ip: request.ip ?? null,
      method: request.method.toUpperCase(),
      path: request.originalUrl,
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const response = http.getResponse<Response>();
          this.audit.record({ ...base, success: true, statusCode: response.statusCode });
        },
        error: (error: unknown) => {
          const info = describeError(error);
          this.audit.record({ ...base, success: false, ...info });
        },
      }),
    );
  }
}

/** 取请求体作为上下文（GET/DELETE 一般没有 body） */
function detailOf(request: AuditRequest): unknown {
  const body = (request as Request & { body?: unknown }).body;
  if (body === undefined || body === null) return null;
  if (typeof body === "object" && Object.keys(body as object).length === 0) return null;
  return body;
}

/** 从异常里取业务码 / HTTP 状态 / 可展示文案 */
function describeError(error: unknown): { statusCode: number; errorCode: number; errorMessage: string } {
  if (error instanceof BizException) {
    return { statusCode: error.getStatus(), errorCode: error.code, errorMessage: error.message };
  }
  if (error instanceof HttpException) {
    const payload = error.getResponse();
    const message =
      typeof payload === "string"
        ? payload
        : typeof (payload as { message?: unknown }).message === "string"
          ? ((payload as { message: string }).message as string)
          : error.message;
    return { statusCode: error.getStatus(), errorCode: BizCode.PARAM_INVALID, errorMessage: message };
  }
  return {
    statusCode: 500,
    errorCode: BizCode.INTERNAL,
    errorMessage: error instanceof Error ? error.message : "未知错误",
  };
}

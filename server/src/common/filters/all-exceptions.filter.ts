import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Request, Response } from "express";
import { BizCode } from "../constants/biz-code";
import { BizException } from "../errors/biz.exception";

/**
 * 统一异常出口
 *
 * 任何异常（业务异常 / 参数校验 / 未捕获异常）都收敛成同一种响应体：
 * `{ code, message, data: null, timestamp, path }`
 * 5xx 额外打日志（带堆栈），4xx 只回消息 —— 面向调用方的 message 一定是中文。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exception");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: number = BizCode.INTERNAL;
    let message = "服务器内部错误，请稍后再试";

    if (exception instanceof BizException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = this.codeOfStatus(status);
      message = this.messageOf(exception);
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({ code, message, data: null, timestamp: Date.now(), path: request.url });
  }

  /** HTTP 状态码 → 通用业务码 */
  private codeOfStatus(status: number): number {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return BizCode.PARAM_INVALID;
      case HttpStatus.UNAUTHORIZED:
        return BizCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return BizCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return BizCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return BizCode.CONFLICT;
      default:
        return status >= 500 ? BizCode.INTERNAL : BizCode.PARAM_INVALID;
    }
  }

  /** 从 HttpException 里取可展示信息（ValidationPipe 会给一个 message 数组） */
  private messageOf(exception: HttpException): string {
    const payload = exception.getResponse();
    if (typeof payload === "string") return payload;
    const detail = (payload as { message?: string | string[] }).message;
    if (Array.isArray(detail)) return detail.join("；");
    if (typeof detail === "string" && detail) return detail;
    return exception.message;
  }
}

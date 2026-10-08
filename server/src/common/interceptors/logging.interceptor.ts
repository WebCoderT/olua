import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { Observable, tap } from "rxjs";

/**
 * 请求日志（开发期用来对着客户端 / 管理端排查「到底发没发、发了什么」）
 * 由配置 LOG_REQUESTS 开关；日志只打方法、路径与耗时，**不打请求体**（里面有密码）。
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  constructor(private readonly config: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.config.get<boolean>("logRequests")) return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const startedAt = Date.now();
    return next.handle().pipe(tap(() => this.logger.log(`${request.method} ${request.originalUrl} ${Date.now() - startedAt}ms`)));
  }
}

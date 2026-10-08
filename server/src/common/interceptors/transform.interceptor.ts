import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";
import { BizCode } from "../constants/biz-code";
import { ApiEnvelope } from "../interfaces/api-envelope.interface";

/**
 * 统一响应包裹
 *
 * 控制器只返回「业务数据」，这里补上 code / message / timestamp，
 * 于是客户端与管理端的请求层只需要写一次解包逻辑。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T | null>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T | null>> {
    return next.handle().pipe(
      map((data) => ({
        code: BizCode.OK,
        message: "ok",
        data: data ?? null,
        timestamp: Date.now(),
      })),
    );
  }
}

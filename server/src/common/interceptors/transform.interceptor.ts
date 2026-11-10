import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";
import { BizCode } from "../constants/biz-code";
import { ApiEnvelope } from "../interfaces/api-envelope.interface";

/**
 * 成功响应的信封（**形状的唯一来源**）
 *
 * 全局拦截器用它包所有返回值；极少数「必须自己写响应」的接口也用它 ——
 * 目前只有配置快照（#881：要发 304，而 304 不能用 passthrough 返回，见那个控制器）。
 * 两处共用这一个函数，才不会出现「有的接口信封里没有 timestamp」这种事。
 */
export function apiEnvelope<T>(data: T | null | undefined): ApiEnvelope<T | null> {
  return {
    code: BizCode.OK,
    message: "ok",
    data: data ?? null,
    timestamp: Date.now(),
  };
}

/**
 * 统一响应包裹
 *
 * 控制器只返回「业务数据」，这里补上 code / message / timestamp，
 * 于是客户端与管理端的请求层只需要写一次解包逻辑。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T | null>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T | null>> {
    return next.handle().pipe(map((data) => apiEnvelope(data)));
  }
}

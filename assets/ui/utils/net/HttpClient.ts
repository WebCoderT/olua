import { networkConfig } from "../../../configs/network";
import type { HttpMethod } from "../../../configs/network";
import ApiError, { ApiErrorKind } from "./ApiError";
import { ApiErrorTextKey } from "./ApiRoutes";
import Session from "./Session";

/** 统一响应包裹（与服务端一致：{ code, message, data, timestamp }） */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: number;
  path?: string;
}

/** 查询参数（值为空串/undefined/null 时自动跳过） */
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** 请求描述（业务层只填这些） */
export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: unknown;
  /** 是否带令牌（注册/登录为 false）；默认 true */
  auth?: boolean;
  /** 超时覆盖（默认走 configs/network.timeout） */
  timeout?: number;
  /**
   * 静默模式：失败不交给全局提示出口（调用方自己决定怎么提示）
   *
   * 给「后台自动跑、玩家没主动触发」的请求用 —— 典型是角色进度同步（打怪时每 1.5 秒推一次，
   * 后端宕机时若每次都弹提示会刷屏，见 utils/net/RoleSync）。需要重登时依旧回登录场景：
   * 令牌失效不是「可以静默」的错误，闷掉会让玩家卡在一个永远失败的游戏里。
   */
  silent?: boolean;
}

/** 加工后的请求（拦截器拿到的是它：已经拼好 url、带好默认头） */
interface ResolvedRequest extends RequestOptions {
  url: string;
  headers: Record<string, string>;
}

export type RequestInterceptor = (request: ResolvedRequest) => ResolvedRequest;

/**
 * 请求层（全客户端**唯一**发请求的地方）
 *
 * 统一调度：拦截器链 → 超时 → 失败重试（仅网络层）→ 响应包裹解包 → 错误归一 → 需要重登时回登录场景。
 * 业务代码只写「路径 + 入参 + 返回类型」，不碰 XMLHttpRequest、不写 Authorization、不判 HTTP 状态码。
 *
 * 为什么用 XMLHttpRequest 而不是 fetch：Cocos 在 Web 与原生两端都保证有 XMLHttpRequest，
 * fetch 在部分原生环境并不存在（用 fetch 会让同一份代码在两端行为不一致）。
 */
export default class HttpClient {
  private static requestInterceptors: RequestInterceptor[] = [];
  /** 需要重新登录时的处理（由游戏入口接上「回登录场景」，请求层不认识场景） */
  private static unauthorizedHandler: (() => void) | null = null;
  /** 失败观察者（统一的错误提示出口） */
  private static failureHandler: ((error: ApiError) => void) | null = null;

  /** 注册请求拦截器（按注册顺序执行；默认的「注入令牌」已注册为第一个） */
  static addRequestInterceptor(interceptor: RequestInterceptor) {
    this.requestInterceptors.push(interceptor);
  }

  /** 注册「需要重新登录」的处理 */
  static setUnauthorizedHandler(handler: (() => void) | null) {
    this.unauthorizedHandler = handler;
  }

  /** 注册全局失败观察者（提示层用） */
  static setFailureHandler(handler: ((error: ApiError) => void) | null) {
    this.failureHandler = handler;
  }

  static get<T>(path: string, options: Omit<RequestOptions, "method" | "path"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "GET", path });
  }

  static post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "path" | "body"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "POST", path, body });
  }

  static put<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "path" | "body"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "PUT", path, body });
  }

  static del<T>(path: string, options: Omit<RequestOptions, "method" | "path"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "DELETE", path });
  }

  /** 统一调度：重试 → 解包 → 错误归一 → 未登录兜底 */
  private static async request<T>(options: RequestOptions): Promise<T> {
    const attempts = Math.max(1, networkConfig.retry + 1);
    let failure: ApiError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.send<T>(options);
      } catch (error) {
        failure = error instanceof ApiError ? error : new ApiError(ApiErrorKind.Http, { textKey: ApiErrorTextKey.unknown });
        // 只有网络层失败值得重试：业务失败（比如角色重名）重试还是同样的结果
        if (!failure.retryable || attempt === attempts - 1) break;
      }
    }
    const error = failure ?? new ApiError(ApiErrorKind.Http, { textKey: ApiErrorTextKey.parse });
    if (error.needRelogin) this.unauthorizedHandler?.();
    if (!options.silent) this.failureHandler?.(error);
    throw error;
  }

  /** 实际发一次请求（XMLHttpRequest 包装成 Promise） */
  private static send<T>(options: RequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = this.resolve(options);
      const xhr = new XMLHttpRequest();
      xhr.open(request.method, request.url, true);
      xhr.timeout = request.timeout ?? networkConfig.timeout;
      Object.keys(request.headers).forEach((key) => xhr.setRequestHeader(key, request.headers[key]));

      xhr.onload = () => {
        const envelope = HttpClient.parseEnvelope<T>(xhr.responseText);
        if (!envelope) {
          reject(new ApiError(ApiErrorKind.Http, { status: xhr.status, textKey: ApiErrorTextKey.parse }));
          return;
        }
        if (envelope.code !== 0) {
          reject(new ApiError(ApiErrorKind.Business, { status: xhr.status, code: envelope.code, serverMessage: envelope.message }));
          return;
        }
        resolve(envelope.data);
      };
      xhr.onerror = () => reject(new ApiError(ApiErrorKind.Network, { status: xhr.status, textKey: ApiErrorTextKey.unreachable }));
      xhr.ontimeout = () => reject(new ApiError(ApiErrorKind.Timeout, { status: xhr.status, textKey: ApiErrorTextKey.timeout }));
      xhr.send(request.body === undefined ? null : JSON.stringify(request.body));
    });
  }

  /** 拼 url + 默认头，再交给拦截器链加工 */
  private static resolve(options: RequestOptions): ResolvedRequest {
    let request: ResolvedRequest = {
      ...options,
      url: this.buildUrl(options.path, options.query),
      headers: { "Content-Type": "application/json" },
    };
    for (const interceptor of this.requestInterceptors) request = interceptor(request);
    return request;
  }

  /** 拼装完整地址（host 只来自 configs/network） */
  private static buildUrl(path: string, query?: QueryParams): string {
    const base = networkConfig.baseUrl.replace(/\/+$/, "");
    const url = `${base}${path.charAt(0) === "/" ? path : `/${path}`}`;
    if (!query) return url;
    const parts: string[] = [];
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value === undefined || value === null || value === "") return;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    });
    return parts.length ? `${url}?${parts.join("&")}` : url;
  }

  /** 解析统一响应包裹（解析不出来返回 null，由调用方判定为链路异常） */
  private static parseEnvelope<T>(text: string): ApiEnvelope<T> | null {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as ApiEnvelope<T>;
      return parsed && typeof parsed.code === "number" ? parsed : null;
    } catch {
      return null;
    }
  }
}

/** 默认请求拦截器：带令牌（唯一注入点，业务层不许自己拼 Authorization） */
HttpClient.addRequestInterceptor((request) => {
  if (request.auth === false) return request;
  const token = Session.token;
  if (token) request.headers.Authorization = `Bearer ${token}`;
  return request;
});

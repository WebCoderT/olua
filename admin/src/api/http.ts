import { readToken } from "../store/session";
import { API_TIMEOUT, buildUrl } from "./config";
import { ApiError } from "./types";
import type { ApiEnvelope } from "./types";

/** 一次请求的完整描述（拦截器改的就是它） */
export interface RequestConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 接口路径（不含 API_BASE_URL 前缀，如 `/admin/accounts`） */
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** 是否携带令牌（登录 / 注册为 false） */
  auth: boolean;
  /** 静默模式：不触发全局错误提示（表单这类自己就地展示错误的场景用） */
  silent?: boolean;
  timeout: number;
  headers: Record<string, string>;
}

/** 请求拦截器：进网络之前改配置（加签、加公共头…） */
export type RequestInterceptor = (config: RequestConfig) => RequestConfig | Promise<RequestConfig>;
/** 响应拦截器：拿到 data 之后加工（缓存、埋点…） */
export type ResponseInterceptor = (data: unknown, config: RequestConfig) => unknown;
/** 错误观察者：统一错误出口（弹提示、上报） */
export type ErrorObserver = (error: ApiError, config: RequestConfig) => void;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];
let errorObserver: ErrorObserver | null = null;
let reloginHandler: (() => void) | null = null;

/** 注册请求拦截器（按注册顺序执行） */
export function useRequestInterceptor(interceptor: RequestInterceptor): void {
  requestInterceptors.push(interceptor);
}

/** 注册响应拦截器 */
export function useResponseInterceptor(interceptor: ResponseInterceptor): void {
  responseInterceptors.push(interceptor);
}

/** 注册错误观察者（单槽位：重复注册即替换，避免组件重复挂载时弹两次） */
export function setErrorObserver(observer: ErrorObserver | null): void {
  errorObserver = observer;
}

/** 注册「需要重新登录」时的处理（由 main.tsx 接到路由跳转上，避免 http 层依赖路由） */
export function setReloginHandler(handler: () => void): void {
  reloginHandler = handler;
}

/** 默认请求拦截器：补公共头 + 注入令牌 */
useRequestInterceptor((config) => {
  config.headers["Content-Type"] = config.headers["Content-Type"] ?? "application/json";
  if (config.auth) {
    const token = readToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * 发一次请求
 *
 * 统一调度在这里：拦截器 → 超时 → 响应包裹解包 → 错误归一 → 重新登录兜底。
 * 业务模块只写「路径 + 入参 + 返回类型」，不碰 fetch、不碰 Authorization、不判 HTTP 状态。
 */
async function request<T>(partial: Partial<RequestConfig> & Pick<RequestConfig, "path">): Promise<T> {
  let config: RequestConfig = {
    method: "GET",
    auth: true,
    timeout: API_TIMEOUT,
    headers: {},
    ...partial,
  };
  for (const interceptor of requestInterceptors) config = await interceptor(config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

  let response: Response;
  try {
    response = await fetch(buildUrl(config.path, config.query), {
      method: config.method,
      headers: config.headers,
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const apiError = new ApiError(aborted ? "请求超时，请检查网络后重试" : "网络异常，无法连接服务端", -1, 0);
    return Promise.reject(notifyError(apiError, config));
  } finally {
    clearTimeout(timer);
  }

  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    envelope = null;
  }

  // 服务端所有响应（含错误）都是统一包裹；解析不出包裹说明这条链路不是后端给的（网关 502 之类）
  if (!envelope) {
    const apiError = new ApiError(`服务端返回异常（HTTP ${response.status}）`, -1, response.status);
    return Promise.reject(notifyError(apiError, config));
  }

  if (!response.ok || envelope.code !== 0) {
    const apiError = new ApiError(envelope.message || `请求失败（HTTP ${response.status}）`, envelope.code, response.status);
    return Promise.reject(notifyError(apiError, config));
  }

  let data: unknown = envelope.data;
  for (const interceptor of responseInterceptors) data = interceptor(data, config);
  return data as T;
}

/** 错误统一出口：先回登录（如果需要），再通知观察者（silent 时跳过提示） */
function notifyError(error: ApiError, config: RequestConfig): ApiError {
  if (error.needRelogin) reloginHandler?.();
  if (!config.silent) errorObserver?.(error, config);
  return error;
}

/** 业务侧只认这几个方法 */
export const http = {
  get: <T>(path: string, options: { query?: RequestConfig["query"]; auth?: boolean; silent?: boolean } = {}) =>
    request<T>({ method: "GET", path, query: options.query, auth: options.auth ?? true, silent: options.silent }),
  post: <T>(path: string, body?: unknown, options: { auth?: boolean; silent?: boolean } = {}) =>
    request<T>({ method: "POST", path, body, auth: options.auth ?? true, silent: options.silent }),
  put: <T>(path: string, body?: unknown) => request<T>({ method: "PUT", path, body }),
  patch: <T>(path: string, body?: unknown) => request<T>({ method: "PATCH", path, body }),
  del: <T>(path: string) => request<T>({ method: "DELETE", path }),
};

import { getText } from "../../../configs/texts";
import { ApiErrorTextKey, RELOGIN_BIZ_CODES } from "./ApiCodes";

/** 错误归类 */
export enum ApiErrorKind {
  /** 连不上服务端 */
  Network = "network",
  /** 超时 */
  Timeout = "timeout",
  /** 服务端返回了非统一包裹（网关错误之类） */
  Http = "http",
  /** 业务失败（code !== 0） */
  Business = "business",
}

/**
 * 请求错误
 *
 * 统一归一「网络失败 / 超时 / 非包裹响应 / 业务失败」四种情况，
 * 且**不在代码里写中文**：服务端文案直接用（serverMessage），拿不到时用 configs/texts 的 key 兜底。
 */
export default class ApiError {
  readonly kind: ApiErrorKind;
  /** HTTP 状态码（网络层失败为 0） */
  readonly status: number;
  /** 业务码（网络层失败为 -1） */
  readonly code: number;
  /** 服务端给的可展示文案 */
  readonly serverMessage: string | null;
  /** 本地兜底文案 key */
  readonly textKey: string;

  constructor(kind: ApiErrorKind, options: { status?: number; code?: number; serverMessage?: string | null; textKey?: string } = {}) {
    this.kind = kind;
    this.status = options.status ?? 0;
    this.code = options.code ?? -1;
    this.serverMessage = options.serverMessage ?? null;
    this.textKey = options.textKey ?? ApiErrorTextKey.unknown;
  }

  /** 网络层失败可以重试（业务失败重试没意义） */
  get retryable(): boolean {
    return this.kind === ApiErrorKind.Network || this.kind === ApiErrorKind.Timeout;
  }

  /**
   * 是否需要重新登录（令牌失效 / 账号被封禁）
   *
   * 判据**只有业务码**，不看 HTTP 状态码：登录接口「账号或密码错误」也回 401
   * （服务端防账号枚举，见 server auth.service 的 PASSWORD_WRONG），但那是业务失败 ——
   * 提示一下即可；「status 401 就重登」会把登录页整个重载，错误提示刚建出来就被销毁，
   * 玩家只看到页面闪一下。会话类失败（40100~40103 / 10004 被封禁）服务端都带对应业务码
   * （auth.guard 抛 40100，all-exceptions.filter 把其他 401 兜底映射成 40100），码表里查得到。
   */
  get needRelogin(): boolean {
    return RELOGIN_BIZ_CODES.indexOf(this.code as (typeof RELOGIN_BIZ_CODES)[number]) !== -1;
  }

  /** 可直接展示给玩家的文案 */
  describe(): string {
    return this.serverMessage ?? getText(this.textKey);
  }
}

/** 把任意异常收敛成一句可展示的文案（调用方不必先判断类型） */
export function describeError(error: unknown): string {
  return error instanceof ApiError ? error.describe() : getText(ApiErrorTextKey.unknown);
}

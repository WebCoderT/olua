/**
 * 网络配置（客户端**唯一的服务端地址来源**）
 *
 * 铁律：客户端代码里不允许再出现任何服务端地址字面量
 * （自查 `node tools/audit-api-hardcode.cjs`）。
 *
 * baseUrl 不是写死的常量，而是按运行环境解析（见 resolveBaseUrl）：
 * 本地调试走本机服务端，Web 部署走同源 /api。**一份构建产物两种场景通用**，
 * 换环境不用重新构建。
 *
 * 与服务端默认值对应关系：server/.env 的 PORT=3100 + API_PREFIX=api。
 */
/** 本地开发地址：Cocos 预览 / 从 localhost 打开时使用 */
const DEV_BASE_URL = "http://localhost:3100/api";
/** 线上同源地址：Web 部署后由 nginx 把 /api 反代到服务端容器（服务端 3100 不对宿主机暴露） */
const SAME_ORIGIN_BASE_URL = "/api";

/** 页面从这些 host 打开时认定为本地调试（"" 是 file:// 打开预览的情况） */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", ""];

/**
 * 解析接口根地址。
 * 非 Web 环境（原生壳）拿不到 location，一律回落到本地地址，由宿主另行配置。
 */
function resolveBaseUrl(): string {
  const scope = globalThis as unknown as { location?: { hostname?: string } };
  if (!scope || !scope.location) {
    return DEV_BASE_URL;
  }
  const host = scope.location.hostname || "";
  return LOCAL_HOSTS.indexOf(host) >= 0 ? DEV_BASE_URL : SAME_ORIGIN_BASE_URL;
}

export const networkConfig = {
  /** 接口根地址（后面接 ui/utils/net/ApiRoutes 里登记的路由） */
  baseUrl: resolveBaseUrl(),
  /** 单次请求超时（毫秒） */
  timeout: 10000,
  /** 网络层失败（连不上 / 超时）的重试次数；业务失败不重试 */
  retry: 1,
  /** 角色进度同步的防抖间隔（毫秒）：改动停下多久之后才推服务端，避免打怪时每杀一只推一次 */
  roleSyncDelay: 1500,
} as const;

/** HTTP 方法（请求层只认这几种） */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

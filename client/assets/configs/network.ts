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

/** 回环地址与 file://（拿不到 host）一定是本地调试 */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", ""];

/**
 * 私有网段与本地域名：也算本地调试。
 *
 * Cocos 预览经常不是从 localhost 打开的 —— 编辑器要出扫码调试的二维码，预览地址就得用
 * 能出网的那张网卡的地址（`192.168.x.x` / `10.x.x.x` / `xxx.local`）。这些地址不是
 * 「线上部署」，接口仍然该打本机服务端。
 *
 * 判据用**地址性质**而不是列白名单：本地调试的形态列不完，而线上部署只会落在公网域名 /
 * 公网 IP 上，反着认更稳（白名单漏一种，就是一次「明明在本地却连不上」）。
 */
const PRIVATE_HOST_PATTERNS = [
  /^10\./, // 10.0.0.0/8
  /^192\.168\./, // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12（只有 16~31 是私有段）
  /^169\.254\./, // 链路本地（没拿到 DHCP 地址时）
  /\.local$/i, // mDNS 名
  /\.lan$/i,
];

function isLocalDebugHost(host: string): boolean {
  return LOCAL_HOSTS.indexOf(host) >= 0 || PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

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
  return isLocalDebugHost(host) ? DEV_BASE_URL : SAME_ORIGIN_BASE_URL;
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

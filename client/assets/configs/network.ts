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
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", ""];

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
 * Cocos Creator 预览服务的默认端口。
 *
 * **这条判据比 host 可靠**：编辑器会按网卡生成预览地址，可能是带方括号的 IPv6
 * （`[fe80::…]` / `[fd..::]`）、`0.0.0.0`，也可能被改成局域网里的任意地址 ——
 * 列举 host 形态永远会漏，而「预览页由预览服务提供」这件事是恒定的。
 *
 * 预览页永远不是部署站，同源相对地址 `/api` 在那里只会把请求打到预览服务器自己
 * （拿回 HTML，解析不出统一包裹 → 报「请求失败」）。所以预览端口一律指向本机服务端。
 */
const PREVIEW_PORTS = ["7456"];

/**
 * 能以「同源相对地址」工作的页面协议。
 *
 * **这条判据比 host 和端口都更根本**：Cocos 的「编辑器内预览」不是普通网页 ——
 * 它跑在编辑器自己的 `packages://scene` 页面里（protocol = `packages:`，没有 port，
 * hostname 是 `scene`）。这种页面上 `/api/...` 会被解析成 `packages://scene/api/...`，
 * 根本不是合法 HTTP 地址，`xhr.open()` 当场失败（`status=0`，界面报「无法连接服务器」）。
 * `file://` 直接打开产物同理。所以：**只有 http(s) 页面才可能是部署站**。
 */
const WEB_PROTOCOLS = ["http:", "https:"];

/**
 * 解析接口根地址。
 *
 * 判据顺序（前一条命中就不再往下判）：
 * 1. 拿不到 location（原生壳）→ 本机地址，由宿主另行配置
 * 2. 非 http(s) 页面（编辑器内预览 `packages://scene` / `file://`）→ 本机地址
 * 3. 预览端口 → 本机地址（覆盖任意 host 形态的浏览器预览）
 * 4. 本地 host（回环 / 私有网段 / 本地域名）→ 本机地址
 * 5. 其余 → 同源 `/api`（页面由部署站提供，nginx 反代到服务端）
 */
function resolveBaseUrl(): string {
  const scope = globalThis as unknown as { location?: { hostname?: string; port?: string; protocol?: string } };
  if (!scope || !scope.location) {
    return DEV_BASE_URL;
  }
  // protocol 拿不到（老宿主 / 单测垫片）时不作判据，继续往下按 host 判
  const protocol = scope.location.protocol || "";
  if (protocol && WEB_PROTOCOLS.indexOf(protocol) < 0) {
    return DEV_BASE_URL;
  }
  const port = scope.location.port || "";
  if (PREVIEW_PORTS.indexOf(port) >= 0) {
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
  /**
   * 实时通道（WebSocket）的参数
   *
   * 通道的地址**不在这里** —— 它跟 baseUrl 同源（`http→ws` / `https→wss`，见
   * ui/utils/net/RealtimeClient 的 buildRealtimeUrl），换后端只改上面那一个 baseUrl。
   * 这里只放时间参数。心跳间隔以**服务端 welcome 给的 `heartbeatMs` 为准**，下面那个只是
   * 还没收到 welcome 时的兜底（服务端改间隔不必跟着改客户端）。
   */
  realtime: {
    /** 握手超时（毫秒）：连上之后多久没等到 welcome，就认为这条连接不可用 */
    handshakeTimeout: 10000,
    /** 应用层心跳间隔的兜底（毫秒）：连上后以服务端 welcome 的 heartbeatMs 为准 */
    pingInterval: 20000,
    /** 心跳应答超时（毫秒）：发出 ping 后多久没收到任何一帧就判掉线（要 > 心跳间隔，容忍一次丢包） */
    pongTimeout: 30000,
    /** 重连退避的首个间隔（毫秒），此后每失败一次翻倍 */
    reconnectBaseDelay: 1000,
    /** 重连退避的封顶间隔（毫秒） */
    reconnectMaxDelay: 30000,
  },
} as const;

/** HTTP 方法（请求层只认这几种） */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

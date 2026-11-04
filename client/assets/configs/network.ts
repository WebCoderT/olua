/**
 * 网络配置（客户端**唯一的服务端地址来源**）
 *
 * 铁律：客户端代码里不允许再出现任何服务端地址字面量
 * （自查 `node tools/audit-api-hardcode.cjs`）。
 *
 * baseUrl **按当前页面的 host 在运行时决定**，一份产物两处通用（#697）：
 *   - 本机 / 局域网预览（Cocos :7456、局域网 IP）→ `http://localhost:3100/api`，直连本机服务端
 *   - 公网（服务器 IP、game.yimw.cn 等域名）      → `/api`，同源，由 nginx 反代到服务端
 *
 * 为什么不能写死成常量：写 `localhost:3100` 时公网玩家的浏览器会去连**自己电脑**的 3100，
 * 写 `/api` 时本机预览又没有同源后端 —— 两种写法各错一半，只能按 host 判。
 *
 * 判据是「这个 host 是不是开发机/内网」：回环、私有网段、`.local`、不带主机名（原生/模拟器）
 * 都算本地；其余（公网 IP、域名）一律走同源 `/api`。
 *
 * 与服务端默认值对应关系：server/.env 的 PORT=3100 + API_PREFIX=api。
 */

/** 本机 / 内网才直连 3100；公网（含服务器公网 IP 与域名）走同源反代 */
function isLocalHost(host: string): boolean {
  if (!host) return true; // 原生端 / 模拟器 / file:// —— 没有页面主机名，按本地开发处理
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  // 私有网段：10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

/** 当前页面的主机名（非浏览器环境 / 取不到时给空串） */
function currentHost(): string {
  const scope = globalThis as unknown as { location?: { hostname?: string } };
  return String(scope.location?.hostname ?? "").toLowerCase();
}

function resolveBaseUrl(): string {
  return isLocalHost(currentHost()) ? "http://localhost:3100/api" : "/api";
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

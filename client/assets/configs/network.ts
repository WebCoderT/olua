/**
 * 网络配置（客户端**唯一的服务端地址来源**）
 *
 * 铁律：客户端代码里不允许再出现任何服务端地址字面量
 * （自查 `node tools/audit-api-hardcode.cjs`）。
 *
 * 开发环境与打包产物的差异**不自动判断**，全部由下面唯一的 `DEV_MODE` 开关手动控制：
 *   - `true`（开发）  → `http://<页面 host>:3100/api`，Cocos 预览直连本机服务端。
 *     主机**取自当前页面**：电脑上打开是 localhost，手机用局域网 IP 打开就自动是那个 IP
 *     （见 devBaseUrlFor）—— 真机调试因此不用改配置。`localhost` 在手机上指的是手机自己，
 *     写死它必然连不上。
 *   - `false`（打包） → `/api`，同源，由 nginx 反代到服务端
 *
 * ## 发布流程里的一步
 * **每次打包发布前把 `DEV_MODE` 改成 `false`，打完开发就改回 `true`** —— 忘了改的后果：
 *   - 带着true发布：线上玩家去连自己电脑的 3100，全部连不上；
 *   - 开发时改成 false：预览页没有同源后端，请求全 404。
 * 两种都很好发现（请求层会在控制台报错），改回来即可。
 *
 * 实时通道（WebSocket）地址由 baseUrl 推导（`http→ws` / `https→wss`，见
 * ui/utils/net/RealtimeClient 的 buildRealtimeUrl），不在这里重复配置。
 *
 * 与服务端默认值对应关系：server/.env 的 PORT=3100 + API_PREFIX=api。
 */

/**
 * 是否为开发模式（**唯一的开发/打包差异开关**）
 *
 * 以后再有「开发和打包行为不一样」的配置（地址、日志、调试工具……）都加到这里，
 * 用 `DEV_MODE ? 开发值 : 打包值` 表达，不再各写各的开关。
 */
export const DEV_MODE = true;

/** 开发模式连的服务端端口（与服务端 `server/.env` 的 PORT 默认值一致） */
const DEV_PORT = 3100;

/**
 * 开发模式的接口根地址：主机由**页面**决定
 *
 * 页面用 localhost 打开就连 localhost，用局域网 IP 打开就连那个 IP —— 手机真机调试
 * 不用再去改配置（每个人 IP 不同，写死反而谁都不对）。拿不到页面信息时（原生包、
 * 单测沙箱）回落 localhost。
 *
 * @param pageHostname 当前页面的主机名（可为空）
 */
export function devBaseUrlFor(pageHostname: string): string {
  const host = pageHostname && pageHostname.trim() ? pageHostname.trim() : "localhost";
  return `http://${host}:${DEV_PORT}/api`;
}

/** 当前页面的主机名（不在浏览器 / 预览环境里时返回空串） */
function pageHostname(): string {
  if (typeof window === "undefined" || !window.location) return "";
  return window.location.hostname ?? "";
}

/** 打包产物走的同源地址（nginx 反代到服务端） */
const PROD_BASE_URL = "/api";

export const networkConfig = {
  /** 接口根地址（后面接 ui/utils/net/ApiRoutes 里登记的路由） */
  baseUrl: DEV_MODE ? devBaseUrlFor(pageHostname()) : PROD_BASE_URL,
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
  /**
   * 网络诊断层（#767：同步延迟测量基线，默认关）
   *
   * 打开 = 游戏场景左上角出现一块诊断文本（RTT / players 与 monster-ai 的帧龄 /
   * 互见插值剩余距离），供「多人同图延迟」问题排查用 —— **不进正式 HUD**。
   * 关闭（默认）= 不建节点、不起定时器、所有统计入口是空操作（零开销）。
   * 开着发布出去会暴露诊断文本：发布前检查这里，e2e 与单测都有断言守着默认值。
   */
  diagnostics: {
    /** 总开关：false = 诊断层完全不存在（宽化成 boolean：运行期才判真假，字面量类型会挡住比较） */
    enabled: false as boolean,
  },
} as const;

/** HTTP 方法（请求层只认这几种） */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

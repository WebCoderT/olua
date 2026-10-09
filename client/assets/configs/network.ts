/**
 * 网络配置（客户端**唯一的服务端地址来源**）
 *
 * 铁律：客户端代码里不允许再出现任何服务端地址字面量
 * （自查 `node tools/audit-api-hardcode.cjs`）。
 * 要换后端只改这一处；打包到手机/真机时把 host 换成局域网 IP 或线上域名即可。
 *
 * 与服务端默认值对应关系：server/.env 的 PORT=3100 + API_PREFIX=api。
 */
export const networkConfig = {
  /** 接口根地址（后面接 ui/utils/net/ApiRoutes 里登记的路由） */
  baseUrl: "http://localhost:3100/api",
  /** 单次请求超时（毫秒） */
  timeout: 10000,
  /** 网络层失败（连不上 / 超时）的重试次数；业务失败不重试 */
  retry: 1,
  /** 角色进度同步的防抖间隔（毫秒）：改动停下多久之后才推服务端，避免打怪时每杀一只推一次 */
  roleSyncDelay: 1500,
} as const;

/** HTTP 方法（请求层只认这几种） */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

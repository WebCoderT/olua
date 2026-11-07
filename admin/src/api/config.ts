/**
 * 接口地址与超时的**唯一来源**
 *
 * 铁律：管理端代码里不允许出现任何后端地址字面量（自查：tools/audit-api-hardcode.cjs）。
 * 换环境只改 `.env.*` 里的 `VITE_API_BASE_URL`：
 * - `.env.development` → 本地服务端（http://localhost:3100/api）
 * - `.env.production`  → 部署域名（或走同域反向代理的相对路径 `/api`）
 */
function readEnv(key: string, fallback: string): string {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const value = env[key];
  return value && value.trim() ? value.trim() : fallback;
}

/** 接口根地址（默认相对路径 `/api`：同域反向代理下无需任何配置） */
const CONFIGURED_BASE_URL = readEnv("VITE_API_BASE_URL", "/api").replace(/\/+$/, "");

/** 是否让接口地址跟随当前页面的主机（局域网调试用；缺省关，见 .env.example 的说明） */
const FOLLOW_PAGE_HOST = readEnv("VITE_API_FOLLOW_PAGE_HOST", "false") === "true";

/**
 * 把接口地址的主机换成「当前页面的主机」（端口 / 路径 / 协议照抄）
 *
 * 为什么需要：`.env.development` 里写的是本机地址，但页面可能是从**局域网 IP** 打开的
 * （手机 / 另一台电脑）。这时页面自己的 host 才是这台电脑，把地址跟着换掉即可直连，
 * 不用为了调试去改 `.env.development`（改了容易忘记改回来，而且每个人 IP 都不一样）。
 *
 * 三种情况原样返回：开关没开 / 地址是相对路径（同源）/ 主机本来就一致。
 */
function followPageHost(baseUrl: string): string {
  if (!FOLLOW_PAGE_HOST) return baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) return baseUrl;
  const pageHost = typeof window === "undefined" ? "" : window.location.hostname;
  if (!pageHost) return baseUrl;
  const url = new URL(baseUrl);
  if (!url.hostname || url.hostname === pageHost) return baseUrl;
  url.hostname = pageHost;
  return url.toString().replace(/\/+$/, "");
}

/** 接口根地址（最终生效值；地址唯一来源仍是 `.env.*`） */
export const API_BASE_URL = followPageHost(CONFIGURED_BASE_URL);

/** 请求超时（毫秒） */
export const API_TIMEOUT = Number(readEnv("VITE_API_TIMEOUT", "15000"));

/** 页面标题 */
export const APP_TITLE = readEnv("VITE_APP_TITLE", "olua 管理端");

/** 令牌在 localStorage 里的键（统一前缀，避免与同域其它应用撞车） */
export const STORAGE_KEYS = {
  token: "olua.admin.token",
  profile: "olua.admin.profile",
} as const;

/** 把路径与查询参数拼成完整地址（路径不含 API_BASE_URL 前缀，见各 api 模块） */
export function buildUrl(path: string, query?: Record<string, string | number | undefined | null>): string {
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `${url}?${text}` : url;
}

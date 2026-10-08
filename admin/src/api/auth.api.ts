import { http } from "./http";
import type { AdminAuthResult, AdminInfo } from "./types";

/** 管理端认证接口（注册 / 登录 / 当前管理员） */
export const authApi = {
  /** 注册（服务端配了 ADMIN_REGISTER_CODE 时 registerCode 必填；表单自带错误展示，故静默） */
  register: (payload: { username: string; password: string; registerCode?: string }) =>
    http.post<AdminAuthResult>("/admin/auth/register", payload, { auth: false, silent: true }),

  /** 登录（同上：就地展示错误） */
  login: (payload: { username: string; password: string }) =>
    http.post<AdminAuthResult>("/admin/auth/login", payload, { auth: false, silent: true }),

  /** 当前登录管理员（用于刷新页面后校验令牌是否仍有效） */
  me: () => http.get<AdminInfo>("/admin/auth/me"),
};

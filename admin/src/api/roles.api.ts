import { http } from "./http";
import type { AdminRole, PageResult, RolePatchPayload } from "./types";

/** 角色管理接口（跨账号） */
export const rolesApi = {
  /** 角色分页列表（keyword 匹配角色名或角色 id；accountId 限定账号） */
  list: (query: { page?: number; size?: number; keyword?: string; accountId?: string }) =>
    http.get<PageResult<AdminRole>>("/admin/roles", { query }),

  /** 角色详情（含完整 data） */
  detail: (id: string) => http.get<AdminRole>(`/admin/roles/${encodeURIComponent(id)}`),

  /** 修改角色（只提交要改的字段） */
  patch: (id: string, payload: RolePatchPayload) => http.patch<AdminRole>(`/admin/roles/${encodeURIComponent(id)}`, payload),

  /** 设为该账号的在线角色 */
  select: (id: string) => http.post<AdminRole>(`/admin/roles/${encodeURIComponent(id)}/select`),

  /** 删除角色 */
  remove: (id: string) => http.del<null>(`/admin/roles/${encodeURIComponent(id)}`),
};

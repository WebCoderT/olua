import { http } from "./http";
import type { AdminInfo, AdminUpdatePayload, PageResult } from "./types";

/** 管理员管理接口（需要 admin:read / admin:manage 权限） */
export const adminsApi = {
  /** 管理员分页列表（keyword 匹配账号名；role 精确筛选） */
  list: (query: { page?: number; size?: number; keyword?: string; role?: string }) =>
    http.get<PageResult<AdminInfo>>("/admin/admins", { query }),

  /** 改角色 / 启停（服务端会保护「最后一个启用中的超级管理员」） */
  update: (id: string, payload: AdminUpdatePayload) => http.patch<AdminInfo>(`/admin/admins/${encodeURIComponent(id)}`, payload),

  /** 删除管理员 */
  remove: (id: string) => http.del<null>(`/admin/admins/${encodeURIComponent(id)}`),
};

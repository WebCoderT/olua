import { http } from "./http";
import type { Account, AccountDetail, AdminStats, PageResult } from "./types";

/** 账号管理接口 */
export const accountsApi = {
  /** 概览统计 */
  stats: () => http.get<AdminStats>("/admin/stats"),

  /** 账号分页列表（keyword 匹配账号名；status 精确筛选） */
  list: (query: { page?: number; size?: number; keyword?: string; status?: string }) =>
    http.get<PageResult<Account>>("/admin/accounts", { query }),

  /** 账号详情（含名下角色概要） */
  detail: (id: string) => http.get<AccountDetail>(`/admin/accounts/${encodeURIComponent(id)}`),

  /** 封禁 / 解封 */
  updateStatus: (id: string, status: string) => http.patch<Account>(`/admin/accounts/${encodeURIComponent(id)}/status`, { status }),

  /** 删除账号（名下角色级联删除） */
  remove: (id: string) => http.del<null>(`/admin/accounts/${encodeURIComponent(id)}`),
};

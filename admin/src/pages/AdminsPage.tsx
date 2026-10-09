import { useCallback, useEffect, useState } from "react";
import { adminRoleLabel, adminsApi, ADMIN_ROLE, ADMIN_ROLE_LABELS, formatTime, PERMISSION } from "../api";
import type { AdminInfo, AdminQuery, AdminUpdatePayload, PageResult } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { ResetPasswordDialog } from "../components/ResetPasswordDialog";
import { SortableTh, useSort } from "../components/sortable";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission, readAdmin } from "../store/session";
import { toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

const ROLE_TONE: Record<string, "amber" | "indigo" | "slate"> = {
  [ADMIN_ROLE.SUPER]: "amber",
  [ADMIN_ROLE.ADMIN]: "indigo",
  [ADMIN_ROLE.VIEWER]: "slate",
};

/**
 * 管理员管理（权限管理入口）
 *
 * 三层限制，从宽到严：界面（没有 admin:manage 就禁用按钮）→ 服务端权限守卫（403 / 30006）
 * → 服务端的「最后一个启用中的超级管理员」保护（30007）。
 * 所以这里不做任何本地规则判断，服务端怎么说就怎么显示。
 */
export function AdminsPage() {
  const self = readAdmin();
  const canManage = hasPermission(PERMISSION.ADMIN_MANAGE);
  const [draft, setDraft] = useState({ keyword: "", role: "" });
  const [query, setQuery] = useState({ keyword: "", role: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<AdminInfo> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingReset, setPendingReset] = useState<AdminInfo | null>(null);

  // 初始值与服务端默认（创建时间升序）保持一致，免得表头箭头骗人
  const { sort, order, toggle } = useSort({ initial: { sort: "createdAt", order: "asc" }, onChange: () => setPage(1) });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await adminsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          role: (query.role || undefined) as AdminQuery["role"],
          sort,
          order,
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query, sort, order]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), role: draft.role });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", role: "" });
    setPage(1);
    setQuery({ keyword: "", role: "" });
  };

  /** 改角色（服务端保护最后一个超管，被拒时错误由请求层统一提示） */
  const changeRole = async (admin: AdminInfo, role: string) => {
    setBusyId(admin.id);
    try {
      // 下拉框给的是字符串，收口到服务端枚举；非法值服务端同样会拒
      await adminsApi.update(admin.id, { role: role as AdminUpdatePayload["role"] });
      toastSuccess(`已把 ${admin.username} 改为${adminRoleLabel(role)}`);
      await load();
    } catch {
      /* 统一提示；失败了就重新拉一次，把下拉框回滚到服务端的真实值 */
      await load();
    } finally {
      setBusyId(null);
    }
  };

  /** 停用 / 启用 */
  const toggleStatus = async (admin: AdminInfo) => {
    const next = admin.status === "active" ? "disabled" : "active";
    setBusyId(admin.id);
    try {
      await adminsApi.update(admin.id, { status: next });
      toastSuccess(next === "disabled" ? `已停用 ${admin.username}` : `已启用 ${admin.username}`);
      await load();
    } catch {
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await adminsApi.remove(pendingDelete.id);
      toastSuccess(`已删除管理员 ${pendingDelete.username}`);
      setPendingDelete(null);
      if (data && data.list.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 重置某个管理员的密码（口令由弹窗生成并展示一次）
   *
   * 注意：被重置的人手里那个令牌当场失效 —— 他下一次操作就会被送回登录页。
   * 所以**不给自己用这个入口**（改自己的密码在「我的账号」里，那边会回一个新令牌续上会话）。
   */
  const resetPassword = async (password: string): Promise<boolean> => {
    if (!pendingReset) return false;
    try {
      await adminsApi.resetPassword(pendingReset.id, { password });
      await load();
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">管理员</h1>
        <p className="mt-1 text-xs text-slate-500">
          三级角色：超级管理员（全部权限）/ 管理员（不能管管理员）/ 只读观察员（只能查看）。改角色与启停立即生效，无需对方重新登录；重置密码会让对方手里的令牌当场失效（他需要重新登录）。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">管理员账号</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-40">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">角色</span>
            <Select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
              <option value="">全部</option>
              {Object.entries(ADMIN_ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="管理员列表"
        actions={loading ? <Spinner /> : null}
        description={canManage ? undefined : "当前角色没有「管理管理员」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <SortableTh label="账号" field="username" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="角色" field="role" sort={sort} order={order} onToggle={toggle} />
                <th className={thClass}>权限点</th>
                <SortableTh label="状态" field="status" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="创建时间" field="createdAt" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="最近登录" field="lastLoginAt" sort={sort} order={order} onToggle={toggle} defaultOrder="desc" />
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((admin) => {
                const isSelf = self?.id === admin.id;
                const busy = busyId === admin.id;
                return (
                  <tr key={admin.id} className="transition hover:bg-slate-800/30">
                    <td className={tdClass}>
                      <span className="font-medium text-slate-100">{admin.username}</span>
                      {isSelf ? <span className="ml-2 text-xs text-indigo-300">当前登录</span> : null}
                    </td>
                    <td className={tdClass}>
                      {canManage && !busy ? (
                        <Select
                          className="w-36 py-1 text-xs"
                          value={admin.role}
                          onChange={(event) => void changeRole(admin, event.target.value)}
                        >
                          {Object.entries(ADMIN_ROLE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge tone={ROLE_TONE[admin.role] ?? "slate"}>{adminRoleLabel(admin.role)}</Badge>
                      )}
                    </td>
                    <td className={tdClass}>{admin.permissions?.length ?? 0}</td>
                    <td className={tdClass}>{admin.status === "active" ? <Badge tone="green">正常</Badge> : <Badge tone="red">已停用</Badge>}</td>
                    <td className={tdClass}>{formatTime(admin.createdAt)}</td>
                    <td className={tdClass}>{formatTime(admin.lastLoginAt)}</td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canManage || isSelf}
                          title={isSelf ? "改自己的密码请到「我的账号」" : undefined}
                          onClick={() => setPendingReset(admin)}
                        >
                          重置密码
                        </Button>
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canManage}
                          loading={busy}
                          onClick={() => void toggleStatus(admin)}
                        >
                          {admin.status === "active" ? "停用" : "启用"}
                        </Button>
                        <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canManage} onClick={() => setPendingDelete(admin)}>
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的管理员" description="换个关键字或重置筛选条件试试" /> : null}

        <Pagination
          page={page}
          size={size}
          total={data?.total ?? 0}
          onChange={setPage}
          onSizeChange={(value) => {
            setSize(value);
            setPage(1);
          }}
        />
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除管理员"
        description={pendingDelete ? `将删除管理员「${pendingDelete.username}」，该账号将无法再登录管理端，操作不可恢复。` : ""}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ResetPasswordDialog
        open={pendingReset !== null}
        targetKind="admin"
        targetName={pendingReset?.username ?? ""}
        onCancel={() => setPendingReset(null)}
        onSubmit={resetPassword}
      />
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsApi, PERMISSION } from "../api";
import type { Account, AccountQuery, PageResult } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { formatTime } from "../api";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 账号管理：检索 / 封禁解封 / 删除 / 进角色列表（写操作按权限点显隐，服务端独立校验） */
export function AccountsPage() {
  const canStatus = hasPermission(PERMISSION.ACCOUNT_STATUS);
  const canDelete = hasPermission(PERMISSION.ACCOUNT_DELETE);
  const [draft, setDraft] = useState({ keyword: "", status: "" });
  const [query, setQuery] = useState({ keyword: "", status: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResult<Account> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await accountsApi.list({
        page,
        size: PAGE_SIZE,
        keyword: query.keyword || undefined,
        status: (query.status || undefined) as AccountQuery["status"],
      });
      setData(result);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), status: draft.status });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", status: "" });
    setPage(1);
    setQuery({ keyword: "", status: "" });
  };

  /** 封禁 / 解封（改完立刻生效：服务端每次请求都回查账号状态） */
  const toggleStatus = async (account: Account) => {
    const next = account.status === "active" ? "disabled" : "active";
    setBusyId(account.id);
    try {
      await accountsApi.updateStatus(account.id, { status: next });
      toastSuccess(next === "disabled" ? `已封禁 ${account.username}` : `已解封 ${account.username}`);
      await load();
    } catch {
      /* 统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await accountsApi.remove(pendingDelete.id);
      toastSuccess(`已删除账号 ${pendingDelete.username}`);
      setPendingDelete(null);
      // 删掉本页最后一条时回退一页，避免停在空页
      if (data && data.list.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch {
      /* 统一提示 */
      toastError("删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">账号管理</h1>
        <p className="mt-1 text-xs text-slate-500">封禁后该账号的令牌立即失效；删除账号会连带删掉名下所有角色。</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">账号名</span>
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
            <span className="mb-1.5 block text-xs font-medium text-slate-400">状态</span>
            <Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              <option value="">全部</option>
              <option value="active">正常</option>
              <option value="disabled">已封禁</option>
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="账号列表"
        actions={loading ? <Spinner /> : null}
        description={canStatus && canDelete ? undefined : "当前角色权限不足，部分操作不可用（服务端同样会拒绝）。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>账号</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>角色数</th>
                <th className={thClass}>注册时间</th>
                <th className={thClass}>最近登录</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((account) => (
                <tr key={account.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <Link to={`/accounts/${account.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">
                      {account.username}
                    </Link>
                    {account.onlineRoleId ? <span className="ml-2 text-xs text-slate-500">有在线角色</span> : null}
                  </td>
                  <td className={tdClass}>
                    {account.status === "active" ? <Badge tone="green">正常</Badge> : <Badge tone="red">已封禁</Badge>}
                  </td>
                  <td className={tdClass}>{account.roleCount ?? 0}</td>
                  <td className={tdClass}>{formatTime(account.createdAt)}</td>
                  <td className={tdClass}>{formatTime(account.lastLoginAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Link to={`/accounts/${account.id}`}>
                        <Button variant="outline" className="px-2.5 py-1 text-xs">
                          查看角色
                        </Button>
                      </Link>
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canStatus}
                        loading={busyId === account.id}
                        onClick={() => void toggleStatus(account)}
                      >
                        {account.status === "active" ? "封禁" : "解封"}
                      </Button>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canDelete} onClick={() => setPendingDelete(account)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的账号" description="换个关键字或重置筛选条件试试" /> : null}

        <Pagination page={page} size={PAGE_SIZE} total={data?.total ?? 0} onChange={setPage} />
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除账号"
        description={pendingDelete ? `将删除账号「${pendingDelete.username}」及其名下 ${pendingDelete.roleCount ?? 0} 个角色，操作不可恢复。` : ""}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

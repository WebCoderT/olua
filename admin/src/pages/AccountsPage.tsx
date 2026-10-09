import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsApi, banStateOf, PERMISSION } from "../api";
import type { Account, AccountQuery, BatchStatusResult, PageResult } from "../api";
import { BanDialog } from "../components/BanDialog";
import { BanStatus } from "../components/BanStatus";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { SortableTh, useSort } from "../components/sortable";
import { Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { formatTime } from "../api";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 批量操作进行中的忙碌标记（与单条操作的账号 id 区分开） */
const BATCH_BUSY = "__batch__";

/** 一次批量操作的目标：可能是单条（列表行按钮），也可能是勾选的一批 */
interface BanTarget {
  ids: string[];
  /** 提示文案里的对象名（单个是账号名，批量是「已选的 N 个账号」） */
  label: string;
}

/** 账号管理：检索 / 排序 / 封禁解封（含批量）/ 删除 / 进角色列表（写操作按权限点显隐，服务端独立校验） */
export function AccountsPage() {
  const canStatus = hasPermission(PERMISSION.ACCOUNT_STATUS);
  const canDelete = hasPermission(PERMISSION.ACCOUNT_DELETE);
  const [draft, setDraft] = useState({ keyword: "", status: "" });
  const [query, setQuery] = useState({ keyword: "", status: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<Account> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingBan, setPendingBan] = useState<BanTarget | null>(null);
  const [pendingUnban, setPendingUnban] = useState<BanTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 排序由服务端执行（列表是分页的）；初始值与服务端默认（注册时间倒序）保持一致，免得表头箭头骗人
  const { sort, order, toggle } = useSort({ initial: { sort: "createdAt", order: "desc" }, onChange: () => setPage(1) });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await accountsApi.list({
        page,
        size,
        keyword: query.keyword || undefined,
        status: (query.status || undefined) as AccountQuery["status"],
        sort,
        order,
      });
      setData(result);
      // 列表刷新后清掉勾选：翻页 / 换条件之后，上一页选中的已经不眼前，留着容易误操作
      setSelectedIds([]);
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
    setQuery({ keyword: draft.keyword.trim(), status: draft.status });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", status: "" });
    setPage(1);
    setQuery({ keyword: "", status: "" });
  };

  const currentList = data?.list ?? [];
  const allChecked = currentList.length > 0 && selectedIds.length === currentList.length;

  const toggleOne = (id: string) => {
    setSelectedIds((previous) => (previous.indexOf(id) === -1 ? [...previous, id] : previous.filter((item) => item !== id)));
  };

  const toggleAll = () => {
    setSelectedIds(allChecked ? [] : currentList.map((account) => account.id));
  };

  /** 实测条数少于请求条数时补一句（列表可能已过期，为一条陈旧 id 整体失败更难用） */
  const missed = (result: BatchStatusResult) => (result.updated < result.requested ? `，${result.requested - result.updated} 个已不存在` : "");

  /**
   * 封禁（单个与批量同一条路径）
   *
   * 原因与时长由弹窗收集（`BanDialog` 保证原因非空）。返回是否成功 ——
   * 失败了要让弹窗留在原地，管理员不用重新填一遍。
   */
  const ban = async (payload: { reason: string; durationHours: number | null }): Promise<boolean> => {
    if (!pendingBan) return false;
    const target = pendingBan;
    setBusyId(BATCH_BUSY);
    try {
      const result = await accountsApi.batchStatus({
        ids: target.ids,
        status: "disabled",
        reason: payload.reason,
        durationHours: payload.durationHours,
      });
      const label = target.ids.length === 1 ? target.label : `${result.updated} 个账号`;
      const hours = payload.durationHours === null ? "" : `，${payload.durationHours} 小时后自动解封`;
      // 封禁会清在线标记 = 正在玩的会被踢回选角界面，这事得说清楚
      const kicked = result.clearedOnlineAccountIds.length > 0 ? `（其中 ${result.clearedOnlineAccountIds.length} 个在线，已踢下线）` : "";
      toastSuccess(`${payload.durationHours === null ? "已永久封禁" : "已封禁"} ${label}${hours}${missed(result)}${kicked}`);
      setPendingBan(null);
      await load();
      return true;
    } catch {
      /* 统一提示 */
      return false;
    } finally {
      setBusyId(null);
    }
  };

  /** 解封（封禁反而要多填原因与时长，所以两者不共用一个按钮） */
  const unban = async (target: BanTarget) => {
    setBusyId(BATCH_BUSY);
    try {
      const result = await accountsApi.batchStatus({ ids: target.ids, status: "active" });
      const label = target.ids.length === 1 ? target.label : `${result.updated} 个账号`;
      toastSuccess(`已解封 ${label}${missed(result)}`);
      setPendingUnban(null);
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
        <p className="mt-1 text-xs text-slate-500">
          封禁后该账号的令牌立即失效；删除账号会连带删掉名下所有角色。点表头可换排序，排序由服务端执行（对全部数据生效，不是只排当前页）。
        </p>
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
        actions={
          loading ? (
            <Spinner />
          ) : canStatus ? (
            <>
              {selectedIds.length > 0 ? <span className="text-xs text-slate-400">已选 {selectedIds.length} 个</span> : null}
              <Button
                variant="outline"
                className="px-2.5 py-1 text-xs"
                disabled={selectedIds.length === 0}
                onClick={() => setPendingBan({ ids: selectedIds, label: `已选的 ${selectedIds.length} 个账号` })}
              >
                批量封禁
              </Button>
              <Button
                variant="outline"
                className="px-2.5 py-1 text-xs"
                disabled={selectedIds.length === 0}
                onClick={() => setPendingUnban({ ids: selectedIds, label: `已选的 ${selectedIds.length} 个账号` })}
              >
                批量解封
              </Button>
            </>
          ) : null
        }
        description={canStatus && canDelete ? undefined : "当前角色权限不足，部分操作不可用（服务端同样会拒绝）。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                {canStatus ? (
                  <th className={`${thClass} w-10`}>
                    <input
                      type="checkbox"
                      aria-label="全选本页"
                      className="h-4 w-4 accent-indigo-500"
                      checked={allChecked}
                      disabled={currentList.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                ) : null}
                <SortableTh label="账号" field="username" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="状态" field="status" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="角色数" field="roleCount" sort={sort} order={order} onToggle={toggle} defaultOrder="desc" />
                <SortableTh label="注册时间" field="createdAt" sort={sort} order={order} onToggle={toggle} defaultOrder="desc" />
                <SortableTh label="最近登录" field="lastLoginAt" sort={sort} order={order} onToggle={toggle} defaultOrder="desc" />
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {currentList.map((account) => (
                <tr key={account.id} className="transition hover:bg-slate-800/30">
                  {canStatus ? (
                    <td className={tdClass}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${account.username}`}
                        className="h-4 w-4 accent-indigo-500"
                        checked={selectedIds.indexOf(account.id) !== -1}
                        onChange={() => toggleOne(account.id)}
                      />
                    </td>
                  ) : null}
                  <td className={tdClass}>
                    <Link to={`/accounts/${account.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">
                      {account.username}
                    </Link>
                    {account.onlineRoleId ? <span className="ml-2 text-xs text-slate-500">有在线角色</span> : null}
                  </td>
                  <td className={tdClass}>
                    <BanStatus account={account} />
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
                      {banStateOf(account).banned ? (
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canStatus}
                          loading={busyId === account.id || busyId === BATCH_BUSY}
                          onClick={() => void unban({ ids: [account.id], label: account.username })}
                        >
                          解封
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canStatus}
                          loading={busyId === account.id}
                          onClick={() => setPendingBan({ ids: [account.id], label: account.username })}
                        >
                          封禁
                        </Button>
                      )}
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

      <BanDialog
        open={pendingBan !== null}
        targetName={pendingBan?.label ?? ""}
        onCancel={() => setPendingBan(null)}
        onSubmit={ban}
      />

      <ConfirmDialog
        open={pendingUnban !== null}
        title="批量解封账号"
        description={pendingUnban ? `将解封 ${pendingUnban.ids.length} 个账号，它们可以立即重新登录。` : ""}
        confirmText="确认解封"
        loading={busyId === BATCH_BUSY}
        onConfirm={() => {
          if (pendingUnban) void unban(pendingUnban);
        }}
        onCancel={() => setPendingUnban(null)}
      />

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

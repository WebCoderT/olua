import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatTime, OCCUPATION_LABELS, PERMISSION, rolesApi, SEX_LABELS } from "../api";
import type { AdminRole, PageResult } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 角色管理：跨账号检索角色、进编辑页、直接删除（删除按权限点显隐） */
export function RolesPage() {
  const canDelete = hasPermission(PERMISSION.ROLE_DELETE);
  const [searchParams, setSearchParams] = useSearchParams();
  const accountId = searchParams.get("accountId") ?? "";
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResult<AdminRole> | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<AdminRole | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await rolesApi.list({ page, size: PAGE_SIZE, keyword: keyword || undefined, accountId: accountId || undefined }));
    } catch {
      /* 统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, keyword, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draft.trim());
  };

  const clearAccountFilter = () => {
    setSearchParams({}, { replace: true });
    setPage(1);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await rolesApi.remove(pendingDelete.id);
      toastSuccess(`已删除角色 ${pendingDelete.name}`);
      setPendingDelete(null);
      if (data && data.list.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">角色管理</h1>
        <p className="mt-1 text-xs text-slate-500">关键字同时匹配角色名与角色 id；可改等级 / 金币 / 称号等常用字段。</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">角色名 / 角色 id</span>
            <Input
              value={draft}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          {accountId ? (
            <Button variant="outline" onClick={clearAccountFilter}>
              清除账号筛选
            </Button>
          ) : null}
        </div>
        {accountId ? <p className="mt-3 text-xs text-slate-500">当前只显示账号 id 为 {accountId} 的角色</p> : null}
      </Card>

      <Card title="角色列表" actions={loading ? <Spinner /> : null}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>角色名</th>
                <th className={thClass}>所属账号</th>
                <th className={thClass}>职业</th>
                <th className={thClass}>性别</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((role) => (
                <tr key={role.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <Link to={`/roles/${role.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">
                      {role.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-slate-500">id: {role.id}</div>
                  </td>
                  <td className={tdClass}>
                    {role.accountName ? (
                      <Link to={`/accounts/${role.accountId}`} className="text-slate-300 hover:text-indigo-300">
                        {role.accountName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={tdClass}>{OCCUPATION_LABELS[role.occupation] ?? role.occupation}</td>
                  <td className={tdClass}>{SEX_LABELS[role.sex] ?? role.sex}</td>
                  <td className={tdClass}>{role.level}</td>
                  <td className={tdClass}>{role.online ? <Badge tone="indigo">在线</Badge> : <Badge>离线</Badge>}</td>
                  <td className={tdClass}>{formatTime(role.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Link to={`/roles/${role.id}`}>
                        <Button variant="outline" className="px-2.5 py-1 text-xs">
                          编辑
                        </Button>
                      </Link>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canDelete} onClick={() => setPendingDelete(role)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的角色" description="换个关键字试试" /> : null}

        <Pagination page={page} size={PAGE_SIZE} total={data?.total ?? 0} onChange={setPage} />
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除角色"
        description={pendingDelete ? `将删除角色「${pendingDelete.name}」（账号 ${pendingDelete.accountName ?? "未知"}），操作不可恢复。` : ""}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

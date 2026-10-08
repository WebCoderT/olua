import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { accountsApi, formatTime, OCCUPATION_LABELS, PERMISSION, SEX_LABELS, rolesApi } from "../api";
import type { AccountDetail } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, EmptyState, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 某个账号的详情 + 名下角色（可进角色编辑、可直接删角色；写操作按权限点显隐） */
export function AccountDetailPage() {
  const canSelect = hasPermission(PERMISSION.ROLE_SELECT);
  const canDeleteRole = hasPermission(PERMISSION.ROLE_DELETE);
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await accountsApi.detail(id));
    } catch {
      /* 统一提示 */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 把某个角色设为该账号的在线角色（等价于玩家在选角界面点它进游戏） */
  const setOnline = async (roleId: string) => {
    setBusyId(roleId);
    try {
      const updated = await rolesApi.select(roleId);
      toastSuccess(`已把「${updated.name}」设为该账号的在线角色`);
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
      await rolesApi.remove(pendingDelete.id);
      toastSuccess(`已删除角色 ${pendingDelete.name}`);
      setPendingDelete(null);
      await load();
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  /** 清空该账号的全部角色（账号保留；玩家可以重新创建角色） */
  const purgeRoles = async () => {
    setPurging(true);
    try {
      const result = await accountsApi.purgeRoles(id);
      toastSuccess(result.deleted > 0 ? `已清空 ${result.deleted} 个角色` : "该账号本来就没有角色");
      setPurgeConfirm(false);
      await load();
    } catch {
      /* 统一提示 */
    } finally {
      setPurging(false);
    }
  };

  if (loading && !detail) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Spinner /> 加载中…
      </div>
    );
  }

  if (!detail) {
    return <EmptyState title="账号不存在" description="它可能已经被删除了" />;
  }

  const { account, roles } = detail;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">{account.username}</h1>
          <p className="mt-1 text-xs text-slate-500">账号 id：{account.id}</p>
        </div>
        <Link to="/accounts">
          <Button variant="outline">返回列表</Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card title="账号状态">
          <p className="text-sm text-slate-200">{account.status === "active" ? <Badge tone="green">正常</Badge> : <Badge tone="red">已封禁</Badge>}</p>
        </Card>
        <Card title="注册时间">
          <p className="text-sm text-slate-200">{formatTime(account.createdAt)}</p>
        </Card>
        <Card title="最近登录">
          <p className="text-sm text-slate-200">{formatTime(account.lastLoginAt)}</p>
        </Card>
        <Card title="在线角色">
          <p className="text-sm text-slate-200">{roles.find((role) => role.online)?.name ?? "未选角色"}</p>
        </Card>
      </div>

      <Card
        title={`角色（${roles.length}）`}
        description="基础信息与装备 / 技能 / 背包都能直接改；账号本身不会被删除，清空后玩家可以重新创建角色。"
        actions={
          <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canDeleteRole || roles.length === 0} onClick={() => setPurgeConfirm(true)}>
            清空全部角色
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>角色名</th>
                <th className={thClass}>职业</th>
                <th className={thClass}>性别</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <Link to={`/roles/${role.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">
                      {role.name}
                    </Link>
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
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canSelect}
                        loading={busyId === role.id}
                        onClick={() => void setOnline(role.id)}
                      >
                        设为在线
                      </Button>
                      <Button
                        variant="danger"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canDeleteRole}
                        onClick={() => setPendingDelete({ id: role.id, name: role.name })}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {roles.length === 0 ? <EmptyState title="该账号还没有角色" description="玩家在游戏内创建角色后会出现在这里" /> : null}
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除角色"
        description={pendingDelete ? `将删除角色「${pendingDelete.name}」，操作不可恢复。` : ""}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={purgeConfirm}
        title="清空该账号的全部角色"
        description={`将删除账号「${account.username}」名下的 ${roles.length} 个角色（账号保留），操作不可恢复。`}
        confirmText="确认清空"
        loading={purging}
        onConfirm={() => void purgeRoles()}
        onCancel={() => setPurgeConfirm(false)}
      />
    </div>
  );
}

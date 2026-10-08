import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatTime, OCCUPATION_LABELS, PERMISSION, rolesApi, SEX_LABELS } from "../api";
import type { AdminRole, PageResult, RoleListQuery } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 筛选表单（字符串形态，便于受控输入） */
interface RoleFilterForm {
  keyword: string;
  online: string;
  occupation: string;
  sex: string;
  minLevel: string;
  maxLevel: string;
}

const EMPTY_FILTER: RoleFilterForm = { keyword: "", online: "", occupation: "", sex: "", minLevel: "", maxLevel: "" };

/** 表单 → 接口查询参数（空值不传；等级只收数字） */
function toQuery(form: RoleFilterForm, accountId: string, page: number): RoleListQuery {
  const level = (value: string) => {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isInteger(parsed) ? parsed : undefined;
  };
  return {
    page,
    size: PAGE_SIZE,
    keyword: form.keyword.trim() || undefined,
    accountId: accountId || undefined,
    online: form.online || undefined,
    occupation: form.occupation || undefined,
    sex: form.sex || undefined,
    minLevel: level(form.minLevel),
    maxLevel: level(form.maxLevel),
  };
}

/** 角色管理：筛选检索 + 多选批量删除（写操作按权限点显隐） */
export function RolesPage() {
  const canDelete = hasPermission(PERMISSION.ROLE_DELETE);
  const [searchParams, setSearchParams] = useSearchParams();
  const accountId = searchParams.get("accountId") ?? "";
  const [form, setForm] = useState<RoleFilterForm>(EMPTY_FILTER);
  /** 已提交的筛选条件（表单改动要等「查询」才生效，避免每敲一个字就请求一次） */
  const [applied, setApplied] = useState<RoleFilterForm>(EMPTY_FILTER);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResult<AdminRole> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<AdminRole | null>(null);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rolesApi.list(toQuery(applied, accountId, page));
      setData(result);
      // 列表刷新后清掉选中：翻页 / 换筛选条件之后，上一页的选中项已经不在眼前，留着容易误删
      setSelectedIds([]);
    } catch {
      /* 统一提示 */
    } finally {
      setLoading(false);
    }
  }, [applied, accountId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setApplied(form);
  };

  const resetFilter = () => {
    setForm(EMPTY_FILTER);
    setApplied(EMPTY_FILTER);
    setPage(1);
    if (accountId) setSearchParams({}, { replace: true });
  };

  const currentList = data?.list ?? [];
  const allChecked = currentList.length > 0 && selectedIds.length === currentList.length;

  const toggleOne = (id: string) => {
    setSelectedIds((previous) => (previous.indexOf(id) === -1 ? [...previous, id] : previous.filter((item) => item !== id)));
  };

  const toggleAll = () => {
    setSelectedIds(allChecked ? [] : currentList.map((role) => role.id));
  };

  /** 选中项的名字（确认框里列出来，避免「删了谁」全靠数量猜） */
  const selectedNames = useMemo(
    () => currentList.filter((role) => selectedIds.indexOf(role.id) !== -1).map((role) => role.name),
    [currentList, selectedIds],
  );

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

  const confirmBatchDelete = async () => {
    if (selectedIds.length === 0) return;
    setDeleting(true);
    try {
      const result = await rolesApi.batchRemove(selectedIds);
      toastSuccess(
        result.deleted > 0
          ? `已删除 ${result.deleted} 个角色${result.deleted < result.requested ? `（${result.requested - result.deleted} 个已不存在）` : ""}`
          : "这些角色已经不存在了",
      );
      setBatchConfirm(false);
      setSelectedIds([]);
      await load();
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  const update = (key: keyof RoleFilterForm, value: string) => setForm({ ...form, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">角色管理</h1>
        <p className="mt-1 text-xs text-slate-500">
          关键字同时匹配角色名与角色 id；可改基础信息（含时装 / 所在地图）与装备、技能、背包。
          「在线」= 该角色是所属账号当前选中的那个（玩家在选角界面选它进游戏）。
        </p>
      </div>

      <Card title="筛选" actions={loading ? <Spinner /> : null}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="角色名 / 角色 id">
            <Input
              value={form.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => update("keyword", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field label="在线状态">
            <Select value={form.online} onChange={(event) => update("online", event.target.value)}>
              <option value="">全部</option>
              <option value="true">在线</option>
              <option value="false">离线</option>
            </Select>
          </Field>
          <Field label="职业">
            <Select value={form.occupation} onChange={(event) => update("occupation", event.target.value)}>
              <option value="">全部</option>
              {Object.entries(OCCUPATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别">
            <Select value={form.sex} onChange={(event) => update("sex", event.target.value)}>
              <option value="">全部</option>
              {Object.entries(SEX_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="最低等级">
            <Input
              inputMode="numeric"
              value={form.minLevel}
              placeholder="不限"
              onChange={(event) => update("minLevel", event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="最高等级">
            <Input
              inputMode="numeric"
              value={form.maxLevel}
              placeholder="不限"
              onChange={(event) => update("maxLevel", event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button onClick={submitSearch}>查询</Button>
            <Button variant="outline" onClick={resetFilter}>
              重置
            </Button>
          </div>
        </div>
        {accountId ? <p className="mt-3 text-xs text-slate-500">当前只显示账号 id 为 {accountId} 的角色（重置可清除该筛选）</p> : null}
      </Card>

      <Card
        title={`角色列表（${data?.total ?? 0}）`}
        actions={
          <>
            {selectedIds.length > 0 ? <span className="text-xs text-slate-400">已选 {selectedIds.length} 个</span> : null}
            <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canDelete || selectedIds.length === 0} onClick={() => setBatchConfirm(true)}>
              批量删除
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={`${thClass} w-10`}>
                  <input
                    type="checkbox"
                    aria-label="全选本页"
                    className="h-4 w-4 accent-indigo-500"
                    checked={allChecked}
                    disabled={!canDelete || currentList.length === 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className={thClass}>角色名</th>
                <th className={thClass}>所属账号</th>
                <th className={thClass}>职业</th>
                <th className={thClass}>性别</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>修订</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {currentList.map((role) => (
                <tr key={role.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${role.name}`}
                      className="h-4 w-4 accent-indigo-500"
                      checked={selectedIds.indexOf(role.id) !== -1}
                      disabled={!canDelete}
                      onChange={() => toggleOne(role.id)}
                    />
                  </td>
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
                  <td className={tdClass}>
                    <span className="text-xs text-slate-500">#{role.revision}</span>
                  </td>
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的角色" description="换个筛选条件试试" /> : null}

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

      <ConfirmDialog
        open={batchConfirm}
        title="批量删除角色"
        description={`将删除 ${selectedIds.length} 个角色（${selectedNames.slice(0, 3).join("、")}${
          selectedNames.length > 3 ? ` 等 ${selectedNames.length} 个` : ""
        }），操作不可恢复。`}
        confirmText="确认批量删除"
        loading={deleting}
        onConfirm={() => void confirmBatchDelete()}
        onCancel={() => setBatchConfirm(false)}
      />
    </div>
  );
}

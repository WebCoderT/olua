import { useCallback, useEffect, useState } from "react";
import { formatTime, npcsApi, PERMISSION } from "../api";
import type { Npc, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * NPC 配置管理（#258，养成配置第七页）
 *
 * id 清单固定（被 Tiled 地图对象组引用，启动时 seed 落库）——**没有「新建」「删除」**，
 * 只有「编辑」；名称与对话文案可改，外观资源（src / scale / position）与点击行为是
 * 表现层配置不进服务端。对话文案 seed 为空串（客户端暂无对话数据形态），在这里运营
 * 可维护，客户端消费等对接。写操作要 `gameConfig:write`。
 */
export function NpcsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Npc> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Npc | null>(null);
  const [form, setForm] = useState<Npc | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await npcsApi.list({ page, size, keyword: keyword || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draftKeyword.trim());
  };

  const resetSearch = () => {
    setDraftKeyword("");
    setPage(1);
    setKeyword("");
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const openEdit = (item: Npc) => {
    setEditing(item);
    setForm({ ...item });
  };

  const closeEdit = () => {
    setEditing(null);
    setForm(null);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段） */
  const submitEdit = async () => {
    if (!editing || !form) return;
    try {
      await npcsApi.update(editing.id, { label: form.label, dialog: form.dialog });
      toastSuccess(`NPC「${form.label}」已更新`);
      closeEdit();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">NPC 配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          id 清单固定（被 Tiled 地图对象组引用），只可编辑、不可新增 / 删除；外观资源与点击行为是表现层配置，不进服务端。
          对话文案在客户端暂无数据形态，先在这里维护。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 名称</span>
            <Input
              value={draftKeyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraftKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="NPC 列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>对话</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={`${tdClass} max-w-[360px] truncate text-xs text-slate-400`} title={item.dialog}>
                    {item.dialog || <span className="text-slate-600">（未配置）</span>}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的 NPC" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {form ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">编辑 NPC · {editing?.id}</h3>
            <p className="mt-1 text-xs text-slate-500">部分更新：只提交下方字段；对话文案传空串 = 清空。</p>

            <div className="mt-5 flex flex-col gap-4">
              <Field label="名称">
                <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
              </Field>
              <Field label="对话文案" hint="客户端暂无对话数据形态，先在这里维护（≤2000 字）">
                <textarea
                  className="min-h-[96px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500"
                  maxLength={2000}
                  value={form.dialog}
                  onChange={(event) => setForm({ ...form, dialog: event.target.value })}
                />
              </Field>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={closeEdit}>
                取消
              </Button>
              <Button disabled={!form.label.trim()} onClick={() => void submitEdit()}>
                保存修改
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
